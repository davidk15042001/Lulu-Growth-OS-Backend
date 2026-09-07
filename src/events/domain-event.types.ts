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
  BILLING_ACTIVATED: 'billing.activated',
  ONBOARDING_CLEANUP_REQUESTED: 'onboarding.cleanup.requested',
  INTEGRATION_CONNECTED: 'integration.connected',
  PROVIDER_CONNECTION_CREATED: 'provider.connection.created',
  PROVIDER_CONNECTION_CONNECTED: 'provider.connection.connected',
  PROVIDER_CONNECTION_AUTHORIZATION_REQUIRED: 'provider.connection.authorization_required',
  PROVIDER_CONNECTION_DISCONNECTED: 'provider.connection.disconnected',
  PROVIDER_CONNECTION_ERROR: 'provider.connection.error',
  PROVIDER_ACCOUNT_DISCOVERED: 'provider.account.discovered',
  PROVIDER_ASSET_DISCOVERED: 'provider.asset.discovered',
  PROVIDER_CAPABILITY_CHANGED: 'provider.capability.changed',
  PROVIDER_HEALTH_DEGRADED: 'provider.health.degraded',
  PROVIDER_HEALTH_RECOVERED: 'provider.health.recovered',
  PROVIDER_SYNC_STARTED: 'provider.sync.started',
  PROVIDER_SYNC_COMPLETED: 'provider.sync.completed',
  PROVIDER_SYNC_FAILED: 'provider.sync.failed',
  PROVIDER_WEBHOOK_RECEIVED: 'provider.webhook.received',
  CONVERSATION_CREATED: 'conversation.created',
  CONVERSATION_ROUTED: 'conversation.routed',
  CONVERSATION_ROUTING_FAILED: 'conversation.routing_failed',
  CONVERSATION_ASSIGNED: 'conversation.assigned',
  CONVERSATION_STATUS_CHANGED: 'conversation.status_changed',
  CONVERSATION_ESCALATED: 'conversation.escalated',
  CONVERSATION_RESOLVED: 'conversation.resolved',
  CONVERSATION_REOPENED: 'conversation.reopened',
  MESSAGE_RECEIVED: 'message.received',
  MESSAGE_QUEUED: 'message.queued',
  MESSAGE_SENT: 'message.sent',
  MESSAGE_DELIVERED: 'message.delivered',
  MESSAGE_READ: 'message.read',
  MESSAGE_FAILED: 'message.failed',
  CONVERSATION_AI_ENABLED: 'conversation.ai_enabled',
  CONVERSATION_HUMAN_TAKEOVER: 'conversation.human_takeover',
  CONVERSATION_RETURNED_TO_AI: 'conversation.returned_to_ai',
  CHANNEL_IDENTITY_CREATED: 'channel.identity.created',
  CHANNEL_IDENTITY_CONNECTED: 'channel.identity.connected',
  CHANNEL_IDENTITY_ERROR: 'channel.identity.error',
  ROUTING_DECISION_CREATED: 'routing.decision.created',
  ROUTING_DECISION_RESOLVED: 'routing.decision.resolved',
  WEBSITE_CHAT_SESSION_STARTED: 'website_chat.session.started',
  PRODUCT_CREATED: 'product.created',
  PRODUCT_UPDATED: 'product.updated',
  PRODUCT_ACTIVATED: 'product.activated',
  PRODUCT_ARCHIVED: 'product.archived',
  PRODUCT_VARIANT_CREATED: 'product.variant.created',
  PRODUCT_VARIANT_UPDATED: 'product.variant.updated',
  PRODUCT_MEDIA_ADDED: 'product.media.added',
  PRODUCT_CERTIFICATE_ADDED: 'product.certificate.added',
  PRODUCT_TRANSLATION_CREATED: 'product.translation.created',
  PRODUCT_TRANSLATION_UPDATED: 'product.translation.updated',
  PRODUCT_MARKET_ENABLED: 'product.market.enabled',
  PRODUCT_MARKET_DISABLED: 'product.market.disabled',
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
