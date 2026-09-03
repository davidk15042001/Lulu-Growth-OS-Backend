import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool.js';
import type { AppendDomainEventInput, DomainEvent } from './domain-event.types.js';

const eventSelect = `
  id,
  sequence::text AS "sequence",
  workspace_id AS "workspaceId",
  event_type AS "type",
  event_version AS "version",
  aggregate_type AS "aggregateType",
  aggregate_id AS "aggregateId",
  payload,
  metadata,
  idempotency_key AS "idempotencyKey",
  status,
  attempts,
  max_attempts AS "maxAttempts",
  available_at AS "availableAt",
  locked_at AS "lockedAt",
  locked_by AS "lockedBy",
  processed_at AS "processedAt",
  dead_lettered_at AS "deadLetteredAt",
  last_error AS "lastError",
  occurred_at AS "occurredAt"
`;

async function notifyEvent(client: PoolClient | undefined, event: DomainEvent) {
  await query(
    `SELECT pg_notify('lulu_domain_events', $1)`,
    [JSON.stringify({ id: event.id, sequence: event.sequence })],
    client,
  );
}

export async function appendDomainEvent(input: AppendDomainEventInput, client?: PoolClient): Promise<DomainEvent> {
  const params = [
    input.workspaceId ?? null,
    input.type,
    input.version ?? 1,
    input.aggregateType,
    input.aggregateId ?? null,
    JSON.stringify(input.payload ?? {}),
    JSON.stringify(input.metadata ?? {}),
    input.idempotencyKey ?? null,
    input.maxAttempts ?? 10,
    input.occurredAt ?? new Date(),
  ];
  const { rows } = await query<DomainEvent>(
    `INSERT INTO domain_events (
       workspace_id, event_type, event_version, aggregate_type, aggregate_id,
       payload, metadata, idempotency_key, max_attempts, occurred_at
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)
     ON CONFLICT (idempotency_key)
       WHERE idempotency_key IS NOT NULL
     DO NOTHING
     RETURNING ${eventSelect}`,
    params,
    client,
  );

  let event = rows[0];
  if (!event && input.idempotencyKey) {
    const existing = await query<DomainEvent>(
      `SELECT ${eventSelect}
       FROM domain_events
       WHERE idempotency_key = $1
       LIMIT 1`,
      [input.idempotencyKey],
      client,
    );
    event = existing.rows[0];
  }
  if (!event) throw new Error('Domain event insert did not return an event');
  if (rows[0]) await notifyEvent(client, event);
  return event;
}

export async function findDomainEvent(eventId: string) {
  const { rows } = await query<DomainEvent>(`SELECT ${eventSelect} FROM domain_events WHERE id=$1`, [eventId]);
  return rows[0] ?? null;
}

export async function listDomainEventsAfter(afterSequence = '0', limit = 500) {
  const { rows } = await query<DomainEvent>(
    `SELECT ${eventSelect}
     FROM domain_events
     WHERE sequence > $1::bigint
     ORDER BY sequence ASC
     LIMIT $2`,
    [afterSequence, limit],
  );
  return rows;
}

export async function latestDomainEventSequence() {
  const { rows } = await query<{ sequence: string }>(
    `SELECT COALESCE(MAX(sequence), 0)::text AS sequence FROM domain_events`,
  );
  return rows[0]?.sequence ?? '0';
}

export async function listWorkspaceDomainEvents(
  workspaceId: string,
  afterSequence = '0',
  eventTypes: readonly string[] = [],
  limit = 200,
) {
  const { rows } = await query<DomainEvent>(
    `SELECT ${eventSelect}
     FROM domain_events
     WHERE workspace_id=$1
       AND sequence > $2::bigint
       AND (cardinality($3::text[]) = 0 OR event_type = ANY($3::text[]))
     ORDER BY sequence ASC
     LIMIT $4`,
    [workspaceId, afterSequence, [...eventTypes], limit],
  );
  return rows;
}

export async function latestWorkspaceDomainEventSequence(workspaceId: string) {
  const { rows } = await query<{ sequence: string }>(
    `SELECT COALESCE(MAX(sequence), 0)::text AS sequence
     FROM domain_events
     WHERE workspace_id=$1`,
    [workspaceId],
  );
  return rows[0]?.sequence ?? '0';
}

export const claimDomainEventsSql = `WITH candidates AS (
  SELECT id AS candidate_id
  FROM domain_events
  WHERE available_at <= NOW()
    AND attempts < max_attempts
    AND (
      status='pending'
      OR (status='processing' AND locked_at < NOW() - ($3::integer * INTERVAL '1 second'))
    )
  ORDER BY sequence ASC
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
UPDATE domain_events AS event
SET status='processing', attempts=event.attempts + 1, locked_at=NOW(), locked_by=$1
FROM candidates
WHERE event.id=candidates.candidate_id
RETURNING ${eventSelect}`;

export async function claimDomainEvents(workerId: string, limit: number, leaseSeconds: number) {
  return withTransaction(async (client) => {
    await query(
      `UPDATE domain_events
       SET status='dead_letter', dead_lettered_at=NOW(), locked_at=NULL, locked_by=NULL
       WHERE attempts >= max_attempts
         AND (
           status='pending'
           OR (status='processing' AND locked_at < NOW() - ($1::integer * INTERVAL '1 second'))
         )`,
      [leaseSeconds],
      client,
    );
    const { rows } = await query<DomainEvent>(
      claimDomainEventsSql,
      [workerId, limit, leaseSeconds],
      client,
    );
    return rows;
  });
}

export async function hasConsumerReceipt(eventId: string, consumerName: string) {
  const { rows } = await query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM domain_event_receipts WHERE event_id=$1 AND consumer_name=$2
     ) AS exists`,
    [eventId, consumerName],
  );
  return Boolean(rows[0]?.exists);
}

export async function recordConsumerReceipt(eventId: string, consumerName: string, result?: Record<string, unknown>) {
  await query(
    `INSERT INTO domain_event_receipts (event_id, consumer_name, result)
     VALUES ($1,$2,$3::jsonb)
     ON CONFLICT (event_id, consumer_name) DO NOTHING`,
    [eventId, consumerName, result ? JSON.stringify(result) : null],
  );
}

export async function markDomainEventProcessed(eventId: string, workerId: string) {
  await query(
    `UPDATE domain_events
     SET status='processed', processed_at=NOW(), locked_at=NULL, locked_by=NULL, last_error=NULL
     WHERE id=$1 AND status='processing' AND locked_by=$2`,
    [eventId, workerId],
  );
}

export async function heartbeatDomainEvent(eventId: string, workerId: string) {
  await query(
    `UPDATE domain_events SET locked_at=NOW()
     WHERE id=$1 AND status='processing' AND locked_by=$2`,
    [eventId, workerId],
  );
}

export async function retryDomainEvent(eventId: string, workerId: string, message: string, delayMs: number) {
  await query(
    `UPDATE domain_events
     SET status=CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'pending' END,
         available_at=NOW() + ($4::integer * INTERVAL '1 millisecond'),
         locked_at=NULL,
         locked_by=NULL,
         last_error=$3,
         dead_lettered_at=CASE WHEN attempts >= max_attempts THEN NOW() ELSE NULL END
     WHERE id=$1 AND status='processing' AND locked_by=$2`,
    [eventId, workerId, message.slice(0, 4000), Math.max(0, Math.floor(delayMs))],
  );
}
