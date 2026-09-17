import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { createRuntimeWorkerMonitor } from '../../operations/worker-liveness.js';
import { canonicalProviderKey } from '../provider-control/provider-registry.js';
import { syncLegacyControlStatus } from '../provider-control/provider.repo.js';
import { getGoogleBusinessOverview } from './google-business.service.js';
import * as repo from './integration-sync.repo.js';

const workerId = `integration-sync-${process.pid}-${randomUUID()}`;
const runtimeMonitor = createRuntimeWorkerMonitor('integration-sync', {
  required: true,
  staleAfterMs: Math.max(60_000, env.INTEGRATION_SYNC_WORKER_INTERVAL_MS * 4),
});

let interval: NodeJS.Timeout | undefined;
let activeCycle: Promise<void> | null = null;
let stopping = false;

export class IntegrationSyncFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'IntegrationSyncFailure';
  }
}

export function classifyIntegrationSyncError(error: unknown) {
  if (error instanceof IntegrationSyncFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new IntegrationSyncFailure('INTEGRATION_SYNC_UNEXPECTED', message || 'Integration synchronization failed', true);
}

async function executeIntegrationSync(job: repo.IntegrationSyncJob) {
  const pendingHeartbeats = new Set<Promise<unknown>>();
  const heartbeat = setInterval(() => {
    const pending = repo.heartbeatIntegrationSyncJob(job.id, workerId);
    pendingHeartbeats.add(pending);
    pending.then(
      () => pendingHeartbeats.delete(pending),
      (error: unknown) => {
        pendingHeartbeats.delete(pending);
        logger.warn({ error, jobId: job.id }, 'Integration sync heartbeat failed');
      },
    );
  }, Math.max(5_000, Math.floor(env.INTEGRATION_SYNC_JOB_LEASE_SECONDS * 1_000 / 3)));
  heartbeat.unref();

  try {
    const provider = canonicalProviderKey(job.integrationKey ?? '');
    if (provider !== 'google_business') {
      throw new IntegrationSyncFailure(
        'INTEGRATION_SYNC_UNSUPPORTED',
        `Automatic synchronization is not registered for provider ${job.integrationKey ?? 'unknown'}. Connect a supported provider adapter before scheduling sync.`,
        false,
      );
    }

    const overview = await getGoogleBusinessOverview(job.workspaceId);
    if (!overview.connected) {
      throw new IntegrationSyncFailure('GOOGLE_BUSINESS_NOT_CONNECTED', 'Google Business is not connected for this workspace.', false);
    }
    if (!overview.apiReachable) {
      throw new IntegrationSyncFailure(
        overview.reauthRequired ? 'GOOGLE_BUSINESS_REAUTH_REQUIRED' : 'GOOGLE_BUSINESS_UNAVAILABLE',
        overview.lastError ?? 'Google Business is temporarily unavailable.',
        !overview.reauthRequired,
      );
    }

    const recordsProcessed = overview.summary.accountCount + overview.summary.locationCount;
    const result = {
      provider: 'google_business',
      accountCount: overview.summary.accountCount,
      locationCount: overview.summary.locationCount,
      apiReachable: overview.apiReachable,
    };
    await repo.finishIntegrationSyncJob({
      job,
      workerId,
      status: 'succeeded',
      recordsProcessed,
      result,
    });
    await syncLegacyControlStatus({
      sourceType: 'workspace_platform',
      sourceId: job.platformId,
      status: 'connected',
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    });
  } catch (error) {
    const failure = classifyIntegrationSyncError(error);
    await repo.finishIntegrationSyncJob({
      job,
      workerId,
      status: 'failed',
      recordsFailed: 1,
      errorCode: failure.code,
      errorMessage: failure.message,
      retryable: failure.retryable,
    });
    await syncLegacyControlStatus({
      sourceType: 'workspace_platform',
      sourceId: job.platformId,
      status: 'error',
      lastError: failure.message,
    }).catch((statusError: unknown) => logger.warn({ statusError, jobId: job.id }, 'Legacy integration status could not be updated after sync failure'));
    logger.error({ error: failure, jobId: job.id, platformId: job.platformId, attempts: job.attempts }, 'Integration synchronization failed');
  } finally {
    clearInterval(heartbeat);
    if (pendingHeartbeats.size > 0) await Promise.allSettled([...pendingHeartbeats]);
  }
}

async function drainIntegrationSyncJobs() {
  let processed = 0;
  while (!stopping) {
    const job = await repo.claimNextIntegrationSyncJob(workerId, env.INTEGRATION_SYNC_JOB_LEASE_SECONDS);
    if (!job) break;
    await executeIntegrationSync(job);
    processed += 1;
  }
  runtimeMonitor.progress({ phase: processed ? 'processed' : 'idle', processed });
}

export function runIntegrationSyncCycle(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (activeCycle) return activeCycle;
  activeCycle = drainIntegrationSyncJobs()
    .catch((error: unknown) => {
      runtimeMonitor.failed(error);
      logger.error({ error }, 'Integration synchronization worker cycle failed');
    })
    .finally(() => { activeCycle = null; });
  return activeCycle;
}

export function requestIntegrationSyncWorkerRun() {
  if (!stopping) void runIntegrationSyncCycle();
}

export function startIntegrationSyncWorker() {
  if (interval) return;
  stopping = false;
  registerDomainEventHandler({
    name: 'integration-sync-worker-wakeup.v1',
    eventTypes: [DOMAIN_EVENT_TYPES.INTEGRATION_SYNC_REQUESTED],
    handle() {
      requestIntegrationSyncWorkerRun();
      return { woken: true };
    },
  });
  runtimeMonitor.start({ workerId });
  interval = setInterval(requestIntegrationSyncWorkerRun, env.INTEGRATION_SYNC_WORKER_INTERVAL_MS);
  interval.unref();
  requestIntegrationSyncWorkerRun();
  logger.info({ intervalMs: env.INTEGRATION_SYNC_WORKER_INTERVAL_MS }, 'Integration synchronization worker started');
}

export async function stopIntegrationSyncWorker() {
  stopping = true;
  if (interval) clearInterval(interval);
  interval = undefined;
  await runtimeMonitor.stopping();
  if (activeCycle) await activeCycle;
  await runtimeMonitor.stopped();
}
