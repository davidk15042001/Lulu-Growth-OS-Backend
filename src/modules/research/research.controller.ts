import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { successResponse } from '../../utils/response.js';
import { runPerplexityResearch } from './research.service.js';

export async function deepResearch(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = String(req.params.workspaceId ?? '');
    return successResponse(res, 'Perplexity deep research completed', await runPerplexityResearch(workspaceId, req.user!.id, req.body));
  } catch (error) {
    next(error);
  }
}
