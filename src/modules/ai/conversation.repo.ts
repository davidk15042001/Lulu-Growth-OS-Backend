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
