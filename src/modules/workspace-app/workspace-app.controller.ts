import type { NextFunction, Response } from 'express';
import { z } from 'zod';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './workspace-app.service.js';
import { configurePaygPaymentMethod as configurePaygPaymentMethodCheckout, createCheckout, createPaygApiUsageCheckout as createPaygApiUsageCheckoutInvoice, syncCheckoutStatus, syncPaygPaymentMethodSetup, type BillingPlanKey } from '../billing/airwallex.service.js';
import { isBillingAdminUser } from '../billing/payg-billing.repo.js';
import * as contentGeneration from '../content-generation/content-generation.service.js';
import { CONTENT_MODULES, type ContentModule } from '../content-generation/content-generation.repo.js';
import {
  createSavedViewSchema,
  configurePaygPaymentMethodSchema,
  googleBusinessConnectSchema,
  inviteMemberSchema,
  inviteTokenParamsSchema,
  listAuditQuerySchema,
  listGoogleReviewsQuerySchema,
  listSavedViewsQuerySchema,
  listUsageQuerySchema,
  updateGoogleReviewReplySchema,
  updateMemberSchema,
  updateSavedViewSchema,
  updateWorkspaceSettingsSchema,
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

export async function competitorIntelligence(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    return successResponse(res, 'Competitor intelligence loaded', await service.getCompetitorIntelligence(workspaceId, req.user!.id));
  } catch (error) { next(error); }
}

export async function googleReviews(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    return successResponse(res, 'Google reviews manager loaded', await service.getGoogleReviewsManager(workspaceId, req.user!.id, listGoogleReviewsQuerySchema.parse(req.query)));
  } catch (error) { next(error); }
}

export async function googleBusiness(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    return successResponse(res, 'Google Business workspace state loaded', await service.getGoogleBusinessOverview(workspaceId));
  } catch (error) { next(error); }
}

export async function connectGoogleBusiness(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    return successResponse(res, 'Google Business authorization URL created', await service.createGoogleBusinessAuthorization(workspaceId, req.user!.id, googleBusinessConnectSchema.parse(req.body)));
  } catch (error) { next(error); }
}

export async function disconnectGoogleBusiness(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    return successResponse(res, 'Google Business connection removed', await service.disconnectGoogleBusiness(workspaceId));
  } catch (error) { next(error); }
}

export async function syncGoogleBusiness(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    return createdResponse(res, 'Google Business sync queued', await service.syncGoogleBusiness(workspaceId));
  } catch (error) { next(error); }
}

export async function updateGoogleReviewReply(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, reviewId } = params(req);
    return successResponse(res, 'Google review reply updated', await service.updateGoogleReviewReply(workspaceId, reviewId!, updateGoogleReviewReplySchema.parse(req.body)));
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
      planKey: z.enum(['viewer', 'starter', 'ai', 'test']),
      successUrl: z.string().url(),
      backUrl: z.string().url(),
      password: z.string().max(128).optional(),
    }).parse(req.body);
    const allowInternalPlans = await isBillingAdminUser(req.user?.id);
    return successResponse(res, 'Billing checkout created', await createCheckout({ workspaceId, planKey: input.planKey as BillingPlanKey, successUrl: input.successUrl, backUrl: input.backUrl, allowInternalPlans, ...(req.user?.email ? { customerEmail: req.user.email } : {}), ...(input.password ? { password: input.password } : {}) }));
  } catch (error) { next(error); }
}

export async function syncBillingCheckout(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    const rawCheckoutId = req.params.checkoutId;
    const checkoutId = Array.isArray(rawCheckoutId) ? rawCheckoutId[0] : rawCheckoutId;
    if (!checkoutId) throw new Error('Billing checkout ID is required');
    return successResponse(res, 'Billing checkout status synchronized', await syncCheckoutStatus(workspaceId, checkoutId));
  } catch (error) { next(error); }
}

export async function createPaygApiUsageCheckout(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    return successResponse(res, 'API usage payment checkout created', await createPaygApiUsageCheckoutInvoice(workspaceId));
  } catch (error) { next(error); }
}

export async function configurePaygPaymentMethod(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    const input = configurePaygPaymentMethodSchema.parse(req.body);
    return successResponse(res, 'PAYG payment method configured', await configurePaygPaymentMethodCheckout({
      workspaceId,
      userId: req.user!.id,
      paymentMethod: input.paymentMethod,
      ...(input.successUrl ? { successUrl: input.successUrl } : {}),
      ...(input.backUrl ? { backUrl: input.backUrl } : {}),
    }));
  } catch (error) { next(error); }
}

export async function syncPaygPaymentMethod(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    const setupId = z.string().uuid().parse(req.params.setupId);
    return successResponse(res, 'PAYG payment method setup synchronized', await syncPaygPaymentMethodSetup({ workspaceId, userId: req.user!.id, setupId }));
  } catch (error) { next(error); }
}

export async function billing(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    return successResponse(res, 'Billing state loaded', await service.getBilling(workspaceId, req.user!.id, listUsageQuerySchema.parse(req.query)));
  } catch (error) { next(error); }
}

export async function settings(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    if (req.method === 'GET') {
      return successResponse(res, 'Workspace settings loaded', await service.getWorkspaceSettings(workspaceId));
    }
    return successResponse(res, 'Workspace settings updated', await service.updateWorkspaceSettings(workspaceId, req.user!.id, updateWorkspaceSettingsSchema.parse(req.body)));
  } catch (error) { next(error); }
}

export async function startContentRefresh(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    const requested = Array.isArray(req.body?.modules) ? req.body.modules.filter((value: unknown): value is ContentModule => CONTENT_MODULES.includes(value as ContentModule)) : [...CONTENT_MODULES];
    return createdResponse(res, 'Workspace content refresh started', await contentGeneration.startContentRefresh(workspaceId, req.user!.id, requested));
  } catch (error) { next(error); }
}

export async function contentRefreshStatus(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    return successResponse(res, 'Workspace content refresh status loaded', await contentGeneration.getContentRefresh(workspaceId, String(req.params.jobId)));
  } catch (error) { next(error); }
}

export async function contentAssets(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = params(req);
    const rawModule = typeof req.query.module === 'string' ? req.query.module : undefined;
    const module = CONTENT_MODULES.includes(rawModule as ContentModule) ? rawModule as ContentModule : undefined;
    return successResponse(res, 'Workspace content assets loaded', { items: await contentGeneration.listContentAssets(workspaceId, module) });
  } catch (error) { next(error); }
}

export async function syncIntegration(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, platformId } = params(req);
    return createdResponse(res, 'Integration sync queued', await service.queueIntegrationSync(workspaceId, platformId!));
  } catch (error) { next(error); }
}
