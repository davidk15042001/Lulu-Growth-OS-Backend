export const brainSignalStatuses = ['OPEN', 'NO_ACTION', 'ACTIONED', 'DISMISSED'] as const;
export type BrainSignalStatus = typeof brainSignalStatuses[number];

export const brainMissionStatuses = ['PROPOSED', 'PLANNED', 'RUNNING', 'BLOCKED', 'COMPLETED', 'CANCELLED'] as const;
export type BrainMissionStatus = typeof brainMissionStatuses[number];

export const brainTaskStatuses = ['PROPOSED', 'READY', 'RUNNING', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type BrainTaskStatus = typeof brainTaskStatuses[number];

export type BrainObservation = {
  id: string;
  workspaceId: string;
  sourceType: 'domain_event' | 'metric' | 'provider' | 'user';
  sourceKey: string;
  sourceEventId: string | null;
  subjectType: string;
  subjectId: string | null;
  eventType: string | null;
  summary: string;
  evidence: Record<string, unknown>;
  trustScore: number;
  observedAt: string;
  createdAt: string;
};

export type BrainSignal = {
  id: string;
  workspaceId: string;
  observationId: string;
  signalType: string;
  severity: number;
  materiality: number;
  status: BrainSignalStatus;
  explanation: string;
  evidence: Record<string, unknown>;
  detectedAt: string;
  resolvedAt: string | null;
};

export type BrainMission = {
  id: string;
  workspaceId: string;
  signalId: string | null;
  title: string;
  objective: string;
  status: BrainMissionStatus;
  priority: number;
  northStar: string;
  ownerEmployeeId: string | null;
  createdBy: string | null;
  context: Record<string, unknown>;
  outcome: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BrainTask = {
  id: string;
  workspaceId: string;
  missionId: string;
  parentTaskId: string | null;
  assignedEmployeeId: string | null;
  taskType: string;
  title: string;
  objective: string;
  status: BrainTaskStatus;
  priority: number;
  dependencyCount: number;
  context: Record<string, unknown>;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BrainDecision = {
  id: string;
  workspaceId: string;
  signalId: string | null;
  missionId: string | null;
  decisionType: string;
  decision: string;
  confidence: number;
  rationale: string;
  evidence: Record<string, unknown>;
  actorType: 'system' | 'agent' | 'human';
  actorId: string | null;
  createdAt: string;
};
