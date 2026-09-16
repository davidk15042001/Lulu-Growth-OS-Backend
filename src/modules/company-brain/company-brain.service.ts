import type { DomainEvent } from '../../events/domain-event.types.js';
import * as repo from './company-brain.repo.js';
import { notFoundError } from '../../utils/app-error.js';

export async function observeDomainEvent(event: DomainEvent) {
  const result = await repo.observeDomainEvent(event);
  if (!result) return null;
  return result;
}

export async function overview(workspaceId: string, limit: number) {
  const [counts, signals, missions, decisions] = await Promise.all([
    repo.counts(workspaceId),
    repo.listSignals(workspaceId, limit),
    repo.listMissions(workspaceId, limit),
    repo.listDecisions(workspaceId, limit),
  ]);
  return { generatedAt: new Date().toISOString(), counts, signals, missions, decisions };
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
