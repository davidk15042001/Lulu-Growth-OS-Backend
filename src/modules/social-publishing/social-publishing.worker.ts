import { randomUUID } from 'node:crypto';
import { logger } from '../../config/logger.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import * as repo from './social-publishing.repo.js';
import { processClaimedPublication } from './social-publishing.service.js';
import { SOCIAL_EVENT_TYPES, SOCIAL_WORKER_DEFAULTS } from './social-publishing.types.js';
import { createRuntimeWorkerMonitor } from '../../operations/worker-liveness.js';

const workerId = `social-publishing-${process.pid}-${randomUUID()}`;
const runtimeMonitor = createRuntimeWorkerMonitor('social-publishing', { staleAfterMs: Math.max(60_000, SOCIAL_WORKER_DEFAULTS.intervalMs * 4) });
let interval: NodeJS.Timeout | null = null;
let activeCycle: Promise<void> | null = null;
let stopping = false;

export function runSocialPublishingCycle(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (activeCycle) return activeCycle;
  activeCycle = (async () => {
    let processedCount = 0;
    await repo.blockStalePublishingJobs(SOCIAL_WORKER_DEFAULTS.leaseSeconds);
    for (let processed = 0; processed < SOCIAL_WORKER_DEFAULTS.maxBatchSize && !stopping; processed += 1) {
      const job = await repo.claimNextPublication(workerId);
      if (!job) {
        runtimeMonitor.progress({ phase: processedCount ? 'processed' : 'idle', processed: processedCount });
        return;
      }
      logger.info({ jobId: job.id, workspaceId: job.workspaceId, provider: job.account.provider, attemptCount: job.attemptCount }, 'Social publication claimed');
      await processClaimedPublication(job);
      processedCount += 1;
    }
    runtimeMonitor.progress({ phase: 'processed', processed: processedCount });
  })()
    .catch((error: unknown) => { runtimeMonitor.failed(error); logger.error({ error }, 'Social publishing worker cycle failed'); })
    .finally(() => { activeCycle = null; });
  return activeCycle;
}

export function requestSocialPublishingWorkerRun() {
  if (!stopping) void runSocialPublishingCycle();
}

export function startSocialPublishingWorker() {
  if (interval) return;
  stopping = false;
  runtimeMonitor.start({ workerId });
  registerDomainEventHandler({
    name: 'social-publishing.queue-wakeup.v1',
    eventTypes: [SOCIAL_EVENT_TYPES.PUBLICATION_QUEUED],
    handle() {
      requestSocialPublishingWorkerRun();
      return { woken: true };
    },
  });
  interval = setInterval(requestSocialPublishingWorkerRun, SOCIAL_WORKER_DEFAULTS.intervalMs);
  interval.unref();
  requestSocialPublishingWorkerRun();
  logger.info({ workerId, intervalMs: SOCIAL_WORKER_DEFAULTS.intervalMs }, 'Social publishing worker started');
}

export async function stopSocialPublishingWorker() {
  stopping = true;
  if (interval) clearInterval(interval);
  interval = null;
  await runtimeMonitor.stopping();
  if (activeCycle) await activeCycle;
  await runtimeMonitor.stopped();
}
