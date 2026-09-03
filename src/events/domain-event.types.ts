export const DOMAIN_EVENT_TYPES = {
  WORKSPACE_CREATED: 'workspace.created',
  WORKSPACE_UPDATED: 'workspace.updated',
  RECORD_CREATED: 'record.created',
  RECORD_UPDATED: 'record.updated',
  RECORD_ARCHIVED: 'record.archived',
  RECORD_RESTORED: 'record.restored',
  METRIC_CREATED: 'metric.created',
  METRIC_UPDATED: 'metric.updated',
  METRIC_ARCHIVED: 'metric.archived',
  METRIC_POINTS_RECORDED: 'metric.points_recorded',
  AGENT_RUN_REQUESTED: 'agent.run.requested',
  AGENT_RUN_RESUME_REQUESTED: 'agent.run.resume_requested',
  AGENT_AUTOMATIC_CYCLE_REQUESTED: 'agent.automatic_cycle.requested',
  AGENT_RUN_COMPLETED: 'run.completed',
  AGENT_RUN_FAILED: 'run.failed',
  AGENT_RUN_CANCELLED: 'run.cancelled',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_DECIDED: 'approval.decided',
  EMAIL_SYNC_REQUESTED: 'email.sync.requested',
  EMAIL_SYNC_COMPLETED: 'email.sync.completed',
  EMAIL_SYNC_FAILED: 'email.sync.failed',
  CALENDAR_SYNC_REQUESTED: 'calendar.sync.requested',
  CALENDAR_SYNC_COMPLETED: 'calendar.sync.completed',
  CALENDAR_SYNC_FAILED: 'calendar.sync.failed',
  WEBSITE_GENERATION_REQUESTED: 'website.generation.requested',
  WEBSITE_GENERATION_COMPLETED: 'website.generation.completed',
  WEBSITE_GENERATION_FAILED: 'website.generation.failed',
  CONTENT_REFRESH_REQUESTED: 'content.refresh.requested',
  CONTENT_REFRESH_COMPLETED: 'content.refresh.completed',
  CONTENT_REFRESH_FAILED: 'content.refresh.failed',
  BILLING_CYCLE_REQUESTED: 'billing.cycle.requested',
  ONBOARDING_CLEANUP_REQUESTED: 'onboarding.cleanup.requested',
  INTEGRATION_CONNECTED: 'integration.connected',
  NOTIFICATION_CREATED: 'notification.created',
} as const;

export type DomainEventType = typeof DOMAIN_EVENT_TYPES[keyof typeof DOMAIN_EVENT_TYPES] | (string & {});

export type DomainEventMetadata = {
  actorId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  source?: string | null;
  traceId?: string | null;
};

export type DomainEvent = {
  id: string;
  sequence: string;
  workspaceId: string | null;
  type: DomainEventType;
  version: number;
  aggregateType: string;
  aggregateId: string | null;
  payload: Record<string, unknown>;
  metadata: DomainEventMetadata & Record<string, unknown>;
  idempotencyKey: string | null;
  status: 'pending' | 'processing' | 'processed' | 'dead_letter';
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  lockedAt: string | null;
  lockedBy: string | null;
  processedAt: string | null;
  deadLetteredAt: string | null;
  lastError: string | null;
  occurredAt: string;
};

export type AppendDomainEventInput = {
  workspaceId?: string | null;
  type: DomainEventType;
  version?: number;
  aggregateType: string;
  aggregateId?: string | null;
  payload?: Record<string, unknown>;
  metadata?: DomainEventMetadata & Record<string, unknown>;
  idempotencyKey?: string | null;
  maxAttempts?: number;
  occurredAt?: Date;
};

export type DomainEventHandler = {
  name: string;
  eventTypes: readonly DomainEventType[];
  handle: (event: DomainEvent) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
};
