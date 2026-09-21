import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { createRuntimeWorkerMonitor } from '../../operations/worker-liveness.js';
import { AppError } from '../../utils/app-error.js';
import * as repo from './onboarding.repo.js';
import { processCatalogImport } from './onboarding.service.js';

const workerId = `catalog-import-${process.pid}-${randomUUID()}`;
const runtimeMonitor = createRuntimeWorkerMonitor('catalog-import', {
  required: true,
  staleAfterMs: Math.max(60_000, env.CATALOG_IMPORT_WORKER_INTERVAL_MS * 4),
});

let interval: NodeJS.Timeout | undefined;
let activeCycle: Promise<void> | null = null;
let stopping = false;

function classifyFailure(error: unknown) {
  const code = error instanceof AppError ? error.code : 'CATALOG_IMPORT_UNEXPECTED';
  const message = error instanceof Error ? error.message : 'Catalog import failed unexpectedly.';
  const status = error instanceof AppError ? error.status : null;
  return { code, message, retryable: !status || status >= 500 || status === 429 };
}

async function executeCatalogImport(job: repo.CatalogImportJob) {
  const heartbeat = setInterval(() => {
    void repo.heartbeatCatalogImportJob(job.id, workerId).catch((error: unknown) => {
      logger.warn({ error, jobId: job.id }, 'Catalog import heartbeat failed');
    });
  }, Math.max(5_000, Math.floor(env.CATALOG_IMPORT_JOB_LEASE_SECONDS * 1_000 / 3)));
  heartbeat.unref();
  try {
    const result = await processCatalogImport(job);
    await repo.finishCatalogImportJob({ job, workerId });
    if (!result.skipped) {
      await appendDomainEvent({
        workspaceId: job.workspaceId,
        type: DOMAIN_EVENT_TYPES.CATALOG_IMPORT_REVIEW_REQUIRED,
        aggregateType: 'workspace_knowledge_activation',
        aggregateId: job.activationId,
        payload: result,
        metadata: { source: 'onboarding.catalog-import.worker' },
        idempotencyKey: `catalog-import:${job.activationId}:review-required`,
      });
    }
  } catch (error) {
    const failure = classifyFailure(error);
    await repo.finishCatalogImportJob({ job, workerId, error: failure });
    if (!failure.retryable || job.attempts >= job.maxAttempts) {
      await appendDomainEvent({
        workspaceId: job.workspaceId,
        type: DOMAIN_EVENT_TYPES.CATALOG_IMPORT_FAILED,
        aggregateType: 'workspace_knowledge_activation',
        aggregateId: job.activationId,
        payload: { code: failure.code },
        metadata: { source: 'onboarding.catalog-import.worker' },
        idempotencyKey: `catalog-import:${job.activationId}:failed:${job.attempts}`,
      });
    }
    logger.error({ error, jobId: job.id, activationId: job.activationId, attempts: job.attempts }, 'Catalog import failed');
  } finally {
    clearInterval(heartbeat);
  }
}

async function drainCatalogImports() {
  let processed = 0;
  while (!stopping) {
    const job = await repo.claimNextCatalogImportJob(workerId, env.CATALOG_IMPORT_JOB_LEASE_SECONDS);
    if (!job) break;
    await executeCatalogImport(job);
    processed += 1;
  }
  runtimeMonitor.progress({ phase: processed ? 'processed' : 'idle', processed });
}

export function runCatalogImportCycle(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (activeCycle) return activeCycle;
  activeCycle = drainCatalogImports()
    .catch((error: unknown) => { runtimeMonitor.failed(error); logger.error({ error }, 'Catalog import worker cycle failed'); })
    .finally(() => { activeCycle = null; });
  return activeCycle;
}

export function startCatalogImportWorker() {
  if (interval) return;
  stopping = false;
  runtimeMonitor.start({ workerId });
  interval = setInterval(() => void runCatalogImportCycle(), env.CATALOG_IMPORT_WORKER_INTERVAL_MS);
  interval.unref();
  void runCatalogImportCycle();
  logger.info({ intervalMs: env.CATALOG_IMPORT_WORKER_INTERVAL_MS }, 'Catalog import worker started');
}

export async function stopCatalogImportWorker() {
  stopping = true;
  if (interval) clearInterval(interval);
  interval = undefined;
  await runtimeMonitor.stopping();
  if (activeCycle) await activeCycle;
  await runtimeMonitor.stopped();
}
