import { query, withTransaction } from '../../db/pool.js';
import type { DomainEvent } from '../../events/domain-event.types.js';

export type ReactiveDeferral = {
  id: string;
  workspaceId: string;
  sourceEventId: string;
  sourceEventType: string;
  status: 'WAITING' | 'RESUMING' | 'RESUMED' | 'FAILED';
  attempts: number;
  lastError: string | null;
};

const select = `id,workspace_id AS "workspaceId",source_event_id AS "sourceEventId",
  source_event_type AS "sourceEventType",status,attempts,last_error AS "lastError"`;
const returningSelect = `deferral.id,deferral.workspace_id AS "workspaceId",
  deferral.source_event_id AS "sourceEventId",deferral.source_event_type AS "sourceEventType",
  deferral.status,deferral.attempts,deferral.last_error AS "lastError"`;

export async function deferReactiveEvent(event: DomainEvent) {
  if (!event.workspaceId) return null;
  const { rows } = await query<ReactiveDeferral>(
    `INSERT INTO agent_reactive_deferrals(
       workspace_id,source_event_id,source_event_type,required_funding,status
     ) VALUES($1,$2,$3,'AI_WALLET','WAITING')
     ON CONFLICT(workspace_id,source_event_id) DO UPDATE SET
       status=CASE
         WHEN agent_reactive_deferrals.status='RESUMED' THEN 'RESUMED'
         ELSE 'WAITING'
       END,
       locked_at=NULL,
       last_error=NULL
     RETURNING ${select}`,
    [event.workspaceId, event.id, event.type],
  );
  return rows[0] ?? null;
}

export async function claimWorkspaceReactiveDeferrals(workspaceId: string, limit = 100) {
  return withTransaction(async (client) => {
    const { rows } = await query<ReactiveDeferral>(
      `WITH candidates AS (
         SELECT id
         FROM agent_reactive_deferrals
         WHERE workspace_id=$1
           AND attempts < 10
           AND (
             status='WAITING'
             OR (status='RESUMING' AND locked_at < NOW() - INTERVAL '5 minutes')
           )
         ORDER BY created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE agent_reactive_deferrals deferral
       SET status='RESUMING',attempts=deferral.attempts+1,locked_at=NOW(),last_error=NULL
       FROM candidates
       WHERE deferral.id=candidates.id
       RETURNING ${returningSelect}`,
      [workspaceId, limit],
      client,
    );
    return rows;
  });
}

export async function markReactiveDeferralResumed(id: string) {
  await query(
    `UPDATE agent_reactive_deferrals
     SET status='RESUMED',resumed_at=NOW(),locked_at=NULL,last_error=NULL
     WHERE id=$1 AND status='RESUMING'`,
    [id],
  );
}

export async function releaseReactiveDeferral(id: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await query(
    `UPDATE agent_reactive_deferrals
     SET status=CASE WHEN attempts >= 10 THEN 'FAILED' ELSE 'WAITING' END,
         locked_at=NULL,last_error=$2
     WHERE id=$1 AND status='RESUMING'`,
    [id, message.slice(0, 4000)],
  );
}

export async function countOutstandingReactiveDeferrals(workspaceId: string) {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_reactive_deferrals
     WHERE workspace_id=$1 AND status IN ('WAITING','RESUMING')`,
    [workspaceId],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function getReactiveDeferral(workspaceId: string, sourceEventId: string) {
  const { rows } = await query<ReactiveDeferral>(
    `SELECT ${select} FROM agent_reactive_deferrals
     WHERE workspace_id=$1 AND source_event_id=$2`,
    [workspaceId, sourceEventId],
  );
  return rows[0] ?? null;
}
