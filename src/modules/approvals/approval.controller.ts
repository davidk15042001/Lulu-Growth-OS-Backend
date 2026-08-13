import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { notFoundError } from '../../utils/app-error.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as repo from './approval.repo.js';
import {
  approvalParamsSchema,
  createApprovalSchema,
  decideApprovalSchema,
  listApprovalsQuerySchema,
} from './approval.validator.js';

function isWorkspaceAdmin(req: WorkspaceRequest) {
  return req.workspaceAccess?.role === 'owner' || req.workspaceAccess?.role === 'admin';
}

export async function list(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = approvalParamsSchema.parse(req.params);
    const filters = listApprovalsQuerySchema.parse(req.query);
    const result = await repo.listApprovals(workspaceId, req.user!.id, isWorkspaceAdmin(req), filters);
    return successResponse(res, 'Approvals loaded', result);
  } catch (error) {
    next(error);
  }
}

export async function create(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = approvalParamsSchema.parse(req.params);
    const input = createApprovalSchema.parse(req.body);
    const approval = await repo.createApproval(workspaceId, req.user!.id, input);
    return createdResponse(res, 'Approval requested', approval);
  } catch (error) {
    next(error);
  }
}

export async function decide(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = approvalParamsSchema.parse(req.params);
    const input = decideApprovalSchema.parse(req.body);
    const approval = await repo.decideApproval(
      params.workspaceId,
      params.approvalId!,
      req.user!.id,
      isWorkspaceAdmin(req),
      input
    );
    if (!approval) throw notFoundError('Pending approval not found or not assigned to you');
    return successResponse(res, 'Approval decision saved', approval);
  } catch (error) {
    next(error);
  }
}
