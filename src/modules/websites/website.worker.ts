import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { processWebsiteGenerationWorkItem } from './website.automation.service.js';
import * as repo from './website.repo.js';

const workerId = `website-${process.pid}-${randomUUID()}`;
let interval: NodeJS.Timeout | undefined;
let activeCycle: Promise<void> | null = null;
let stopping = false;

export function runWebsiteGenerationCycle(): Promise<void> {
  if (activeCycle) return activeCycle;

  activeCycle = (async () => {
    await repo.failExhaustedJobs(env.WEBSITE_JOB_MAX_ATTEMPTS, env.WEBSITE_JOB_LEASE_SECONDS);

    while (!stopping) {
      const job = await repo.claimNextGenerationJob(workerId, env.WEBSITE_JOB_LEASE_SECONDS, env.WEBSITE_JOB_MAX_ATTEMPTS);
      if (!job) return;
      logger.info({ jobId: job.id, siteId: job.siteId, attemptCount: job.attemptCount }, 'Website generation job claimed');
      await processWebsiteGenerationWorkItem(job, workerId);
    }
  })()
    .catch((error: unknown) => logger.error({ error }, 'Website generation worker cycle failed'))
    .finally(() => { activeCycle = null; });

  return activeCycle;
}

export function requestWebsiteGenerationWorkerRun() {
  if (!stopping) void runWebsiteGenerationCycle();
}

export function startWebsiteGenerationWorker() {
  if (interval) return;
  stopping = false;
  interval = setInterval(requestWebsiteGenerationWorkerRun, env.WEBSITE_WORKER_INTERVAL_MS);
  interval.unref();
  requestWebsiteGenerationWorkerRun();
  logger.info({ workerId, intervalMs: env.WEBSITE_WORKER_INTERVAL_MS }, 'Website generation worker started');
}

export function stopWebsiteGenerationWorker() {
  stopping = true;
  if (interval) clearInterval(interval);
  interval = undefined;
}
