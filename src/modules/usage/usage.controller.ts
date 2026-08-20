import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { successResponse } from '../../utils/response.js';
import { getWorkspaceCredits } from './usage.service.js';

export async function credits(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = String(req.params.workspaceId ?? '');
    if (!workspaceId) throw new Error('Workspace ID was not provided');
    const data = await getWorkspaceCredits(workspaceId);
    return successResponse(res, 'Workspace credits loaded', data);
  } catch (error) {
    next(error);
  }
}
