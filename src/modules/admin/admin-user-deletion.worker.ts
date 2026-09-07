import { randomUUID } from 'node:crypto';
import { logger } from '../../config/logger.js';
import * as repo from './admin.repo.js';

const workerId = `admin-user-deletion-${process.pid}-${randomUUID()}`;
const pollIntervalMs = 5_000;
let timer: NodeJS.Timeout | null = null;
let activeCycle: Promise<void> | null = null;
let stopping = false;

async function processJob(job: NonNullable<Awaited<ReturnType<typeof repo.claimNextUserDeletionJob>>>) {
  const heartbeat = setInterval(() => {
    void repo.heartbeatUserDeletionJob(job.id, workerId).catch((error: unknown) => {
      logger.warn({ error, jobId: job.id }, 'Could not refresh account deletion lease');
    });
  }, 30_000);
  heartbeat.unref();
  try {
    const result = await repo.deleteUserAndOwnedData(job.targetUserId);
    await repo.markUserDeletionJobSucceeded(job.id, result ?? {
      userId: job.targetUserId,
      previousEmail: job.targetEmail,
      alreadyDeleted: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown account deletion failure';
    await repo.markUserDeletionJobFailed(job.id, message).catch((markError: unknown) => {
      logger.error({ error: markError, jobId: job.id }, 'Could not record admin account deletion failure');
    });
    logger.error({ error, jobId: job.id, targetUserId: job.targetUserId }, 'Admin account deletion job failed');
  } finally {
    clearInterval(heartbeat);
  }
}

export function runAdminUserDeletionWorkerCycle(): Promise<void> {
  if (activeCycle) return activeCycle;
  activeCycle = (async () => {
    while (!stopping) {
      const job = await repo.claimNextUserDeletionJob(workerId);
      if (!job) return;
      await processJob(job);
    }
  })()
    .catch((error: unknown) => logger.error({ error }, 'Admin account deletion worker cycle failed'))
    .finally(() => { activeCycle = null; });
  return activeCycle;
}

export function requestAdminUserDeletionWorkerRun() {
  if (!stopping) void runAdminUserDeletionWorkerCycle();
}

export function startAdminUserDeletionWorker() {
  if (timer) return;
  stopping = false;
  timer = setInterval(requestAdminUserDeletionWorkerRun, pollIntervalMs);
  timer.unref();
  requestAdminUserDeletionWorkerRun();
  logger.info({ workerId, pollIntervalMs }, 'Admin account deletion worker started');
}

export function stopAdminUserDeletionWorker() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
}
