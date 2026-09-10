import { AppError, conflictError, notFoundError } from '../../utils/app-error.js';
import { env } from '../../config/env.js';
import { configuredModel, getOpenAIResponsesClient, isAiGenerationConfigured } from '../ai/openai.service.js';
import * as onboardingRepo from '../onboarding/onboarding.repo.js';
import * as repo from './agent.repo.js';
import type { AgentRole, AgentRun, AgentTool } from './agent.types.js';
import { getAgentCapabilities, type AgentModule, isAgentModule } from './agent.capabilities.js';
import { buildAgentExecutionProfile } from './agent.domain.js';
import {
  automaticPageProfiles,
  buildGlobalAgentGoal,
  buildPageAgentGoal,
  pageSnapshotType,
  resolveAgentModule,
  sanitizeAgentPageContext,
  type AgentPageContext,
} from './agent.page-context.js';
import { registerAgentTools } from './agent.tools.js';
import { authorizeAgentTool, authorizeAgentIdentity } from './agent.authorization.js';

const tools = new Map<string, AgentTool>();
const activeRuns = new Set<string>();
const MAX_RUN_DURATION_MS = 10 * 60 * 1000;
const TOOL_TIMEOUT_MS = env.AI_REQUEST_TIMEOUT_MS;

registerAgentTools(tools);

function buildPipeline(
  goal: string,
  executionMode: 'analysis_only' | 'autonomous',
  module: AgentModule,
  capabilities: ReturnType<typeof getAgentCapabilities>,
  page: AgentPageContext | null,
) {
  const profile = buildAgentExecutionProfile(page, module);
  const steps: Array<{
    role: AgentRole;
    title: string;
    instruction: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
  }> = [
    {
      role: 'planner',
      title: page ? `${page.pageLabel}: Frame the page objective` : 'Frame the objective',
      instruction: `${profile.plannerInstruction} Goal: ${goal}`,
    },
    {
      role: 'analyst',
      title: page ? `${page.pageLabel}: Collect live evidence` : 'Collect live evidence',
      instruction: `Inspect the strongest live signals for module "${module}" and summarize the facts that matter most for the current goal.`,
      toolName: profile.analystToolName,
      toolInput: {
        module,
        pageId: page?.pageId ?? null,
        pageLabel: page?.pageLabel ?? null,
        resourceTypes: profile.resourceTypes,
      },
    },
    ...(capabilities.recommend
      ? [{
          role: 'strategist' as const,
          title: page ? `${page.pageLabel}: Design the next moves` : 'Design the next moves',
          instruction: profile.strategistInstruction,
        }]
      : []),
    ...(capabilities.act && profile.executorToolName && profile.executorInstruction && profile.actionResourceType
      ? [{
          role: 'executor' as const,
          title: page ? `${page.pageLabel}: Execute backend action` : 'Execute backend action',
          instruction: profile.executorInstruction,
          toolName: profile.executorToolName,
          toolInput: {
            module,
            pageId: page?.pageId ?? null,
            pageLabel: page?.pageLabel ?? null,
            goal,
            jobs: page?.jobs ?? [],
            approvalGates: page?.approvalGates ?? [],
            resourceTypes: profile.resourceTypes,
            actionResourceType: profile.actionResourceType,
            executionMode,
          },
        }]
      : []),
    {
      role: 'reviewer',
      title: page ? `${page.pageLabel}: Verify evidence and outcomes` : 'Verify evidence and outcomes',
      instruction: profile.reviewerInstruction,
    },
  ];
  return { profile, steps };
}

async function event(input: Parameters<typeof repo.addEvent>[0]) { return repo.addEvent(input); }
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new AppError(504, code, 'The agent operation exceeded its time limit')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
async function assertNotCancelled(workspaceId: string, runId: string) {
  const run = await repo.getRun(workspaceId, runId).catch(() => undefined);
  if (run?.status === 'cancelled') throw new AppError(409, 'AGENT_RUN_CANCELLED', 'The agent run was cancelled');
}

function describePageContext(page: AgentPageContext | null) {
  if (!page) return 'No dedicated page context was provided.';
  return JSON.stringify({
    pageId: page.pageId,
    pageLabel: page.pageLabel,
    sectionLabel: page.sectionLabel,
    agentName: page.agentName,
    objective: page.objective,
    autonomy: page.autonomy,
    jobs: page.jobs,
    integrations: page.integrations,
    successMetrics: page.successMetrics,
    approvalGates: page.approvalGates,
  });
}

function compactEntityName(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 200) : '';
}

function entityItems(source: unknown, kind: string) {
  if (!Array.isArray(source)) return [];
  return source
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const entity = item as Record<string, unknown>;
      const name = compactEntityName(entity.name ?? entity.title ?? entity.subject ?? entity.emailAddress ?? entity.goal);
      if (!name) return null;
      return {
        kind,
        id: typeof entity.id === 'string' ? entity.id : null,
        name,
        status: typeof entity.status === 'string' ? entity.status : null,
        updatedAt: typeof entity.updatedAt === 'string'
          ? entity.updatedAt
          : typeof entity.latestAt === 'string'
            ? entity.latestAt
            : typeof entity.startAt === 'string'
              ? entity.startAt
              : null,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function extractEntitiesFromOutputs(outputs: unknown[]) {
  const entities: Array<{ kind: string; id: string | null; name: string; status: string | null; updatedAt: string | null }> = [];
  for (const entry of outputs) {
    const output = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).output : null;
    if (!output || typeof output !== 'object') continue;
    const payload = output as Record<string, unknown>;
    entities.push(...entityItems((payload.records as Record<string, unknown> | undefined)?.recent, 'record'));
    entities.push(...entityItems((payload.accounts as Record<string, unknown> | undefined)?.top, 'account'));
    entities.push(...entityItems((payload.threads as Record<string, unknown> | undefined)?.recent, 'thread'));
    entities.push(...entityItems((payload.drafts as Record<string, unknown> | undefined)?.recent, 'draft'));
    entities.push(...entityItems((payload.automations as Record<string, unknown> | undefined)?.recent, 'automation'));
    entities.push(...entityItems((payload.events as Record<string, unknown> | undefined)?.recent, 'event'));
    entities.push(...entityItems((payload.sites as Record<string, unknown> | undefined)?.top, 'site'));
    entities.push(...entityItems((payload.runs as Record<string, unknown> | undefined)?.recent, 'run'));
    entities.push(...entityItems((payload.actionRecord ? [payload.actionRecord] : []), 'action'));
  }
  return entities.slice(0, 24);
}

function buildInitialPlan(
  module: AgentModule,
  capabilities: ReturnType<typeof getAgentCapabilities>,
  executionMode: 'analysis_only' | 'autonomous',
  page: AgentPageContext | null,
) {
  const profile = buildAgentExecutionProfile(page, module);
  return {
    version: 3,
    module,
    capabilities,
    executionMode,
    page,
    executionProfile: {
      analystToolName: profile.analystToolName,
      executorToolName: profile.executorToolName,
      actionResourceType: profile.actionResourceType,
      resourceTypes: profile.resourceTypes,
      telemetryTags: profile.telemetryTags,
    },
    agents: [] as string[],
    steps: [] as Array<{ id: string; role: string; title: string }>,
  };
}

function requireRegisteredPageId(pageId?: string) {
  if (!pageId) return null;
  const page = sanitizeAgentPageContext({ pageId });
  if (!page) throw new AppError(400, 'AGENT_PAGE_UNKNOWN', 'The requested page agent is not registered');
  return page;
}

async function persistPageSnapshot(
  runId: string,
  workspaceId: string,
  goal: string,
  page: AgentPageContext | null,
  finalResult: Record<string, unknown>,
) {
  if (!page) return;
  const summary = typeof finalResult.summary === 'string'
    ? finalResult.summary
    : typeof finalResult.goal === 'string'
      ? `Latest ${page.pageLabel} agent run completed for goal: ${finalResult.goal}`
      : `Latest ${page.pageLabel} agent run completed.`;
  const snapshot = await repo.createKnowledgeSnapshot({
    workspaceId,
    sourceRunId: runId,
    snapshotType: pageSnapshotType(page.pageId),
    status: 'completed',
    executiveSummary: summary,
    priorities: page.jobs,
    knowledgeBase: {
      page,
      goal,
      outputs: Array.isArray(finalResult.outputs) ? finalResult.outputs : [],
      summary: finalResult.summary ?? null,
    },
    sourceManifest: {
      source: 'page_agent_run',
      generatedBy: 'lulu-page-agent-orchestrator',
      pageId: page.pageId,
      pageLabel: page.pageLabel,
      sectionLabel: page.sectionLabel,
    },
    generatedAt: new Date(),
  });
  if (!snapshot?.id) return;
  const entities = extractEntitiesFromOutputs(Array.isArray(finalResult.outputs) ? finalResult.outputs : []);
  await repo.replaceKnowledgeSections(snapshot.id, workspaceId, {
    overview: {
      title: page.pageLabel,
      objective: page.objective,
      summary,
      jobs: page.jobs,
      integrations: page.integrations,
      successMetrics: page.successMetrics,
    },
    execution: {
      goal,
      outputs: Array.isArray(finalResult.outputs) ? finalResult.outputs : [],
      completedAt: new Date().toISOString(),
    },
    entities: {
      total: entities.length,
      items: entities,
    },
    telemetry: {
      module: finalResult.module ?? null,
      toolName: typeof finalResult.telemetry === 'object' && finalResult.telemetry
        ? (finalResult.telemetry as Record<string, unknown>).analystToolName ?? null
        : null,
      executorToolName: typeof finalResult.telemetry === 'object' && finalResult.telemetry
        ? (finalResult.telemetry as Record<string, unknown>).executorToolName ?? null
        : null,
      actionResourceType: typeof finalResult.telemetry === 'object' && finalResult.telemetry
        ? (finalResult.telemetry as Record<string, unknown>).actionResourceType ?? null
        : null,
      resourceTypes: typeof finalResult.telemetry === 'object' && finalResult.telemetry
        ? (finalResult.telemetry as Record<string, unknown>).resourceTypes ?? []
        : [],
      telemetryTags: typeof finalResult.telemetry === 'object' && finalResult.telemetry
        ? (finalResult.telemetry as Record<string, unknown>).telemetryTags ?? []
        : [],
    },
  });
}

async function planRun(
  runId: string,
  workspaceId: string,
  goal: string,
  executionMode: 'analysis_only' | 'autonomous',
  module: AgentModule,
  capabilities: ReturnType<typeof getAgentCapabilities>,
  page: AgentPageContext | null,
) {
  await repo.updateRun(runId, { status: 'planning', started_at: new Date() });
  await event({ runId, workspaceId, eventType: 'run.planning_started', agentRole: 'planner', payload: { goal, pageId: page?.pageId ?? null } });
  const { profile, steps: selectedPipeline } = buildPipeline(goal, executionMode, module, capabilities, page);
  const steps = await repo.createSteps(selectedPipeline.map((step, index) => ({
    runId,
    workspaceId,
    sequenceNo: index + 1,
    agentRole: step.role,
    title: step.title,
    instruction: `${step.instruction} Module: ${module}. Capabilities: ${JSON.stringify(capabilities)} User goal: ${goal} Page context: ${describePageContext(page)}`,
    toolName: step.toolName ?? null,
    toolInput: step.toolInput ?? null,
  })));
  await repo.updateRun(runId, {
    status: 'running',
    plan: {
      version: 3,
      module,
      capabilities,
      executionMode,
      page,
      executionProfile: {
        analystToolName: profile.analystToolName,
        executorToolName: profile.executorToolName,
        actionResourceType: profile.actionResourceType,
        resourceTypes: profile.resourceTypes,
        telemetryTags: profile.telemetryTags,
      },
      agents: selectedPipeline.map((item) => item.role),
      steps: steps.map((item) => ({ id: item.id, role: item.agentRole, title: item.title })),
    },
  });
  await event({
    runId,
    workspaceId,
    eventType: 'run.planned',
    agentRole: 'planner',
    payload: {
      stepCount: steps.length,
      pageId: page?.pageId ?? null,
      module,
      analystToolName: profile.analystToolName,
      executorToolName: profile.executorToolName,
      actionResourceType: profile.actionResourceType,
      resourceTypes: profile.resourceTypes,
    },
  });
  return steps;
}
async function executeStep(runId: string, workspaceId: string, userId: string, step: Awaited<ReturnType<typeof repo.listSteps>>[number], autonomous: boolean) {
  await repo.updateStep(step.id, { status: 'running', started_at: new Date() });
  await event({
    runId,
    stepId: step.id,
    workspaceId,
    eventType: 'step.started',
    agentRole: step.agentRole,
    payload: { title: step.title, toolName: step.toolName ?? null },
  });
  const tool = step.toolName ? tools.get(step.toolName) : undefined;
  if (step.toolName && !tool) throw new AppError(500, 'AGENT_TOOL_NOT_REGISTERED', `Tool ${step.toolName} is not registered`);
  const toolInput = step.toolInput ?? {};
  const identity = { runId, workspaceId, userId, stepId: step.id };
  const toolAuthorization = await authorizeAgentTool(identity, step.toolName);
  const policyDecision = toolAuthorization.decision;
  const effectiveToolInput = {
    ...toolInput,
    policyDecision,
    executionMode: autonomous ? 'autonomous' : 'analysis_only',
  };
  if (tool && policyDecision === 'require_budget') throw new AppError(409, 'CUSTOMER_BUDGET_REQUIRED', 'Fund the prepaid ad-spend wallet before this action can run.');
  const toolOutput = tool ? await withTimeout(tool.execute(effectiveToolInput, identity), TOOL_TIMEOUT_MS, 'AGENT_TOOL_TIMEOUT') : { acknowledged: true, role: step.agentRole, instruction: step.instruction };
  await repo.updateStep(step.id, { status: 'completed', tool_output: toolOutput, result: toolOutput, finished_at: new Date() });
  await event({ runId, stepId: step.id, workspaceId, eventType: 'step.completed', agentRole: step.agentRole, payload: toolOutput });
  return { waiting: false, output: toolOutput };
}
async function executeRun(
  runId: string,
  workspaceId: string,
  userId: string,
  goal: string,
  executionMode: 'analysis_only' | 'autonomous',
  module: AgentModule,
  capabilities: ReturnType<typeof getAgentCapabilities>,
  page: AgentPageContext | null,
  initial = false,
) {
  if (activeRuns.has(runId)) return;
  activeRuns.add(runId);
  const deadline = Date.now() + MAX_RUN_DURATION_MS;
  try {
    const { profile, steps: pipelineSteps } = buildPipeline(goal, executionMode, module, capabilities, page);
    let steps = await repo.listSteps(workspaceId, runId);
    if (initial && steps.length === 0) steps = await planRun(runId, workspaceId, goal, executionMode, module, capabilities, page);
    const outputs: Record<string, unknown>[] = [];
    for (const step of steps) {
      if (Date.now() > deadline) throw new AppError(504, 'AGENT_RUN_TIMEOUT', 'The agent run exceeded its time limit');
      await assertNotCancelled(workspaceId, runId);
      if (step.status === 'completed' || step.status === 'skipped') {
        if (step.result) outputs.push({ stepId: step.id, output: step.result });
        continue;
      }
      const result = await executeStep(runId, workspaceId, userId, step, executionMode === 'autonomous');
      if (result.waiting) return;
      outputs.push({ stepId: step.id, output: result.output });
    }
    let finalResult: Record<string, unknown> = {
      goal,
      outputs,
      completedBy: pipelineSteps.map((item) => item.role),
      page,
      module,
      telemetry: {
        analystToolName: profile.analystToolName,
        executorToolName: profile.executorToolName,
        actionResourceType: profile.actionResourceType,
        resourceTypes: profile.resourceTypes,
        telemetryTags: profile.telemetryTags,
      },
    };
    if (isAiGenerationConfigured()) {
      if (!steps[0]) throw new AppError(403,'AGENT_EXECUTION_FORBIDDEN','Agent synthesis requires a persisted step identity');
      await authorizeAgentIdentity({workspaceId,userId,runId,stepId:steps[0].id});
      const response = await withTimeout(getOpenAIResponsesClient().create({ model: configuredModel(), instructions: 'Synthesize the coordinated agent outputs into a concise page-aware business result. Return plain text.', input: [{ role: 'user', content: JSON.stringify(finalResult) }], store: false }, { billing: { workspaceId, userId: userId === 'system' ? null : userId } }), TOOL_TIMEOUT_MS, 'AGENT_SYNTHESIS_TIMEOUT');
      finalResult = { ...finalResult, summary: response.output_text?.trim() ?? null };
    }
    await persistPageSnapshot(runId, workspaceId, goal, page, finalResult);
    await repo.finalizeRun({
      runId,
      workspaceId,
      status: 'completed',
      patch: { result: finalResult, finished_at: new Date() },
      eventPayload: finalResult,
      pageId: page?.pageId ?? null,
      actorId: userId === 'system' ? null : userId,
      agentRole: 'reviewer',
    });
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError(500, 'AGENT_RUN_FAILED', error instanceof Error ? error.message : 'Agent run failed');
    const status = appError.code === 'AGENT_RUN_CANCELLED' ? 'cancelled' : 'failed';
    await repo.finalizeRun({
      runId,
      workspaceId,
      status,
      patch: { error_code: appError.code, error_message: appError.message, finished_at: new Date() },
      eventPayload: { code: appError.code, message: appError.message },
      pageId: page?.pageId ?? null,
      actorId: userId === 'system' ? null : userId,
    });
  } finally { activeRuns.delete(runId); }
}

export async function executePersistedAgentRun(run: AgentRun) {
  if (['completed', 'failed', 'cancelled'].includes(run.status)) return;
  const subscription = await repo.getWorkspacePlan(run.workspaceId);
  const module = isAgentModule(run.plan?.module) ? run.plan.module : 'general';
  const capabilities = getAgentCapabilities(subscription.plan_key, module);
  const page = sanitizeAgentPageContext(run.plan?.page as Record<string, unknown> | null | undefined);
  const actorId = run.createdBy ?? await repo.getWorkspaceActorId(run.workspaceId) ?? 'system';
  await executeRun(
    run.id,
    run.workspaceId,
    actorId,
    run.goal,
    capabilities.autonomous ? 'autonomous' : 'analysis_only',
    module,
    capabilities,
    page,
    true,
  );
}
export async function startRun(
  workspaceId: string,
  userId: string,
  _requestedGoal: string | undefined,
  module: AgentModule = 'general',
  pageInput?: unknown,
  dedupeMinutes?: number,
) {
  const subscription = await repo.getWorkspacePlan(workspaceId);
  if (subscription.status !== 'active' && subscription.status !== 'trialing') throw new AppError(403, 'AGENT_PLAN_INACTIVE', 'An active workspace subscription is required for agent analysis');
  const page = sanitizeAgentPageContext(pageInput as Record<string, unknown> | null | undefined);
  if (pageInput && !page) throw new AppError(400, 'AGENT_PAGE_UNKNOWN', 'The requested page agent is not registered');
  const resolvedModule = resolveAgentModule(isAgentModule(module) ? module : 'general', page);
  const goal = page ? buildPageAgentGoal(page) : buildGlobalAgentGoal();
  const capabilities = getAgentCapabilities(subscription.plan_key, resolvedModule);
  if (!capabilities.analyze) throw new AppError(403, 'AGENT_EXPLORER_READ_ONLY', 'Explorer is read-only and does not run AI analysis. Choose Starter or AI.');
  const executionMode = capabilities.autonomous ? 'autonomous' : 'analysis_only';
  const initialPlan = buildInitialPlan(resolvedModule, capabilities, executionMode, page);
  let run;
  if (page && dedupeMinutes) {
    const result = await repo.createOrReusePageRun({
      workspaceId,
      userId,
      goal,
      pageId: page.pageId,
      dedupeMinutes,
      initialPlan,
    });
    run = result.run;
  } else {
    run = await repo.createRun(workspaceId, userId, goal, page ? initialPlan : null);
  }
  if (!run) throw new AppError(500, 'AGENT_RUN_CREATION_FAILED', 'The agent run could not be created');
  return run;
}
export async function startAutomaticRun(
  workspaceId: string,
  _requestedGoal: string,
  module: AgentModule,
  pageInput?: unknown,
  dedupeMinutes?: number,
  actorUserId?: string,
) {
  const subscription = await repo.getWorkspacePlan(workspaceId);
  const page = sanitizeAgentPageContext(pageInput as Record<string, unknown> | null | undefined);
  if (pageInput && !page) throw new AppError(400, 'AGENT_PAGE_UNKNOWN', 'The requested page agent is not registered');
  const resolvedModule = resolveAgentModule(module, page);
  const goal = page ? buildPageAgentGoal(page) : buildGlobalAgentGoal();
  const capabilities = getAgentCapabilities(subscription.plan_key, resolvedModule);
  if ((subscription.status !== 'active' && subscription.status !== 'trialing') || !capabilities.automatic || !capabilities.analyze) return null;
  const automaticCapabilities = { ...capabilities };
  const executionMode = automaticCapabilities.autonomous ? 'autonomous' : 'analysis_only';
  const initialPlan = buildInitialPlan(resolvedModule, automaticCapabilities, executionMode, page);
  let run;
  if (page && dedupeMinutes) {
    const result = await repo.createOrReusePageRun({
      workspaceId,
      userId: actorUserId ?? null,
      goal,
      pageId: page.pageId,
      dedupeMinutes,
      initialPlan,
    });
    run = result.run;
  } else {
    run = await repo.createRun(workspaceId, actorUserId ?? null, goal, page ? initialPlan : null);
  }
  if (!run) throw new AppError(500, 'AGENT_AUTOMATIC_RUN_CREATION_FAILED', 'The automatic analysis run could not be created');
  return run;
}
export async function listRuns(workspaceId: string, pageId?: string) {
  const page = requireRegisteredPageId(pageId);
  return repo.listRuns(workspaceId, 50, page?.pageId);
}
export async function getKnowledgeBundle(workspaceId: string, pageId?: string) {
  const page = requireRegisteredPageId(pageId);
  return repo.getKnowledgeBundle(workspaceId, page ? pageSnapshotType(page.pageId) : 'initial_business_analysis');
}
function runPageId(run: Awaited<ReturnType<typeof repo.listRuns>>[number]) {
  return typeof run.plan?.page === 'object'
    && run.plan?.page
    && typeof (run.plan.page as Record<string, unknown>).pageId === 'string'
    ? (run.plan.page as Record<string, unknown>).pageId
    : null;
}

function matchingPlatforms(page: AgentPageContext, platforms: Awaited<ReturnType<typeof onboardingRepo.listPlatforms>>) {
  const terms = new Set(
    [
      page.sectionLabel,
      page.pageLabel,
      ...page.integrations,
      ...(page.sectionLabel.toLowerCase() === 'email' ? ['email', 'mail', 'gmail', 'outlook'] : []),
      ...(page.sectionLabel.toLowerCase() === 'calendar' ? ['calendar', 'google calendar', 'calendly', 'cal.com'] : []),
      ...(page.sectionLabel.toLowerCase() === 'google business' ? ['google', 'google business'] : []),
    ]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return platforms.filter((platform) => {
    const haystack = `${platform.integrationKey ?? ''} ${platform.name} ${platform.category}`.toLowerCase();
    return [...terms].some((term) => haystack.includes(term));
  });
}

export async function getAgentHealth(workspaceId: string, pageId?: string) {
  const page = requireRegisteredPageId(pageId);
  const [runs, platforms] = await Promise.all([
    repo.listRuns(workspaceId, page ? 50 : 400, page?.pageId),
    onboardingRepo.listPlatforms(workspaceId),
  ]);
  const pages = page ? [page] : automaticPageProfiles;
  const items = pages.map((page) => {
    const module = resolveAgentModule('general', page);
    const profile = buildAgentExecutionProfile(page, module);
    const pageRuns = runs.filter((run) => runPageId(run) === page.pageId);
    const latestRun = pageRuns[0] ?? null;
    const completedRuns = pageRuns.filter((run) => run.status === 'completed').length;
    const failedRuns = pageRuns.filter((run) => run.status === 'failed').length;
    const pagePlatforms = matchingPlatforms(page, platforms);
    const errorClasses = [...new Set(pageRuns.map((run) => run.errorCode).filter((value): value is string => typeof value === 'string' && value.length > 0))].slice(0, 5);
    return {
      pageId: page.pageId,
      pageLabel: page.pageLabel,
      sectionLabel: page.sectionLabel,
      module,
      successRate: pageRuns.length ? Math.round((completedRuns / pageRuns.length) * 100) : null,
      recentRunCount: pageRuns.length,
      failedRunCount: failedRuns,
      lastRunStatus: latestRun?.status ?? 'never_run',
      lastRunAt: latestRun?.updatedAt ?? null,
      lastErrorCode: latestRun?.errorCode ?? null,
      latestActionSummary: typeof latestRun?.result?.summary === 'string' ? latestRun.result.summary.slice(0, 240) : null,
      connectedIntegrations: pagePlatforms.map((platform) => ({
        name: platform.name,
        category: platform.category,
        status: platform.connectionStatus,
      })).slice(0, 6),
      latestSyncSources: pagePlatforms.map((platform) => `${platform.name}:${platform.connectionStatus}`).slice(0, 6),
      errorClasses,
      approvalGates: page.approvalGates,
      executionProfile: {
        analystToolName: profile.analystToolName,
        executorToolName: profile.executorToolName,
        actionResourceType: profile.actionResourceType,
        resourceTypes: profile.resourceTypes,
        telemetryTags: profile.telemetryTags,
      },
    };
  });
  const activeItems = items.filter((item) => item.lastRunStatus !== 'never_run');
  const completedCount = activeItems.filter((item) => item.lastRunStatus === 'completed').length;
  return {
    summary: {
      totalPages: items.length,
      activePages: activeItems.length,
      healthyPages: completedCount,
      pagesNeedingAttention: activeItems.filter((item) => item.lastRunStatus !== 'completed').length,
      connectedPlatformCount: platforms.filter((platform) => ['connected', 'active', 'syncing', 'pending'].includes(platform.connectionStatus)).length,
    },
    items,
  };
}
export async function getRunDetails(workspaceId: string, runId: string) {
  const run = await repo.getRun(workspaceId, runId);
  if (!run) throw notFoundError('Agent run not found');
  const [steps, events] = await Promise.all([repo.listSteps(workspaceId, runId), repo.listEvents(workspaceId, runId)]);
  return { run, steps, events };
}
export async function cancelRun(workspaceId: string, runId: string, userId: string) {
  const run = await repo.getRun(workspaceId, runId);
  if (!run) throw notFoundError('Agent run not found');
  if (['completed', 'failed', 'cancelled'].includes(run.status)) throw conflictError('This agent run is already finished');
  await repo.finalizeRun({
    runId,
    workspaceId,
    status: 'cancelled',
    patch: { finished_at: new Date(), error_code: 'AGENT_RUN_CANCELLED', error_message: 'Cancelled by workspace user' },
    eventPayload: { code: 'AGENT_RUN_CANCELLED', message: 'Cancelled by workspace user' },
    actorId: userId,
  });
  return repo.getRun(workspaceId, runId);
}
export { automaticPageProfiles, buildPageAgentGoal };
