import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import * as repo from './agent.repo.js';
import { executePersistedAgentRun } from './agent.service.js';

const workerId = `agent-runs-${process.pid}-${randomUUID()}`;
let timer: NodeJS.Timeout | null = null;
let activeCycle: Promise<void> | null = null;
let stopping = false;

async function processRun(run: NonNullable<Awaited<ReturnType<typeof repo.claimNextRunnableRun>>>) {
  const heartbeat = setInterval(
    () => void repo.heartbeatRun(run.id, workerId).catch((error: unknown) => {
      logger.warn({ error, runId: run.id }, 'Agent run lease heartbeat failed');
    }),
    Math.max(10_000, Math.floor(env.AGENT_RUN_WORKER_LEASE_SECONDS * 1_000 / 3)),
  );
  heartbeat.unref();
  try {
    await executePersistedAgentRun(run);
  } finally {
    clearInterval(heartbeat);
    await repo.releaseRunLease(run.id, workerId);
  }
}

export function runAgentRunWorkerCycle(): Promise<void> {
  if (activeCycle) return activeCycle;
  activeCycle = (async () => {
    while (!stopping) {
      const claimed = [];
      for (let index = 0; index < env.AGENT_RUN_WORKER_CONCURRENCY; index += 1) {
        const run = await repo.claimNextRunnableRun(
          workerId,
          env.AGENT_RUN_WORKER_LEASE_SECONDS,
          env.AGENT_RUN_WORKER_MAX_ATTEMPTS,
        );
        if (!run) break;
        claimed.push(run);
      }
      if (claimed.length === 0) return;
      await Promise.all(claimed.map(processRun));
    }
  })()
    .catch((error: unknown) => logger.error({ error }, 'Agent run worker cycle failed'))
    .finally(() => { activeCycle = null; });
  return activeCycle;
}

export function requestAgentRunWorkerRun() {
  if (!stopping) void runAgentRunWorkerCycle();
}

export function startAgentRunWorker() {
  if (timer) return;
  stopping = false;
  registerDomainEventHandler({
    name: 'agents.run-job-wakeup.v1',
    eventTypes: [DOMAIN_EVENT_TYPES.AGENT_RUN_REQUESTED, DOMAIN_EVENT_TYPES.AGENT_RUN_RESUME_REQUESTED],
    handle(event) {
      requestAgentRunWorkerRun();
      return { woken: true, runId: event.aggregateId };
    },
  });
  timer = setInterval(requestAgentRunWorkerRun, env.AGENT_RUN_WORKER_INTERVAL_MS);
  timer.unref();
  requestAgentRunWorkerRun();
  logger.info({
    workerId,
    concurrency: env.AGENT_RUN_WORKER_CONCURRENCY,
    fallbackPollMs: env.AGENT_RUN_WORKER_INTERVAL_MS,
  }, 'Agent run worker started');
}

export function stopAgentRunWorker() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
}
