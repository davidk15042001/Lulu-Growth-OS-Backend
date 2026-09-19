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
