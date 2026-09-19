import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './adspend.service.js';
import {
  adBudgetAuthorizationParamsSchema,
  adSpendTopupParamsSchema,
  adSpendWorkspaceParamsSchema,
  createAdBudgetAuthorizationSchema,
  createAdSpendTopupSchema,
  adComplianceListQuerySchema,
  revokeAdBudgetAuthorizationSchema,
} from './adspend.validator.js';
import { listAdsComplianceChecks } from '../advertising-compliance/advertising-compliance.service.js';

export async function overview(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = adSpendWorkspaceParamsSchema.parse(req.params);
    return successResponse(res, 'Ad spend wallet loaded', await service.getAdSpendOverview(workspaceId));
  } catch (error) { next(error); }
}

export async function listComplianceChecks(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = adSpendWorkspaceParamsSchema.parse(req.params);
    const { limit } = adComplianceListQuerySchema.parse(req.query);
    return successResponse(res, 'Ads compliance checks loaded', await listAdsComplianceChecks(workspaceId, limit));
  } catch (error) { next(error); }
}

export async function createTopup(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = adSpendWorkspaceParamsSchema.parse(req.params);
    const input = createAdSpendTopupSchema.parse(req.body);
    return createdResponse(res, 'Ad spend payment created', await service.startAdSpendTopup({
      workspaceId,
      userId: req.user!.id,
      amount: input.amount,
      paymentMethod: input.paymentMethod,
      returnUrl: input.returnUrl,
    }));
  } catch (error) { next(error); }
}

export async function syncTopup(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, topupId } = adSpendTopupParamsSchema.parse(req.params);
    return successResponse(res, 'Ad spend payment synchronized', await service.syncAdSpendTopup(workspaceId, topupId));
  } catch (error) { next(error); }
}

export async function listBudgetAuthorizations(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = adSpendWorkspaceParamsSchema.parse(req.params);
    return successResponse(res, 'Campaign budget authorizations loaded', await service.listAdBudgetAuthorizations(workspaceId));
  } catch (error) { next(error); }
}

export async function createBudgetAuthorization(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = adSpendWorkspaceParamsSchema.parse(req.params);
    const input = createAdBudgetAuthorizationSchema.parse(req.body);
    return createdResponse(res, 'Campaign budget authorized', await service.createAdBudgetAuthorization({
      workspaceId,
      userId: req.user!.id,
      provider: input.provider,
      accountId: input.accountId,
      campaignId: input.campaignId,
      currency: input.currency,
      amount: input.amount,
      endsAt: input.endsAt,
      idempotencyKey: input.idempotencyKey,
      ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }));
  } catch (error) { next(error); }
}

export async function revokeBudgetAuthorization(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, authorizationId } = adBudgetAuthorizationParamsSchema.parse(req.params);
    const input = revokeAdBudgetAuthorizationSchema.parse(req.body);
    return successResponse(res, 'Campaign budget authorization revoked', await service.revokeAdBudgetAuthorization({
      workspaceId,
      authorizationId,
      userId: req.user!.id,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    }));
  } catch (error) { next(error); }
}
