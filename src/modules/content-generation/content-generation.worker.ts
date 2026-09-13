import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import * as repo from './content-generation.repo.js';
import { executeContentRefresh } from './content-generation.service.js';
import { createRuntimeWorkerMonitor } from '../../operations/worker-liveness.js';

const workerId = `content-${process.pid}-${randomUUID()}`;
const runtimeMonitor = createRuntimeWorkerMonitor('content-generation', { staleAfterMs: Math.max(60_000, env.CONTENT_WORKER_INTERVAL_MS * 4) });
let timer: NodeJS.Timeout | null = null;
let activeCycle: Promise<void> | null = null;
let stopping = false;

async function processJob(job: NonNullable<Awaited<ReturnType<typeof repo.claimNextJob>>>) {
  const pendingHeartbeats = new Set<Promise<unknown>>();
  const requestHeartbeat = () => {
    const task = repo.heartbeatJob(String(job.id), workerId);
    pendingHeartbeats.add(task);
    task.then(
      () => pendingHeartbeats.delete(task),
      (error: unknown) => {
        pendingHeartbeats.delete(task);
        logger.warn({ error, jobId: job.id }, 'Content refresh lease heartbeat failed');
      },
    );
  };
  const heartbeat = setInterval(
    requestHeartbeat,
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
    if (pendingHeartbeats.size > 0) await Promise.allSettled([...pendingHeartbeats]);
    await repo.releaseJobLease(String(job.id), workerId);
  }
}

export function runContentGenerationCycle(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (activeCycle) return activeCycle;
  activeCycle = (async () => {
    let processed = 0;
    while (!stopping) {
      const job = await repo.claimNextJob(workerId, env.CONTENT_JOB_LEASE_SECONDS, env.CONTENT_JOB_MAX_ATTEMPTS);
      if (!job) {
        runtimeMonitor.progress({ phase: processed ? 'processed' : 'idle', processed });
        return;
      }
      await processJob(job);
      processed += 1;
    }
  })()
    .catch((error: unknown) => { runtimeMonitor.failed(error); logger.error({ error }, 'Content generation worker cycle failed'); })
    .finally(() => { activeCycle = null; });
  return activeCycle;
}

export function requestContentGenerationWorkerRun() {
  if (!stopping) void runContentGenerationCycle();
}

export function startContentGenerationWorker() {
  if (timer) return;
  stopping = false;
  runtimeMonitor.start({ workerId });
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

export async function stopContentGenerationWorker() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
  await runtimeMonitor.stopping();
  if (activeCycle) await activeCycle;
  await runtimeMonitor.stopped();
}
