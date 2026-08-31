import { logger } from '../../config/logger.js';
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

async function executeRecord(record: recordRepo.WorkspaceRecord) {
  const data = record.data ?? {};
  const nextData = {
    ...data,
    executionStatus: 'executed',
    sideEffectsApplied: false,
    executionCompletedAt: new Date().toISOString(),
    executorVersion: '1.0.0',
    executionSummary: executionSummary(record),
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
