import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';
import { forbiddenError } from '../../utils/app-error.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import {
  ROLE_CAPABILITIES,
  type WorkspaceActorType,
  type WorkspaceCapability,
  type WorkspaceRole,
} from './workspace-permissions.js';

export type WorkspaceAuthorizationInput = {
  workspaceId: string;
  userId: string;
  capability: WorkspaceCapability;
  actorType?: WorkspaceActorType;
  resource?: { type: string; id?: string };
  context?: Record<string, unknown>;
};

export type WorkspaceAuthorizationDecision = {
  allowed: boolean;
  reason: string;
  role: WorkspaceRole | null;
  capability: WorkspaceCapability;
  actorType: WorkspaceActorType;
  policySource: 'workspace_role_capabilities' | 'fallback_registry' | 'system_policy';
};

/**
 * The single workspace policy decision point. Non-human actors are never
 * omnipotent: until a dedicated actor principal exists they must carry a
 * human workspace membership and receive the same capability decision.
 */
export async function authorizeWorkspaceAction(input: WorkspaceAuthorizationInput, client?: PoolClient): Promise<WorkspaceAuthorizationDecision> {
  const actorType = input.actorType ?? 'USER';
  const membership = (await query<{ role: WorkspaceRole }>(
    `SELECT wm.role
       FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id AND w.deleted_at IS NULL
       JOIN users u ON u.id = wm.user_id AND u.deleted_at IS NULL
      WHERE wm.workspace_id = $1 AND wm.user_id = $2
      LIMIT 1`,
    [input.workspaceId, input.userId],
    client,
  )).rows[0];
  if (!membership) {
    const decision: WorkspaceAuthorizationDecision = {
      allowed: false, reason: 'not_a_workspace_member', role: null,
      capability: input.capability, actorType, policySource: 'system_policy',
    };
    await recordSecurityEvent({ eventType: 'AUTHORIZATION_DENIED', workspaceId: input.workspaceId, userId: input.userId, metadata: { capability: input.capability, reason: decision.reason } }, client);
    return decision;
  }

  const registryRows = (await query<{ capabilityKey: WorkspaceCapability }>(
    `SELECT capability_key AS "capabilityKey"
       FROM workspace_role_capabilities
      WHERE role = $1 AND capability_key = $2
      LIMIT 1`,
    [membership.role, input.capability],
    client,
  )).rows;
  const allowed = registryRows.length > 0 || Boolean(ROLE_CAPABILITIES[membership.role]?.has(input.capability));
  const decision: WorkspaceAuthorizationDecision = {
    allowed,
    reason: allowed ? 'capability_granted' : 'capability_not_granted',
    role: membership.role,
    capability: input.capability,
    actorType,
    policySource: registryRows.length > 0 ? 'workspace_role_capabilities' : 'fallback_registry',
  };
  if (!allowed) {
    await recordSecurityEvent({ eventType: 'AUTHORIZATION_DENIED', workspaceId: input.workspaceId, userId: input.userId, metadata: { capability: input.capability, role: membership.role, reason: decision.reason } }, client);
  }
  return decision;
}

export async function assertWorkspaceCapability(input: WorkspaceAuthorizationInput, client?: PoolClient) {
  const decision = await authorizeWorkspaceAction(input, client);
  if (!decision.allowed) throw forbiddenError(`Workspace capability required: ${input.capability}`);
  return decision;
}

