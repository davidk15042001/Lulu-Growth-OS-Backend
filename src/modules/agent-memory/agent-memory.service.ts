import { ZepClient, type Zep } from '@getzep/zep-cloud';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

export const ZEP_ORG_KNOWLEDGE_GRAPH_ID = 'zep_org_knowledge_db724683d0b3';

type MemoryMessageRole = 'user' | 'assistant' | 'system' | 'tool';

export type AgentMemoryMessage = {
  id?: string;
  role: MemoryMessageRole;
  content: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
};

export type AgentMemoryUser = {
  userId: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  workspaceId?: string | null;
};

export type AgentMemoryBusinessData = {
  workspaceId: string;
  userId: string;
  source: string;
  sourceId?: string | null;
  data: Record<string, unknown> | string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
};

export type AgentMemoryOrgKnowledge = {
  source: string;
  sourceId?: string | null;
  data: Record<string, unknown> | string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
};

type AgentMemoryClient = {
  user: {
    add(request: Zep.CreateUserRequest, requestOptions?: AgentMemoryRequestOptions): Promise<unknown>;
  };
  thread: {
    create(request: Zep.CreateThreadRequest, requestOptions?: AgentMemoryRequestOptions): Promise<unknown>;
    addMessages(threadId: string, request: Zep.AddThreadMessagesRequest, requestOptions?: AgentMemoryRequestOptions): Promise<unknown>;
    getUserContext(threadId: string, request?: Zep.ThreadGetUserContextRequest, requestOptions?: AgentMemoryRequestOptions): Promise<Zep.ThreadContextResponse>;
  };
  graph: {
    add(request: Zep.AddDataRequest, requestOptions?: AgentMemoryRequestOptions): Promise<unknown>;
    search(request: Zep.GraphSearchQuery, requestOptions?: AgentMemoryRequestOptions): Promise<Zep.GraphSearchResults>;
  };
};

type AgentMemoryRequestOptions = {
  timeoutInSeconds?: number;
  maxRetries?: number;
};

type ZepMetadataValue = string | number | boolean | Array<string | number | boolean>;

const maxZepMetadataKeys = 10;
const maxZepMetadataStringLength = 1_000;
const maxUserContextLength = 12_000;
const maxOrganizationContextLength = 8_000;
const maxOrganizationQueryLength = 400;
const sensitiveMetadataKey = /(password|secret|token|api[_-]?key|credential|authorization|cookie)/i;
const sensitiveText = /((?:password|secret|token|api[_-]?key|credential|authorization)\s*[:=]\s*)\S+/gi;

const requestOptions = { timeoutInSeconds: 10, maxRetries: 1 } satisfies AgentMemoryRequestOptions;
let zepClient: AgentMemoryClient | null | undefined;

function configuredClient() {
  if (zepClient !== undefined) return zepClient;
  if (!env.ZEP_API_KEY) return null;
  zepClient = new ZepClient({ apiKey: env.ZEP_API_KEY });
  return zepClient;
}

export function setAgentMemoryClientForTests(client: AgentMemoryClient | null | undefined) {
  zepClient = client;
}

export function isAgentMemoryConfigured() {
  return Boolean(configuredClient());
}

export function workspaceScopedZepUserId(workspaceId: string, userId: string) {
  return `workspace:${workspaceId}:user:${userId}`;
}

function boundedText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return '';
  return value.replace(sensitiveText, '$1[redacted]').trim().slice(0, maxLength);
}

function asMetadataValue(value: unknown): ZepMetadataValue | undefined {
  if (typeof value === 'string') return boundedText(value, maxZepMetadataStringLength);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .filter((item): item is string | number | boolean => (
      typeof item === 'boolean'
      || (typeof item === 'number' && Number.isFinite(item))
      || typeof item === 'string'
    ))
    .slice(0, 24)
    .map((item) => typeof item === 'string' ? boundedText(item, 240) : item);
  return normalized.length > 0 ? normalized : undefined;
}

function metadata(input: Record<string, unknown> | undefined, required: Record<string, unknown>) {
  const result: Record<string, ZepMetadataValue> = {};
  const add = (key: string, value: unknown) => {
    if (Object.keys(result).length >= maxZepMetadataKeys
      || sensitiveMetadataKey.test(key)
      || key === '__proto__'
      || key === 'constructor'
      || key === 'prototype') return;
    const normalized = asMetadataValue(value);
    if (normalized !== undefined) result[key.slice(0, 120)] = normalized;
  };
  for (const [key, value] of Object.entries(required)) add(key, value);
  for (const [key, value] of Object.entries(input ?? {})) {
    if (Object.prototype.hasOwnProperty.call(required, key)) continue;
    add(key, value);
  }
  return result;
}

function asJsonData(data: Record<string, unknown> | string) {
  return typeof data === 'string' ? data : JSON.stringify(data);
}

function safeBusinessData(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return boundedText(value, 5_000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => safeBusinessData(item, depth + 1));
  if (!value || typeof value !== 'object') return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
    if (sensitiveMetadataKey.test(key)) continue;
    const normalized = safeBusinessData(item, depth + 1);
    if (normalized !== undefined) output[key.slice(0, 120)] = normalized;
  }
  return output;
}

function zepCreatedAt(value: unknown) {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? value.toISOString() : undefined;
  }
  return undefined;
}

function safeError(error: unknown) {
  const status = error && typeof error === 'object'
    ? (error as { statusCode?: unknown; status?: unknown }).statusCode ?? (error as { status?: unknown }).status
    : undefined;
  if (error instanceof Error) return { name: error.name, status, message: boundedText(error.message, 300) };
  return { message: boundedText(String(error), 300) };
}

function isConflict(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { statusCode?: unknown; status?: unknown; name?: unknown; message?: unknown };
  return candidate.statusCode === 409
    || candidate.status === 409
    || candidate.name === 'ConflictError'
    || (typeof candidate.message === 'string' && /\balready exists\b/i.test(candidate.message));
}

export async function ensureAgentMemoryUser(user: AgentMemoryUser) {
  const client = configuredClient();
  if (!client) return { configured: false as const };
  try {
    await client.user.add({
      userId: user.userId,
      ...(user.email ? { email: user.email } : {}),
      ...(user.firstName ? { firstName: user.firstName } : {}),
      ...(user.lastName ? { lastName: user.lastName } : {}),
      metadata: metadata(undefined, {
        source: 'lulu',
        ...(user.workspaceId ? { workspace_id: user.workspaceId } : {}),
      }),
    }, requestOptions);
    return { configured: true as const, ok: true as const };
  } catch (error) {
    if (isConflict(error)) return { configured: true as const, ok: true as const };
    logger.warn({ error: safeError(error), userId: user.userId, workspaceId: user.workspaceId ?? null }, 'Zep user upsert failed');
    return { configured: true as const, ok: false as const };
  }
}

export async function ensureWorkspaceAgentMemoryUser(user: Omit<AgentMemoryUser, 'userId'> & { userId: string; workspaceId: string }) {
  return ensureAgentMemoryUser({
    ...user,
    userId: workspaceScopedZepUserId(user.workspaceId, user.userId),
  });
}

export async function createAgentMemoryThread(input: { workspaceId: string; userId: string; conversationId: string }) {
  const client = configuredClient();
  if (!client) return { configured: false as const, threadId: null };
  const zepUserId = workspaceScopedZepUserId(input.workspaceId, input.userId);
  const threadId = `conversation:${input.conversationId}`;
  try {
    await ensureAgentMemoryUser({ userId: zepUserId, workspaceId: input.workspaceId });
    await client.thread.create({ threadId, userId: zepUserId }, requestOptions);
    return { configured: true as const, threadId };
  } catch (error) {
    if (isConflict(error)) return { configured: true as const, threadId };
    logger.warn({ error: safeError(error), workspaceId: input.workspaceId, conversationId: input.conversationId }, 'Zep thread creation failed');
    return { configured: true as const, threadId: null };
  }
}

export async function addAgentMemoryMessages(input: {
  workspaceId: string;
  userId: string;
  threadId: string | null | undefined;
  conversationId: string;
  messages: AgentMemoryMessage[];
}) {
  const client = configuredClient();
  if (!client || !input.threadId || input.messages.length === 0) return { configured: Boolean(client), ok: false as const };
  try {
    await client.thread.addMessages(input.threadId, {
      messages: input.messages.map((message) => {
        const createdAt = zepCreatedAt(message.createdAt);
        return {
          role: message.role,
          name: message.role === 'user' ? 'Workspace user' : message.role === 'assistant' ? 'Lulu AI' : 'Lulu system',
          content: message.content,
          ...(message.id ? { uuid: message.id } : {}),
          ...(createdAt ? { createdAt } : {}),
          metadata: metadata(message.metadata, {
            workspace_id: input.workspaceId,
            user_id: input.userId,
            conversation_id: input.conversationId,
            source: 'lulu.ai_conversation',
          }),
        };
      }),
    }, requestOptions);
    return { configured: true as const, ok: true as const };
  } catch (error) {
    logger.warn({ error: safeError(error), workspaceId: input.workspaceId, conversationId: input.conversationId }, 'Zep message ingestion failed');
    return { configured: true as const, ok: false as const };
  }
}

export async function getAgentMemoryContext(input: {
  workspaceId: string;
  userId: string;
  threadId: string | null | undefined;
  conversationId: string;
}) {
  const client = configuredClient();
  if (!client || !input.threadId) return null;
  try {
    const result = await client.thread.getUserContext(input.threadId, undefined, requestOptions);
    const context = boundedText(result.context, maxUserContextLength);
    return context || null;
  } catch (error) {
    logger.warn({ error: safeError(error), workspaceId: input.workspaceId, conversationId: input.conversationId }, 'Zep context retrieval failed');
    return null;
  }
}

export async function createAgentCollaborationMemoryThread(input: {
  workspaceId: string;
  userId: string;
  runId: string;
}) {
  const client = configuredClient();
  if (!client) return { configured: false as const, threadId: null };
  const zepUserId = workspaceScopedZepUserId(input.workspaceId, input.userId);
  const threadId = `agent-run:${input.runId}`;
  try {
    await ensureAgentMemoryUser({ userId: zepUserId, workspaceId: input.workspaceId });
    await client.thread.create({ threadId, userId: zepUserId }, requestOptions);
    return { configured: true as const, threadId };
  } catch (error) {
    if (isConflict(error)) return { configured: true as const, threadId };
    logger.warn({ error: safeError(error), workspaceId: input.workspaceId, runId: input.runId }, 'Zep agent-collaboration thread creation failed');
    return { configured: true as const, threadId: null };
  }
}

export async function addAgentCollaborationMemoryMessages(input: {
  workspaceId: string;
  userId: string;
  threadId: string | null | undefined;
  runId: string;
  messages: Array<AgentMemoryMessage & { senderType?: 'agent' | 'system' | 'human'; senderAgentId?: string | null; messageType?: string }>;
}) {
  const client = configuredClient();
  if (!client || !input.threadId || input.messages.length === 0) return { configured: Boolean(client), ok: false as const };
  try {
    await client.thread.addMessages(input.threadId, {
      messages: input.messages.map((message) => {
        const createdAt = zepCreatedAt(message.createdAt);
        return {
          role: message.senderType === 'system' ? 'system' : message.senderType === 'human' ? 'user' : 'assistant',
          name: boundedText(message.senderAgentId ?? (message.senderType === 'human' ? 'Workspace user' : 'Lulu system'), 120),
          content: message.content,
          ...(message.id ? { uuid: message.id } : {}),
          ...(createdAt ? { createdAt } : {}),
          metadata: metadata(message.metadata, {
            workspace_id: input.workspaceId,
            user_id: input.userId,
            agent_run_id: input.runId,
            source: 'lulu.agent_collaboration',
            ...(message.senderAgentId ? { sender_agent_id: message.senderAgentId } : {}),
            ...(message.messageType ? { message_type: message.messageType } : {}),
          }),
        };
      }),
    }, requestOptions);
    return { configured: true as const, ok: true as const };
  } catch (error) {
    logger.warn({ error: safeError(error), workspaceId: input.workspaceId, runId: input.runId }, 'Zep agent-collaboration message ingestion failed');
    return { configured: true as const, ok: false as const };
  }
}

export async function getAgentCollaborationMemoryContext(input: {
  workspaceId: string;
  userId: string;
  threadId: string | null | undefined;
  runId: string;
}) {
  const client = configuredClient();
  if (!client || !input.threadId) return null;
  try {
    const result = await client.thread.getUserContext(input.threadId, undefined, requestOptions);
    const context = boundedText(result.context, maxUserContextLength);
    return context || null;
  } catch (error) {
    logger.warn({ error: safeError(error), workspaceId: input.workspaceId, runId: input.runId }, 'Zep agent-collaboration context retrieval failed');
    return null;
  }
}

export async function getOrganizationKnowledgeContext(input: { query: string; maxCharacters?: number }) {
  const client = configuredClient();
  const query = boundedText(input.query, maxOrganizationQueryLength);
  if (!client || !query) return null;
  const maxCharacters = Math.max(1_000, Math.min(maxOrganizationContextLength, input.maxCharacters ?? maxOrganizationContextLength));
  try {
    const result = await client.graph.search({
      graphId: ZEP_ORG_KNOWLEDGE_GRAPH_ID,
      query,
      scope: 'auto',
      maxCharacters,
    }, requestOptions);
    const context = boundedText(result.context, maxCharacters);
    return context || null;
  } catch (error) {
    logger.warn({ error: safeError(error), queryLength: query.length }, 'Zep organization-knowledge retrieval failed');
    return null;
  }
}

export async function addUserBusinessDataToMemory(input: AgentMemoryBusinessData) {
  const client = configuredClient();
  if (!client) return { configured: false as const };
  const zepUserId = workspaceScopedZepUserId(input.workspaceId, input.userId);
  const ensured = await ensureAgentMemoryUser({ userId: zepUserId, workspaceId: input.workspaceId });
  if (!ensured.configured || !('ok' in ensured && ensured.ok)) return { configured: ensured.configured, ok: false as const };
  try {
    const createdAt = zepCreatedAt(input.createdAt);
    await client.graph.add({
      userId: zepUserId,
      type: typeof input.data === 'string' ? 'text' : 'json',
      data: asJsonData(safeBusinessData(input.data) as Record<string, unknown> | string),
      sourceDescription: input.source,
      ...(createdAt ? { createdAt } : {}),
      metadata: metadata(input.metadata, {
        workspace_id: input.workspaceId,
        user_id: input.userId,
        source: input.source,
        ...(input.sourceId ? { source_id: input.sourceId } : {}),
      }),
    }, requestOptions);
    return { configured: true as const, ok: true as const };
  } catch (error) {
    logger.warn({ error: safeError(error), workspaceId: input.workspaceId, source: input.source }, 'Zep business-data ingestion failed');
    return { configured: true as const, ok: false as const };
  }
}

export async function addOrganizationKnowledgeToMemory(input: AgentMemoryOrgKnowledge) {
  const client = configuredClient();
  if (!client) return { configured: false as const };
  try {
    const createdAt = zepCreatedAt(input.createdAt);
    await client.graph.add({
      graphId: ZEP_ORG_KNOWLEDGE_GRAPH_ID,
      type: typeof input.data === 'string' ? 'text' : 'json',
      data: asJsonData(input.data),
      sourceDescription: input.source,
      ...(createdAt ? { createdAt } : {}),
      metadata: metadata(input.metadata, {
        source: input.source,
        ...(input.sourceId ? { source_id: input.sourceId } : {}),
        scope: 'shared_organization_knowledge',
      }),
    }, requestOptions);
    return { configured: true as const, ok: true as const };
  } catch (error) {
    logger.warn({ error: safeError(error), source: input.source }, 'Zep org-knowledge ingestion failed');
    return { configured: true as const, ok: false as const };
  }
}
