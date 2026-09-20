import { Composio } from '@composio/core';
import { env, hasComposio } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';

let composio: Composio | undefined;

function client() {
  if (!hasComposio || !env.COMPOSIO_API_KEY) {
    throw new AppError(503, 'COMPOSIO_NOT_CONFIGURED', 'Composio is not configured on the server.');
  }
  composio ??= new Composio({ apiKey: env.COMPOSIO_API_KEY, allowTracking: false });
  return composio;
}

function scopedUserId(workspaceId: string, userId: string) {
  // Stable, tenant-scoped identity: a user can never reuse a connection from
  // another workspace accidentally.
  return `lulu:${workspaceId}:${userId}`;
}

export function getComposioUserId(workspaceId: string, userId: string) {
  return scopedUserId(workspaceId, userId);
}

export function normalizeComposioToolkit(value: string) {
  const toolkit = value.trim().toLowerCase();
  if (!toolkit || toolkit.length > 80 || !/^[a-z0-9][a-z0-9_-]*$/.test(toolkit)) {
    throw new AppError(422, 'COMPOSIO_TOOLKIT_INVALID', 'A valid Composio toolkit slug is required.');
  }
  return toolkit;
}

export function isComposioConfigured() {
  return hasComposio;
}

export async function createWorkspaceSession(input: { workspaceId: string; userId: string; toolkits?: string[] }) {
  const toolkits = (input.toolkits ?? []).map((toolkit) => toolkit.trim().toLowerCase()).filter(Boolean).slice(0, 50);
  const session = await client().sessions.create(scopedUserId(input.workspaceId, input.userId), {
    ...(toolkits.length ? { toolkits: { enable: toolkits } } : {}),
    manageConnections: { enable: true },
    mcp: true,
  });
  return {
    sessionId: session.sessionId,
    userId: scopedUserId(input.workspaceId, input.userId),
    toolkits,
    mcp: session.mcp,
  };
}

export async function listWorkspaceToolkits(input: { workspaceId: string; userId: string; search?: string }) {
  const session = await client().sessions.create(scopedUserId(input.workspaceId, input.userId), {
    manageConnections: { enable: true },
  });
  const result = await session.toolkits({
    limit: 100,
    ...(input.search ? { search: input.search.trim().slice(0, 80) } : {}),
  });
  return {
    items: result.items.map((toolkit) => ({
      slug: toolkit.slug,
      name: toolkit.name,
      isNoAuth: toolkit.isNoAuth,
      ...(toolkit.logo ? { logo: toolkit.logo } : {}),
      connected: Boolean(toolkit.connection?.isActive),
      connectionStatus: toolkit.connection?.connectedAccount?.status ?? null,
      connectedAccountId: toolkit.connection?.connectedAccount?.id ?? null,
    })),
    nextCursor: result.cursor ?? null,
    totalPages: result.totalPages,
  };
}

export async function authorizeWorkspaceToolkit(input: { workspaceId: string; userId: string; toolkit: string }) {
  const toolkit = normalizeComposioToolkit(input.toolkit);
  const session = await client().sessions.create(scopedUserId(input.workspaceId, input.userId), {
    toolkits: { enable: [toolkit] },
    manageConnections: { enable: true },
  });
  const connection = await session.authorize(toolkit);
  if (!connection.redirectUrl) {
    throw new AppError(502, 'COMPOSIO_CONNECT_LINK_MISSING', 'Composio did not return a connection link for this toolkit.');
  }
  return {
    sessionId: session.sessionId,
    toolkit,
    connectedAccountId: connection.id,
    redirectUrl: connection.redirectUrl,
  };
}
