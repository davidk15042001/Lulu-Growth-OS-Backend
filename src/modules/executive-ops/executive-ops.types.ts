export const executiveCycleTypes = ['daily', 'weekly'] as const;
export type ExecutiveCycleType = typeof executiveCycleTypes[number];

export const executiveCycleStatuses = ['running', 'completed', 'failed', 'superseded'] as const;
export type ExecutiveCycleStatus = typeof executiveCycleStatuses[number];

export const executiveProposalStatuses = ['draft', 'proposed', 'approved', 'rejected', 'dispatched', 'completed', 'cancelled'] as const;
export type ExecutiveProposalStatus = typeof executiveProposalStatuses[number];

export const executiveProposalTypes = [
  'strategy', 'marketing', 'campaign', 'crm', 'finance', 'product', 'operations', 'digital_employee',
] as const;
export type ExecutiveProposalType = typeof executiveProposalTypes[number];

export type ExecutiveOperatingSchedule = {
  id: string;
  workspaceId: string;
  cycleType: ExecutiveCycleType;
  timezone: string;
  hourOfDay: number;
  weekday: number;
  active: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExecutiveOperatingCycle = {
  id: string;
  workspaceId: string;
  cycleType: ExecutiveCycleType;
  triggerType: 'scheduled' | 'manual' | 'event';
  timezone: string;
  periodStart: string;
  periodEnd: string;
  dataCutoffAt: string;
  status: ExecutiveCycleStatus;
  summary: Record<string, unknown>;
  evidence: Record<string, unknown>;
  dataGaps: unknown[];
  failureCode: string | null;
  failureMessage: string | null;
  startedBy: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExecutiveFinding = {
  id: string;
  workspaceId: string;
  cycleId: string;
  sourceKey: string;
  findingType: string;
  subjectType: string;
  subjectId: string | null;
  severity: number;
  materiality: number;
  status: 'open' | 'acknowledged' | 'resolved' | 'dismissed';
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  createdAt: string;
};

export type ExecutiveMetricForecast = {
  id: string;
  workspaceId: string;
  cycleId: string;
  metricId: string;
  metricKey: string;
  metricName: string;
  metricDomain: string;
  metricUnit: string;
  sourceMetricPointId: string | null;
  method: 'two_point_trend';
  modelVersion: string;
  baselineValue: string;
  projectedLow: string;
  projectedBase: string;
  projectedHigh: string;
  baselineRecordedAt: string;
  forecastedFor: string;
  horizonSeconds: number;
  confidence: number;
  assumptions: unknown[];
  evidence: Record<string, unknown>;
  status: 'active' | 'calibrated' | 'superseded' | 'insufficient_data';
  actualValue: string | null;
  actualRecordedAt: string | null;
  absoluteError: string | null;
  relativeError: string | null;
  calibratedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExecutiveScenarioProjection = {
  id: string;
  workspaceId: string;
  scenarioId: string;
  forecastId: string;
  metricId: string;
  metricKey: string;
  metricName: string;
  adjustmentPercent: string;
  projectedValue: string;
  evidence: Record<string, unknown>;
  createdAt: string;
};

export type ExecutiveScenario = {
  id: string;
  workspaceId: string;
  cycleId: string;
  name: string;
  description: string;
  status: 'draft' | 'ready' | 'archived';
  assumptions: unknown[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  projections?: ExecutiveScenarioProjection[];
};

export type ExecutiveProposal = {
  id: string;
  workspaceId: string;
  cycleId: string | null;
  findingId: string | null;
  proposalType: ExecutiveProposalType;
  title: string;
  objective: string;
  status: ExecutiveProposalStatus;
  priority: number;
  confidence: number;
  requiresHumanApproval: boolean;
  executionMode: 'plan_only';
  expectedImpact: Record<string, unknown>;
  riskNotes: unknown[];
  evidence: Record<string, unknown>;
  companyBrainSignalId: string | null;
  companyBrainMissionId: string | null;
  companyBrainTaskId: string | null;
  idempotencyKey: string;
  createdBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ExecutiveProposalEvent = {
  id: string;
  workspaceId: string;
  proposalId: string;
  eventType: string;
  actorType: 'system' | 'agent' | 'human';
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ExecutiveLearningRecord = {
  id: string;
  workspaceId: string;
  cycleId: string | null;
  forecastId: string | null;
  proposalId: string | null;
  sourceKey: string;
  learningType: string;
  outcome: string;
  evidence: Record<string, unknown>;
  confidence: number;
  verified: boolean;
  createdAt: string;
};
