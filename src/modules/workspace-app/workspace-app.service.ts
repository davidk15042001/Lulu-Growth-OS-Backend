import { env, hasAiProvider } from '../../config/env.js';
import { conflictError, notFoundError } from '../../utils/app-error.js';
import { sendWorkspaceInvitationEmail } from '../../utils/mailer.js';
import * as workspaceService from '../workspaces/workspace.service.js';
import * as repo from './workspace-app.repo.js';
import { getCompetitorIntelligence as getCompetitorIntelligenceEngine } from './competitor-intelligence.service.js';
import { getGoogleReviewsManager as getGoogleReviewsManagerEngine, updateGoogleReviewReply as updateGoogleReviewReplyEngine } from './google-reviews.service.js';
import type {
  CreateSavedViewInput,
  InviteMemberInput,
  ListAuditQuery,
  ListGoogleReviewsQuery,
  ListSavedViewsQuery,
  ListUsageQuery,
  UpdateGoogleReviewReplyInput,
  UpdateMemberInput,
  UpdateSavedViewInput,
} from './workspace-app.validator.js';

export async function getBootstrap(workspaceId: string, userId: string) {
  const [workspace, statistics] = await Promise.all([
    workspaceService.getWorkspace(workspaceId, userId),
    repo.getBootstrapStats(workspaceId, userId),
  ]);
  return {
    workspace,
    permissions: {
      role: workspace.role,
      canEdit: workspace.role !== 'viewer',
      canAdminister: workspace.role === 'owner' || workspace.role === 'admin',
    },
    capabilities: {
      aiGeneration: hasAiProvider,
      transactionalEmail: !!env.MAILCOW_SMTP_HOST && !!env.MAILCOW_SMTP_USER && !!env.MAILCOW_SMTP_PASS,
    },
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
  const result = await repo.createInvitation(workspaceId, userId, input);
  if (!result.invitation) throw new Error('Invitation insert did not return a row');

  const baseUrl = env.FRONTEND_BASE_URL ?? 'http://localhost:5173';
  const invitationUrl = `${baseUrl.replace(/\/$/, '')}/auth/invitations/${encodeURIComponent(result.token)}`;
  await sendWorkspaceInvitationEmail(input.email, workspace.companyName, invitationUrl);
  return result.invitation;
}

export async function acceptInvitation(token: string, userId: string, userEmail: string) {
  const invitation = await repo.acceptInvitation(token, userId, userEmail);
  if (!invitation) throw notFoundError('Invitation is invalid, expired, or belongs to another account');
  return invitation;
}

export async function updateMember(
  workspaceId: string,
  memberId: string,
  input: UpdateMemberInput
) {
  const member = await repo.updateMember(workspaceId, memberId, input);
  if (!member) throw conflictError('Workspace owners cannot be reassigned or the member does not exist');
  return member;
}

export async function removeMember(workspaceId: string, memberId: string) {
  if (!(await repo.removeMember(workspaceId, memberId))) {
    throw conflictError('Workspace owners cannot be removed or the member does not exist');
  }
}

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

export async function queueIntegrationSync(workspaceId: string, platformId: string) {
  const run = await repo.queueIntegrationSync(workspaceId, platformId);
  if (!run) throw notFoundError('Integration not found');
  return run;
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
