import type { NextFunction, Response } from 'express';
import { z } from 'zod';
import type { AuthedRequest } from './auth.middleware.js';
import { AppError, forbiddenError, notFoundError } from '../utils/app-error.js';
import { findMembership, type WorkspaceRole } from '../modules/workspaces/workspace.repo.js';
import { getCompletionState } from '../modules/onboarding/onboarding.repo.js';
import { assertWorkspaceCapability } from '../modules/workspaces/workspace-authorization.service.js';
import type { WorkspaceCapability } from '../modules/workspaces/workspace-permissions.js';
import { hasWorkspaceEntitlement } from '../modules/entitlements/entitlement.service.js';
import type { EntitlementKey } from '../modules/entitlements/entitlement.types.js';
import { query } from '../db/pool.js';

export type WorkspaceRequest = AuthedRequest & {
  workspaceAccess?: { id: string; role: WorkspaceRole };
};

const workspaceIdSchema = z.string().uuid();

// Commercial plans are not authorization roles. Only capabilities that mutate
// workspace state require the technical workspace.write entitlement; read
// access remains available to Viewer-plan members where their role permits it.
const WRITE_CAPABILITIES = new Set<WorkspaceCapability>([
  'workspace.write', 'workspace.manage', 'members.invite', 'members.manage',
  'members.remove', 'products.create', 'products.update', 'products.delete',
  'crm.manage', 'leads.manage', 'opportunities.manage', 'quotes.create', 'quotes.update',
  'quotes.send', 'quotes.approve', 'invoices.create', 'invoices.issue', 'invoices.send', 'invoices.cancel', 'commercial_policy.manage', 'orders.manage', 'website.manage',
  'website.publish', 'omnichannel.reply', 'omnichannel.manage',
  'advertising.manage', 'advertising.budget_authorize', 'finance.manage',
  'payouts.request', 'payouts.manage', 'providers.connect', 'providers.manage',
  'agents.manage', 'agents.execute', 'settings.manage',
]);

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

/** Canonical capability middleware for new and migrated workspace routes. */
export function requireWorkspaceCapability(
  capability: WorkspaceCapability,
  options: { enforceWriteEntitlement?: boolean } = {},
) {
  return async function workspaceCapabilityMiddleware(
    req: WorkspaceRequest,
    _res: Response,
    next: NextFunction,
  ) {
    try {
      const userId = req.user?.id;
      if (!userId) { next(forbiddenError('Authentication is required')); return; }
      const workspaceId = workspaceIdSchema.parse(req.params.workspaceId);
      const membership = await findMembership(workspaceId, userId);
      if (!membership) { next(notFoundError('Workspace not found')); return; }
      await assertWorkspaceCapability({ workspaceId, userId, capability });
      // Reads must remain available while a workspace is unpaid. The write
      // entitlement is enforced only for state-changing capabilities (or when
      // a caller explicitly opts in), so sensitive read-only screens such as
      // the company profile do not become inaccessible before billing.
      const enforceWriteEntitlement = options.enforceWriteEntitlement ?? true;
      if (enforceWriteEntitlement && WRITE_CAPABILITIES.has(capability) && !(await hasWorkspaceEntitlement(workspaceId, 'workspace.write'))) {
        next(forbiddenError('Workspace write access is not enabled for this plan or workspace')); return;
      }
      req.workspaceAccess = { id: workspaceId, role: membership.role };
      next();
    } catch (error) { next(error); }
  };
}

/** Backend entitlement guard. Frontend gating remains a convenience only. */
export function requireWorkspaceEntitlement(entitlementKey: EntitlementKey) {
  return async function workspaceEntitlementMiddleware(req: WorkspaceRequest, _res: Response, next: NextFunction) {
    try {
      const workspaceId = req.workspaceAccess?.id ?? workspaceIdSchema.parse(req.params.workspaceId);
      if (!(await hasWorkspaceEntitlement(workspaceId, entitlementKey))) {
        next(forbiddenError(`Workspace entitlement required: ${entitlementKey}`));
        return;
      }
      next();
    } catch (error) { next(error); }
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
    const complete = Boolean(state?.onboardingCompletedAt && state.hasProfile && state.hasKnowledgeBase);
    if (!complete) {
      next(forbiddenError('Complete onboarding before accessing the workspace'));
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}

/** Mandatory activation boundary for every workspace sub-route. The few
 * endpoints needed by the active gate remain reachable; direct URLs cannot
 * bypass this policy. */
export async function requireWorkspaceActivationGate(req: WorkspaceRequest,_res:Response,next:NextFunction){
  try{
    const workspaceId=workspaceIdSchema.parse(req.params.workspaceId);
    const member=await findMembership(workspaceId,req.user!.id);
    if(!member){next(notFoundError('Workspace not found'));return;}
    const workspace=(await query<{onboardingStep:string;onboardingCompletedAt:string|null}>(`SELECT onboarding_step AS "onboardingStep",onboarding_completed_at AS "onboardingCompletedAt" FROM workspaces WHERE id=$1 AND deleted_at IS NULL`,[workspaceId])).rows[0];
    if(!workspace){next(notFoundError('Workspace not found'));return;}
    if(workspace.onboardingCompletedAt){next();return;}
    const suffix=req.path.replace(new RegExp(`^/${workspaceId}`),'');
    const knowledgeRoute = suffix==='/onboarding'
      || suffix==='/onboarding/documents'
      || /^\/onboarding\/documents\/[0-9a-f-]+(?:\/content)?$/i.test(suffix)
      || suffix==='/onboarding/knowledge-activation';
    const allowed=workspace.onboardingStep==='company_information'
      ? (suffix==='/onboarding'||suffix==='/onboarding/company-information')
      : workspace.onboardingStep==='billing'
        ? (suffix==='/onboarding'||suffix.startsWith('/billing'))
        : workspace.onboardingStep==='profile_completion'
          ? suffix==='/profile'
          : workspace.onboardingStep==='knowledge_base'
            ? knowledgeRoute
            : false;
    if(!allowed){next(new AppError(423,'WORKSPACE_ACTIVATION_REQUIRED','Complete the current activation step before accessing this workspace.',{onboardingStep:workspace.onboardingStep}));return;}
    next();
  }catch(error){next(error);}
}

export const requireWorkspaceMember = requireWorkspaceCapability('workspace.read');
export const requireWorkspaceEditor = requireWorkspaceCapability('workspace.write');
export const requireWorkspaceAdmin = requireWorkspaceCapability('workspace.manage');
export const requireWorkspaceAdminRead = requireWorkspaceCapability('workspace.manage', { enforceWriteEntitlement: false });
