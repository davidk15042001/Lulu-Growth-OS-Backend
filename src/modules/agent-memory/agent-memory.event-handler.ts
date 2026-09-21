import { query } from '../../db/pool.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import type { DomainEvent } from '../../events/domain-event.types.js';
import { addUserBusinessDataToMemory } from './agent-memory.service.js';

const MEMORY_EVENT_TYPES = [
  DOMAIN_EVENT_TYPES.RECORD_CREATED,
  DOMAIN_EVENT_TYPES.RECORD_UPDATED,
  DOMAIN_EVENT_TYPES.RECORD_ARCHIVED,
  DOMAIN_EVENT_TYPES.RECORD_RESTORED,
  DOMAIN_EVENT_TYPES.METRIC_CREATED,
  DOMAIN_EVENT_TYPES.METRIC_UPDATED,
  DOMAIN_EVENT_TYPES.METRIC_POINTS_RECORDED,
  DOMAIN_EVENT_TYPES.PRODUCT_CREATED,
  DOMAIN_EVENT_TYPES.PRODUCT_UPDATED,
  DOMAIN_EVENT_TYPES.PRODUCT_ACTIVATED,
  DOMAIN_EVENT_TYPES.PRODUCT_ARCHIVED,
  DOMAIN_EVENT_TYPES.PRODUCT_VARIANT_CREATED,
  DOMAIN_EVENT_TYPES.PRODUCT_VARIANT_UPDATED,
  DOMAIN_EVENT_TYPES.ORDER_CREATED,
  DOMAIN_EVENT_TYPES.ORDER_UPDATED,
  DOMAIN_EVENT_TYPES.ORDER_PLACED,
  DOMAIN_EVENT_TYPES.ORDER_CONFIRMED,
  DOMAIN_EVENT_TYPES.ORDER_PROCESSING,
  DOMAIN_EVENT_TYPES.ORDER_PARTIALLY_FULFILLED,
  DOMAIN_EVENT_TYPES.ORDER_FULFILLED,
  DOMAIN_EVENT_TYPES.ORDER_CANCELLED,
  DOMAIN_EVENT_TYPES.INVENTORY_LOCATION_CREATED,
  DOMAIN_EVENT_TYPES.INVENTORY_LOCATION_UPDATED,
  DOMAIN_EVENT_TYPES.INVENTORY_ADJUSTED,
  DOMAIN_EVENT_TYPES.INVENTORY_RESERVED,
  DOMAIN_EVENT_TYPES.INVENTORY_RELEASED,
  DOMAIN_EVENT_TYPES.INVENTORY_FULFILLED,
  DOMAIN_EVENT_TYPES.FULFILLMENT_CREATED,
  DOMAIN_EVENT_TYPES.FULFILLMENT_PROCESSING,
  DOMAIN_EVENT_TYPES.FULFILLMENT_SHIPPED,
  DOMAIN_EVENT_TYPES.FULFILLMENT_DELIVERED,
  DOMAIN_EVENT_TYPES.FULFILLMENT_CANCELLED,
  DOMAIN_EVENT_TYPES.QUOTE_CREATED,
  DOMAIN_EVENT_TYPES.QUOTE_READY,
  DOMAIN_EVENT_TYPES.QUOTE_SENT,
  DOMAIN_EVENT_TYPES.QUOTE_ACCEPTED,
  DOMAIN_EVENT_TYPES.QUOTE_DECLINED,
  DOMAIN_EVENT_TYPES.QUOTE_EXPIRED,
  DOMAIN_EVENT_TYPES.INVOICE_CREATED,
  DOMAIN_EVENT_TYPES.INVOICE_READY,
  DOMAIN_EVENT_TYPES.INVOICE_ISSUED,
  DOMAIN_EVENT_TYPES.INVOICE_SENT,
  DOMAIN_EVENT_TYPES.INVOICE_PARTIALLY_PAID,
  DOMAIN_EVENT_TYPES.INVOICE_PAID,
  DOMAIN_EVENT_TYPES.INVOICE_OVERDUE,
  DOMAIN_EVENT_TYPES.INVOICE_CANCELLED,
] as const;

async function workspaceOwnerId(workspaceId: string) {
  const result = await query<{ userId: string }>(
    `SELECT user_id AS "userId"
       FROM workspace_members
      WHERE workspace_id=$1 AND role='owner'
      ORDER BY joined_at, user_id
      LIMIT 1`,
    [workspaceId],
  );
  return result.rows[0]?.userId ?? null;
}

async function mirrorBusinessEvent(event: DomainEvent) {
  if (!event.workspaceId) return { skipped: true, reason: 'workspace_missing' };
  const userId = event.metadata.actorId ?? await workspaceOwnerId(event.workspaceId);
  if (!userId) return { skipped: true, reason: 'memory_user_missing' };
  const result = await addUserBusinessDataToMemory({
    workspaceId: event.workspaceId,
    userId,
    source: `lulu.domain_event.${event.type}`,
    sourceId: event.id,
    createdAt: event.occurredAt,
    data: {
      eventType: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload,
    },
    metadata: {
      event_id: event.id,
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId ?? '',
      source: 'lulu.domain_event_memory_sync',
    },
  });
  if (result.configured && 'ok' in result && !result.ok) throw new Error(`Zep memory sync failed for ${event.type}`);
  return { mirrored: result.configured && 'ok' in result && result.ok };
}

export function registerAgentMemoryEventHandler() {
  registerDomainEventHandler({
    name: 'agent-memory.business-events.v1',
    eventTypes: [...MEMORY_EVENT_TYPES],
    handle: mirrorBusinessEvent,
  });
}
