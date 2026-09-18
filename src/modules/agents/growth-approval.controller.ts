import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { successResponse } from '../../utils/response.js';
import * as service from './growth-approval.service.js';

export async function list(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const status = typeof req.query.status === 'string' && ['pending', 'approved', 'rejected', 'cancelled', 'expired', 'all'].includes(req.query.status)
      ? req.query.status as Parameters<typeof service.listGrowthApprovals>[1]
      : 'pending';
    return successResponse(res, 'Growth approvals loaded', await service.listGrowthApprovals(String(req.params.workspaceId), status));
  } catch (error) { next(error); }
}

export async function decide(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      return res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Decision must be approve or reject.' } });
    }
    return successResponse(res, `Growth approval ${decision}d`, await service.decideGrowthApproval({
      workspaceId: String(req.params.workspaceId),
      approvalId: String(req.params.approvalId),
      actorId: req.user!.id,
      decision,
      note: typeof req.body?.note === 'string' ? req.body.note : undefined,
    }));
  } catch (error) { next(error); }
}
