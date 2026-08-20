import type { NextFunction, Response } from 'express';
import { z } from 'zod';
import type { AuthedRequest } from './auth.middleware.js';
import { forbiddenError, notFoundError } from '../utils/app-error.js';
import { findMembership, type WorkspaceRole } from '../modules/workspaces/workspace.repo.js';
import { getCompletionState } from '../modules/onboarding/onboarding.repo.js';
import { getWorkspacePlan } from '../modules/agents/agent.repo.js';

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
      if (allowedRoles.length > 0) {
        const plan = await getWorkspacePlan(workspaceId);
        if (plan.plan_key === 'viewer') {
          next(forbiddenError('The Viewer plan is read-only'));
          return;
        }
      }

      req.workspaceAccess = { id: workspaceId, role: membership.role };
      next();
    } catch (error) {
      next(error);
    }
  };
}

export async function requireOnboardingComplete(
  req: WorkspaceRequest,
  _res: Response,
  next: NextFunction
) {
  try {
    const workspaceId = req.workspaceAccess?.id ?? workspaceIdSchema.parse(req.params.workspaceId);
    if (!req.workspaceAccess) {
      const userId = req.user?.id;
      if (!userId) {
        next(forbiddenError('Authentication is required'));
        return;
      }
      const membership = await findMembership(workspaceId, userId);
      if (!membership) {
        next(notFoundError('Workspace not found'));
        return;
      }
      req.workspaceAccess = { id: workspaceId, role: membership.role };
    }
    const state = await getCompletionState(workspaceId);
    const complete = Boolean(
      state?.onboardingCompletedAt
      || (state?.hasCompanyInformation && state.hasBusinessDescription && state.hasBillingConfirmation),
    );
    if (!complete) {
      next(forbiddenError('Complete onboarding before accessing the workspace'));
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}

export const requireWorkspaceMember = requireWorkspaceRole();
export const requireWorkspaceEditor = requireWorkspaceRole('owner', 'admin', 'member');
export const requireWorkspaceAdmin = requireWorkspaceRole('owner', 'admin');
