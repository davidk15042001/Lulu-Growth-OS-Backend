import type { Response, NextFunction } from 'express';
import type { AuthedRequest } from '../../middlewares/auth.middleware.js';
import { forbidden, successResponse } from '../../utils/response.js';
import * as repo from './admin.repo.js';

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
    if (!['explorer', 'starter', 'ai', 'test'].includes(plan)) return res.status(422).json({ success: false, error: { code: 'INVALID_PLAN', message: 'Plan must be explorer, starter, ai, or test' } });
    const workspaceId = typeof req.params.workspaceId === 'string' ? req.params.workspaceId : undefined;
    if (!workspaceId) return res.status(400).json({ success: false, error: { code: 'INVALID_WORKSPACE_ID', message: 'Workspace ID is required' } });
    const result = await repo.updatePlan(workspaceId, plan);
    if (!result) return res.status(404).json({ success: false, error: { code: 'WORKSPACE_SUBSCRIPTION_NOT_FOUND', message: 'Workspace subscription not found' } });
    return successResponse(res, 'Plan updated', result);
  } catch (error) { next(error); }
}
