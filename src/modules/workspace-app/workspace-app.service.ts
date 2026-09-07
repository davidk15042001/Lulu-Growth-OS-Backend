import { env, hasAiProvider } from '../../config/env.js';
import { conflictError, notFoundError } from '../../utils/app-error.js';
import { sendWorkspaceInvitationEmail } from '../../utils/mailer.js';
import * as workspaceService from '../workspaces/workspace.service.js';
import * as repo from './workspace-app.repo.js';
import { getCompetitorIntelligence as getCompetitorIntelligenceEngine } from './competitor-intelligence.service.js';
import {
  createGoogleBusinessAuthorization as createGoogleBusinessAuthorizationEngine,
  disconnectGoogleBusiness as disconnectGoogleBusinessEngine,
  getGoogleBusinessOverview as getGoogleBusinessOverviewEngine,
  syncGoogleBusiness as syncGoogleBusinessEngine,
} from './google-business.service.js';
import { getGoogleReviewsManager as getGoogleReviewsManagerEngine, updateGoogleReviewReply as updateGoogleReviewReplyEngine } from './google-reviews.service.js';
import type {
  CreateSavedViewInput,
  GoogleBusinessConnectInput,
  InviteMemberInput,
  ListAuditQuery,
  ListGoogleReviewsQuery,
  ListSavedViewsQuery,
  ListUsageQuery,
  UpdateGoogleReviewReplyInput,
  UpdateMemberInput,
  UpdateSavedViewInput,
  UpdateWorkspaceSettingsInput,
} from './workspace-app.validator.js';
import { canGrantRole, canTransferOwnership, roleCan, ROLE_CAPABILITIES, type WorkspaceRole } from '../workspaces/workspace-permissions.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import { resolveWorkspaceEntitlements, addWorkspaceOverride as addEntitlementOverride, removeWorkspaceOverride as removeEntitlementOverride } from '../entitlements/entitlement.service.js';
import { getWorkspaceBusinessIdentity } from '../business-identity/identity.service.js';

export async function getBootstrap(workspaceId: string, userId: string) {
  const [workspace, statistics, entitlements] = await Promise.all([
    workspaceService.getWorkspace(workspaceId, userId),
    repo.getBootstrapStats(workspaceId, userId),
    resolveWorkspaceEntitlements(workspaceId),
  ]);
  return {
    workspace,
    permissions: {
      role: workspace.role,
      canEdit: roleCan(workspace.role, 'workspace.write'),
      canAdminister: roleCan(workspace.role, 'workspace.manage'),
      capabilities: [...(ROLE_CAPABILITIES[workspace.role] ?? [])],
    },
    capabilities: {
      aiGeneration: hasAiProvider && entitlements['ai.enabled'].enabled,
      transactionalEmail: !!env.MAILCOW_SMTP_HOST && !!env.MAILCOW_SMTP_USER && !!env.MAILCOW_SMTP_PASS,
    },
    entitlements,
    ...statistics,
  };
}

export function listMembers(workspaceId: string) {
  return repo.listMembers(workspaceId);
}

export async function inviteMember(
  workspaceId: string,
  userId: string,
  input: InviteMemberInput
) {
  const workspace = await workspaceService.getWorkspace(workspaceId, userId);
  const targetRole = input.role as WorkspaceRole;
  if (!canGrantRole(workspace.role, targetRole)) throw conflictError('You cannot grant a workspace role at or above your own authority');
  const result = await repo.createInvitation(workspaceId, userId, input);
  if (!result.invitation) throw new Error('Invitation insert did not return a row');
  await recordSecurityEvent({ eventType: 'WORKSPACE_MEMBER_INVITED', workspaceId, userId, metadata: { targetId: result.invitation.id, role: input.role } });

  const baseUrl = env.FRONTEND_BASE_URL ?? 'http://localhost:5173';
  const invitationUrl = `${baseUrl.replace(/\/$/, '')}/auth/invitations/${encodeURIComponent(result.token)}`;
  await sendWorkspaceInvitationEmail(input.email, workspace.companyName, invitationUrl);
  return result.invitation;
}

export async function acceptInvitation(token: string, userId: string, userEmail: string) {
  const invitation = await repo.acceptInvitation(token, userId, userEmail);
  if (!invitation) throw notFoundError('Invitation is invalid, expired, or belongs to another account');
  await recordSecurityEvent({ eventType: 'WORKSPACE_MEMBER_ACCEPTED', workspaceId: invitation.workspaceId, userId, metadata: { targetId: userId, role: invitation.role } });
  return invitation;
}

export async function updateMember(
  workspaceId: string,
  actorId: string,
  memberId: string,
  input: UpdateMemberInput
) {
  const actor = await workspaceService.getWorkspace(workspaceId, actorId);
  if (!canGrantRole(actor.role, input.role as WorkspaceRole)) throw conflictError('You cannot grant a workspace role at or above your own authority');
  const member = await repo.updateMember(workspaceId, memberId, input);
  if (!member) throw conflictError('Workspace owners cannot be reassigned or the member does not exist');
  await recordSecurityEvent({ eventType: 'WORKSPACE_MEMBER_ROLE_CHANGED', workspaceId, userId: actorId, metadata: { targetId: memberId, role: input.role } });
  return member;
}

export async function removeMember(workspaceId: string, actorId: string, memberId: string) {
  const actor = await workspaceService.getWorkspace(workspaceId, actorId);
  const targetRole = await repo.getMemberRole(workspaceId, memberId);
  if (!targetRole || targetRole === 'owner' || actor.role === 'viewer' || actor.role === 'member') throw conflictError('Only an authorized role can remove this member');
  if (!(await repo.removeMember(workspaceId, memberId))) {
    throw conflictError('Workspace owners cannot be removed or the member does not exist');
  }
  await recordSecurityEvent({ eventType: 'WORKSPACE_MEMBER_REMOVED', workspaceId, userId: actorId, metadata: { targetId: memberId, role: targetRole } });
}

export async function transferOwnership(workspaceId: string, actorId: string, newOwnerId: string) {
  const actor = await workspaceService.getWorkspace(workspaceId, actorId);
  if (!canTransferOwnership(actor.role)) throw conflictError('Only the current owner can transfer ownership');
  if (!(await repo.transferOwnership(workspaceId, actorId, newOwnerId))) throw conflictError('The new owner must be an existing workspace member');
  await recordSecurityEvent({ eventType: 'WORKSPACE_OWNERSHIP_TRANSFERRED', workspaceId, userId: actorId, metadata: { targetId: newOwnerId } });
}

export function getEntitlements(workspaceId: string) { return resolveWorkspaceEntitlements(workspaceId); }
export function getBusinessIdentity(workspaceId: string) { return getWorkspaceBusinessIdentity(workspaceId); }
export function addWorkspaceEntitlementOverride(input: { workspaceId: string; entitlementKey: string; enabled?: boolean | undefined; limitValue?: number | null | undefined; reason: string; actorId: string; expiresAt?: string | null | undefined }) { return addEntitlementOverride(input); }
export function removeWorkspaceEntitlementOverride(workspaceId: string, overrideId: string, actorId: string) { return removeEntitlementOverride(workspaceId, overrideId, actorId); }

export function listSavedViews(workspaceId: string, userId: string, filters: ListSavedViewsQuery) {
  return repo.listSavedViews(workspaceId, userId, filters);
}

export function createSavedView(workspaceId: string, userId: string, input: CreateSavedViewInput) {
  return repo.createSavedView(workspaceId, userId, input);
}

export async function updateSavedView(
  workspaceId: string,
  userId: string,
  viewId: string,
  input: UpdateSavedViewInput
) {
  const view = await repo.updateSavedView(workspaceId, userId, viewId, input);
  if (!view) throw notFoundError('Saved view not found');
  return view;
}

export async function deleteSavedView(workspaceId: string, userId: string, viewId: string) {
  if (!(await repo.deleteSavedView(workspaceId, userId, viewId))) throw notFoundError('Saved view not found');
}

export function listAudit(workspaceId: string, filters: ListAuditQuery) {
  return repo.listAudit(workspaceId, filters);
}

export function getBilling(workspaceId: string, userId: string, filters: ListUsageQuery) {
  return repo.getBilling(workspaceId, userId, filters);
}

export function getWorkspaceSettings(workspaceId: string) {
  return repo.getWorkspaceSettings(workspaceId);
}

export function updateWorkspaceSettings(workspaceId: string, userId: string, input: UpdateWorkspaceSettingsInput) {
  return repo.updateWorkspaceSettings(workspaceId, userId, input);
}

export async function queueIntegrationSync(workspaceId: string, platformId: string) {
  const run = await repo.queueIntegrationSync(workspaceId, platformId);
  if (!run) throw notFoundError('Integration not found');
  return run;
}

export function getGoogleBusinessOverview(workspaceId: string) {
  return getGoogleBusinessOverviewEngine(workspaceId);
}

export function createGoogleBusinessAuthorization(workspaceId: string, userId: string, input: GoogleBusinessConnectInput) {
  return createGoogleBusinessAuthorizationEngine(workspaceId, userId, input);
}

export function disconnectGoogleBusiness(workspaceId: string) {
  return disconnectGoogleBusinessEngine(workspaceId);
}

export function syncGoogleBusiness(workspaceId: string) {
  return syncGoogleBusinessEngine(workspaceId);
}

export function getCompetitorIntelligence(workspaceId: string, userId: string) {
  return getCompetitorIntelligenceEngine(workspaceId, userId);
}

export function getGoogleReviewsManager(workspaceId: string, userId: string, filters: ListGoogleReviewsQuery) {
  return getGoogleReviewsManagerEngine(workspaceId, userId, filters);
}

export function updateGoogleReviewReply(workspaceId: string, reviewId: string, input: UpdateGoogleReviewReplyInput) {
  return updateGoogleReviewReplyEngine(workspaceId, reviewId, input);
}
