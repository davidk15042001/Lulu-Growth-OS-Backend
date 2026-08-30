import type { Response, NextFunction } from 'express';
import type { AuthedRequest } from '../../middlewares/auth.middleware.js';
import { forbidden, jsonError, successResponse } from '../../utils/response.js';
import * as repo from './admin.repo.js';
import * as authService from '../auth/auth.service.js';
import { setRefreshTokenCookie } from '../auth/auth.controller.js';

const ADMIN_BILLING_EMAIL = 'lulu.ai.cn@gmail.com';

function requireAdmin(req: AuthedRequest, res: Response) {
  if (req.user?.role !== 'admin' || req.user.email.trim().toLowerCase() !== ADMIN_BILLING_EMAIL) {
    forbidden(res, 'Administrator access restricted to the billing administrator account');
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
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
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
    const result = await repo.updateUserStatus(userId, action);
    if (!result) return res.status(404).json({ success: false, error: { code: 'USER_NOT_FOUND', message: 'User not found' } });
    return successResponse(res, `User ${action} complete`, result);
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
    const result = await repo.updateWorkspaceStatus(workspaceId, action, planKey);
    if (!result) return res.status(404).json({ success: false, error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } });
    return successResponse(res, `Workspace ${action} complete`, result);
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

