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

export async function listToolkits(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = String(req.params.workspaceId ?? '');
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    return successResponse(res, 'Composio toolkits loaded', await service.listWorkspaceToolkits({ workspaceId, userId: req.user!.id, ...(search ? { search } : {}) }));
  } catch (error) { next(error); }
}

export async function authorizeToolkit(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = String(req.params.workspaceId ?? '');
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const toolkit = typeof body.toolkit === 'string' ? body.toolkit : '';
    return successResponse(res, 'Composio connection link created', await service.authorizeWorkspaceToolkit({ workspaceId, userId: req.user!.id, toolkit }));
  } catch (error) { next(error); }
}
