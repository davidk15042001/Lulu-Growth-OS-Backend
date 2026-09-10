import type { Response, NextFunction } from 'express';
import type { AuthedRequest } from '../../middlewares/auth.middleware.js';
import { forbidden, jsonError, successResponse } from '../../utils/response.js';
import * as repo from './admin.repo.js';
import * as authService from '../auth/auth.service.js';
import { setRefreshTokenCookie } from '../auth/auth.controller.js';

import { assertAdminCapability } from './admin.authorization.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../config/logger.js';
import { requestAdminUserDeletionWorkerRun } from './admin-user-deletion.worker.js';
import * as oauthService from '../onboarding/oauth.service.js';
import * as adminOAuthRepo from './admin-oauth.repo.js';
import * as providerControlService from '../provider-control/provider.service.js';
import { connectionParamsSchema, providerAccessSchema } from '../provider-control/provider.validator.js';
import { z } from 'zod';
import { getObject } from '../../storage/s3.service.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import { ensurePaygProfile } from '../billing/payg-billing.repo.js';

function requireAdmin(req: AuthedRequest, res: Response) {
  if (!req.adminCapabilities?.length || Boolean(req.impersonator)) {
    forbidden(res, 'Administrator capability required');
    return false;
  }
  return true;
}

function monthRange(value: unknown) {
  const raw = typeof value === 'string' && /^\d{4}-\d{2}$/.test(value) ? value : new Date().toISOString().slice(0, 7);
  const start = `${raw}-01`;
  const [yearValue, monthValue] = raw.split('-').map(Number);
  const year = yearValue ?? new Date().getUTCFullYear();
  const month = monthValue ?? new Date().getUTCMonth() + 1;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start, end, month: raw };
}

function paginate(req: AuthedRequest) {
  const limit = Math.max(1, Math.min(Math.floor(Number(req.query.limit)) || 100, 500));
  const offset = Math.max(Math.floor(Number(req.query.offset)) || 0, 0);
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  return { limit, offset, search };
}

export async function overview(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const range = monthRange(req.query.month);
    const customers = await repo.listCustomerBillingOverview(range.start, range.end);
    return successResponse(res, 'Admin billing overview loaded', { month: range.month, periodStart: range.start, periodEnd: range.end, customers });
  } catch (error) { next(error); }
}

export async function changePlan(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const plan = req.body?.planKey;
    if (!['starter', 'ai', 'test'].includes(plan)) return res.status(422).json({ success: false, error: { code: 'INVALID_PLAN', message: 'Plan must be starter, ai, or test' } });
    const workspaceId = typeof req.params.workspaceId === 'string' ? req.params.workspaceId : undefined;
    if (!workspaceId) return res.status(400).json({ success: false, error: { code: 'INVALID_WORKSPACE_ID', message: 'Workspace ID is required' } });
    const result = await repo.updatePlan(workspaceId, plan);
    if (!result) return res.status(404).json({ success: false, error: { code: 'WORKSPACE_SUBSCRIPTION_NOT_FOUND', message: 'Workspace subscription not found' } });
    return successResponse(res, 'Plan updated', result);
  } catch (error) { next(error); }
}

export async function setWorkspaceSubscriptionPrice(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const workspaceId = typeof req.params.workspaceId === 'string' ? req.params.workspaceId : '';
    if (!workspaceId) return res.status(400).json({ success: false, error: { code: 'INVALID_WORKSPACE_ID', message: 'Workspace ID is required' } });

    const rawAmount = req.body?.amountCny;
    // null is an explicit request to restore the catalog price. Undefined is
    // rejected so a malformed request can never accidentally clear pricing.
    if (rawAmount === undefined) {
      return res.status(422).json({ success: false, error: { code: 'SUBSCRIPTION_PRICE_REQUIRED', message: 'amountCny is required; use null to restore the catalog price' } });
    }
    let amountMinor: number | null = null;
    if (rawAmount !== null) {
      const amount = typeof rawAmount === 'number' ? rawAmount : Number(rawAmount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
        return res.status(422).json({ success: false, error: { code: 'INVALID_SUBSCRIPTION_PRICE', message: 'Subscription price must be between 0 and 10,000,000 CNY with at most two decimal places' } });
      }
      amountMinor = Math.round(amount * 100);
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    if (!reason) {
      return res.status(422).json({ success: false, error: { code: 'SUBSCRIPTION_PRICE_REASON_REQUIRED', message: 'A reason is required for every subscription price change' } });
    }

    const result = await repo.setWorkspaceSubscriptionPrice(workspaceId, amountMinor, reason, req.user!.id);
    return successResponse(res, amountMinor === null ? 'Catalog subscription price restored' : 'Subscription price override saved', result);
  } catch (error) { next(error); }
}

export async function dashboard(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const stats = await repo.getDashboardStats();
    return successResponse(res, 'Dashboard stats loaded', stats);
  } catch (error) { next(error); }
}

export async function searchAll(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (q.trim().length < 2) return successResponse(res, 'Search query too short', { users: [], workspaces: [], crm: [], websites: [] });
    const results = await repo.globalAdminSearch(q);
    return successResponse(res, 'Search complete', results);
  } catch (error) { next(error); }
}

export async function getUsers(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const { limit, offset, search } = paginate(req);
    const users = await repo.listUsers(limit, offset, search);
    return successResponse(res, 'Users loaded', { users, limit, offset });
  } catch (error) { next(error); }
}

export async function getUser(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const userId = typeof req.params.userId === 'string' ? req.params.userId : '';
    const user = await repo.getUserDetail(userId);
    if (!user) return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    return successResponse(res, 'User loaded', user);
  } catch (error) { next(error); }
}

export async function patchUser(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const userId = typeof req.params.userId === 'string' ? req.params.userId : '';
    const action = req.body?.action as 'lock' | 'unlock' | 'verify' | 'reset-sessions' | undefined;
    if (!action || !['lock', 'unlock', 'verify', 'reset-sessions'].includes(action)) {
      return res.status(422).json({ success: false, error: { code: 'INVALID_ACTION', message: 'Action must be lock, unlock, verify, or reset-sessions' } });
    }
    if(action==='verify'||action==='reset-sessions') await assertAdminCapability(req.user!.id,'security.manage');
    const result = await repo.updateUserStatus(userId, action);
    if (!result) return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    return successResponse(res, `User ${action} complete`, result);
  } catch (error) { next(error); }
}

export async function deleteUser(req: AuthedRequest, res: Response, next: NextFunction) {
  const userId = typeof req.params.userId === 'string' ? req.params.userId : '';
  try {
    if (!requireAdmin(req, res)) return;
    if (!userId) return res.status(400).json({ success: false, error: { code: 'INVALID_USER_ID', message: 'User ID is required' } });
    if (req.user?.id === userId) {
      return res.status(409).json({ success: false, error: { code: 'ADMIN_SELF_DELETE_FORBIDDEN', message: 'The active administrator account cannot be deleted.' } });
    }
    const job = await repo.queueUserDeletion(userId, req.user!.id);
    if (!job) return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    requestAdminUserDeletionWorkerRun();
    return res.status(202).json({ success: true, message: 'User deletion queued', data: job });
  } catch (error) {
    if (error instanceof Error && error.message === 'LAST_SUPER_ADMIN_DELETE_FORBIDDEN') {
      return res.status(409).json({ success: false, error: { code: 'LAST_SUPER_ADMIN_DELETE_FORBIDDEN', message: 'At least one active Super Admin account must remain.' } });
    }
    // Do not expose database internals in the admin UI. Log enough context to
    // correlate the request, while returning a non-generic, actionable code.
    logger.error({ error, actorUserId: req.user?.id, targetUserId: userId, requestId: req.id }, 'Admin user deletion failed');
    next(new AppError(500, 'USER_DELETE_FAILED', 'The account could not be deleted. No data was changed. Please retry shortly or contact support with the request ID.'));
  }
}

export async function getUserDeletionJob(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const jobId = typeof req.params.jobId === 'string' ? req.params.jobId : '';
    if (!jobId) return jsonError(res, 400, 'INVALID_JOB_ID', 'Deletion job ID is required');
    const job = await repo.getUserDeletionJob(jobId);
    if (!job) return jsonError(res, 404, 'USER_DELETION_JOB_NOT_FOUND', 'Deletion job not found');
    return successResponse(res, 'User deletion job loaded', job);
  } catch (error) { next(error); }
}

export async function impersonateUser(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const userId = typeof req.params.userId === 'string' ? req.params.userId : '';
    if (!userId) return jsonError(res, 400, 'INVALID_USER_ID', 'User ID is required');

    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
    const result = await authService.impersonateUser(
      { userId: req.user!.id, email: req.user!.email },
      userId,
      { userAgent, ipAddress: req.ip ?? null },
    );

    if ('notFound' in result) return jsonError(res, 404, 'USER_NOT_FOUND', 'User not found');
    if ('invalidTarget' in result) return jsonError(res, 409, 'IMPERSONATION_INVALID_TARGET', 'This account cannot be impersonated');

    setRefreshTokenCookie(res, result.refreshToken);
    return successResponse(res, 'Impersonation started', {
      token: result.token,
      user: result.user,
    });
  } catch (error) { next(error); }
}

export async function getWorkspaces(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const { limit, offset, search } = paginate(req);
    const workspaces = await repo.listWorkspaces(limit, offset, search);
    return successResponse(res, 'Workspaces loaded', { workspaces, limit, offset });
  } catch (error) { next(error); }
}

export async function getWorkspace(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const workspaceId = typeof req.params.workspaceId === 'string' ? req.params.workspaceId : '';
    const ws = await repo.getWorkspaceDetail(workspaceId);
    if (!ws) return res.status(404).json({ success: false, error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } });
    return successResponse(res, 'Workspace loaded', ws);
  } catch (error) { next(error); }
}

export async function patchWorkspace(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const workspaceId = typeof req.params.workspaceId === 'string' ? req.params.workspaceId : '';
    const action = req.body?.action as 'lock' | 'unlock' | 'reset-onboarding' | 'skip-onboarding' | 'set-plan' | undefined;
    if (!action || !['lock', 'unlock', 'reset-onboarding', 'skip-onboarding', 'set-plan'].includes(action)) {
      return res.status(422).json({ success: false, error: { code: 'INVALID_ACTION', message: 'Action invalid' } });
    }
    const planKey = typeof req.body?.planKey === 'string' ? req.body.planKey : undefined;
    if(action==='set-plan'||action==='skip-onboarding') await assertAdminCapability(req.user!.id,'billing.manage');
    const result = await repo.updateWorkspaceStatus(workspaceId, action, planKey, req.user!.id);
    if (!result) return res.status(404).json({ success: false, error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } });
    return successResponse(res, `Workspace ${action} complete`, result);
  } catch (error) { next(error); }
}

export async function getWorkspaceCredits(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const workspaceId = typeof req.params.workspaceId === 'string' ? req.params.workspaceId : '';
    if (!workspaceId) return res.status(400).json({ success: false, error: { code: 'INVALID_WORKSPACE_ID', message: 'Workspace ID is required' } });
    const [balance, grants] = await Promise.all([
      repo.getWorkspaceCreditBalance(workspaceId),
      repo.listWorkspaceCreditGrants(workspaceId),
    ]);
    return successResponse(res, 'Workspace credits loaded', { workspaceId, balance, grants });
  } catch (error) { next(error); }
}

export async function addWorkspaceCredits(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const workspaceId = typeof req.params.workspaceId === 'string' ? req.params.workspaceId : '';
    if (!workspaceId) return res.status(400).json({ success: false, error: { code: 'INVALID_WORKSPACE_ID', message: 'Workspace ID is required' } });
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(422).json({ success: false, error: { code: 'INVALID_CREDIT_AMOUNT', message: 'Credits amount must be a positive number' } });
    }
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : undefined;
    const balance = await repo.addWorkspaceCredits(workspaceId, amount, req.user!.id, note);
    return successResponse(res, 'Credits added', { workspaceId, balance, added: amount });
  } catch (error) { next(error); }
}

export async function getWorkspaceUsageAdjustments(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const workspaceId = typeof req.params.workspaceId === 'string' ? req.params.workspaceId : '';
    if (!workspaceId) return res.status(400).json({ success: false, error: { code: 'INVALID_WORKSPACE_ID', message: 'Workspace ID is required' } });
    const [adjustments, paygUsage] = await Promise.all([
      repo.listWorkspaceUsageAdjustments(workspaceId),
      repo.getWorkspacePaygUsage(workspaceId),
    ]);
    return successResponse(res, 'Workspace usage adjustments loaded', { workspaceId, adjustments, paygUsage });
  } catch (error) { next(error); }
}

export async function addWorkspaceUsageAdjustment(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const workspaceId = typeof req.params.workspaceId === 'string' ? req.params.workspaceId : '';
    if (!workspaceId) return res.status(400).json({ success: false, error: { code: 'INVALID_WORKSPACE_ID', message: 'Workspace ID is required' } });
    const metric = req.body?.metric;
    if (metric !== 'api' && metric !== 'server' && metric !== 'storage') {
      return res.status(422).json({ success: false, error: { code: 'INVALID_USAGE_METRIC', message: 'Metric must be api, server or storage' } });
    }
    const amountUsd = Number(req.body?.amountUsd);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > 1_000_000) {
      return res.status(422).json({ success: false, error: { code: 'INVALID_USAGE_ADJUSTMENT', message: 'Adjustment must be greater than 0 and no more than 1,000,000 USD' } });
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    if (!reason) {
      return res.status(422).json({ success: false, error: { code: 'USAGE_ADJUSTMENT_REASON_REQUIRED', message: 'A reason is required for every usage adjustment' } });
    }
    const adjustment = await repo.addWorkspaceUsageAdjustment(workspaceId, metric, amountUsd, reason, req.user!.id);
    return successResponse(res, 'Workspace usage credit added', adjustment);
  } catch (error) { next(error); }
}

export async function setWorkspaceUsageCosts(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const workspaceId = String(req.params.workspaceId ?? '');
    if (!workspaceId) return res.status(400).json({ success: false, error: { code: 'INVALID_WORKSPACE_ID', message: 'Workspace ID is required' } });
    const apiAiCostUsd = Number(req.body?.apiAiCostUsd);
    const storageCostUsd = Number(req.body?.storageCostUsd);
    if (![apiAiCostUsd, storageCostUsd].every((value) => Number.isFinite(value) && value >= 0 && value <= 1_000_000)) {
      return res.status(422).json({ success: false, error: { code: 'INVALID_USAGE_COST', message: 'API/AI and storage costs must be between 0 and 1,000,000 USD' } });
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    if (!reason) return res.status(422).json({ success: false, error: { code: 'USAGE_COST_REASON_REQUIRED', message: 'A reason is required when costs are changed' } });
    await ensurePaygProfile(workspaceId);
    await repo.setWorkspaceUsageCosts(workspaceId, apiAiCostUsd, storageCostUsd, reason, req.user!.id);
    return successResponse(res, 'Workspace API/AI and storage costs updated', await repo.getWorkspacePaygUsage(workspaceId));
  } catch (error) { next(error); }
}

export async function getCrm(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const { limit, offset, search } = paginate(req);
    const resourceType = typeof req.query.resourceType === 'string' ? req.query.resourceType : undefined;
    const records = await repo.listCrmRecords(limit, offset, search, resourceType);
    return successResponse(res, 'CRM records loaded', { records, limit, offset, resourceType });
  } catch (error) { next(error); }
}

export async function getWebsites(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const { limit, offset, search } = paginate(req);
    const websites = await repo.listWebsites(limit, offset, search);
    return successResponse(res, 'Websites loaded', { websites, limit, offset });
  } catch (error) { next(error); }
}

export async function getAgents(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const { limit, offset } = paginate(req);
    const agents = await repo.listAgents(limit, offset);
    return successResponse(res, 'Agents loaded', { agents, limit, offset });
  } catch (error) { next(error); }
}

export async function getIntegrations(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const { limit, offset } = paginate(req);
    const integrations = await repo.listIntegrations(limit, offset);
    return successResponse(res, 'Integrations loaded', { integrations, limit, offset });
  } catch (error) { next(error); }
}

export async function getOAuthConnections(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const { limit, offset, search } = paginate(req);
    const connections = await repo.listOAuthConnections(limit, offset, search);
    return successResponse(res, 'OAuth connections loaded', { connections, limit, offset });
  } catch (error) { next(error); }
}

export async function getProviderControlPlane(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    return successResponse(res, 'Provider control plane loaded', {
      connections: await providerControlService.listAdminProviders(),
      catalog: await providerControlService.listProviderCatalog(),
    });
  } catch (error) { next(error); }
}

export async function grantProviderWorkspaceAccess(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const { connectionId } = connectionParamsSchema.parse(req.params);
    const input = providerAccessSchema.parse(req.body);
    return successResponse(res, 'Shared provider access granted', await providerControlService.grantSharedProviderAccess({ providerConnectionId: connectionId, workspaceId: input.workspaceId, actorId: req.user!.id, grantedCapabilities: input.grantedCapabilities }));
  } catch (error) { next(error); }
}

export async function revokeProviderWorkspaceAccess(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const { connectionId } = connectionParamsSchema.parse(req.params);
    const input = providerAccessSchema.pick({ workspaceId: true }).parse(req.body);
    return successResponse(res, 'Shared provider access revoked', await providerControlService.revokeSharedProviderAccess({ providerConnectionId: connectionId, workspaceId: input.workspaceId, actorId: req.user!.id }));
  } catch (error) { next(error); }
}

export async function startManagedOAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const provider = String(req.params.provider);
    if (!oauthService.isSupportedProvider(provider) || !oauthService.isLuluManagedOAuthProvider(provider)) {
      return res.status(404).json({ success: false, error: { code: 'OAUTH_PROVIDER_NOT_ADMIN_MANAGED', message: 'This provider is not configured as a Lulu-managed connection' } });
    }
    const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '/app/admin-billing-overview-9901?page=oauth-connections';
    const authorizationUrl = oauthService.buildAdminAuthorizationUrl(provider, req.user!.id, returnTo);
    return successResponse(res, 'Managed OAuth authorization URL created', { provider, authorizationUrl, management: 'lulu_managed' });
  } catch (error) { next(error); }
}

export async function disconnectManagedOAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const provider = String(req.params.provider);
    if (!oauthService.isSupportedProvider(provider) || !oauthService.isLuluManagedOAuthProvider(provider)) {
      return res.status(404).json({ success: false, error: { code: 'OAUTH_PROVIDER_NOT_ADMIN_MANAGED', message: 'This provider is not configured as a Lulu-managed connection' } });
    }
    const disconnected = await adminOAuthRepo.disconnectManagedOAuthConnection(provider);
    return successResponse(res, disconnected ? 'Managed OAuth connection disconnected' : 'Managed OAuth connection was already disconnected', { provider, disconnected, management: 'lulu_managed' });
  } catch (error) { next(error); }
}

export async function getOAuthSelfServicePermissions(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : undefined;
    const workspaces = await adminOAuthRepo.listWorkspaceOAuthSelfServicePermissions(search);
    return successResponse(res, 'Workspace OAuth self-service permissions loaded', {
      workspaces,
      providers: adminOAuthRepo.LULU_MANAGED_PROVIDERS,
    });
  } catch (error) { next(error); }
}

export async function setOAuthSelfServicePermission(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const workspaceId = z.string().uuid().parse(req.params.workspaceId);
    const providerValue = z.string().min(1).parse(req.params.provider);
    const allowed = z.boolean().parse(req.body?.allowed);
    if (!adminOAuthRepo.isLuluManagedProvider(providerValue)) {
      return res.status(404).json({ success: false, error: { code: 'OAUTH_PROVIDER_NOT_ADMIN_MANAGED', message: 'This provider is not configured as a Lulu-managed connection' } });
    }
    const permission = await adminOAuthRepo.setWorkspaceOAuthSelfServicePermission({
      workspaceId,
      provider: providerValue,
      allowed,
      actorId: req.user!.id,
    });
    if (!permission) return res.status(404).json({ success: false, error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } });
    return successResponse(res, allowed ? 'Workspace OAuth self-service enabled' : 'Workspace OAuth self-service disabled', permission);
  } catch (error) { next(error); }
}

export async function getApprovals(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const { limit, offset } = paginate(req);
    const approvals = await repo.listApprovals(limit, offset);
    return successResponse(res, 'Approvals loaded', { approvals, limit, offset });
  } catch (error) { next(error); }
}

export async function getErrors(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const { limit, offset } = paginate(req);
    const errors = await repo.listErrorEvents(limit, offset);
    return successResponse(res, 'Error events loaded', { errors, limit, offset });
  } catch (error) { next(error); }
}

export async function getAuditLogs(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const { limit, offset } = paginate(req);
    const logs = await repo.listAuditLogs(limit, offset);
    return successResponse(res, 'Audit logs loaded', { logs, limit, offset });
  } catch (error) { next(error); }
}

export async function getConversations(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const { limit, offset } = paginate(req);
    const conversations = await repo.listConversations(limit, offset);
    return successResponse(res, 'Conversations loaded', { conversations, limit, offset });
  } catch (error) { next(error); }
}

export async function getFiles(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const { limit, offset } = paginate(req);
    const files = await repo.listFiles(limit, offset);
    return successResponse(res, 'Files loaded', { files, limit, offset });
  } catch (error) { next(error); }
}

export async function getJobs(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const { limit, offset } = paginate(req);
    const jobs = await repo.listJobs(limit, offset);
    return successResponse(res, 'Jobs loaded', { jobs, limit, offset });
  } catch (error) { next(error); }
}

export async function downloadFile(req:AuthedRequest,res:Response,next:NextFunction) {
  try {
    const file=await repo.getUploadedFile(z.enum(['onboarding','record','omnichannel']).parse(req.params.source),z.string().uuid().parse(req.params.fileId));
    await recordSecurityEvent({eventType:'ADMIN_ACTION',userId:req.user!.id,workspaceId:file.workspace_id,
      requestId:String(req.id??''),metadata:{action:'customer_file.download',targetId:String(req.params.fileId)}});
    const content=file.content??(file.storage_key?await getObject(file.storage_key):null);
    if(!content) throw new AppError(404,'FILE_CONTENT_UNAVAILABLE','Customer upload content is unavailable');
    res.setHeader('Content-Type','application/octet-stream');
    res.setHeader('Content-Disposition',`attachment; filename="customer-upload"; filename*=UTF-8''${encodeURIComponent(file.file_name??'customer-upload')}`);
    res.setHeader('Cache-Control','private, no-store');
    return res.send(content);
  } catch(error) {next(error);}
}

export async function getSettings(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const settings = await repo.listSettings();
    return successResponse(res, 'Settings loaded', { settings });
  } catch (error) { next(error); }
}

export async function getSupport(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (!requireAdmin(req, res)) return;
    const { limit, offset } = paginate(req);
    const tickets = await repo.listSupportTickets(limit, offset);
    return successResponse(res, 'Support tickets loaded', { tickets, limit, offset });
  } catch (error) { next(error); }
}
