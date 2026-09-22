import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './payout.service.js';
import { createPayoutAccountSchema, payoutAccountParamsSchema, payoutListQuerySchema, payoutParamsSchema, requestPayoutSchema } from './payout.validator.js';

function actorId(req: WorkspaceRequest) {
  if (!req.user?.id) throw new Error('Authentication is required');
  return req.user.id;
}

export async function list(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = payoutAccountParamsSchema.parse(req.params);
    return successResponse(res, 'Payouts loaded', await service.list(workspaceId, actorId(req), payoutListQuerySchema.parse(req.query).limit));
  } catch (error) { next(error); }
}

export async function createAccount(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = payoutAccountParamsSchema.parse(req.params);
    return createdResponse(res, 'Payout account saved', await service.createAccount(workspaceId, actorId(req), createPayoutAccountSchema.parse(req.body)));
  } catch (error) { next(error); }
}

export async function request(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = payoutAccountParamsSchema.parse(req.params);
    return createdResponse(res, 'Payout requested', await service.request(workspaceId, actorId(req), requestPayoutSchema.parse(req.body)));
  } catch (error) { next(error); }
}

export async function submit(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, payoutId } = payoutParamsSchema.parse(req.params);
    return successResponse(res, 'Payout submitted', await service.submit(workspaceId, actorId(req), payoutId));
  } catch (error) { next(error); }
}
