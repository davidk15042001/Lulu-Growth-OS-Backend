import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { createRuntimeWorkerMonitor } from '../../operations/worker-liveness.js';
import { releaseAdSpendReservation } from './adspend.repo.js';
import { claimGoogleAdsSpendAllocation, listRecoverableGoogleAdsReservationOrphans, scheduleGoogleAdsSpendAllocation } from './google-ads-spend.repo.js';
import { reconcileGoogleAdsSpendAllocation } from './google-ads-spend.service.js';

const workerId = `google-ads-spend-reconciliation-${process.pid}-${randomUUID()}`;
const runtimeMonitor = createRuntimeWorkerMonitor('google-ads-spend-reconciliation', {
  staleAfterMs: Math.max(180_000, env.GOOGLE_ADS_RECONCILIATION_WORKER_INTERVAL_MS * 4),
});
let timer: NodeJS.Timeout | undefined;
let activeCycle: Promise<void> | null = null;
let stopping = false;

function errorCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'GOOGLE_ADS_RECONCILIATION_FAILED';
}

export function runGoogleAdsSpendReconciliationCycle(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (activeCycle) return activeCycle;
  activeCycle = (async () => {
    let processed = 0;
    const orphans = await listRecoverableGoogleAdsReservationOrphans(env.GOOGLE_ADS_RECONCILIATION_BATCH_SIZE);
    for (const orphan of orphans) {
      if (stopping) break;
      await releaseAdSpendReservation({ workspaceId: orphan.workspaceId, reservationId: orphan.reservationId,
        reason: 'Recovered a pre-provider Google Ads allocation initialization failure' });
      processed += 1;
    }
    for (; processed < env.GOOGLE_ADS_RECONCILIATION_BATCH_SIZE && !stopping; processed += 1) {
      const allocation = await claimGoogleAdsSpendAllocation(workerId, env.GOOGLE_ADS_RECONCILIATION_LEASE_SECONDS);
      if (!allocation) break;
      try {
        const result = await reconcileGoogleAdsSpendAllocation(allocation, workerId);
        logger.info({ workspaceId: allocation.workspaceId, reservationId: allocation.reservationId, result }, 'Google Ads spend allocation reconciled');
      } catch (error) {
        const attempt = allocation.attemptCount + 1;
        const delaySeconds = Math.min(
          env.GOOGLE_ADS_BILLING_RETRY_INTERVAL_SECONDS,
          Math.max(60, 60 * (2 ** Math.min(attempt, 8))),
        );
        await scheduleGoogleAdsSpendAllocation({
          workspaceId: allocation.workspaceId,
          reservationId: allocation.reservationId,
          workerId,
          delaySeconds,
          errorCode: errorCode(error),
          errorMessage: error instanceof Error ? error.message : String(error),
        }).catch((scheduleError: unknown) => logger.error({ scheduleError, reservationId: allocation.reservationId }, 'Google Ads reconciliation lease could not be released'));
        logger.warn({ error, workspaceId: allocation.workspaceId, reservationId: allocation.reservationId }, 'Google Ads spend reconciliation is blocked; customer funds remain reserved');
      }
    }
    runtimeMonitor.progress({ phase: processed > 0 ? 'processed' : 'idle', processed });
  })()
    .catch((error: unknown) => {
      runtimeMonitor.failed(error);
      logger.error({ error }, 'Google Ads spend reconciliation worker cycle failed');
    })
    .finally(() => { activeCycle = null; });
  return activeCycle;
}

export function requestGoogleAdsSpendReconciliationRun() {
  if (!stopping) void runGoogleAdsSpendReconciliationCycle();
}

export function startGoogleAdsSpendReconciliationWorker() {
  if (timer) return;
  stopping = false;
  runtimeMonitor.start({ workerId });
  timer = setInterval(requestGoogleAdsSpendReconciliationRun, env.GOOGLE_ADS_RECONCILIATION_WORKER_INTERVAL_MS);
  timer.unref();
  requestGoogleAdsSpendReconciliationRun();
  logger.info({ workerId, intervalMs: env.GOOGLE_ADS_RECONCILIATION_WORKER_INTERVAL_MS }, 'Google Ads spend reconciliation worker started');
}

export async function stopGoogleAdsSpendReconciliationWorker() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = undefined;
  await runtimeMonitor.stopping();
  if (activeCycle) await activeCycle;
  await runtimeMonitor.stopped();
}
