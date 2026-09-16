import { randomUUID } from 'node:crypto';
import { logger } from '../../config/logger.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import * as repo from './company-brain.repo.js';
import { startAutomaticRun } from '../agents/agent.service.js';
import { isAgentModule, type AgentModule } from '../agents/agent.capabilities.js';
import { automaticPageProfiles } from '../agents/agent.page-context.js';
import { classifyAgentFailure } from '../agents/agent-prerequisite.js';
import { createRuntimeWorkerMonitor } from '../../operations/worker-liveness.js';

const workerId = `company-brain-tasks-${process.pid}-${randomUUID()}`;
const intervalMs = 10_000;
const concurrency = 3;
const leaseSeconds = 120;
const runtimeMonitor = createRuntimeWorkerMonitor('company-brain-task-dispatch', {
  required: true,
  staleAfterMs: intervalMs * 6,
});
let timer: NodeJS.Timeout | null = null;
let activeCycle: Promise<void> | null = null;
let stopping = false;

function textValue(value: unknown, maxLength = 4000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function taskContext(task: Awaited<ReturnType<typeof repo.claimNextRunnableTask>>) {
  const context = task?.context ?? {};
  const contextModule = context.module;
  const module: AgentModule = isAgentModule(contextModule) ? contextModule : task?.taskType === 'provider-diagnosis' ? 'settings' : 'general';
  const pageId = textValue(context.pageId, 120);
  const page = pageId ? automaticPageProfiles.find((entry) => entry.pageId === pageId) : undefined;
  const employeeKey = textValue(context.employeeKey, 160) || null;
  return { module, page, employeeKey };
}

async function dispatchTask(task: NonNullable<Awaited<ReturnType<typeof repo.claimNextRunnableTask>>>) {
  const { module, page, employeeKey } = taskContext(task);
  const requestedGoal = `${task.title}: ${task.objective || 'Inspect the live canonical state, resolve the issue safely, and verify the outcome.'}`.slice(0, 4_000);
  try {
    const dispatchContext: { taskId: string; missionId: string; taskType: string; employeeKey?: string; assignedEmployeeId?: string | null } = {
      taskId: task.id,
      missionId: task.missionId,
      taskType: task.taskType,
      assignedEmployeeId: task.assignedEmployeeId,
    };
    if (employeeKey) dispatchContext.employeeKey = employeeKey;
    const run = await startAutomaticRun(
      task.workspaceId,
      requestedGoal,
      module,
      page,
      undefined,
      undefined,
      undefined,
      dispatchContext,
    );
    if (!run) {
      await repo.updateTask({
        workspaceId: task.workspaceId,
        taskId: task.id,
        status: 'BLOCKED',
        blockedReason: 'AGENT_ENTITLEMENT_REQUIRED',
        errorCode: 'AGENT_ENTITLEMENT_REQUIRED',
        errorMessage: 'No active autonomous agent entitlement is available for this workspace. Lulu will not retry automatically.',
        actorType: 'system',
        actorId: workerId,
      });
      return;
    }
    const linked = await repo.attachAgentRun({ workspaceId: task.workspaceId, taskId: task.id, runId: run.id, workerId });
    if (!linked) {
      await repo.updateTask({
        workspaceId: task.workspaceId,
        taskId: task.id,
        status: 'FAILED',
        errorCode: 'BRAIN_TASK_RUN_LINK_FAILED',
        errorMessage: 'The agent run was created but could not be linked to the Company Brain task. The task is paused to prevent duplicate side effects.',
        actorType: 'system',
        actorId: workerId,
      });
      return;
    }
    runtimeMonitor.progress({ phase: 'dispatched', processed: 1, metadata: { taskId: task.id, runId: run.id } });
  } catch (error) {
    const classification = classifyAgentFailure(error);
    await repo.updateTask({
      workspaceId: task.workspaceId,
      taskId: task.id,
      status: classification.blocked ? 'BLOCKED' : 'FAILED',
      blockedReason: classification.blocked ? classification.originalCode : null,
      errorCode: classification.code,
      errorMessage: classification.message,
      actorType: 'system',
      actorId: workerId,
    });
    logger.warn({ error, taskId: task.id, workspaceId: task.workspaceId, code: classification.code }, 'Company Brain task dispatch paused');
  }
}

export function runCompanyBrainTaskWorkerCycle(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (activeCycle) return activeCycle;
  activeCycle = (async () => {
    const claimed = [];
    for (let index = 0; index < concurrency && !stopping; index += 1) {
      const task = await repo.claimNextRunnableTask(workerId, leaseSeconds);
      if (!task) break;
      claimed.push(task);
    }
    if (claimed.length === 0) {
      runtimeMonitor.progress({ phase: 'idle', processed: 0 });
      return;
    }
    await Promise.all(claimed.map(dispatchTask));
  })()
    .catch((error: unknown) => {
      runtimeMonitor.failed(error);
      logger.error({ error }, 'Company Brain task dispatch cycle failed');
    })
    .finally(() => { activeCycle = null; });
  return activeCycle;
}

export function requestCompanyBrainTaskWorkerRun() {
  if (!stopping) void runCompanyBrainTaskWorkerCycle();
}

export function startCompanyBrainTaskWorker() {
  if (timer) return;
  stopping = false;
  runtimeMonitor.start({ workerId });
  registerDomainEventHandler({
    name: 'company-brain-task-dispatcher.v1',
    eventTypes: ['brain.task.created', 'brain.mission.updated'],
    handle() {
      requestCompanyBrainTaskWorkerRun();
      return { woken: true };
    },
  });
  timer = setInterval(requestCompanyBrainTaskWorkerRun, intervalMs);
  timer.unref();
  requestCompanyBrainTaskWorkerRun();
  logger.info({ workerId, intervalMs, concurrency }, 'Company Brain task dispatcher started');
}

export async function stopCompanyBrainTaskWorker() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
  if (activeCycle) await activeCycle;
  await runtimeMonitor.stopping();
  await runtimeMonitor.stopped();
}
