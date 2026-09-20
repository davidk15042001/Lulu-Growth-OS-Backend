import { query } from '../../db/pool.js';
import type {
  AgentCollaborationMessage,
  AgentCollaborationPage,
  AgentCollaborationThread,
  AgentCollaborationThreadStatus,
} from './agent-collaboration.types.js';

const threadSelect = `id, workspace_id AS "workspaceId", run_id AS "runId",
  company_brain_task_id AS "companyBrainTaskId", topic, status,
  zep_thread_id AS "zepThreadId", created_at AS "createdAt", updated_at AS "updatedAt"`;
const messageSelect = `id, workspace_id AS "workspaceId", thread_id AS "threadId", run_id AS "runId",
  step_id AS "stepId", sender_type AS "senderType", sender_agent_id AS "senderAgentId",
  recipient_agent_id AS "recipientAgentId", message_type AS "messageType", content,
  structured_content AS "structuredContent", evidence_refs AS "evidenceRefs",
  confidence::float AS confidence, idempotency_key AS "idempotencyKey",
  zep_synced_at AS "zepSyncedAt", created_at AS "createdAt"`;

export async function getThread(workspaceId: string, runId: string) {
  const { rows } = await query<AgentCollaborationThread>(
    `SELECT ${threadSelect} FROM agent_collaboration_threads WHERE workspace_id=$1 AND run_id=$2`,
    [workspaceId, runId],
  );
  return rows[0] ?? null;
}

export async function ensureThread(input: {
  workspaceId: string;
  runId: string;
  topic: string;
  companyBrainTaskId?: string | null;
}) {
  const { rows } = await query<AgentCollaborationThread>(
    `INSERT INTO agent_collaboration_threads(workspace_id,run_id,company_brain_task_id,topic)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(workspace_id,run_id)
     DO UPDATE SET
       company_brain_task_id=COALESCE(agent_collaboration_threads.company_brain_task_id, EXCLUDED.company_brain_task_id),
       topic=CASE WHEN agent_collaboration_threads.topic='' THEN EXCLUDED.topic ELSE agent_collaboration_threads.topic END,
       updated_at=NOW()
     RETURNING ${threadSelect}`,
    [input.workspaceId, input.runId, input.companyBrainTaskId ?? null, input.topic],
  );
  if (!rows[0]) throw new Error('Agent collaboration thread insert did not return a row');
  return rows[0];
}

export async function setThreadZepThreadId(workspaceId: string, runId: string, zepThreadId: string) {
  const { rows } = await query<AgentCollaborationThread>(
    `UPDATE agent_collaboration_threads
     SET zep_thread_id=COALESCE(zep_thread_id,$3), updated_at=NOW()
     WHERE workspace_id=$1 AND run_id=$2
     RETURNING ${threadSelect}`,
    [workspaceId, runId, zepThreadId],
  );
  return rows[0] ?? null;
}

export async function closeThread(input: {
  workspaceId: string;
  runId: string;
  status: Exclude<AgentCollaborationThreadStatus, 'active'>;
}) {
  const { rows } = await query<AgentCollaborationThread>(
    `UPDATE agent_collaboration_threads
     SET status=$3, updated_at=NOW()
     WHERE workspace_id=$1 AND run_id=$2
     RETURNING ${threadSelect}`,
    [input.workspaceId, input.runId, input.status],
  );
  return rows[0] ?? null;
}

export async function addMessage(input: {
  workspaceId: string;
  threadId: string;
  runId: string;
  stepId?: string | null;
  senderType: 'agent' | 'system' | 'human';
  senderAgentId?: string | null;
  recipientAgentId?: string | null;
  messageType: AgentCollaborationMessage['messageType'];
  content: string;
  structuredContent?: Record<string, unknown>;
  evidenceRefs?: string[];
  confidence?: number | null;
  idempotencyKey: string;
}) {
  const inserted = await query<AgentCollaborationMessage>(
    `INSERT INTO agent_collaboration_messages(
       workspace_id,thread_id,run_id,step_id,sender_type,sender_agent_id,recipient_agent_id,
       message_type,content,structured_content,evidence_refs,confidence,idempotency_key
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13)
     ON CONFLICT(workspace_id,thread_id,idempotency_key) DO NOTHING
     RETURNING ${messageSelect}`,
    [
      input.workspaceId,
      input.threadId,
      input.runId,
      input.stepId ?? null,
      input.senderType,
      input.senderAgentId ?? null,
      input.recipientAgentId ?? null,
      input.messageType,
      input.content,
      JSON.stringify(input.structuredContent ?? {}),
      JSON.stringify(input.evidenceRefs ?? []),
      input.confidence ?? null,
      input.idempotencyKey,
    ],
  );
  if (inserted.rows[0]) return { message: inserted.rows[0], created: true as const };
  const { rows } = await query<AgentCollaborationMessage>(
    `SELECT ${messageSelect} FROM agent_collaboration_messages
     WHERE workspace_id=$1 AND thread_id=$2 AND idempotency_key=$3`,
    [input.workspaceId, input.threadId, input.idempotencyKey],
  );
  if (!rows[0]) throw new Error('Agent collaboration message replay did not return a row');
  return { message: rows[0], created: false as const };
}

export async function markMessageZepSynced(workspaceId: string, messageId: string) {
  const { rowCount } = await query(
    `UPDATE agent_collaboration_messages
     SET zep_synced_at=COALESCE(zep_synced_at,NOW())
     WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, messageId],
  );
  return rowCount > 0;
}

export async function listUnsyncedMessages(workspaceId: string, runId: string, limit: number) {
  const { rows } = await query<AgentCollaborationMessage>(
    `SELECT ${messageSelect} FROM agent_collaboration_messages
     WHERE workspace_id=$1 AND run_id=$2 AND zep_synced_at IS NULL
     ORDER BY created_at ASC,id ASC
     LIMIT $3`,
    [workspaceId, runId, limit],
  );
  return rows;
}

export async function listMessages(input: {
  workspaceId: string;
  runId: string;
  limit: number;
  beforeMessageId?: string | null;
}): Promise<AgentCollaborationPage> {
  const thread = await getThread(input.workspaceId, input.runId);
  if (!thread) return { items: [], nextBeforeMessageId: null };
  let cursor: { createdAt: string; id: string } | null = null;
  if (input.beforeMessageId) {
    const result = await query<{ createdAt: string; id: string }>(
      `SELECT created_at AS "createdAt",id FROM agent_collaboration_messages
       WHERE workspace_id=$1 AND thread_id=$2 AND id=$3`,
      [input.workspaceId, thread.id, input.beforeMessageId],
    );
    cursor = result.rows[0] ?? null;
  }
  const { rows } = await query<AgentCollaborationMessage>(
    `SELECT ${messageSelect} FROM agent_collaboration_messages
     WHERE workspace_id=$1 AND thread_id=$2
       AND ($3::timestamptz IS NULL OR (created_at,id) < ($3::timestamptz,$4::uuid))
     ORDER BY created_at DESC,id DESC
     LIMIT $5`,
    [input.workspaceId, thread.id, cursor?.createdAt ?? null, cursor?.id ?? null, input.limit + 1],
  );
  const hasMore = rows.length > input.limit;
  const page = (hasMore ? rows.slice(0, input.limit) : rows).reverse();
  return {
    items: page,
    nextBeforeMessageId: hasMore ? page[0]?.id ?? null : null,
  };
}

export async function listRecentMessageContext(workspaceId: string, runId: string, limit: number) {
  const page = await listMessages({ workspaceId, runId, limit });
  return page.items;
}
