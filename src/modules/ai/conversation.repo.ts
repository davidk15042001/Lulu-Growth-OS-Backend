import { query, withTransaction } from '../../db/pool.js';
import { buildUpdateSet } from '../../db/update-builder.js';
import type {
  CreateConversationInput,
  CreateMessageInput,
  ListConversationsQuery,
  ListMessagesQuery,
  UpdateConversationInput,
} from './conversation.validator.js';

type Conversation = {
  id: string;
  workspaceId: string;
  userId: string;
  title: string;
  model: string | null;
  zepThreadId: string | null;
  metadata: Record<string, unknown>;
  messageCount: number;
  lastMessageAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const conversationSelect = `
  c.id,
  c.workspace_id AS "workspaceId",
  c.user_id AS "userId",
  c.title,
  c.model,
  c.zep_thread_id AS "zepThreadId",
  c.metadata,
  (SELECT count(*)::int FROM ai_messages m WHERE m.conversation_id = c.id) AS "messageCount",
  (SELECT max(m.created_at) FROM ai_messages m WHERE m.conversation_id = c.id) AS "lastMessageAt",
  c.archived_at AS "archivedAt",
  c.created_at AS "createdAt",
  c.updated_at AS "updatedAt"
`;

export async function listConversations(
  workspaceId: string,
  userId: string,
  filters: ListConversationsQuery
) {
  const archivedCondition = filters.archived ? 'c.archived_at IS NOT NULL' : 'c.archived_at IS NULL';
  const offset = (filters.page - 1) * filters.limit;
  const [items, count] = await Promise.all([
    query<Conversation>(
      `SELECT ${conversationSelect}
       FROM ai_conversations c
       WHERE c.workspace_id = $1 AND c.user_id = $2 AND ${archivedCondition}
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT $3 OFFSET $4`,
      [workspaceId, userId, filters.limit, offset]
    ),
    query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM ai_conversations c
       WHERE c.workspace_id = $1 AND c.user_id = $2 AND ${archivedCondition}`,
      [workspaceId, userId]
    ),
  ]);
  const total = Number.parseInt(count.rows[0]?.total ?? '0', 10);
  return {
    items: items.rows,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      pages: Math.ceil(total / filters.limit),
    },
  };
}

export async function findConversation(
  workspaceId: string,
  userId: string,
  conversationId: string,
  includeArchived = false
) {
  const { rows } = await query<Conversation>(
    `SELECT ${conversationSelect}
     FROM ai_conversations c
     WHERE c.workspace_id = $1 AND c.user_id = $2 AND c.id = $3
       ${includeArchived ? '' : 'AND c.archived_at IS NULL'}
     LIMIT 1`,
    [workspaceId, userId, conversationId]
  );
  return rows[0];
}

export async function createConversation(
  workspaceId: string,
  userId: string,
  input: CreateConversationInput
) {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO ai_conversations (workspace_id, user_id, title, model, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [workspaceId, userId, input.title ?? 'New conversation', input.model ?? null, input.metadata ?? {}]
  );
  return rows[0]?.id;
}

export async function setConversationZepThreadId(
  workspaceId: string,
  userId: string,
  conversationId: string,
  zepThreadId: string
) {
  const { rowCount } = await query(
    `UPDATE ai_conversations
     SET zep_thread_id = $4
     WHERE workspace_id = $1 AND user_id = $2 AND id = $3 AND archived_at IS NULL`,
    [workspaceId, userId, conversationId, zepThreadId]
  );
  return rowCount > 0;
}

const conversationUpdateColumns: Partial<Record<keyof UpdateConversationInput, string>> = {
  title: 'title',
  model: 'model',
  metadata: 'metadata',
};

export async function updateConversation(
  workspaceId: string,
  userId: string,
  conversationId: string,
  input: UpdateConversationInput
) {
  const update = buildUpdateSet(input, conversationUpdateColumns, 3);
  const { rowCount } = await query(
    `UPDATE ai_conversations
     SET ${update.assignments.join(', ')}
     WHERE workspace_id = $1 AND user_id = $2 AND id = $3 AND archived_at IS NULL`,
    [workspaceId, userId, conversationId, ...update.values]
  );
  return rowCount > 0;
}

export async function archiveConversation(workspaceId: string, userId: string, conversationId: string) {
  const { rowCount } = await query(
    `UPDATE ai_conversations
     SET archived_at = NOW()
     WHERE workspace_id = $1 AND user_id = $2 AND id = $3 AND archived_at IS NULL`,
    [workspaceId, userId, conversationId]
  );
  return rowCount > 0;
}

type Message = {
  id: string;
  conversationId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolName: string | null;
  toolCallId: string | null;
  metadata: Record<string, unknown>;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
};

const messageSelect = `
  m.id,
  m.conversation_id AS "conversationId",
  m.role,
  m.content,
  m.tool_name AS "toolName",
  m.tool_call_id AS "toolCallId",
  m.metadata,
  m.input_tokens AS "inputTokens",
  m.output_tokens AS "outputTokens",
  m.created_at AS "createdAt"
`;

const messageReturning = `
  id,
  conversation_id AS "conversationId",
  role,
  content,
  tool_name AS "toolName",
  tool_call_id AS "toolCallId",
  metadata,
  input_tokens AS "inputTokens",
  output_tokens AS "outputTokens",
  created_at AS "createdAt"
`;

export async function listMessages(
  workspaceId: string,
  userId: string,
  conversationId: string,
  filters: ListMessagesQuery
) {
  const offset = (filters.page - 1) * filters.limit;
  const [items, count] = await Promise.all([
    query<Message>(
      `SELECT ${messageSelect}
       FROM ai_messages m
       JOIN ai_conversations c ON c.id = m.conversation_id
       WHERE c.workspace_id = $1 AND c.user_id = $2 AND c.id = $3 AND c.archived_at IS NULL
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT $4 OFFSET $5`,
      [workspaceId, userId, conversationId, filters.limit, offset]
    ),
    query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM ai_messages m
       JOIN ai_conversations c ON c.id = m.conversation_id
       WHERE c.workspace_id = $1 AND c.user_id = $2 AND c.id = $3 AND c.archived_at IS NULL`,
      [workspaceId, userId, conversationId]
    ),
  ]);
  const total = Number.parseInt(count.rows[0]?.total ?? '0', 10);
  return {
    items: items.rows,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      pages: Math.ceil(total / filters.limit),
    },
  };
}

export async function createUserMessage(
  workspaceId: string,
  userId: string,
  conversationId: string,
  input: CreateMessageInput
) {
  return withTransaction(async (client) => {
    const conversation = await query<{ title: string }>(
      `SELECT title
       FROM ai_conversations
       WHERE workspace_id = $1 AND user_id = $2 AND id = $3 AND archived_at IS NULL
       FOR UPDATE`,
      [workspaceId, userId, conversationId],
      client
    );
    const current = conversation.rows[0];
    if (!current) return undefined;

    const { rows } = await query<Message>(
      `INSERT INTO ai_messages (conversation_id, role, content, metadata)
       VALUES ($1, 'user', $2, $3)
       RETURNING ${messageReturning}`,
      [conversationId, input.content, input.metadata ?? {}],
      client
    );

    const generatedTitle = input.content.replace(/\s+/g, ' ').trim().slice(0, 80);
    await query(
      `UPDATE ai_conversations
       SET title = CASE WHEN title = 'New conversation' THEN $2 ELSE title END,
           updated_at = NOW()
       WHERE id = $1`,
      [conversationId, generatedTitle],
      client
    );
    return rows[0];
  });
}

export async function appendAssistantMessage(
  conversationId: string,
  content: string,
  metadata: Record<string, unknown> = {},
  usage?: { inputTokens?: number; outputTokens?: number }
) {
  const { rows } = await query<Message>(
    `INSERT INTO ai_messages (
       conversation_id, role, content, metadata, input_tokens, output_tokens
     ) VALUES ($1, 'assistant', $2, $3, $4, $5)
     RETURNING ${messageReturning}`,
    [conversationId, content, metadata, usage?.inputTokens ?? null, usage?.outputTokens ?? null]
  );
  return rows[0];
}

export async function conversationTurns(
  workspaceId: string,
  userId: string,
  conversationId: string,
  limit = 50
) {
  const { rows } = await query<{ role: 'user' | 'assistant'; content: string }>(
    `SELECT recent.role, recent.content
     FROM (
       SELECT m.role, m.content, m.created_at, m.id
       FROM ai_messages m
       JOIN ai_conversations c ON c.id = m.conversation_id
       WHERE c.workspace_id = $1 AND c.user_id = $2 AND c.id = $3
         AND c.archived_at IS NULL AND m.role IN ('user', 'assistant')
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $4
     ) recent
     ORDER BY recent.created_at ASC, recent.id ASC`,
    [workspaceId, userId, conversationId, limit]
  );
  return rows;
}

/** Bounded, workspace-scoped export for user-owned assistant work. */
export async function exportConversation(
  workspaceId: string,
  userId: string,
  conversationId: string,
) {
  const conversation = await findConversation(workspaceId, userId, conversationId, true);
  if (!conversation) return undefined;
  const maxItems = 5_000;
  const [messages, actions, sessions, transcripts] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT ${messageSelect}
         FROM ai_messages m
        WHERE m.conversation_id=$1
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT $2`,
      [conversationId, maxItems + 1],
    ),
    query<Record<string, unknown>>(
      `SELECT id, action_type AS "type", summary, payload, status,
              result, error_code AS "errorCode", error_message AS "errorMessage",
              created_at AS "createdAt", completed_at AS "completedAt"
         FROM assistant_action_requests
        WHERE workspace_id=$1 AND conversation_id=$2 AND requested_by=$3
        ORDER BY created_at ASC, id ASC
        LIMIT $4`,
      [workspaceId, conversationId, userId, maxItems + 1],
    ),
    query<Record<string, unknown>>(
      `SELECT id, transport, provider, status, language, voice, speed::text AS speed,
              mode, metadata, started_at AS "startedAt", ended_at AS "endedAt"
         FROM ai_voice_sessions
        WHERE workspace_id=$1 AND user_id=$2 AND conversation_id=$3
        ORDER BY started_at ASC, id ASC
        LIMIT $4`,
      [workspaceId, userId, conversationId, maxItems + 1],
    ),
    query<Record<string, unknown>>(
      `SELECT t.id, t.session_id AS "sessionId", t.direction, t.content,
              t.sequence_number AS "sequenceNumber", t.is_final AS "isFinal",
              t.source, t.started_at AS "startedAt", t.ended_at AS "endedAt",
              t.metadata, t.created_at AS "createdAt"
         FROM ai_voice_transcripts t
         JOIN ai_voice_sessions s ON s.id=t.session_id
        WHERE t.workspace_id=$1 AND s.workspace_id=$1 AND s.user_id=$2 AND s.conversation_id=$3
        ORDER BY t.sequence_number ASC, t.created_at ASC, t.id ASC
        LIMIT $4`,
      [workspaceId, userId, conversationId, maxItems + 1],
    ),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    conversation,
    messages: messages.rows.slice(0, maxItems),
    actions: actions.rows.slice(0, maxItems),
    voiceSessions: sessions.rows.slice(0, maxItems),
    voiceTranscripts: transcripts.rows.slice(0, maxItems),
    truncated: {
      messages: messages.rows.length > maxItems,
      actions: actions.rows.length > maxItems,
      voiceSessions: sessions.rows.length > maxItems,
      voiceTranscripts: transcripts.rows.length > maxItems,
    },
  };
}
