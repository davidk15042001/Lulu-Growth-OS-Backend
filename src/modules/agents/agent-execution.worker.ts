import { logger } from '../../config/logger.js';
import type { ResourceType } from '../../domain/resource-catalog.js';
import * as recordRepo from '../records/record.repo.js';
import { createAiDraft, createDraft } from '../email/email.service.js';
import { updateGoogleReviewReply } from '../workspace-app/workspace-app.service.js';
import { publishWebsiteJob } from '../websites/website.publish.service.js';
import { generateProductImagesFromText } from '../product-images/product-image.service.js';
import {
  normalizeAgentExecutionCommands,
  type AgentExecutionCommand,
} from './agent.execution-command.js';

const intervalMs = 30 * 1000;
const batchSize = 20;
const maxExecutionAttempts = 3;
let timer: NodeJS.Timeout | undefined;
let running = false;

function textValue(value: unknown, maxLength = 400) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function executionSummary(record: recordRepo.WorkspaceRecord) {
  const data = record.data ?? {};
  const targetSystem = textValue(data.targetSystem) || 'ai';
  const pageLabel = textValue(data.pageLabel) || record.name;
  const jobs = stringList(data.jobs).slice(0, 4);
  const gates = stringList(data.approvalGates).slice(0, 4);
  const fragments = [
    `Execution packet processed for ${pageLabel}.`,
    `Target system: ${targetSystem}.`,
    jobs.length > 0 ? `Jobs: ${jobs.join(', ')}.` : 'Jobs: no explicit jobs attached.',
    gates.length > 0 ? `Approval gates respected: ${gates.join(', ')}.` : 'Approval gates: none attached.',
  ];
  return fragments.join(' ');
}

function objectValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function emailAddresses(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const next = objectValue(item);
    const address = textValue(next.address).toLowerCase();
    if (!address) return [];
    const name = textValue(next.name) || null;
    return [{ address, ...(name ? { name } : {}) }];
  });
}

function numberValue(value: unknown, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function isoAfterMinutes(minutes: number) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function resolveDomainArtifactType(targetSystem: string): ResourceType | null {
  if (targetSystem === 'crm') return 'crm_tasks';
  if (targetSystem === 'sales') return 'sales_tasks';
  if (targetSystem === 'marketing') return 'marketing_content';
  if (targetSystem === 'advertising') return 'ad_optimizations';
  if (targetSystem === 'finance') return 'finance_automations';
  if (targetSystem === 'ecommerce') return 'ai_tasks';
  if (targetSystem === 'website') return 'marketing_publications';
  if (targetSystem === 'communication') return 'ai_tasks';
  if (targetSystem === 'reputation') return 'ai_tasks';
  return 'ai_tasks';
}

function resolveCommandResultResourceType(command: AgentExecutionCommand): ResourceType {
  if (command.type === 'crm.create_followup_task') return 'crm_tasks';
  if (command.type === 'sales.create_followup_task') return 'sales_tasks';
  if (command.type === 'advertising.create_optimization') return 'ad_optimizations';
  if (command.type === 'finance.create_automation') return 'finance_automations';
  if (command.type === 'website.publish_job') return 'marketing_publications';
  if (command.type === 'ecommerce.generate_product_images') return 'ecommerce_products';
  return 'activities';
}

async function createExecutionArtifacts(record: recordRepo.WorkspaceRecord) {
  const data = record.data ?? {};
  const targetSystem = textValue(data.targetSystem) || 'ai';
  const targetModule = textValue(data.targetModule) || 'general';
  const pageLabel = textValue(data.pageLabel) || record.name;
  const summary = executionSummary(record);
  const existingArtifacts = await recordRepo.listExecutionArtifactsBySourceRecordId(record.workspaceId, record.id);
  const existingActivity = existingArtifacts.find((entry) => entry.resourceType === 'activities') ?? null;
  const artifactType = resolveDomainArtifactType(targetSystem);
  const existingArtifact = artifactType
    ? existingArtifacts.find((entry) => entry.resourceType === artifactType) ?? null
    : null;
  const baseData = {
    sourceActionRecordId: record.id,
    sourceActionResourceType: record.resourceType,
    sourcePageId: textValue(data.pageId) || null,
    sourcePageLabel: pageLabel,
    targetSystem,
    targetModule,
    executionMode: textValue(data.executionMode) || 'analysis_only',
    policyDecision: textValue(data.policyDecision) || 'allow',
    commandTypes: stringList(data.commandTypes),
    jobs: stringList(data.jobs),
    approvalGates: stringList(data.approvalGates),
    executionSummary: summary,
    generatedByExecutor: true,
    generatedAt: new Date().toISOString(),
  };

  const activity = existingActivity ?? await recordRepo.createRecord(record.workspaceId, 'activities', record.createdBy, {
    name: `${pageLabel} execution activity`,
    description: summary,
    status: 'completed',
    stage: 'executed',
    source: 'agent_executor',
    tags: ['agent-executor', targetSystem, targetModule].filter(Boolean),
    data: baseData,
  });

  if (!artifactType) {
    return { activity, artifact: null };
  }

  const artifact = existingArtifact ?? await recordRepo.createRecord(record.workspaceId, artifactType, record.createdBy, {
    name: `${pageLabel} execution result`,
    description: textValue(record.description) || summary,
    status: 'active',
    stage: 'prepared_by_agent',
    source: 'agent_executor',
    tags: ['agent-generated', targetSystem, targetModule, pageLabel.toLowerCase().replace(/\s+/g, '-')].slice(0, 12),
    data: baseData,
  });
  return { activity, artifact };
}

async function persistCommandExecutionResult(
  record: recordRepo.WorkspaceRecord,
  command: AgentExecutionCommand,
  result: Record<string, unknown>,
) {
  const existing = await recordRepo.findExecutionResultByCommandIdempotencyKey(record.workspaceId, command.idempotencyKey);
  if (existing) return existing;
  const resourceType = resolveCommandResultResourceType(command);
  return recordRepo.createRecord(record.workspaceId, resourceType, record.createdBy, {
    parentId: record.id,
    name: `${command.type} result`,
    description: command.summary,
    status: 'completed',
    stage: 'executed',
    source: 'agent_executor_command',
    tags: ['agent-executor-command', command.targetSystem, command.type].slice(0, 12),
    externalId: command.idempotencyKey,
    data: {
      sourceActionRecordId: record.id,
      commandIdempotencyKey: command.idempotencyKey,
      commandType: command.type,
      commandTargetSystem: command.targetSystem,
      commandProvider: command.provider,
      commandPayload: command.payload,
      commandResult: result,
      executedAt: new Date().toISOString(),
    },
  });
}

async function executeAgentCommand(record: recordRepo.WorkspaceRecord, command: AgentExecutionCommand) {
  const existing = await recordRepo.findExecutionResultByCommandIdempotencyKey(record.workspaceId, command.idempotencyKey);
  if (existing) {
    return {
      type: command.type,
      targetEntityId: command.targetEntityId,
      provider: command.provider,
      reused: true,
      resultRecordId: existing.id,
      result: existing.data?.commandResult ?? { status: 'reused' },
    };
  }
  const payload = objectValue(command.payload);
  const actorUserId = record.createdBy ?? 'system';

  if (command.type === 'google_reviews.reply') {
    const reviewId = textValue(payload.reviewId || command.targetEntityId);
    const accountId = textValue(payload.accountId);
    const locationId = textValue(payload.locationId);
    const comment = textValue(payload.comment, 4000);
    if (!reviewId || !accountId || !locationId || !comment) {
      throw new Error('google_reviews.reply requires reviewId, accountId, locationId, and comment');
    }
    const reviewResult = await updateGoogleReviewReply(record.workspaceId, reviewId, { accountId, locationId, comment });
    const commandResult = {
      reviewId,
      locationId,
      status: 'updated',
    };
    const stored = await persistCommandExecutionResult(record, command, commandResult);
    return {
      type: command.type,
      targetEntityId: reviewId,
      provider: command.provider,
      resultRecordId: stored.id,
      result: reviewResult,
    };
  }

  if (command.type === 'crm.create_followup_task' || command.type === 'sales.create_followup_task') {
    const resourceType = command.type === 'crm.create_followup_task' ? 'crm_tasks' : 'sales_tasks';
    const item = await persistCommandExecutionResult(record, command, {
      taskTitle: textValue(payload.title || command.summary, 240),
      taskDescription: textValue(payload.description || command.summary, 4000),
      jobs: Array.isArray(payload.jobs) ? payload.jobs : [],
      status: 'created',
    });
    return {
      type: command.type,
      targetEntityId: item.id,
      provider: command.provider,
      resultRecordId: item.id,
      result: { status: 'created', resourceType },
    };
  }

  if (command.type === 'advertising.create_optimization' || command.type === 'finance.create_automation') {
    const resourceType = command.type === 'advertising.create_optimization' ? 'ad_optimizations' : 'finance_automations';
    const item = await persistCommandExecutionResult(record, command, {
      title: textValue(payload.title || command.summary, 240),
      description: textValue(payload.description || command.summary, 4000),
      jobs: Array.isArray(payload.jobs) ? payload.jobs : [],
      status: 'created',
    });
    return {
      type: command.type,
      targetEntityId: item.id,
      provider: command.provider,
      resultRecordId: item.id,
      result: { status: 'created', resourceType },
    };
  }

  if (command.type === 'email.create_draft') {
    const accountId = textValue(payload.accountId);
    if (!accountId) throw new Error('email.create_draft requires accountId');
    const draft = await createDraft(record.workspaceId, actorUserId, {
      accountId,
      threadId: textValue(payload.threadId) || null,
      to: emailAddresses(payload.to),
      cc: emailAddresses(payload.cc),
      subject: textValue(payload.subject, 998),
      bodyText: textValue(payload.bodyText, 100_000),
      replyToProviderMessageId: textValue(payload.replyToProviderMessageId, 1000) || null,
    });
    const stored = await persistCommandExecutionResult(record, command, {
      draftId: draft.id,
      threadId: draft.threadId,
      status: draft.status,
      source: draft.source,
    });
    return {
      type: command.type,
      targetEntityId: draft.id,
      provider: command.provider,
      resultRecordId: stored.id,
      result: { draftId: draft.id, threadId: draft.threadId, status: draft.status, source: draft.source },
    };
  }

  if (command.type === 'email.create_ai_draft') {
    const accountId = textValue(payload.accountId);
    const threadId = textValue(payload.threadId || command.targetEntityId);
    if (!accountId || !threadId) throw new Error('email.create_ai_draft requires accountId and threadId');
    const draft = await createAiDraft(
      record.workspaceId,
      actorUserId,
      threadId,
      {
        accountId,
        instruction: textValue(payload.instruction, 2000) || undefined,
        tone: textValue(payload.tone, 40) || 'professional',
        language: textValue(payload.language, 16) || 'en',
      },
      'automation',
      { sourceActionRecordId: record.id, generatedBy: 'agent_executor' },
    );
    const stored = await persistCommandExecutionResult(record, command, {
      draftId: draft.id,
      threadId: draft.threadId,
      status: draft.status,
      source: draft.source,
    });
    return {
      type: command.type,
      targetEntityId: draft.id,
      provider: command.provider,
      resultRecordId: stored.id,
      result: { draftId: draft.id, threadId: draft.threadId, status: draft.status, source: draft.source },
    };
  }

  if (command.type === 'website.publish_job') {
    const siteId = textValue(payload.siteId);
    const jobId = textValue(payload.jobId || command.targetEntityId);
    if (!siteId || !jobId) throw new Error('website.publish_job requires siteId and jobId');
    const result = await publishWebsiteJob(record.workspaceId, siteId, jobId);
    const stored = await persistCommandExecutionResult(record, command, {
      siteId,
      jobId,
      status: 'published',
    });
    return {
      type: command.type,
      targetEntityId: jobId,
      provider: command.provider,
      resultRecordId: stored.id,
      result,
    };
  }

  if (command.type === 'ecommerce.generate_product_images') {
    const sourceText = textValue(payload.sourceText, 20_000);
    if (!sourceText) throw new Error('ecommerce.generate_product_images requires sourceText');
    const result = await generateProductImagesFromText(sourceText, record.workspaceId, actorUserId);
    const stored = await persistCommandExecutionResult(record, command, {
      count: result.count,
      sync: result.sync,
      productRecordIds: result.records.map((item) => item.id),
    });
    return {
      type: command.type,
      targetEntityId: null,
      provider: command.provider,
      resultRecordId: stored.id,
      result: { count: result.count, sync: result.sync },
    };
  }

  const stored = await persistCommandExecutionResult(record, command, { status: 'record_only', summary: command.summary });
  return {
    type: command.type,
    targetEntityId: command.targetEntityId,
    provider: command.provider,
    resultRecordId: stored.id,
    result: { status: 'record_only', summary: command.summary },
  };
}

async function executeRecord(record: recordRepo.WorkspaceRecord) {
  const data = record.data ?? {};
  const commands = normalizeAgentExecutionCommands(data.commands, {
    module: textValue(data.targetModule) || textValue(data.module) || 'general',
    targetSystem: textValue(data.targetSystem) || 'ai',
    actionResourceType: record.resourceType,
    pageId: textValue(data.pageId) || null,
    pageLabel: textValue(data.pageLabel) || record.name,
    goal: textValue(data.goal, 400) || record.name,
    jobs: stringList(data.jobs),
    policyDecision: textValue(data.policyDecision) === 'allow' ? 'allow' : 'require_approval',
    executionMode: textValue(data.executionMode) === 'autonomous' ? 'autonomous' : 'analysis_only',
    accountId: textValue(data.accountId) || null,
    threadId: textValue(data.threadId) || null,
    tone: textValue(data.tone) || null,
    language: textValue(data.language) || null,
    instruction: textValue(data.instruction, 2000) || null,
    to: data.to,
    cc: data.cc,
    subject: textValue(data.subject, 998) || null,
    bodyText: textValue(data.bodyText, 100_000) || null,
    replyToProviderMessageId: textValue(data.replyToProviderMessageId, 1000) || null,
    reviewId: textValue(data.reviewId) || null,
    locationId: textValue(data.locationId) || null,
    comment: textValue(data.comment, 4000) || null,
    siteId: textValue(data.siteId) || null,
    jobId: textValue(data.jobId) || null,
    provider: textValue(data.provider) || null,
    sourceText: textValue(data.sourceText, 20_000) || null,
  });
  const commandResults: Array<{ type: string; resultRecordId: string }> = [];
  for (const command of commands) {
    commandResults.push(await executeAgentCommand(record, command));
  }
  const artifacts = await createExecutionArtifacts(record);
  const commandResultEntries: Array<{ id: string; resourceType: ResourceType }> = commands.flatMap((command, index) => {
    const resultId = commandResults[index]?.resultRecordId;
    return typeof resultId === 'string'
      ? [{ id: resultId, resourceType: resolveCommandResultResourceType(command) }]
      : [];
  });

  const resultRecords: Array<{ id: string; resourceType: ResourceType }> = [
    { id: artifacts.activity.id, resourceType: artifacts.activity.resourceType },
    ...(artifacts.artifact ? [{ id: artifacts.artifact.id, resourceType: artifacts.artifact.resourceType }] : []),
    ...commandResultEntries,
  ];

  const nextData = {
    ...data,
    commands,
    commandTypes: [...new Set(commands.map((command) => command.type))],
    executionStatus: 'executed',
    sideEffectsApplied: commandResults.some((item) => item.type !== 'record.create_artifact'),
    executionCompletedAt: new Date().toISOString(),
    executorVersion: '1.0.0',
    executionSummary: executionSummary(record),
    executionResults: commandResults,
    resultRecords,
    resultRecordIds: resultRecords.map((entry) => entry.id),
    resultResourceTypes: resultRecords.map((entry) => entry.resourceType),
    executionNextAttemptAt: null,
    executionError: null,
  };
  const update = await recordRepo.updateRecord(record.workspaceId, record.resourceType, record.id, record.createdBy, {
    status: 'completed',
    stage: 'executed',
    data: nextData,
    description: textValue(record.description) || textValue(data.goal) || `Executed action packet for ${textValue(data.pageLabel) || record.name}.`,
    expectedVersion: record.version,
  });
  if (update.status !== 'updated') {
    throw new Error(`Executor could not finalize record ${record.id}: ${update.status}`);
  }
}

function classifyExecutionError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown execution failure';
  const normalized = message.toLowerCase();
  if (
    normalized.includes('requires') ||
    normalized.includes('not found') ||
    normalized.includes('approval') ||
    normalized.includes('forbidden') ||
    normalized.includes('invalid')
  ) {
    return { retryable: false, errorClass: 'validation', message };
  }
  return { retryable: true, errorClass: 'transient', message };
}

async function failRecord(record: recordRepo.WorkspaceRecord, error: unknown) {
  const failure = classifyExecutionError(error);
  const attempts = Math.max(1, numberValue(record.data?.executionAttempts, 1));
  const canRetry = failure.retryable && attempts < maxExecutionAttempts;
  const nextRetryAt = canRetry ? isoAfterMinutes(Math.max(1, attempts * 2)) : null;
  const update = await recordRepo.updateRecord(record.workspaceId, record.resourceType, record.id, record.createdBy, {
    status: canRetry ? 'approved' : 'failed',
    stage: canRetry ? 'queued_for_execution' : 'execution_failed',
    data: {
      ...(record.data ?? {}),
      executionStatus: canRetry ? 'queued_retry' : 'failed',
      executionFailedAt: new Date().toISOString(),
      executionError: failure.message,
      executionErrorClass: failure.errorClass,
      executionRetryable: canRetry,
      executionNextAttemptAt: nextRetryAt,
    },
    expectedVersion: record.version,
  });
  if (update.status !== 'updated') {
    logger.warn({ workspaceId: record.workspaceId, recordId: record.id, updateStatus: update.status }, 'Agent execution record could not be marked as failed');
  }
}

export async function runAgentExecutionCycle() {
  if (running) return;
  running = true;
  try {
    const claimed = await recordRepo.claimExecutionReadyRecords(batchSize);
    for (const record of claimed) {
      try {
        await executeRecord(record);
      } catch (error) {
        await failRecord(record, error);
        logger.error({ error, workspaceId: record.workspaceId, recordId: record.id }, 'Agent execution record failed');
      }
    }
  } catch (error) {
    logger.error({ error }, 'Agent execution worker cycle failed');
  } finally {
    running = false;
  }
}

export function startAgentExecutionWorker() {
  if (timer) return;
  timer = setInterval(() => void runAgentExecutionCycle(), intervalMs);
  timer.unref();
  void runAgentExecutionCycle();
  logger.info({ intervalMs, batchSize }, 'Agent execution worker started');
}

export function stopAgentExecutionWorker() {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}
