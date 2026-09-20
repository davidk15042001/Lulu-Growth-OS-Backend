import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import * as agentRepo from '../agents/agent.repo.js';
import { createRuntimeWorkerMonitor } from '../../operations/worker-liveness.js';
import * as repo from './executive-ops.repo.js';
import * as service from './executive-ops.service.js';

const workerId = `executive-operating-${process.pid}-${randomUUID()}`;
const intervalMs = env.EXECUTIVE_OPERATIONS_WORKER_INTERVAL_MS;
const leaseSeconds = env.EXECUTIVE_OPERATIONS_WORKER_LEASE_SECONDS;
const batchSize = env.EXECUTIVE_OPERATIONS_WORKER_BATCH_SIZE;
const runtimeMonitor = createRuntimeWorkerMonitor('executive-operating', {
  required: true,
  staleAfterMs: Math.max(60_000, intervalMs * 6),
});

let timer: NodeJS.Timeout | undefined;
let activeCycle: Promise<void> | null = null;
let stopping = false;

export function runExecutiveOperatingWorkerCycle(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (activeCycle) return activeCycle;
  activeCycle = (async () => {
    const targets = await agentRepo.listAutomatedTargets();
    const workspaceIds = targets.map((target) => target.workspace_id);
    const schedulableWorkspaceIds: string[] = [];
    for (const workspaceId of workspaceIds) {
      if (stopping) break;
      try {
        await repo.ensureDefaultSchedules(workspaceId);
        schedulableWorkspaceIds.push(workspaceId);
      } catch (error) {
        // A malformed local-time configuration must not make the executive
        // worker unavailable for every other tenant. The schedule remains
        // visible for correction and this workspace is retried next cycle.
        logger.warn({ error, workspaceId }, 'Executive schedules could not be initialized for workspace');
      }
    }

    const schedules = await repo.claimDueSchedules(workerId, leaseSeconds, batchSize, schedulableWorkspaceIds);
    let completed = 0;
    let failed = 0;
    for (const schedule of schedules) {
      if (stopping) break;
      try {
        await service.runCycle({
          workspaceId: schedule.workspaceId,
          cycleType: schedule.cycleType,
          triggerType: 'scheduled',
          timezone: schedule.timezone,
        });
        await repo.completeScheduleRun({
          workspaceId: schedule.workspaceId,
          cycleType: schedule.cycleType,
          workerId,
        });
        completed += 1;
      } catch (error) {
        failed += 1;
        await repo.releaseScheduleLease({
          workspaceId: schedule.workspaceId,
          cycleType: schedule.cycleType,
          workerId,
          retryAfterSeconds: Math.min(3_600, Math.max(60, Math.trunc(intervalMs / 1000) * 5)),
        }).catch((releaseError: unknown) => logger.warn({ error: releaseError, workspaceId: schedule.workspaceId }, 'Executive schedule lease could not be released'));
        logger.warn({ error, workspaceId: schedule.workspaceId, cycleType: schedule.cycleType }, 'Executive operating cycle failed');
      }
    }

    const [dispatch, calibrated] = await Promise.all([
      service.dispatchApprovedProposals(batchSize),
      service.calibrateDueForecasts(undefined, batchSize),
    ]);
    runtimeMonitor.progress({
      phase: failed > 0 ? 'completed_with_failures' : 'completed',
      processed: completed + dispatch.dispatched + calibrated.length,
      metadata: {
        eligibleWorkspaces: workspaceIds.length,
        schedulableWorkspaces: schedulableWorkspaceIds.length,
        claimedSchedules: schedules.length,
        completedSchedules: completed,
        failedSchedules: failed,
        approvedProposalsInspected: dispatch.inspected,
        calibratedForecasts: calibrated.length,
      },
    });
  })()
    .catch((error: unknown) => {
      runtimeMonitor.failed(error);
      logger.error({ error }, 'Executive operating worker cycle failed');
    })
    .finally(() => { activeCycle = null; });
  return activeCycle;
}

export function startExecutiveOperatingWorker() {
  if (timer) return;
  stopping = false;
  runtimeMonitor.start({ workerId, intervalMs, leaseSeconds, batchSize });
  timer = setInterval(() => { void runExecutiveOperatingWorkerCycle(); }, intervalMs);
  timer.unref();
  void runExecutiveOperatingWorkerCycle();
  logger.info({ workerId, intervalMs, leaseSeconds, batchSize }, 'Executive operating worker started');
}

export async function stopExecutiveOperatingWorker() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = undefined;
  await runtimeMonitor.stopping();
  if (activeCycle) await activeCycle;
  await runtimeMonitor.stopped();
}
