import type { NextFunction, Response } from 'express';
import type { AuthedRequest } from '../../middlewares/auth.middleware.js';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './workspace.service.js';
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  workspaceProfileUpdateSchema,
  workspaceIdParamsSchema,
} from './workspace.validator.js';
import { AppError } from '../../utils/app-error.js';

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

export async function getProfile(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = workspaceIdParamsSchema.parse(req.params);
    const profile = await service.getWorkspaceProfile(workspaceId, req.user!.id);
    return successResponse(res, 'Workspace profile loaded', profile);
  } catch (error) {
    next(error);
  }
}

export async function updateProfile(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = workspaceIdParamsSchema.parse(req.params);
    const input = workspaceProfileUpdateSchema.parse(req.body);
    const profile = await service.updateWorkspaceProfile(workspaceId, req.user!.id, input);
    return successResponse(res, 'Workspace profile updated', profile);
  } catch (error) {
    next(error);
  }
}

export async function uploadLogo(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = workspaceIdParamsSchema.parse(req.params);
    const file = req.file as Express.Multer.File | undefined;
    if (!file) throw new AppError(422, 'WORKSPACE_LOGO_REQUIRED', 'Select a logo image to upload');
    return successResponse(res, 'Workspace logo uploaded', await service.uploadWorkspaceLogo(workspaceId, req.user!.id, file));
  } catch (error) { next(error); }
}

export async function deleteLogo(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = workspaceIdParamsSchema.parse(req.params);
    return successResponse(res, 'Workspace logo removed', await service.deleteWorkspaceLogo(workspaceId, req.user!.id));
  } catch (error) { next(error); }
}

export async function publicLogo(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = workspaceIdParamsSchema.parse(req.params);
    const logo = await service.getWorkspaceLogo(workspaceId);
    if (!logo?.storageReference || !logo.mimeType) return res.status(404).json({ success: false, error: { code: 'WORKSPACE_LOGO_NOT_FOUND', message: 'No company logo is configured.' } });
    const content = await (await import('../../storage/s3.service.js')).getObject(logo.storageReference);
    res.setHeader('Content-Type', logo.mimeType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    return res.send(content);
  } catch (error) { next(error); }
}
