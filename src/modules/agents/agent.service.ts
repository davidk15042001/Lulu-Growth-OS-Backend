import { AppError, conflictError, notFoundError } from '../../utils/app-error.js';
import { createApproval, decideApproval } from '../approvals/approval.repo.js';
import { env } from '../../config/env.js';
import { getOpenAIResponsesClient, isAiGenerationConfigured } from '../ai/openai.service.js';
import * as repo from './agent.repo.js';
import type { AgentRole, AgentTool } from './agent.types.js';
import type { DecideApprovalInput } from '../approvals/approval.validator.js';
import { getAgentCapabilities, type AgentModule, isAgentModule } from './agent.capabilities.js';

const tools = new Map<string, AgentTool>();
const activeRuns = new Set<string>();
const MAX_RUN_DURATION_MS = 10 * 60 * 1000;
const TOOL_TIMEOUT_MS = 60 * 1000;

tools.set('workspace_snapshot', {
  name: 'workspace_snapshot', version: '1.0.0', risk: 'read',
  description: 'Reads the current workspace context for analysis.',
  execute: async ({ workspaceId }) => ({ workspaceId, source: 'workspace_context', capturedAt: new Date().toISOString() }),
});

const pipeline: Array<{ role: AgentRole; title: string; instruction: string; toolName?: string }> = [
  { role: 'planner', title: 'Understand the objective', instruction: 'Clarify the goal, constraints, expected outcome and required approvals.' },
  { role: 'analyst', title: 'Collect workspace signals', instruction: 'Inspect available live workspace records and identify relevant evidence.', toolName: 'workspace_snapshot' },
  { role: 'strategist', title: 'Propose coordinated actions', instruction: 'Convert evidence into prioritized recommendations with risks and dependencies.' },
  { role: 'reviewer', title: 'Review the proposed outcome', instruction: 'Check evidence, uncertainty, permissions, safety and whether an action needs approval.' },
];

async function event(input: Parameters<typeof repo.addEvent>[0]) { return repo.addEvent(input); }
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string) {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new AppError(504, code, 'The agent operation exceeded its time limit')), timeoutMs))]);
}
async function assertNotCancelled(workspaceId: string, runId: string) {
  const run = await repo.getRun(workspaceId, runId).catch(() => undefined);
  if (run?.status === 'cancelled') throw new AppError(409, 'AGENT_RUN_CANCELLED', 'The agent run was cancelled');
}
async function planRun(runId: string, workspaceId: string, goal: string, executionMode: 'analysis_only' | 'autonomous', module: AgentModule, capabilities: ReturnType<typeof getAgentCapabilities>) {
  await repo.updateRun(runId, { status: 'planning', started_at: new Date() });
  await event({ runId, workspaceId, eventType: 'run.planning_started', agentRole: 'planner', payload: { goal } });
  const selectedPipeline = pipeline.filter((step) => step.role !== 'strategist' || capabilities.recommend);
  const steps = await repo.createSteps(selectedPipeline.map((step, index) => ({ runId, workspaceId, sequenceNo: index + 1, agentRole: step.role, title: step.title, instruction: `${step.instruction} Module: ${module}. Capabilities: ${JSON.stringify(capabilities)} User goal: ${goal}`, toolName: step.toolName ?? null })));
  await repo.updateRun(runId, { status: 'running', plan: { version: 1, module, capabilities, executionMode, agents: selectedPipeline.map((item) => item.role), steps: steps.map((item) => ({ id: item.id, role: item.agentRole, title: item.title })) } });
  await event({ runId, workspaceId, eventType: 'run.planned', agentRole: 'planner', payload: { stepCount: steps.length } });
  return steps;
}
async function executeStep(runId: string, workspaceId: string, userId: string, step: Awaited<ReturnType<typeof repo.listSteps>>[number], autonomous: boolean) {
  await repo.updateStep(step.id, { status: 'running', started_at: new Date() });
  await event({ runId, stepId: step.id, workspaceId, eventType: 'step.started', agentRole: step.agentRole, payload: { title: step.title } });
  const tool = step.toolName ? tools.get(step.toolName) : undefined;
  if (step.toolName && !tool) throw new AppError(500, 'AGENT_TOOL_NOT_REGISTERED', `Tool ${step.toolName} is not registered`);
  if (tool && tool.risk !== 'read' && !autonomous) {
    const approval = await createApproval(workspaceId, userId, { actionType: `agent_tool:${tool.name}`, title: `Approve ${tool.name}`, description: step.instruction, payload: { runId, stepId: step.id, toolName: tool.name, toolInput: step.toolInput ?? {} } });
    if (!approval) throw new AppError(500, 'AGENT_APPROVAL_CREATION_FAILED', 'The approval request could not be created');
    await repo.updateStep(step.id, { status: 'waiting_approval', approval_id: approval.id });
    await repo.updateRun(runId, { status: 'waiting_approval' });
    await event({ runId, stepId: step.id, workspaceId, eventType: 'step.waiting_approval', agentRole: 'executor', payload: { approvalId: approval.id, toolName: tool.name } });
    return { waiting: true, output: undefined };
  }
  const toolOutput = tool ? await withTimeout(tool.execute(step.toolInput ?? {}, { workspaceId, userId }), TOOL_TIMEOUT_MS, 'AGENT_TOOL_TIMEOUT') : { acknowledged: true, role: step.agentRole, instruction: step.instruction };
  await repo.updateStep(step.id, { status: 'completed', tool_output: toolOutput, result: toolOutput, finished_at: new Date() });
  await event({ runId, stepId: step.id, workspaceId, eventType: 'step.completed', agentRole: step.agentRole, payload: toolOutput });
  return { waiting: false, output: toolOutput };
}
async function executeRun(runId: string, workspaceId: string, userId: string, goal: string, executionMode: 'analysis_only' | 'autonomous', module: AgentModule, capabilities: ReturnType<typeof getAgentCapabilities>, initial = false) {
  if (activeRuns.has(runId)) return;
  activeRuns.add(runId);
  const deadline = Date.now() + MAX_RUN_DURATION_MS;
  try {
    let steps = await repo.listSteps(workspaceId, runId);
    if (initial && steps.length === 0) steps = await planRun(runId, workspaceId, goal, executionMode, module, capabilities);
    const outputs: Record<string, unknown>[] = [];
    for (const step of steps) {
      if (Date.now() > deadline) throw new AppError(504, 'AGENT_RUN_TIMEOUT', 'The agent run exceeded its time limit');
      await assertNotCancelled(workspaceId, runId);
      if (step.status === 'completed' || step.status === 'skipped') {
        if (step.result) outputs.push({ stepId: step.id, output: step.result });
        continue;
      }
      if (step.status === 'waiting_approval') return;
      const result = await executeStep(runId, workspaceId, userId, step, executionMode === 'autonomous');
      if (result.waiting) return;
      outputs.push({ stepId: step.id, output: result.output });
    }
    let finalResult: Record<string, unknown> = { goal, outputs, completedBy: pipeline.map((item) => item.role) };
    if (isAiGenerationConfigured()) {
      const response = await withTimeout(getOpenAIResponsesClient().create({ model: env.AI_PROVIDER === 'alibaba' ? env.DASHSCOPE_MODEL : env.AI_PROVIDER === 'deepseek' ? env.DEEPSEEK_MODEL : env.OPENAI_MODEL, instructions: 'Synthesize the coordinated agent outputs into a concise business result. Return plain text.', input: [{ role: 'user', content: JSON.stringify(finalResult) }], store: false }, { billing: { workspaceId, userId: userId === 'system' ? null : userId } }), TOOL_TIMEOUT_MS, 'AGENT_SYNTHESIS_TIMEOUT');
      finalResult = { ...finalResult, summary: response.output_text?.trim() ?? null };
    }
    await repo.updateRun(runId, { status: 'completed', result: finalResult, finished_at: new Date() });
    await event({ runId, workspaceId, eventType: 'run.completed', agentRole: 'reviewer', payload: finalResult });
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError(500, 'AGENT_RUN_FAILED', error instanceof Error ? error.message : 'Agent run failed');
    await repo.updateRun(runId, { status: appError.code === 'AGENT_RUN_CANCELLED' ? 'cancelled' : 'failed', error_code: appError.code, error_message: appError.message, finished_at: new Date() });
    await event({ runId, workspaceId, eventType: 'run.failed', payload: { code: appError.code, message: appError.message } });
  } finally { activeRuns.delete(runId); }
}
export async function startRun(workspaceId: string, userId: string, goal: string, module: AgentModule = 'general') {
  const subscription = await repo.getWorkspacePlan(workspaceId);
  if (subscription.status !== 'active' && subscription.status !== 'trialing') throw new AppError(403, 'AGENT_PLAN_INACTIVE', 'An active workspace subscription is required for agent analysis');
  const capabilities = getAgentCapabilities(subscription.plan_key, isAgentModule(module) ? module : 'general');
  if (!capabilities.analyze) throw new AppError(403, 'AGENT_EXPLORER_READ_ONLY', 'Explorer is read-only and does not run AI analysis. Choose Starter or AI.');
  const executionMode = capabilities.autonomous ? 'autonomous' : 'analysis_only';
  const run = await repo.createRun(workspaceId, userId, goal);
  if (!run) throw new AppError(500, 'AGENT_RUN_CREATION_FAILED', 'The agent run could not be created');
  void executeRun(run.id, workspaceId, userId, goal, executionMode, isAgentModule(module) ? module : 'general', capabilities, true);
  return run;
}
export async function startAutomaticRun(workspaceId: string, goal: string, module: AgentModule) {
  const subscription = await repo.getWorkspacePlan(workspaceId);
  const capabilities = getAgentCapabilities(subscription.plan_key, module);
  if ((subscription.status !== 'active' && subscription.status !== 'trialing') || !capabilities.automatic || !capabilities.analyze) return null;
  const run = await repo.createRun(workspaceId, null, goal);
  if (!run) throw new AppError(500, 'AGENT_AUTOMATIC_RUN_CREATION_FAILED', 'The automatic analysis run could not be created');
  void executeRun(run.id, workspaceId, 'system', goal, capabilities.autonomous ? 'autonomous' : 'analysis_only', module, capabilities, true);
  return run;
}
export async function listRuns(workspaceId: string) { return repo.listRuns(workspaceId); }
export async function getKnowledgeBundle(workspaceId: string) {
  return repo.getKnowledgeBundle(workspaceId);
}
export async function getRunDetails(workspaceId: string, runId: string) {
  const run = await repo.getRun(workspaceId, runId);
  if (!run) throw notFoundError('Agent run not found');
  const [steps, events] = await Promise.all([repo.listSteps(workspaceId, runId), repo.listEvents(workspaceId, runId)]);
  return { run, steps, events };
}
export async function cancelRun(workspaceId: string, runId: string) {
  const run = await repo.getRun(workspaceId, runId);
  if (!run) throw notFoundError('Agent run not found');
  if (['completed', 'failed', 'cancelled'].includes(run.status)) throw conflictError('This agent run is already finished');
  await repo.updateRun(runId, { status: 'cancelled', finished_at: new Date(), error_code: 'AGENT_RUN_CANCELLED', error_message: 'Cancelled by workspace user' });
  await event({ runId, workspaceId, eventType: 'run.cancelled', payload: {} });
  return repo.getRun(workspaceId, runId);
}
export async function approveStep(workspaceId: string, runId: string, stepId: string, userId: string, decision: DecideApprovalInput) {
  const step = await repo.getStep(workspaceId, runId, stepId);
  if (!step) throw notFoundError('Agent step not found');
  if (!step.approvalId) throw conflictError('This agent step has no pending approval');
  const approvalStatus = await repo.getApprovalStatus(workspaceId, step.approvalId);
  if (approvalStatus !== 'pending') throw conflictError(`Approval is already ${approvalStatus ?? 'unavailable'}`);
  const approval = await decideApproval(workspaceId, step.approvalId, userId, true, decision);
  if (!approval) throw conflictError('The approval could not be decided');
  if (decision.decision !== 'approved') {
    await repo.updateStep(stepId, { status: 'failed', error_code: 'AGENT_ACTION_REJECTED', error_message: decision.note ?? 'The action was rejected', finished_at: new Date() });
    await repo.updateRun(runId, { status: 'failed', error_code: 'AGENT_ACTION_REJECTED', error_message: decision.note ?? 'The action was rejected', finished_at: new Date() });
    await event({ runId, stepId, workspaceId, eventType: 'step.rejected', agentRole: 'executor', payload: { decision: decision.decision, note: decision.note ?? null } });
    return getRunDetails(workspaceId, runId);
  }
  await repo.updateStep(stepId, { status: 'pending', approval_id: null });
  await repo.updateRun(runId, { status: 'running', error_code: null, error_message: null });
  await event({ runId, stepId, workspaceId, eventType: 'step.approved', agentRole: 'executor', payload: {} });
  const run = await repo.getRun(workspaceId, runId);
  const subscription = await repo.getWorkspacePlan(workspaceId);
  const module = isAgentModule(run?.plan?.module) ? run.plan.module : 'general';
  const capabilities = getAgentCapabilities(subscription.plan_key, module);
  void executeRun(runId, workspaceId, userId, run?.goal ?? 'approved agent run', capabilities.autonomous ? 'autonomous' : 'analysis_only', module, capabilities);
  return getRunDetails(workspaceId, runId);
}
