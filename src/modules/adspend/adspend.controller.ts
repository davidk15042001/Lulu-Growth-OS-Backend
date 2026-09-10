import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './adspend.service.js';
import { adSpendTopupParamsSchema, adSpendWorkspaceParamsSchema, createAdSpendTopupSchema } from './adspend.validator.js';

export async function overview(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = adSpendWorkspaceParamsSchema.parse(req.params);
    return successResponse(res, 'Ad spend wallet loaded', await service.getAdSpendOverview(workspaceId));
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
