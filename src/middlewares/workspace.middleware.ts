import type { NextFunction, Response } from 'express';
import { z } from 'zod';
import type { AuthedRequest } from './auth.middleware.js';
import { forbiddenError, notFoundError } from '../utils/app-error.js';
import { findMembership, type WorkspaceRole } from '../modules/workspaces/workspace.repo.js';

export type WorkspaceRequest = AuthedRequest & {
  workspaceAccess?: { id: string; role: WorkspaceRole };
};

const workspaceIdSchema = z.string().uuid();

export function requireWorkspaceRole(...allowedRoles: WorkspaceRole[]) {
  return async function workspaceAccessMiddleware(
    req: WorkspaceRequest,
    _res: Response,
    next: NextFunction
  ) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        next(forbiddenError('Authentication is required'));
        return;
      }

      const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);
      const membership = await findMembership(workspaceId, userId);
      if (!membership) {
        next(notFoundError('Workspace not found'));
        return;
      }
      if (allowedRoles.length > 0 && !allowedRoles.includes(membership.role)) {
        next(forbiddenError('Your workspace role does not allow this action'));
        return;
      }

      req.workspaceAccess = { id: workspaceId, role: membership.role };
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const requireWorkspaceMember = requireWorkspaceRole();
export const requireWorkspaceEditor = requireWorkspaceRole('owner', 'admin', 'member');
export const requireWorkspaceAdmin = requireWorkspaceRole('owner', 'admin');
