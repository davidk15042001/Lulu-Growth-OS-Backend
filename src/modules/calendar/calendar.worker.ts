import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import * as repo from './calendar.repo.js';
import { executeSyncJob } from './calendar.service.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { createRuntimeWorkerMonitor } from '../../operations/worker-liveness.js';

let interval: NodeJS.Timeout | undefined;
let activeCycle: Promise<void> | null = null;
let stopping = false;
let lastDueScanAt = 0;
const runtimeMonitor = createRuntimeWorkerMonitor('calendar-sync', { staleAfterMs: Math.max(60_000, env.CALENDAR_WORKER_INTERVAL_MS * 4) });

async function enqueueDueAccounts() {
  const now = Date.now();
  const scanIntervalMs = Math.min(env.CALENDAR_SYNC_INTERVAL_MINUTES * 60_000, 60_000);
  if (now - lastDueScanAt < scanIntervalMs) return;
  lastDueScanAt = now;

  for (const account of await repo.dueAccountIds(env.CALENDAR_SYNC_INTERVAL_MINUTES)) {
    if (stopping) break;
    await repo.createSyncJob(account.workspaceId, account.id, null);
  }
}

export function runCalendarSyncCycle(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (activeCycle) return activeCycle;

  activeCycle = (async () => {
    let processed = 0;
    await enqueueDueAccounts();
    while (!stopping) {
      const jobs = await repo.listQueuedSyncJobs(10);
      if (jobs.length === 0) {
        runtimeMonitor.progress({ phase: processed ? 'processed' : 'idle', processed });
        return;
      }
      for (const job of jobs) {
        if (stopping) return;
        await executeSyncJob(job.workspaceId, job.accountId, job.id);
        processed += 1;
      }
    }
  })()
    .catch((error: unknown) => { runtimeMonitor.failed(error); logger.error({ error }, 'Calendar synchronization worker cycle failed'); })
    .finally(() => { activeCycle = null; });

  return activeCycle;
}

export function requestCalendarSyncWorkerRun() {
  if (!stopping) void runCalendarSyncCycle();
}

export function startCalendarSyncWorker() {
  if (interval) return;
  registerDomainEventHandler({
    name: 'calendar.sync-job-wakeup.v1',
    eventTypes: [DOMAIN_EVENT_TYPES.CALENDAR_SYNC_REQUESTED],
    handle() {
      requestCalendarSyncWorkerRun();
      return { woken: true };
    },
  });
  stopping = false;
  runtimeMonitor.start();
  lastDueScanAt = 0;
  interval = setInterval(requestCalendarSyncWorkerRun, env.CALENDAR_WORKER_INTERVAL_MS);
  interval.unref();
  requestCalendarSyncWorkerRun();
  logger.info({ intervalMs: env.CALENDAR_WORKER_INTERVAL_MS }, 'Calendar synchronization worker started');
}

export async function stopCalendarSyncWorker() {
  stopping = true;
  if (interval) clearInterval(interval);
  interval = undefined;
  await runtimeMonitor.stopping();
  if (activeCycle) await activeCycle;
  await runtimeMonitor.stopped();
}
