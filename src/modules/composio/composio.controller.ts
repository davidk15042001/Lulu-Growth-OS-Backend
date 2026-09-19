import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { successResponse } from '../../utils/response.js';
import * as service from './composio.service.js';

export async function createSession(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = String(req.params.workspaceId ?? '');
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const toolkits = Array.isArray(body.toolkits) ? body.toolkits.filter((value): value is string => typeof value === 'string') : undefined;
    return successResponse(res, 'Composio session created', await service.createWorkspaceSession({ workspaceId, userId: req.user!.id, ...(toolkits ? { toolkits } : {}) }));
  } catch (error) { next(error); }
}
