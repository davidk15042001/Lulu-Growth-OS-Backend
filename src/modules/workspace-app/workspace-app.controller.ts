import type { NextFunction, Response } from 'express';
import { z } from 'zod';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './workspace-app.service.js';
import { createCheckout, type BillingPlanKey } from '../billing/airwallex.service.js';
import {
  createSavedViewSchema,
  inviteMemberSchema,
  inviteTokenParamsSchema,
  listAuditQuerySchema,
  listSavedViewsQuerySchema,
  listUsageQuerySchema,
  updateMemberSchema,
  updateSavedViewSchema,
  workspaceAppParamsSchema,
} from './workspace-app.validator.js';

function params(req: WorkspaceRequest) {
  return workspaceAppParamsSchema.parse(req.params);
}

export async function bootstrap(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    return successResponse(res, 'Workspace application state loaded', await service.getBootstrap(workspaceId, req.user!.id));
  } catch (error) { next(error); }
}

export async function members(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    return successResponse(res, 'Workspace members loaded', await service.listMembers(workspaceId));
  } catch (error) { next(error); }
}

export async function invite(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    const input = inviteMemberSchema.parse(req.body);
    return createdResponse(res, 'Workspace invitation sent', await service.inviteMember(workspaceId, req.user!.id, input));
  } catch (error) { next(error); }
}

export async function acceptInvitation(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { token } = inviteTokenParamsSchema.parse(req.params);
    const invitation = await service.acceptInvitation(token, req.user!.id, req.user!.email);
    return successResponse(res, 'Workspace invitation accepted', invitation);
  } catch (error) { next(error); }
}

export async function updateMember(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, memberId } = params(req);
    const member = await service.updateMember(workspaceId, memberId!, updateMemberSchema.parse(req.body));
    return successResponse(res, 'Workspace member updated', member);
  } catch (error) { next(error); }
}

export async function removeMember(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, memberId } = params(req);
    await service.removeMember(workspaceId, memberId!);
    return successResponse(res, 'Workspace member removed');
  } catch (error) { next(error); }
}

export async function savedViews(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    const filters = listSavedViewsQuerySchema.parse(req.query);
    return successResponse(res, 'Saved views loaded', { items: await service.listSavedViews(workspaceId, req.user!.id, filters) });
  } catch (error) { next(error); }
}

export async function createSavedView(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    const view = await service.createSavedView(workspaceId, req.user!.id, createSavedViewSchema.parse(req.body));
    return createdResponse(res, 'Saved view created', view);
  } catch (error) { next(error); }
}

export async function updateSavedView(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, viewId } = params(req);
    const view = await service.updateSavedView(workspaceId, req.user!.id, viewId!, updateSavedViewSchema.parse(req.body));
    return successResponse(res, 'Saved view updated', view);
  } catch (error) { next(error); }
}

export async function deleteSavedView(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, viewId } = params(req);
    await service.deleteSavedView(workspaceId, req.user!.id, viewId!);
    return successResponse(res, 'Saved view deleted');
  } catch (error) { next(error); }
}

export async function audit(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    return successResponse(res, 'Audit trail loaded', await service.listAudit(workspaceId, listAuditQuerySchema.parse(req.query)));
  } catch (error) { next(error); }
}

export async function createBillingCheckout(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    const input = z.object({
      planKey: z.enum(['explorer', 'starter', 'ai']),
      successUrl: z.string().url(),
      backUrl: z.string().url(),
    }).parse(req.body);
    return successResponse(res, 'Billing checkout created', await createCheckout({ workspaceId, planKey: input.planKey as BillingPlanKey, successUrl: input.successUrl, backUrl: input.backUrl }));
  } catch (error) { next(error); }
}

export async function billing(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    return successResponse(res, 'Billing state loaded', await service.getBilling(workspaceId, listUsageQuerySchema.parse(req.query)));
  } catch (error) { next(error); }
}

export async function syncIntegration(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, platformId } = params(req);
    return createdResponse(res, 'Integration sync queued', await service.queueIntegrationSync(workspaceId, platformId!));
  } catch (error) { next(error); }
}
