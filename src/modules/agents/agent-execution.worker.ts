import { logger } from '../../config/logger.js';
import type { ResourceType } from '../../domain/resource-catalog.js';
import * as recordRepo from '../records/record.repo.js';

const intervalMs = 30 * 1000;
const batchSize = 20;
let timer: NodeJS.Timeout | undefined;
let running = false;

function textValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
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

async function executeRecord(record: recordRepo.WorkspaceRecord) {
  const data = record.data ?? {};
  const artifacts = await createExecutionArtifacts(record);
  const nextData = {
    ...data,
    executionStatus: 'executed',
    sideEffectsApplied: true,
    executionCompletedAt: new Date().toISOString(),
    executorVersion: '1.0.0',
    executionSummary: executionSummary(record),
    resultRecordIds: [artifacts.activity.id, artifacts.artifact?.id].filter(Boolean),
    resultResourceTypes: [artifacts.activity.resourceType, artifacts.artifact?.resourceType].filter(Boolean),
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

async function failRecord(record: recordRepo.WorkspaceRecord, error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown execution failure';
  const update = await recordRepo.updateRecord(record.workspaceId, record.resourceType, record.id, record.createdBy, {
    status: 'failed',
    stage: 'execution_failed',
    data: {
      ...(record.data ?? {}),
      executionStatus: 'failed',
      executionFailedAt: new Date().toISOString(),
      executionError: message,
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
