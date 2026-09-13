import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { processWebsiteGenerationWorkItem } from './website.automation.service.js';
import * as repo from './website.repo.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { createRuntimeWorkerMonitor } from '../../operations/worker-liveness.js';

const workerId = `website-${process.pid}-${randomUUID()}`;
const runtimeMonitor = createRuntimeWorkerMonitor('website-generation', { staleAfterMs: Math.max(60_000, env.WEBSITE_WORKER_INTERVAL_MS * 4) });
let interval: NodeJS.Timeout | undefined;
let activeCycle: Promise<void> | null = null;
let stopping = false;

export function runWebsiteGenerationCycle(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (activeCycle) return activeCycle;

  activeCycle = (async () => {
    let processed = 0;
    await repo.failExhaustedJobs(env.WEBSITE_JOB_MAX_ATTEMPTS, env.WEBSITE_JOB_LEASE_SECONDS);

    while (!stopping) {
      const job = await repo.claimNextGenerationJob(workerId, env.WEBSITE_JOB_LEASE_SECONDS, env.WEBSITE_JOB_MAX_ATTEMPTS);
      if (!job) {
        runtimeMonitor.progress({ phase: processed ? 'processed' : 'idle', processed });
        return;
      }
      logger.info({ jobId: job.id, siteId: job.siteId, attemptCount: job.attemptCount }, 'Website generation job claimed');
      await processWebsiteGenerationWorkItem(job, workerId);
      processed += 1;
    }
  })()
    .catch((error: unknown) => { runtimeMonitor.failed(error); logger.error({ error }, 'Website generation worker cycle failed'); })
    .finally(() => { activeCycle = null; });

  return activeCycle;
}

export function requestWebsiteGenerationWorkerRun() {
  if (!stopping) void runWebsiteGenerationCycle();
}

export function startWebsiteGenerationWorker() {
  if (interval) return;
  registerDomainEventHandler({
    name: 'websites.generation-job-wakeup.v1',
    eventTypes: [DOMAIN_EVENT_TYPES.WEBSITE_GENERATION_REQUESTED],
    handle() {
      requestWebsiteGenerationWorkerRun();
      return { woken: true };
    },
  });
  stopping = false;
  runtimeMonitor.start({ workerId });
  interval = setInterval(requestWebsiteGenerationWorkerRun, env.WEBSITE_WORKER_INTERVAL_MS);
  interval.unref();
  requestWebsiteGenerationWorkerRun();
  logger.info({ workerId, intervalMs: env.WEBSITE_WORKER_INTERVAL_MS }, 'Website generation worker started');
}

export async function stopWebsiteGenerationWorker() {
  stopping = true;
  if (interval) clearInterval(interval);
  interval = undefined;
  await runtimeMonitor.stopping();
  if (activeCycle) await activeCycle;
  await runtimeMonitor.stopped();
}
