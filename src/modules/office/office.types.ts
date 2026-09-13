export const officeWorkItemStatuses = [
  'queued',
  'running',
  'waiting',
  'paused',
  'waiting_for_approval',
  'human_controlled',
  'failed',
  'completed',
  'cancelled',
] as const;

export type OfficeWorkItemStatus = typeof officeWorkItemStatuses[number];

export const officeControlActions = ['pause', 'resume', 'retry', 'cancel', 'takeover'] as const;
export type OfficeControlAction = typeof officeControlActions[number];

export type OfficeDisplayState =
  | 'IDLE'
  | 'MONITORING'
  | 'WORKING'
  | 'COLLABORATING'
  | 'WAITING'
  | 'WAITING_FOR_APPROVAL'
  | 'HUMAN_CONTROLLED'
  | 'ERROR'
  | 'OFFLINE';

export type OfficeAvailability = 'AVAILABLE' | 'LIMITED' | 'UNAVAILABLE';

export type OfficeWorkItem = {
  id: string;
  workspaceId: string;
  parentWorkItemId: string | null;
  primaryEmployeeId: string | null;
  sourceType: 'agent_run' | 'agent_action_packet' | 'workflow' | 'domain_event' | 'manual' | 'system';
  sourceId: string | null;
  sourceAgentRunId: string | null;
  sourceRecordId: string | null;
  title: string;
  objective: string;
  description: string;
  status: OfficeWorkItemStatus;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  version: number;
  relatedObjectType: string | null;
  relatedObjectId: string | null;
  context: Record<string, unknown>;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  humanControllerId: string | null;
  availableAt: string;
  startedAt: string | null;
  pausedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  sourceWorkerId?: string | null;
  hasChildren?: boolean;
  hasActiveChildren?: boolean;
  hasRunningChildren?: boolean;
  availableControls?: OfficeControlAction[];
  dependencies?: Array<Record<string, unknown>>;
  assignments?: Array<Record<string, unknown>>;
  attempts?: Array<Record<string, unknown>>;
};

export type OfficeEmployeeRow = {
  departmentId: string;
  departmentKey: string;
  departmentName: string;
  departmentDescription: string;
  departmentSortOrder: number;
  employeeId: string;
  employeeKey: string;
  employeeName: string;
  roleTitle: string;
  employeeDescription: string;
  availability: OfficeAvailability;
  sourceAgentIds: string[];
  sourceModules: string[];
  readCapabilityKeys: string[];
  employeeSortOrder: number;
  status: OfficeDisplayState;
  activeWorkCount: number;
  failedWorkCount: number;
  completedTodayCount: number;
  lastActivityAt: string | null;
  currentWorkItemId: string | null;
  currentWorkItemTitle: string | null;
  currentWorkItemObjective: string | null;
  currentWorkItemStatus: OfficeWorkItemStatus | null;
  currentWorkItemVersion: number | null;
  currentWorkItemSourceType: OfficeWorkItem['sourceType'] | null;
  currentWorkItemRelatedObjectType: string | null;
  currentWorkItemRelatedObjectId: string | null;
};

export type OfficeTimelineItem = {
  id: string;
  source: 'work_item' | 'domain_event';
  type: string;
  title: string;
  occurredAt: string;
  employeeId: string | null;
  employeeName: string | null;
  workItemId: string | null;
  aggregateType: string | null;
  aggregateId: string | null;
  statusFrom: string | null;
  statusTo: string | null;
  payload: Record<string, unknown>;
};

export type CreateOfficeWorkItemInput = {
  workspaceId: string;
  employeeId: string;
  idempotencyKey: string;
  title: string;
  objective?: string;
  description?: string;
  sourceType: 'workflow' | 'domain_event' | 'manual' | 'system';
  sourceId?: string | null;
  parentWorkItemId?: string | null;
  priority?: number;
  maxAttempts?: number;
  relatedObjectType?: string | null;
  relatedObjectId?: string | null;
  context?: Record<string, unknown>;
  createdBy?: string | null;
};
