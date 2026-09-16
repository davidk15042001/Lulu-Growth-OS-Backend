import type { DomainEvent } from '../../events/domain-event.types.js';
import * as repo from './company-brain.repo.js';
import { AppError, notFoundError } from '../../utils/app-error.js';

export async function observeDomainEvent(event: DomainEvent) {
  const result = await repo.observeDomainEvent(event);
  if (!result) return null;
  return result;
}

export async function overview(workspaceId: string, limit: number) {
  const [counts, signals, missions, decisions, learning] = await Promise.all([
    repo.counts(workspaceId),
    repo.listSignals(workspaceId, limit),
    repo.listMissions(workspaceId, limit),
    repo.listDecisions(workspaceId, limit),
    repo.listLearning(workspaceId, limit),
  ]);
  return { generatedAt: new Date().toISOString(), counts, signals, missions, decisions, learning };
}

export const listSignals = repo.listSignals;
export const listMissions = repo.listMissions;
export const listDecisions = repo.listDecisions;

export async function createMission(input: {
  workspaceId: string; signalId: string; title?: string; objective?: string; priority: number; createdBy: string;
}) {
  const signal = await repo.getSignal(input.workspaceId, input.signalId);
  if (!signal) throw notFoundError('Brain signal not found');
  const title = input.title ?? `Investigate ${signal.signalType.replaceAll('_', ' ')}`;
  const objective = input.objective ?? signal.explanation;
  const result = await repo.createMissionFromSignal({ ...input, title, objective });
  if (!result) throw notFoundError('Brain signal not found');
  return result;
}

export async function updateMission(workspaceId: string, missionId: string, status: string, outcome?: Record<string, unknown>) {
  const mission = await repo.updateMission(workspaceId, missionId, status, outcome);
  if (!mission) throw notFoundError('Brain mission not found');
  return mission;
}

export const createDecision = repo.createDecision;
export const listTasksForMission = repo.listTasksForMission;
export const getTask = repo.getTask;
export const getTaskGraph = repo.getTaskGraph;
export const listLearning = repo.listLearning;

export async function createTask(input: Parameters<typeof repo.createTask>[0]) {
  const result = await repo.createTask(input);
  if (!result) throw notFoundError('Company Brain mission, parent task, or employee not found');
  return result;
}

export async function addTaskDependency(input: Parameters<typeof repo.addTaskDependency>[0]) {
  try {
    const result = await repo.addTaskDependency(input);
    if (!result) throw notFoundError('Company Brain task or dependency not found');
    return result;
  } catch (error) {
    if (error instanceof Error && error.message.includes('would create a cycle')) {
      throw new AppError(409, 'BRAIN_TASK_DEPENDENCY_CYCLE', error.message);
    }
    throw error;
  }
}

export async function updateTask(input: Parameters<typeof repo.updateTask>[0]) {
  const task = await repo.updateTask(input);
  if (!task) throw notFoundError('Company Brain task not found');
  return task;
}

export const recordLearning = repo.recordLearning;
