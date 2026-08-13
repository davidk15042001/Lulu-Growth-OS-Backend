import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from '../../middlewares/auth.middleware.js';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './workspace.service.js';
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  workspaceIdParamsSchema,
} from './workspace.validator.js';

export async function list(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const workspaces = await service.listWorkspaces(req.user!.id);
    return successResponse(res, 'Workspaces loaded', { items: workspaces });
  } catch (error) {
    next(error);
  }
}

export async function create(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const input = createWorkspaceSchema.parse(req.body);
    const workspace = await service.createWorkspace(req.user!.id, input);
    return createdResponse(res, 'Workspace created', workspace);
  } catch (error) {
    next(error);
  }
}

export async function get(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = workspaceIdParamsSchema.parse(req.params);
    const workspace = await service.getWorkspace(workspaceId, req.user!.id);
    return successResponse(res, 'Workspace loaded', workspace);
  } catch (error) {
    next(error);
  }
}

export async function update(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = workspaceIdParamsSchema.parse(req.params);
    const input = updateWorkspaceSchema.parse(req.body);
    const workspace = await service.updateWorkspace(workspaceId, req.user!.id, input);
    return successResponse(res, 'Workspace updated', workspace);
  } catch (error) {
    next(error);
  }
}
