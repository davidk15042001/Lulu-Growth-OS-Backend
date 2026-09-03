import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import * as repo from './content-generation.repo.js';
import { executeContentRefresh } from './content-generation.service.js';

const workerId = `content-${process.pid}-${randomUUID()}`;
let timer: NodeJS.Timeout | null = null;
let activeCycle: Promise<void> | null = null;
let stopping = false;

async function processJob(job: NonNullable<Awaited<ReturnType<typeof repo.claimNextJob>>>) {
  const heartbeat = setInterval(
    () => void repo.heartbeatJob(String(job.id), workerId).catch((error: unknown) => {
      logger.warn({ error, jobId: job.id }, 'Content refresh lease heartbeat failed');
    }),
    Math.max(15_000, Math.floor(env.CONTENT_JOB_LEASE_SECONDS * 1_000 / 3)),
  );
  heartbeat.unref();
  try {
    const modules = Array.isArray(job.modules)
      ? job.modules.filter((module: unknown): module is repo.ContentModule => typeof module === 'string' && repo.CONTENT_MODULES.includes(module as repo.ContentModule))
      : [];
    await executeContentRefresh(String(job.workspaceId), String(job.requestedBy), String(job.id), modules);
  } finally {
    clearInterval(heartbeat);
    await repo.releaseJobLease(String(job.id), workerId);
  }
}

export function runContentGenerationCycle(): Promise<void> {
  if (activeCycle) return activeCycle;
  activeCycle = (async () => {
    while (!stopping) {
      const job = await repo.claimNextJob(workerId, env.CONTENT_JOB_LEASE_SECONDS, env.CONTENT_JOB_MAX_ATTEMPTS);
      if (!job) return;
      await processJob(job);
    }
  })()
    .catch((error: unknown) => logger.error({ error }, 'Content generation worker cycle failed'))
    .finally(() => { activeCycle = null; });
  return activeCycle;
}

export function requestContentGenerationWorkerRun() {
  if (!stopping) void runContentGenerationCycle();
}

export function startContentGenerationWorker() {
  if (timer) return;
  stopping = false;
  registerDomainEventHandler({
    name: 'content.refresh-job-wakeup.v1',
    eventTypes: [DOMAIN_EVENT_TYPES.CONTENT_REFRESH_REQUESTED],
    handle(event) {
      requestContentGenerationWorkerRun();
      return { woken: true, jobId: event.aggregateId };
    },
  });
  timer = setInterval(requestContentGenerationWorkerRun, env.CONTENT_WORKER_INTERVAL_MS);
  timer.unref();
  requestContentGenerationWorkerRun();
  logger.info({ workerId, fallbackPollMs: env.CONTENT_WORKER_INTERVAL_MS }, 'Content generation worker started');
}

export function stopContentGenerationWorker() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
}
