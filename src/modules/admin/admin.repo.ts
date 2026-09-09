import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { revokeSessionsInTransaction } from '../auth/auth.repo.js';
import { AppError } from '../../utils/app-error.js';

export async function listCustomerBillingOverview(periodStart: string, periodEnd: string) {
  const { rows } = await query(`
    WITH api_usage AS (
      SELECT workspace_id, SUM(customer_cost_usd)::numeric AS "apiCostUsd"
      FROM ai_usage_ledger
      WHERE created_at >= $1::date
        AND created_at < ($2::date + INTERVAL '1 day')
      GROUP BY workspace_id
    ), server_usage AS (
      SELECT workspace_id, SUM(customer_cost_usd)::numeric AS "serverCostUsd"
      FROM workspace_server_usage_ledger
      WHERE created_at >= $1::date
        AND created_at < ($2::date + INTERVAL '1 day')
      GROUP BY workspace_id
    ), uploaded_bytes AS (
      SELECT workspace_id, SUM(size_bytes)::numeric AS "storageBytes"
      FROM (
        SELECT workspace_id, size_bytes FROM onboarding_documents
        UNION ALL
        SELECT workspace_id, size_bytes FROM record_attachments
        UNION ALL
        SELECT workspace_id, size_bytes FROM omni_message_attachments
      ) uploads
      GROUP BY workspace_id
    ), usage_adjustments AS (
      SELECT workspace_id,
             COALESCE(SUM(amount_usd) FILTER (WHERE metric='api'), 0)::numeric AS "apiAdjustmentUsd",
             COALESCE(SUM(amount_usd) FILTER (WHERE metric IN ('server','storage')), 0)::numeric AS "storageAdjustmentUsd"
      FROM workspace_usage_adjustments
      WHERE period_start < ($2::date + INTERVAL '1 day')
        AND period_end > $1::date
      GROUP BY workspace_id
    )
    SELECT
      w.id,
      u.first_name AS "firstName",
      u.last_name AS "lastName",
      u.email,
      w.name AS "companyName",
      COALESCE(ws.plan_key, 'starter') AS "planKey",
      COALESCE(ws.status, 'inactive') AS "subscriptionStatus",
      ws.custom_price_minor AS "customPriceMinor",
      ws.custom_price_currency AS "customPriceCurrency",
      COALESCE(ws.current_period_starts_at, ws.created_at, w.created_at) AS "startDate",
      COALESCE(ws.current_period_ends_at, ws.trial_ends_at) AS "expiryDate",
      GREATEST(0::numeric, COALESCE(api_usage."apiCostUsd", 0) - COALESCE(usage_adjustments."apiAdjustmentUsd", 0))::numeric AS "apiCostUsd",
      GREATEST(0::numeric, COALESCE(server_usage."serverCostUsd", 0) - COALESCE(usage_adjustments."storageAdjustmentUsd", 0))::numeric AS "serverCostUsd",
      COALESCE(uploaded_bytes."storageBytes", 0)::numeric AS "storageBytes",
      -- Kept for backwards-compatible API clients. New clients must use the
      -- explicit USD fields above; these legacy counters are not authoritative.
      COALESCE(uc."apiCostMinor", 0)::numeric AS "apiCostMinor",
      COALESCE(uc."storageCostMinor", 0)::numeric AS "storageCostMinor"
    FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.role = 'owner'
    JOIN users u ON u.id = wm.user_id AND u.deleted_at IS NULL
    LEFT JOIN workspace_subscriptions ws ON ws.workspace_id = w.id
    LEFT JOIN api_usage ON api_usage.workspace_id = w.id
    LEFT JOIN server_usage ON server_usage.workspace_id = w.id
    LEFT JOIN uploaded_bytes ON uploaded_bytes.workspace_id = w.id
    LEFT JOIN usage_adjustments ON usage_adjustments.workspace_id = w.id
    LEFT JOIN LATERAL (
      SELECT
        SUM(quantity) FILTER (WHERE metric_key IN ('api_cost_minor','api_cost_cny_minor')) AS "apiCostMinor",
        SUM(quantity) FILTER (WHERE metric_key IN ('storage_cost_minor','server_storage_cost_minor')) AS "storageCostMinor"
      FROM workspace_usage_counters
      WHERE workspace_id=w.id AND period_start >= $1::date AND period_end <= $2::date
    ) uc ON TRUE
    WHERE w.deleted_at IS NULL
    GROUP BY w.id, u.first_name, u.last_name, u.email, w.name,
             ws.plan_key, ws.status, ws.current_period_starts_at,
             ws.current_period_ends_at, ws.trial_ends_at, ws.created_at,
             ws.custom_price_minor, ws.custom_price_currency, w.created_at,
             api_usage."apiCostUsd", server_usage."serverCostUsd", uploaded_bytes."storageBytes",
             usage_adjustments."apiAdjustmentUsd", usage_adjustments."storageAdjustmentUsd",
             uc."apiCostMinor", uc."storageCostMinor"
    ORDER BY w.created_at DESC
  `, [periodStart, periodEnd]);
  return rows;
}

export async function updatePlan(workspaceId: string, planKey: 'explorer' | 'starter' | 'ai' | 'test') {
  const { rows } = await query(
    `UPDATE workspace_subscriptions
     SET plan_key = $2, updated_at = NOW()
     WHERE workspace_id = $1
     RETURNING workspace_id AS "workspaceId", plan_key AS "planKey", status`,
    [workspaceId, planKey],
  );
  return rows[0];
}

export async function getWorkspaceCreditBalance(workspaceId: string) {
  const { rows } = await query<{ balance: string }>(
    `SELECT balance FROM workspace_credit_balances WHERE workspace_id = $1`,
    [workspaceId],
  );
  return Number(rows[0]?.balance ?? 0);
}

export async function listWorkspaceCreditGrants(workspaceId: string) {
  const { rows } = await query(
    `SELECT g.id, g.amount, g.balance_after AS "balanceAfter", g.note,
            g.granted_by AS "grantedBy", u.email AS "grantedByEmail",
            g.created_at AS "createdAt"
     FROM workspace_credit_grants g
     LEFT JOIN users u ON u.id = g.granted_by
     WHERE g.workspace_id = $1
     ORDER BY g.created_at DESC
     LIMIT 100`,
    [workspaceId],
  );
  return rows;
}

export async function addWorkspaceCredits(workspaceId: string, amount: number, grantedBy: string, note?: string) {
  return withTransaction(async (client) => {
    const updated = await query<{ balance: string }>(
      `INSERT INTO workspace_credit_balances (workspace_id, balance, updated_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id) DO UPDATE SET
         balance = workspace_credit_balances.balance + EXCLUDED.balance,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING balance`,
      [workspaceId, amount, grantedBy],
      client,
    );
    const balance = Number(updated.rows[0]?.balance ?? amount);
    await query(
      `INSERT INTO workspace_credit_grants (workspace_id, amount, balance_after, granted_by, note)
       VALUES ($1, $2, $3, $4, $5)`,
      [workspaceId, amount, balance, grantedBy, note ?? null],
      client,
    );
    return balance;
  });
}

/**
 * Audited credits granted by an administrator. AI requests are recorded in
 * the API usage ledger, so the `api` metric intentionally covers API + AI
 * costs. Storage is settled alongside the server/infrastructure charge.
 */
export type UsageAdjustmentMetric = 'api' | 'server' | 'storage';

export async function listWorkspaceUsageAdjustments(workspaceId: string) {
  const { rows } = await query(`
    SELECT a.id,
           a.metric,
           a.amount_usd AS "amountUsd",
           a.period_start AS "periodStart",
           a.period_end AS "periodEnd",
           a.payg_period_id AS "paygPeriodId",
           a.applied_at AS "appliedAt",
           a.reason,
           a.created_by AS "createdBy",
           u.email AS "createdByEmail",
           a.created_at AS "createdAt"
    FROM workspace_usage_adjustments a
    LEFT JOIN users u ON u.id = a.created_by
    WHERE a.workspace_id = $1
    ORDER BY a.created_at DESC
    LIMIT 100
  `, [workspaceId]);
  return rows;
}

export async function getWorkspacePaygUsage(workspaceId: string) {
  const { rows } = await query(`
    SELECT p.current_period_start AS "periodStart",
           p.current_period_end AS "periodEnd",
           COALESCE((
             SELECT SUM(u.customer_cost_usd)
             FROM ai_usage_ledger u
             WHERE u.workspace_id = p.workspace_id
               AND u.payg_period_id IS NULL
               AND u.created_at >= p.current_period_start
               AND u.created_at < p.current_period_end
           ), 0)::numeric AS "apiCostUsd",
           COALESCE((
             SELECT SUM(s.customer_cost_usd)
             FROM workspace_server_usage_ledger s
             WHERE s.workspace_id = p.workspace_id
               AND s.payg_period_id IS NULL
               AND s.created_at >= p.current_period_start
               AND s.created_at < p.current_period_end
           ), 0)::numeric AS "serverCostUsd",
           COALESCE((
             SELECT SUM(a.amount_usd)
             FROM workspace_usage_adjustments a
             WHERE a.workspace_id = p.workspace_id
               AND a.payg_period_id IS NULL
               AND a.period_start = p.current_period_start
               AND a.period_end = p.current_period_end
               AND a.metric = 'api'
           ), 0)::numeric AS "apiCreditUsd",
           COALESCE((
             SELECT SUM(a.amount_usd)
             FROM workspace_usage_adjustments a
             WHERE a.workspace_id = p.workspace_id
               AND a.payg_period_id IS NULL
               AND a.period_start = p.current_period_start
               AND a.period_end = p.current_period_end
               AND a.metric IN ('server', 'storage')
           ), 0)::numeric AS "serverCreditUsd",
           COALESCE((
             SELECT SUM(a.amount_usd)
             FROM workspace_usage_adjustments a
             WHERE a.workspace_id = p.workspace_id
               AND a.payg_period_id IS NULL
               AND a.period_start = p.current_period_start
               AND a.period_end = p.current_period_end
               AND a.metric = 'storage'
           ), 0)::numeric AS "storageCreditUsd"
    FROM workspace_payg_profiles p
    WHERE p.workspace_id = $1
  `, [workspaceId]);
  const row = rows[0];
  if (!row) return null;
  const apiCostUsd = Number(row.apiCostUsd ?? 0);
  const serverCostUsd = Number(row.serverCostUsd ?? 0);
  const apiCreditUsd = Number(row.apiCreditUsd ?? 0);
  const serverCreditUsd = Number(row.serverCreditUsd ?? 0);
  const storageCreditUsd = Number(row.storageCreditUsd ?? 0);
  return {
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    apiCostUsd,
    serverCostUsd,
    apiCreditUsd,
    serverCreditUsd,
    storageCreditUsd,
    apiBillableUsd: Math.max(0, apiCostUsd - apiCreditUsd),
    serverBillableUsd: Math.max(0, serverCostUsd - serverCreditUsd),
    totalBillableUsd: Math.max(0, apiCostUsd - apiCreditUsd) + Math.max(0, serverCostUsd - serverCreditUsd),
  };
}

export async function addWorkspaceUsageAdjustment(
  workspaceId: string,
  metric: UsageAdjustmentMetric,
  amountUsd: number,
  reason: string,
  createdBy: string,
) {
  return withTransaction(async (client) => {
    const profile = await query<{ periodStart: string; periodEnd: string }>(
      `SELECT current_period_start AS "periodStart", current_period_end AS "periodEnd"
       FROM workspace_payg_profiles
       WHERE workspace_id = $1 AND enabled = TRUE
       FOR UPDATE`,
      [workspaceId],
      client,
    );
    const current = profile.rows[0];
    if (!current) {
      throw new AppError(409, 'PAYG_USAGE_NOT_CONFIGURED', 'PAYG usage is not configured for this workspace.');
    }
    if (new Date(current.periodEnd).getTime() <= Date.now()) {
      throw new AppError(409, 'PAYG_PERIOD_CLOSED', 'The current PAYG usage period is already closed.');
    }
    const inserted = await query(
      `INSERT INTO workspace_usage_adjustments (
         workspace_id, period_start, period_end, metric, amount_usd, reason, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id,
                 metric,
                 amount_usd AS "amountUsd",
                 period_start AS "periodStart",
                 period_end AS "periodEnd",
                 payg_period_id AS "paygPeriodId",
                 applied_at AS "appliedAt",
                 reason,
                 created_by AS "createdBy",
                 created_at AS "createdAt"`,
      [workspaceId, current.periodStart, current.periodEnd, metric, amountUsd, reason, createdBy],
      client,
    );
    const adjustment = inserted.rows[0];
    if (!adjustment) throw new AppError(500, 'USAGE_ADJUSTMENT_NOT_CREATED', 'The usage adjustment could not be recorded.');
    await query(
      `INSERT INTO audit_log (
         workspace_id, actor_id, action, entity_type, entity_id, after_data
       ) VALUES ($1, $2, 'payg_usage.adjusted', 'workspace_usage_adjustment', $3, $4::jsonb)`,
      [workspaceId, createdBy, adjustment.id, JSON.stringify({ metric, amountUsd, reason, periodStart: current.periodStart, periodEnd: current.periodEnd })],
      client,
    );
    return adjustment;
  });
}

export async function setWorkspaceUsageCosts(
  workspaceId: string,
  apiAiCostUsd: number,
  storageCostUsd: number,
  reason: string,
  updatedBy: string,
) {
  return withTransaction(async (client) => {
    const profile = await query<{ periodStart: string; periodEnd: string }>(
      `SELECT current_period_start AS "periodStart", current_period_end AS "periodEnd"
         FROM workspace_payg_profiles
        WHERE workspace_id=$1 AND enabled=TRUE
        FOR UPDATE`,
      [workspaceId],
      client,
    );
    const period = profile.rows[0];
    if (!period) throw new AppError(409, 'PAYG_USAGE_NOT_CONFIGURED', 'PAYG usage is not configured for this workspace.');

    const totals = await query<{
      rawApi: string; rawStorage: string; apiAdjustments: string; storageAdjustments: string;
    }>(
      `SELECT
         COALESCE((SELECT SUM(customer_cost_usd) FROM ai_usage_ledger
           WHERE workspace_id=$1 AND payg_period_id IS NULL AND created_at >= $2 AND created_at < $3), 0)::numeric AS "rawApi",
         COALESCE((SELECT SUM(customer_cost_usd) FROM workspace_server_usage_ledger
           WHERE workspace_id=$1 AND payg_period_id IS NULL AND created_at >= $2 AND created_at < $3), 0)::numeric AS "rawStorage",
         COALESCE((SELECT SUM(amount_usd) FROM workspace_usage_adjustments
           WHERE workspace_id=$1 AND payg_period_id IS NULL AND period_start=$2 AND period_end=$3 AND metric='api'), 0)::numeric AS "apiAdjustments",
         COALESCE((SELECT SUM(amount_usd) FROM workspace_usage_adjustments
           WHERE workspace_id=$1 AND payg_period_id IS NULL AND period_start=$2 AND period_end=$3 AND metric IN ('server','storage')), 0)::numeric AS "storageAdjustments"`,
      [workspaceId, period.periodStart, period.periodEnd],
      client,
    );
    const current = totals.rows[0]!;
    const changes = [
      { metric: 'api' as const, amount: Number(current.rawApi) - apiAiCostUsd - Number(current.apiAdjustments) },
      { metric: 'storage' as const, amount: Number(current.rawStorage) - storageCostUsd - Number(current.storageAdjustments) },
    ].filter((entry) => Math.abs(entry.amount) >= 0.00000001);

    for (const change of changes) {
      await query(
        `INSERT INTO workspace_usage_adjustments(
           workspace_id, period_start, period_end, metric, amount_usd, reason, created_by
         ) VALUES($1, $2, $3, $4, $5, $6, $7)`,
        [workspaceId, period.periodStart, period.periodEnd, change.metric, change.amount, reason, updatedBy],
        client,
      );
    }
    await query(
      `INSERT INTO audit_log(workspace_id, actor_id, action, entity_type, entity_id, after_data)
       VALUES($1, $2, 'payg_usage.costs_set', 'workspace_payg_profile', $1::uuid::text, $3::jsonb)`,
      [workspaceId, updatedBy, JSON.stringify({ apiAiCostUsd, storageCostUsd, reason, periodStart: period.periodStart, periodEnd: period.periodEnd })],
      client,
    );
    return { workspaceId, apiAiCostUsd, storageCostUsd, periodStart: period.periodStart, periodEnd: period.periodEnd };
  });
}

export async function getDashboardStats() {
  const [users, workspaces, subscriptions, records, websites, errorsResult] = await Promise.all([
    query(`SELECT
      COUNT(*)::int AS "total",
      COUNT(*) FILTER (WHERE verified_at IS NOT NULL)::int AS "verified",
      COUNT(*) FILTER (WHERE role = 'admin')::int AS "admins",
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS "newLast30d"
    FROM users WHERE deleted_at IS NULL`),
    query(`SELECT
      COUNT(*)::int AS "total",
      COUNT(*) FILTER (WHERE onboarding_completed_at IS NOT NULL)::int AS "onboarded",
      COUNT(*) FILTER (WHERE onboarding_files_purged_at IS NOT NULL)::int AS "filesPurged",
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS "newLast30d"
    FROM workspaces WHERE deleted_at IS NULL`),
    query(`SELECT
      COUNT(*)::int AS "total",
      COUNT(*) FILTER (WHERE status = 'active')::int AS "active",
      COUNT(*) FILTER (WHERE status = 'trialing')::int AS "trialing",
      COUNT(*) FILTER (WHERE status = 'canceled')::int AS "canceled",
      COALESCE(SUM(CASE WHEN plan_key = 'ai' THEN 1 ELSE 0 END), 0)::int AS "aiPlan",
      COALESCE(SUM(CASE WHEN plan_key = 'starter' THEN 1 ELSE 0 END), 0)::int AS "starterPlan",
      COALESCE(SUM(CASE WHEN plan_key = 'explorer' THEN 1 ELSE 0 END), 0)::int AS "explorerPlan",
      COALESCE(SUM(CASE WHEN plan_key = 'test' THEN 1 ELSE 0 END), 0)::int AS "testPlan"
    FROM workspace_subscriptions`),
    query(`SELECT
      resource_type AS "resourceType",
      COUNT(*)::int AS "count"
    FROM workspace_records WHERE deleted_at IS NULL
    GROUP BY resource_type`),
    query(`SELECT
      COUNT(*)::int AS "total",
      COUNT(*) FILTER (WHERE status = 'published')::int AS "published",
      COUNT(*) FILTER (WHERE provider = 'wordpress')::int AS "wordpress",
      (SELECT COUNT(*)::int FROM provider_accounts WHERE provider_key='shopify') AS "shopify",
      COUNT(*) FILTER (WHERE provider = 'webflow')::int AS "webflow",
      NULL::int AS "woocommerce"
    FROM workspace_sites`),
    query(`SELECT
      COUNT(*)::int AS "totalLast24h",
      COUNT(*) FILTER (WHERE level = 'error')::int AS "errorsLast24h",
      COUNT(*) FILTER (WHERE level = 'warning')::int AS "warningsLast24h"
    FROM notification_events WHERE created_at >= NOW() - INTERVAL '24 hours'`).catch(() => ({ rows: [{ totalLast24h: 0, errorsLast24h: 0, warningsLast24h: 0 }] })),
  ]);
  return {
    users: users.rows[0],
    workspaces: workspaces.rows[0],
    subscriptions: subscriptions.rows[0],
    crmByType: records.rows,
    websites: websites.rows[0],
    notifications: errorsResult.rows[0],
  };
}

export async function listUsers(limit = 100, offset = 0, search?: string) {
  const values: unknown[] = [limit, offset];
  let where = 'u.deleted_at IS NULL';
  if (search) {
    values.push(`%${search}%`);
    where += ` AND (u.email ILIKE $${values.length} OR u.first_name ILIKE $${values.length} OR u.last_name ILIKE $${values.length})`;
  }
  const { rows } = await query(`
    SELECT
      u.id, u.email, u.first_name AS "firstName", u.last_name AS "lastName",
      u.role, u.verified_at AS "verifiedAt", u.created_at AS "createdAt",
      u.updated_at AS "updatedAt", u.token_version AS "tokenVersion",
      (SELECT COUNT(*) FROM workspace_members wm WHERE wm.user_id = u.id)::int AS "workspaceCount",
      (SELECT COUNT(*) FROM auth_sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at>NOW())::int AS "activeSessions"
    FROM users u
    WHERE ${where}
    ORDER BY u.created_at DESC
    LIMIT $1 OFFSET $2
  `, values);
  return rows;
}

export async function getUserDetail(userId: string) {
  const userResult = await query(`
    SELECT
      u.id, u.email, u.first_name AS "firstName", u.last_name AS "lastName",
      u.role, u.verified_at AS "verifiedAt", u.created_at AS "createdAt",
      u.updated_at AS "updatedAt"
    FROM users u
    WHERE u.id = $1 AND u.deleted_at IS NULL
    LIMIT 1
  `, [userId]);
  if (!userResult.rows[0]) return null;

  const [workspaces, sessions, usage, credits] = await Promise.all([
    query(`
      SELECT w.id, w.name AS "companyName", wm.role, w.onboarding_step AS "onboardingStep",
             w.onboarding_completed_at AS "onboardingCompletedAt", w.created_at AS "joinedAt"
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id AND w.deleted_at IS NULL
      WHERE wm.user_id = $1
      ORDER BY wm.role = 'owner' DESC, w.created_at ASC
    `, [userId]),
    query(`
      SELECT id, device_label AS "userAgent", NULL::text AS "ipAddress",
             created_at AS "createdAt", last_used_at AS "lastUsedAt",
             expires_at AS "expiresAt", (revoked_at IS NOT NULL) AS revoked
      FROM auth_sessions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [userId]),
    query(`
      SELECT uc.metric_key AS "metricKey", SUM(uc.quantity)::numeric AS "total",
             MIN(uc.period_start) AS "periodStart", MAX(uc.period_end) AS "periodEnd"
      FROM workspace_usage_counters uc
      JOIN workspace_members wm ON wm.workspace_id = uc.workspace_id
      WHERE wm.user_id = $1
      GROUP BY uc.metric_key
    `, [userId]),
    query(`
      SELECT COALESCE(SUM(cb.balance), 0)::numeric AS "balance"
      FROM workspace_credit_balances cb
      JOIN workspace_members wm ON wm.workspace_id = cb.workspace_id
      WHERE wm.user_id = $1 AND wm.role = 'owner'
    `, [userId]),
  ]);

  return {
    ...userResult.rows[0],
    workspaces: workspaces.rows,
    sessions: sessions.rows,
    usage: usage.rows,
    creditBalance: Number(credits.rows[0]?.balance ?? 0),
  };
}

export async function updateUserStatus(userId: string, action: 'lock' | 'unlock' | 'verify' | 'reset-sessions') {
  await withTransaction(async client => {
  switch (action) {
    case 'lock':
      await query(`UPDATE users SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`, [userId],client);
      await revokeSessionsInTransaction(userId,null,'admin_locked',client);
      break;
    case 'unlock':
      await query(`UPDATE users SET deleted_at = NULL WHERE id = $1`, [userId],client);
      break;
    case 'verify':
      await query(`UPDATE users SET verified_at = NOW() WHERE id = $1 AND verified_at IS NULL`, [userId],client);
      break;
    case 'reset-sessions':
      await query(`UPDATE users SET token_version = token_version + 1 WHERE id = $1`, [userId],client);
      await revokeSessionsInTransaction(userId,null,'admin_reset',client);
      break;
  }
  });
  return getUserDetail(userId);
}

type RestrictingUserReference = {
  schemaName: string;
  tableName: string;
  columnName: string;
};

const ADMIN_USER_DELETION_JOB_TYPE = 'admin.user.delete';

export type AdminUserDeletionJob = {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  targetUserId: string;
  targetEmail: string | null;
  requestedByUserId: string | null;
  attempts: number;
  errorMessage: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

function mapAdminUserDeletionJob(row: Record<string, unknown>): AdminUserDeletionJob {
  const status = String(row.status ?? 'queued');
  return {
    id: String(row.id),
    status: ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(status)
      ? status as AdminUserDeletionJob['status']
      : 'failed',
    targetUserId: String(row.targetUserId ?? ''),
    targetEmail: typeof row.targetEmail === 'string' ? row.targetEmail : null,
    requestedByUserId: typeof row.requestedByUserId === 'string' ? row.requestedByUserId : null,
    attempts: Number(row.attempts ?? 0),
    errorMessage: typeof row.errorMessage === 'string' ? row.errorMessage : null,
    result: row.result && typeof row.result === 'object' && !Array.isArray(row.result) ? row.result as Record<string, unknown> : null,
    createdAt: String(row.createdAt),
    startedAt: typeof row.startedAt === 'string' ? row.startedAt : null,
    completedAt: typeof row.completedAt === 'string' ? row.completedAt : null,
  };
}

const adminUserDeletionJobSelect = `
  id, status,
  payload->>'targetUserId' AS "targetUserId",
  payload->>'targetEmail' AS "targetEmail",
  payload->>'requestedByUserId' AS "requestedByUserId",
  attempts,
  error_message AS "errorMessage",
  result,
  created_at AS "createdAt",
  started_at AS "startedAt",
  completed_at AS "completedAt"
`;

/**
 * Account erasure can cascade through hundreds of thousands of workspace
 * records. It must be durable and asynchronous so reverse-proxy timeouts do
 * not falsely report a failed deletion while the database is still working.
 */
export async function queueUserDeletion(userId: string, requestedByUserId: string) {
  return withTransaction(async (client) => {
    const target = await query<{ id: string; email: string; isSuperAdmin: boolean }>(
      `SELECT u.id, u.email,
              EXISTS(
                SELECT 1
                  FROM admin_user_roles aur
                 WHERE aur.user_id = u.id AND aur.role = 'SUPER_ADMIN'
              ) AS "isSuperAdmin"
         FROM users u
        WHERE u.id = $1
        LIMIT 1
        FOR UPDATE`,
      [userId],
      client,
    );
    const user = target.rows[0];
    if (!user) return null;

    // Fail this protected case before creating a job. The worker repeats the
    // guard during the actual delete so a role change between queueing and
    // execution is still safe.
    if (user.isSuperAdmin) {
      const remainingSuperAdmins = await query<{ count: string }>(
        `SELECT COUNT(*)::bigint AS count
           FROM admin_user_roles aur
           JOIN users u ON u.id = aur.user_id
          WHERE aur.role = 'SUPER_ADMIN'
            AND aur.user_id <> $1
            AND u.deleted_at IS NULL`,
        [userId],
        client,
      );
      if (Number(remainingSuperAdmins.rows[0]?.count ?? 0) === 0) {
        throw new Error('LAST_SUPER_ADMIN_DELETE_FORBIDDEN');
      }
    }

    const existing = await query<Record<string, unknown>>(
      `SELECT ${adminUserDeletionJobSelect}
         FROM background_jobs
        WHERE job_type = $1
          AND payload->>'targetUserId' = $2
          AND status IN ('queued', 'running')
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [ADMIN_USER_DELETION_JOB_TYPE, userId],
      client,
    );
    if (existing.rows[0]) return mapAdminUserDeletionJob(existing.rows[0]);

    const created = await query<Record<string, unknown>>(
      `INSERT INTO background_jobs (workspace_id, job_type, payload, max_attempts)
       VALUES (NULL, $1, jsonb_build_object(
         'targetUserId', $2::text,
         'targetEmail', $3::text,
         'requestedByUserId', $4::text
       ), 1)
       ON CONFLICT DO NOTHING
       RETURNING ${adminUserDeletionJobSelect}`,
      [ADMIN_USER_DELETION_JOB_TYPE, user.id, user.email, requestedByUserId],
      client,
    );
    if (created.rows[0]) return mapAdminUserDeletionJob(created.rows[0]);

    // The partial unique index protects simultaneous clicks or admin sessions.
    const concurrent = await query<Record<string, unknown>>(
      `SELECT ${adminUserDeletionJobSelect}
         FROM background_jobs
        WHERE job_type = $1
          AND payload->>'targetUserId' = $2
          AND status IN ('queued', 'running')
        ORDER BY created_at DESC
        LIMIT 1`,
      [ADMIN_USER_DELETION_JOB_TYPE, userId],
      client,
    );
    if (concurrent.rows[0]) return mapAdminUserDeletionJob(concurrent.rows[0]);
    throw new Error('USER_DELETION_JOB_CREATE_FAILED');
  });
}

export async function getUserDeletionJob(jobId: string) {
  const result = await query<Record<string, unknown>>(
    `SELECT ${adminUserDeletionJobSelect}
       FROM background_jobs
      WHERE id = $1 AND job_type = $2
      LIMIT 1`,
    [jobId, ADMIN_USER_DELETION_JOB_TYPE],
  );
  return result.rows[0] ? mapAdminUserDeletionJob(result.rows[0]) : null;
}

export async function claimNextUserDeletionJob(workerId = 'admin-user-deletion-worker') {
  const result = await query<Record<string, unknown>>(
    `WITH candidate AS (
       SELECT id
         FROM background_jobs
        WHERE job_type = $1
          AND (
            (status = 'queued' AND scheduled_at <= NOW())
             OR (status = 'running' AND COALESCE(heartbeat_at, started_at) < NOW() - INTERVAL '15 minutes')
          )
        ORDER BY scheduled_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE background_jobs AS job
        SET status = 'running',
            attempts = attempts + 1,
             started_at = NOW(),
             worker_id = $2,
             heartbeat_at = NOW(),
            completed_at = NULL,
            error_message = NULL
       FROM candidate
      WHERE job.id = candidate.id
      RETURNING
        job.id,
        job.status,
        job.payload->>'targetUserId' AS "targetUserId",
        job.payload->>'targetEmail' AS "targetEmail",
        job.payload->>'requestedByUserId' AS "requestedByUserId",
        job.attempts,
        job.error_message AS "errorMessage",
        job.result,
        job.created_at AS "createdAt",
        job.started_at AS "startedAt",
        job.completed_at AS "completedAt"`,
     [ADMIN_USER_DELETION_JOB_TYPE, workerId],
  );
  return result.rows[0] ? mapAdminUserDeletionJob(result.rows[0]) : null;
}

export async function markUserDeletionJobSucceeded(jobId: string, result: Record<string, unknown>) {
  await query(
    `UPDATE background_jobs
        SET status = 'succeeded', result = $2::jsonb, completed_at = NOW(), error_message = NULL,
            worker_id = NULL, heartbeat_at = NULL
      WHERE id = $1 AND job_type = $3 AND status = 'running'`,
    [jobId, JSON.stringify(result), ADMIN_USER_DELETION_JOB_TYPE],
  );
}

export async function markUserDeletionJobFailed(jobId: string, errorMessage: string) {
  await query(
    `UPDATE background_jobs
        SET status = 'failed', error_message = $2, completed_at = NOW(),
            worker_id = NULL, heartbeat_at = NULL
      WHERE id = $1 AND job_type = $3 AND status = 'running'`,
    [jobId, errorMessage.slice(0, 1_000), ADMIN_USER_DELETION_JOB_TYPE],
  );
}

function quoteIdentifier(identifier: string) {
  // Every name is obtained from PostgreSQL's own catalogue. Keep this guard
  // nevertheless: an identifier must never be interpolated unchecked.
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(identifier)) {
    throw new Error('INVALID_DATABASE_IDENTIFIER');
  }
  return `"${identifier}"`;
}

/**
 * Remove rows from any *actual* single-column RESTRICT/NO ACTION foreign key
 * to users. The explicit deletes below document the normal schema and define
 * the order for its dependent CRM data. This catalogue-driven last pass keeps
 * a production database with a historical, not-yet-documented FK from making
 * an account permanently undeletable.
 */
async function deleteLegacyRestrictingUserReferences(userId: string, client: PoolClient) {
  const references = await query<RestrictingUserReference>(
    `SELECT namespace.nspname AS "schemaName",
            relation.relname AS "tableName",
            attribute.attname AS "columnName"
       FROM pg_constraint fk_constraint
       JOIN pg_class relation ON relation.oid = fk_constraint.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_attribute attribute
         ON attribute.attrelid = fk_constraint.conrelid
        AND attribute.attnum = fk_constraint.conkey[1]
      WHERE fk_constraint.contype = 'f'
        AND fk_constraint.confrelid = 'users'::regclass
        AND fk_constraint.confdeltype IN ('a', 'r')
        AND cardinality(fk_constraint.conkey) = 1
        AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY namespace.nspname, relation.relname, attribute.attname`,
    [],
    client,
  );

  let deletedCount = 0;
  for (const reference of references.rows) {
    const schemaName = quoteIdentifier(reference.schemaName);
    const tableName = quoteIdentifier(reference.tableName);
    const columnName = quoteIdentifier(reference.columnName);
    const result = await query(
      `DELETE FROM ${schemaName}.${tableName} WHERE ${columnName} = $1`,
      [userId],
      client,
    );
    deletedCount += result.rowCount;
  }
  return deletedCount;
}

/**
 * The same historical-schema safeguard for data owned by an account's
 * workspaces. Current migrations cascade workspace data, but a production
 * database can still contain an older RESTRICT/NO ACTION relation. Remove only
 * rows that belong to the workspaces being erased, never other tenants' data.
 */
async function deleteLegacyRestrictingWorkspaceReferences(workspaceIds: string[], client: PoolClient) {
  if (!workspaceIds.length) return 0;

  const references = await query<RestrictingUserReference>(
    `SELECT namespace.nspname AS "schemaName",
            relation.relname AS "tableName",
            attribute.attname AS "columnName"
       FROM pg_constraint fk_constraint
       JOIN pg_class relation ON relation.oid = fk_constraint.conrelid
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_attribute attribute
         ON attribute.attrelid = fk_constraint.conrelid
        AND attribute.attnum = fk_constraint.conkey[1]
      WHERE fk_constraint.contype = 'f'
        AND fk_constraint.confrelid = 'workspaces'::regclass
        AND fk_constraint.confdeltype IN ('a', 'r')
        AND cardinality(fk_constraint.conkey) = 1
        AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY namespace.nspname, relation.relname, attribute.attname`,
    [],
    client,
  );

  let deletedCount = 0;
  for (const reference of references.rows) {
    const schemaName = quoteIdentifier(reference.schemaName);
    const tableName = quoteIdentifier(reference.tableName);
    const columnName = quoteIdentifier(reference.columnName);
    const result = await query(
      `DELETE FROM ${schemaName}.${tableName} WHERE ${columnName} = ANY($1::uuid[])`,
      [workspaceIds],
      client,
    );
    deletedCount += result.rowCount;
  }
  return deletedCount;
}

export async function deleteUserAndOwnedData(userId: string) {
  return withTransaction(async (client) => {
    const userResult = await query<{
      id: string;
      email: string;
      isSuperAdmin: boolean;
    }>(
      `SELECT u.id, u.email,
              EXISTS(
                SELECT 1
                FROM admin_user_roles aur
                WHERE aur.user_id = u.id AND aur.role = 'SUPER_ADMIN'
              ) AS "isSuperAdmin"
       FROM users u
       WHERE u.id = $1
       LIMIT 1
       FOR UPDATE`,
      [userId],
      client,
    );
    const user = userResult.rows[0];
    if (!user) return null;

    // The old `users.role` flag predates capability-based administration and
    // must not make an otherwise deletable customer account undeletable. Only
    // protect the final active SUPER_ADMIN account from being removed.
    if (user.isSuperAdmin) {
      const remainingSuperAdmins = await query<{ count: string }>(
        `SELECT COUNT(*)::bigint AS count
         FROM admin_user_roles aur
         JOIN users u ON u.id = aur.user_id
         WHERE aur.role = 'SUPER_ADMIN'
           AND aur.user_id <> $1
           AND u.deleted_at IS NULL`,
        [userId],
        client,
      );
      if (Number(remainingSuperAdmins.rows[0]?.count ?? 0) === 0) {
        throw new Error('LAST_SUPER_ADMIN_DELETE_FORBIDDEN');
      }
    }

    const ownedWorkspaces = await query<{
      id: string;
      companyName: string;
    }>(
      `SELECT DISTINCT w.id, w.name AS "companyName", w.created_at AS "createdAt"
       FROM workspaces w
       LEFT JOIN workspace_members wm
         ON wm.workspace_id = w.id
        AND wm.user_id = $1
        AND wm.role = 'owner'
       WHERE w.created_by = $1 OR wm.user_id IS NOT NULL
       ORDER BY w.created_at DESC`,
      [userId],
      client,
    );
    const workspaceIds = ownedWorkspaces.rows.map((workspace) => workspace.id);

    let deletedWorkspaceCount = 0;
    let deletedIntegrationCount = 0;
    let deletedMembershipCount = 0;

    // These tables intentionally use ON DELETE RESTRICT because normal users
    // must not disappear while their shared-workspace content still exists.
    // An explicit account erasure removes that content before the user row is
    // deleted, so no personal content or credentials remain behind.
    const deletedRelationships = await query(`DELETE FROM record_relationships WHERE created_by = $1`, [userId], client);
    const deletedComments = await query(`DELETE FROM record_comments WHERE author_id = $1`, [userId], client);
    const deletedAttachments = await query(`DELETE FROM record_attachments WHERE uploaded_by = $1`, [userId], client);
    const deletedInvitations = await query(`DELETE FROM workspace_invitations WHERE invited_by = $1`, [userId], client);
    const deletedDocuments = await query(`DELETE FROM onboarding_documents WHERE uploaded_by = $1`, [userId], client);
    const deletedWebhooks = await query(`DELETE FROM webhook_endpoints WHERE created_by = $1`, [userId], client);
    const deletedRecords = await query(`DELETE FROM workspace_records WHERE created_by = $1`, [userId], client);

    let deletedSharedWorkspaceDataCount = [
      deletedRelationships.rowCount,
      deletedComments.rowCount,
      deletedAttachments.rowCount,
      deletedInvitations.rowCount,
      deletedDocuments.rowCount,
      deletedWebhooks.rowCount,
      deletedRecords.rowCount,
    ].reduce((total, count) => total + count, 0);

    if (workspaceIds.length) {
      const integrationCountResult = await query<{ count: string }>(
        `SELECT COUNT(*)::bigint AS count
         FROM workspace_platforms
         WHERE workspace_id = ANY($1::uuid[])`,
        [workspaceIds],
        client,
      );
      deletedIntegrationCount = Number(integrationCountResult.rows[0]?.count ?? 0);

      const membershipCountResult = await query<{ count: string }>(
        `SELECT COUNT(*)::bigint AS count
         FROM workspace_members
         WHERE workspace_id = ANY($1::uuid[])`,
        [workspaceIds],
        client,
      );
      deletedMembershipCount += Number(membershipCountResult.rows[0]?.count ?? 0);

      const deletedLegacyWorkspaceReferenceCount = await deleteLegacyRestrictingWorkspaceReferences(workspaceIds, client);

      const deletedWorkspacesResult = await query<{ id: string }>(
        `DELETE FROM workspaces
         WHERE id = ANY($1::uuid[])`,
        [workspaceIds],
        client,
      );
      deletedWorkspaceCount = deletedWorkspacesResult.rowCount;
      deletedSharedWorkspaceDataCount += deletedLegacyWorkspaceReferenceCount;
    }

    const remainingMembershipCount = await query<{ count: string }>(
      `SELECT COUNT(*)::bigint AS count
       FROM workspace_members
       WHERE user_id = $1`,
      [userId],
      client,
    );
    deletedMembershipCount += Number(remainingMembershipCount.rows[0]?.count ?? 0);

    await query(`DELETE FROM workspace_members WHERE user_id = $1`, [userId], client);

    // This pass is intentionally after the documented, ordered deletes. It
    // makes permanent deletion safe for production databases that retain an
    // older RESTRICT/NO ACTION user reference which is not present in the
    // current migrations. The transaction still rolls back in full on error.
    const deletedLegacyReferenceCount = await deleteLegacyRestrictingUserReferences(userId, client);

    // All session, refresh-token, OTP, notification, AI, usage and admin-role
    // records are protected by database-level ON DELETE CASCADE constraints.
    // A physical DELETE is required here: anonymising the users row left a
    // recoverable account behind and was the source of the broken admin action.
    const deletedUser = await query<{ id: string }>(
      `DELETE FROM users WHERE id = $1 RETURNING id`,
      [userId],
      client,
    );
    if (!deletedUser.rows[0]) throw new Error('USER_DELETE_FAILED');

    return {
      userId: user.id,
      previousEmail: user.email,
      deletedWorkspaceCount,
      deletedIntegrationCount,
      deletedMembershipCount,
      deletedSharedWorkspaceDataCount: deletedSharedWorkspaceDataCount + deletedLegacyReferenceCount,
      deletedWorkspaceNames: ownedWorkspaces.rows.map((workspace) => workspace.companyName),
    };
  });
}

export async function listWorkspaces(limit = 100, offset = 0, search?: string) {
  const values: unknown[] = [limit, offset];
  let where = 'w.deleted_at IS NULL';
  if (search) {
    values.push(`%${search}%`);
    where += ` AND (w.name ILIKE $${values.length} OR w.slug ILIKE $${values.length} OR w.industry ILIKE $${values.length})`;
  }
  const { rows } = await query(`
    SELECT
      w.id, w.name AS "companyName", w.slug, w.industry, w.company_size AS "companySize",
      w.country_region AS "countryRegion", w.onboarding_step AS "onboardingStep",
      w.onboarding_completed_at AS "onboardingCompletedAt",
      w.onboarding_files_purged_at AS "filesPurgedAt",
      w.created_at AS "createdAt", w.updated_at AS "updatedAt",
      COALESCE(ws.plan_key, 'starter') AS "planKey",
      COALESCE(ws.status, 'inactive') AS "subscriptionStatus",
      (SELECT COUNT(*) FROM workspace_members wm WHERE wm.workspace_id = w.id)::int AS "memberCount",
      (SELECT u.email FROM workspace_members wm2 JOIN users u ON u.id = wm2.user_id WHERE wm2.workspace_id = w.id AND wm2.role = 'owner' LIMIT 1) AS "ownerEmail"
    FROM workspaces w
    LEFT JOIN workspace_subscriptions ws ON ws.workspace_id = w.id
    WHERE ${where}
    ORDER BY w.created_at DESC
    LIMIT $1 OFFSET $2
  `, values);
  return rows;
}

export async function getWorkspaceDetail(workspaceId: string) {
  const wsResult = await query(`
    SELECT
      w.id, w.name AS "companyName", w.slug, w.industry, w.company_size AS "companySize",
      w.country_region AS "countryRegion", w.business_description AS "businessDescription",
      w.value_proposition AS "valueProposition", w.target_market AS "targetMarket",
      w.short_brand_description AS "shortBrandDescription", w.positioning_tags AS "positioningTags",
      w.legal_form AS "legalForm", w.founding_year AS "foundingYear",
      w.employee_count AS "employeeCount", w.annual_revenue_range AS "annualRevenueRange",
      w.business_model_type AS "businessModelType", w.company_stage AS "companyStage",
      w.sales_model AS "salesModel", w.sales_cycle_days AS "salesCycleDays",
      w.primary_icp AS "primaryIcp", w.usp, w.mission, w.vision,
      w.primary_challenges AS "primaryChallenges", w.languages,
      w.regulated_industries AS "regulatedIndustries",
      w.onboarding_step AS "onboardingStep", w.onboarding_completed_at AS "onboardingCompletedAt",
      w.onboarding_file_reupload_required AS "fileReuploadRequired",
      w.onboarding_files_purged_at AS "filesPurgedAt",
      w.created_at AS "createdAt", w.updated_at AS "updatedAt",
      COALESCE(ws.plan_key, 'starter') AS "planKey",
      COALESCE(ws.status, 'inactive') AS "subscriptionStatus",
      ws.custom_price_minor AS "customPriceMinor",
      ws.custom_price_currency AS "customPriceCurrency",
      ws.custom_price_reason AS "customPriceReason",
      ws.custom_price_set_by AS "customPriceSetBy",
      ws.custom_price_set_at AS "customPriceSetAt",
      ws.trial_ends_at AS "trialEndsAt",
      ws.current_period_starts_at AS "periodStartsAt",
      ws.current_period_ends_at AS "periodEndsAt",
      ws.seats
    FROM workspaces w
    LEFT JOIN workspace_subscriptions ws ON ws.workspace_id = w.id
    WHERE w.id = $1 AND w.deleted_at IS NULL
    LIMIT 1
  `, [workspaceId]);
  if (!wsResult.rows[0]) return null;

  const [members, records, websites, usage, credits, paygUsage, usageAdjustments] = await Promise.all([
    query(`
      SELECT u.id, u.email, u.first_name AS "firstName", u.last_name AS "lastName",
             wm.role, wm.joined_at AS "joinedAt"
      FROM workspace_members wm
      JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = $1
      ORDER BY wm.role = 'owner' DESC, u.email ASC
    `, [workspaceId]),
    query(`
      SELECT resource_type AS "resourceType", COUNT(*)::int AS "count"
      FROM workspace_records
      WHERE workspace_id = $1 AND deleted_at IS NULL
      GROUP BY resource_type
    `, [workspaceId]),
    query(`
      SELECT id, title, platform, status, domain, published_at AS "publishedAt", created_at AS "createdAt"
      FROM websites
      WHERE workspace_id = $1 AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 50
    `, [workspaceId]).catch(() => ({ rows: [] as any[], rowCount: 0 })),
    query(`
      SELECT metric_key AS "metricKey", SUM(quantity)::numeric AS "total",
             MIN(period_start) AS "periodStart", MAX(period_end) AS "periodEnd"
      FROM workspace_usage_counters
      WHERE workspace_id = $1
      GROUP BY metric_key
    `, [workspaceId]),
    query(`
      SELECT balance FROM workspace_credit_balances WHERE workspace_id = $1
    `, [workspaceId]),
    getWorkspacePaygUsage(workspaceId),
    listWorkspaceUsageAdjustments(workspaceId),
  ]);

  return {
    ...wsResult.rows[0],
    members: members.rows,
    crmByType: records.rows,
    websites: websites.rows,
    usage: usage.rows,
    creditBalance: Number(credits.rows[0]?.balance ?? 0),
    paygUsage,
    usageAdjustments,
  };
}

export async function setWorkspaceSubscriptionPrice(
  workspaceId: string,
  customPriceMinor: number | null,
  reason: string,
  adminUserId: string,
) {
  return withTransaction(async (client) => {
    const current = await query<{
      customPriceMinor: string | null;
      customPriceCurrency: string;
      customPriceReason: string | null;
      customPriceSetBy: string | null;
      customPriceSetAt: string | null;
    }>(
      `SELECT custom_price_minor AS "customPriceMinor",
              custom_price_currency AS "customPriceCurrency",
              custom_price_reason AS "customPriceReason",
              custom_price_set_by AS "customPriceSetBy",
              custom_price_set_at AS "customPriceSetAt"
       FROM workspace_subscriptions
       WHERE workspace_id = $1
       FOR UPDATE`,
      [workspaceId],
      client,
    );
    if (!current.rows[0]) throw new AppError(404, 'WORKSPACE_SUBSCRIPTION_NOT_FOUND', 'Workspace subscription not found');

    const updated = await query<{
      workspaceId: string;
      customPriceMinor: string | null;
      customPriceCurrency: string;
      customPriceReason: string | null;
      customPriceSetBy: string | null;
      customPriceSetAt: string | null;
    }>(
      `UPDATE workspace_subscriptions
       SET custom_price_minor = $2,
           custom_price_currency = 'CNY',
           custom_price_reason = $3,
           custom_price_set_by = $4,
           custom_price_set_at = NOW(),
           custom_price_provider_price_id = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1
       RETURNING workspace_id AS "workspaceId",
                 custom_price_minor AS "customPriceMinor",
                 custom_price_currency AS "customPriceCurrency",
                 custom_price_reason AS "customPriceReason",
                 custom_price_set_by AS "customPriceSetBy",
                 custom_price_set_at AS "customPriceSetAt"`,
      [workspaceId, customPriceMinor, reason, adminUserId],
      client,
    );
    const result = updated.rows[0];
    if (!result) throw new AppError(500, 'SUBSCRIPTION_PRICE_NOT_UPDATED', 'Subscription price could not be updated');

    await query(
      `INSERT INTO audit_log (
         workspace_id, actor_id, action, entity_type, entity_id, before_data, after_data
       ) VALUES ($1, $2, 'subscription.price_override_changed', 'workspace_subscription', $1, $3::jsonb, $4::jsonb)`,
      [
        workspaceId,
        adminUserId,
        JSON.stringify({
          customPriceMinor: current.rows[0].customPriceMinor,
          customPriceCurrency: current.rows[0].customPriceCurrency,
          customPriceReason: current.rows[0].customPriceReason,
          customPriceSetBy: current.rows[0].customPriceSetBy,
          customPriceSetAt: current.rows[0].customPriceSetAt,
        }),
        JSON.stringify({
          customPriceMinor,
          customPriceCurrency: 'CNY',
          customPriceReason: reason,
          customPriceSetBy: adminUserId,
        }),
      ],
      client,
    );

    return {
      ...result,
      customPriceMinor: result.customPriceMinor === null ? null : Number(result.customPriceMinor),
    };
  });
}

export async function heartbeatUserDeletionJob(jobId: string, workerId: string) {
  await query(
    `UPDATE background_jobs
        SET heartbeat_at=NOW()
      WHERE id=$1 AND job_type=$2 AND status='running' AND worker_id=$3`,
    [jobId, ADMIN_USER_DELETION_JOB_TYPE, workerId],
  );
}

export async function updateWorkspaceStatus(workspaceId: string, action: 'lock' | 'unlock' | 'reset-onboarding' | 'skip-onboarding' | 'set-plan', planKey?: string) {
  switch (action) {
    case 'lock':
      await query(`UPDATE workspaces SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`, [workspaceId]);
      break;
    case 'unlock':
      await query(`UPDATE workspaces SET deleted_at = NULL WHERE id = $1`, [workspaceId]);
      break;
    case 'reset-onboarding':
      await query(`UPDATE workspaces SET onboarding_step = 'company_information', onboarding_completed_at = NULL, updated_at = NOW() WHERE id = $1`, [workspaceId]);
      break;
    case 'skip-onboarding':
      await query(
        `UPDATE workspaces
         SET onboarding_step = 'setup_complete',
             onboarding_completed_at = COALESCE(onboarding_completed_at, NOW()),
             onboarding_file_reupload_required = FALSE,
             updated_at = NOW()
         WHERE id = $1 AND deleted_at IS NULL`,
        [workspaceId],
      );
      break;
    case 'set-plan':
      if (planKey) {
        await query(`
          INSERT INTO workspace_subscriptions (workspace_id, plan_key, status, updated_at)
          VALUES ($1, $2, 'active', NOW())
          ON CONFLICT (workspace_id) DO UPDATE SET plan_key = $2, updated_at = NOW()
        `, [workspaceId, planKey]);
      }
      break;
  }
  return getWorkspaceDetail(workspaceId);
}

export async function listCrmRecords(limit = 100, offset = 0, search?: string, resourceType?: string) {
  const values: unknown[] = [limit, offset];
  const where: string[] = ['wr.deleted_at IS NULL'];
  if (search) {
    values.push(`%${search}%`);
    where.push(`(wr.name ILIKE $${values.length} OR wr.description ILIKE $${values.length})`);
  }
  if (resourceType) {
    values.push(resourceType);
    where.push(`wr.resource_type = $${values.length}`);
  }
  const { rows } = await query(`
    SELECT
      wr.id, wr.workspace_id AS "workspaceId", w.name AS "workspaceName",
      wr.resource_type AS "resourceType", wr.parent_id AS "parentId",
      wr.name, wr.description, wr.status, wr.stage,
      wr.value_amount AS "valueAmount", wr.currency,
      wr.starts_at AS "startsAt", wr.ends_at AS "endsAt", wr.due_at AS "dueAt",
      wr.assignee_id AS "assigneeId", u.email AS "assigneeEmail",
      wr.source, wr.tags, wr.version, wr.created_at AS "createdAt", wr.updated_at AS "updatedAt"
    FROM workspace_records wr
    JOIN workspaces w ON w.id = wr.workspace_id
    LEFT JOIN users u ON u.id = wr.assignee_id
    WHERE ${where.join(' AND ')}
    ORDER BY wr.updated_at DESC
    LIMIT $1 OFFSET $2
  `, values);
  return rows;
}

export async function listWebsites(limit = 100, offset = 0, search?: string) {
  const values: unknown[] = [limit, offset];
  let where = 'w.deleted_at IS NULL';
  if (search) {
    values.push(`%${search}%`);
    where += ` AND (ws.name ILIKE $${values.length} OR ws.external_site_url ILIKE $${values.length})`;
  }
  const { rows } = await query(`
    SELECT
      ws.id, ws.workspace_id AS "workspaceId", w.name AS "workspaceName",
      ws.name AS title, ws.provider AS platform, ws.status, ws.external_site_url AS domain,
      NULL AS "templateId", NULL AS version,
      NULL AS "lastSyncedAt", NULL AS "publishedAt",
      (SELECT MAX(j.updated_at) FROM website_generation_jobs j WHERE j.site_id=ws.id AND j.status IN ('generated','preview','published')) AS "lastGeneratedAt",
      ws.created_at AS "createdAt", ws.updated_at AS "updatedAt"
    FROM (
      SELECT id,workspace_id,name,provider,status,external_site_url,created_at,updated_at FROM workspace_sites
      UNION ALL
      SELECT a.id,c.workspace_id,COALESCE(a.name,a.external_account_id),a.provider_key,a.status,
        NULL::text,a.created_at,a.updated_at
      FROM provider_accounts a JOIN provider_connections c ON c.id=a.provider_connection_id
      WHERE a.provider_key='shopify' AND c.workspace_id IS NOT NULL
    ) ws
    JOIN workspaces w ON w.id = ws.workspace_id
    WHERE ${where}
    ORDER BY ws.updated_at DESC
    LIMIT $1 OFFSET $2
  `, values);
  return rows;
}

export async function listAgents(limit = 100, offset = 0) {
  const { rows } = await query(`
    SELECT
      a.id, a.workspace_id AS "workspaceId", w.name AS "workspaceName",
      a.name, a.agent_type AS "agentType", a.mode, a.status, a.version,
      a.model_provider AS "modelProvider", a.model_name AS "modelName",
      a.created_at AS "createdAt", a.updated_at AS "updatedAt",
      (SELECT COUNT(*) FROM agent_run_steps ar WHERE ar.run_id = a.id)::int AS "stepCount",
      a.run_count AS "runCount"
    FROM (
      SELECT id,workspace_id,goal AS name,'workflow' AS agent_type,'orchestrated' AS mode,status,NULL::int AS version,
        NULL::text AS model_provider,NULL::text AS model_name,created_at,updated_at,1 AS run_count FROM agent_runs
      UNION ALL
      SELECT id,workspace_id,name,'configured',data->>'mode',status,version,
        data->>'modelProvider',data->>'modelName',created_at,updated_at,NULL::int
      FROM workspace_records WHERE resource_type='ai_agents' AND deleted_at IS NULL
    ) a
    LEFT JOIN workspaces w ON w.id = a.workspace_id
    WHERE w.deleted_at IS NULL
    ORDER BY a.updated_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return rows;
}

export async function listIntegrations(limit = 100, offset = 0) {
  const { rows } = await query(`
    SELECT
      i.id, i.workspace_id AS "workspaceId", w.name AS "workspaceName",
      i.provider_key AS provider, i.status, i.granted_scopes AS scopes,
      i.created_at AS "connectedAt",
      NULL AS "expiresAt",
      i.last_success_at AS "lastSyncedAt",
      i.last_error AS "lastError",
      NULL::int AS "syncCount", i.mode, i.health_status AS health
    FROM provider_connections i
    LEFT JOIN workspaces w ON w.id = i.workspace_id
    ORDER BY i.updated_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return rows;
}

/**
 * Return every persisted external OAuth connection without exposing secrets.
 * OAuth is stored in the central Lulu-managed table plus workspace-scoped
 * platform, email and calendar tables. This view deliberately normalizes
 * operational metadata for the admin console without exposing secrets.
 */
export async function listOAuthConnections(limit = 100, offset = 0, search?: string) {
  const searchPattern = search?.trim() ? `%${search.trim()}%` : null;
  const { rows } = await query(`
    WITH oauth_connections AS (
      SELECT
        a.id,
        'admin'::text AS "connectionType",
        a.provider,
        a.display_name AS "displayName",
        NULL::uuid AS "workspaceId",
        NULL::text AS "workspaceName",
        'lulu_managed'::text AS management,
        a.status AS "sourceStatus",
        a.status AS status,
        TRUE AS "hasCredentials",
        a.external_account_id AS "accountIdentifier",
        a.granted_scopes AS scopes,
        a.token_expires_at AS "tokenExpiresAt",
        a.last_synced_at AS "lastSyncedAt",
        a.last_error AS "lastError",
        a.created_at AS "connectedAt",
        a.updated_at AS "updatedAt"
      FROM lulu_managed_oauth_connections a

      UNION ALL

      SELECT
        p.id,
        'platform'::text AS "connectionType",
        COALESCE(c.provider, p.integration_key) AS provider,
        p.name AS "displayName",
        p.workspace_id AS "workspaceId",
        w.name AS "workspaceName",
        CASE WHEN p.integration_key IN ('google-ads', 'google-analytics', 'meta', 'linkedin', 'tiktok-ads') THEN 'lulu_managed' ELSE 'workspace' END::text AS management,
        p.connection_status AS "sourceStatus",
        CASE WHEN c.platform_id IS NULL THEN 'missing_credentials' ELSE p.connection_status END AS status,
        (c.platform_id IS NOT NULL) AS "hasCredentials",
        p.external_account_id AS "accountIdentifier",
        p.granted_scopes AS scopes,
        c.token_expires_at AS "tokenExpiresAt",
        p.last_synced_at AS "lastSyncedAt",
        p.last_error AS "lastError",
        p.created_at AS "connectedAt",
        p.updated_at AS "updatedAt"
      FROM workspace_platforms p
      LEFT JOIN workspace_platform_oauth_credentials c ON c.platform_id = p.id
      JOIN workspaces w ON w.id = p.workspace_id
      WHERE p.deleted_at IS NULL
        AND w.deleted_at IS NULL
        AND (
          c.platform_id IS NOT NULL
          OR p.integration_key IN (
            'salesforce', 'pipedrive', 'hubspot', 'google-ads',
            'google-analytics', 'google-business', 'meta', 'linkedin',
            'webflow', 'wordpress', 'shopify'
          )
        )

      UNION ALL

      SELECT
        a.id,
        'email'::text AS "connectionType",
        a.provider,
        COALESCE(NULLIF(a.display_name, ''), a.email_address) AS "displayName",
        a.workspace_id AS "workspaceId",
        w.name AS "workspaceName",
        'workspace'::text AS management,
        a.status AS "sourceStatus",
        CASE
          WHEN a.encrypted_access_token IS NULL AND a.encrypted_refresh_token IS NULL THEN 'missing_credentials'
          ELSE a.status
        END AS status,
        (a.encrypted_access_token IS NOT NULL OR a.encrypted_refresh_token IS NOT NULL) AS "hasCredentials",
        a.email_address AS "accountIdentifier",
        NULL::text[] AS scopes,
        a.token_expires_at AS "tokenExpiresAt",
        a.last_sync_at AS "lastSyncedAt",
        NULLIF(CONCAT_WS(': ', NULLIF(a.last_error_code, ''), NULLIF(a.last_error_message, '')), '') AS "lastError",
        a.created_at AS "connectedAt",
        a.updated_at AS "updatedAt"
      FROM email_accounts a
      JOIN workspaces w ON w.id = a.workspace_id
      WHERE w.deleted_at IS NULL
        AND a.provider IN ('google', 'microsoft')

      UNION ALL

      SELECT
        a.id,
        'calendar'::text AS "connectionType",
        a.provider,
        COALESCE(NULLIF(a.display_name, ''), a.email_address, a.external_account_id, a.provider) AS "displayName",
        a.workspace_id AS "workspaceId",
        w.name AS "workspaceName",
        'workspace'::text AS management,
        a.status AS "sourceStatus",
        CASE
          WHEN a.encrypted_access_token IS NULL AND a.encrypted_refresh_token IS NULL THEN 'missing_credentials'
          ELSE a.status
        END AS status,
        (a.encrypted_access_token IS NOT NULL OR a.encrypted_refresh_token IS NOT NULL) AS "hasCredentials",
        COALESCE(a.email_address, a.external_account_id) AS "accountIdentifier",
        NULL::text[] AS scopes,
        a.token_expires_at AS "tokenExpiresAt",
        a.last_sync_at AS "lastSyncedAt",
        NULLIF(CONCAT_WS(': ', NULLIF(a.last_error_code, ''), NULLIF(a.last_error_message, '')), '') AS "lastError",
        a.created_at AS "connectedAt",
        a.updated_at AS "updatedAt"
      FROM calendar_accounts a
      JOIN workspaces w ON w.id = a.workspace_id
      WHERE w.deleted_at IS NULL
        AND a.provider IN ('google', 'microsoft')
    )
    SELECT
      id, "connectionType", provider, "displayName", "workspaceId", "workspaceName", management,
      "sourceStatus", status, "hasCredentials", "accountIdentifier", scopes,
      "tokenExpiresAt", "lastSyncedAt", "lastError", "connectedAt", "updatedAt"
    FROM oauth_connections
    WHERE ($3::text IS NULL OR
      provider ILIKE $3 OR
      "displayName" ILIKE $3 OR
      "workspaceName" ILIKE $3 OR
      COALESCE("accountIdentifier", '') ILIKE $3)
    ORDER BY "updatedAt" DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset, searchPattern]);
  return rows;
}

export async function listApprovals(limit = 100, offset = 0) {
  const { rows } = await query(`
    SELECT
      a.id, a.workspace_id AS "workspaceId", w.name AS "workspaceName",
      a.action_type AS "approvalType", a.status, a.description AS reason, a.title,
      u.email AS "requesterEmail",
      a.created_at AS "createdAt", a.decided_at AS "resolvedAt"
    FROM approval_requests a
    LEFT JOIN workspaces w ON w.id = a.workspace_id
    LEFT JOIN users u ON u.id = a.requested_by
    ORDER BY a.created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return rows;
}

export async function listErrorEvents(limit = 100, offset = 0) {
  const { rows } = await query(`
    SELECT id, workspace_id AS "workspaceId", NULL AS "userId",
      'error' AS level, message, source, 'open' AS status,
      NULL AS "requestId", NULL AS "correlationId",
      created_at AS "createdAt", NULL AS "resolvedAt", 1 AS "occurrenceCount"
    FROM (
      SELECT id, workspace_id, COALESCE(error_code,'AGENT_RUN_FAILED') AS message, 'agent_run' AS source, updated_at AS created_at
      FROM agent_runs WHERE status='failed'
      UNION ALL
      SELECT id, workspace_id, 'BACKGROUND_JOB_FAILED', job_type, updated_at FROM background_jobs WHERE status='failed'
      UNION ALL
      SELECT id, workspace_id, 'PROVIDER_CONNECTION_ERROR', provider_key, updated_at FROM provider_connections WHERE status='ERROR' OR health_status='ERROR'
      UNION ALL
      SELECT j.id, s.workspace_id, COALESCE(j.error_code,'WEBSITE_GENERATION_FAILED'), 'website_generation', j.updated_at
      FROM website_generation_jobs j JOIN workspace_sites s ON s.id=j.site_id WHERE j.status='failed'
      UNION ALL
      SELECT id, workspace_id, 'DOMAIN_EVENT_DEAD_LETTER', event_type, occurred_at FROM domain_events WHERE status='dead_letter'
      UNION ALL
      SELECT id,workspace_id,metadata->>'action','api',created_at FROM security_events WHERE event_type='API_ERROR'
      UNION ALL
      SELECT id,workspace_id,COALESCE(error_code,'EMAIL_SYNC_FAILED'),'email_sync',updated_at FROM email_sync_jobs WHERE status='failed'
      UNION ALL
      SELECT id,workspace_id,COALESCE(error_code,'CALENDAR_SYNC_FAILED'),'calendar_sync',updated_at FROM calendar_sync_jobs WHERE status='failed'
    ) errors
    ORDER BY created_at DESC, id
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return rows;
}

export async function listAuditLogs(limit = 100, offset = 0) {
  const { rows } = await query(`
    SELECT id, actor_id AS "actorId", actor_type AS "actorType",action,entity_type AS "resourceType",entity_id AS "resourceId",
      workspace_id AS "workspaceId", result,NULL AS reason,ip_address AS "ipAddress",user_agent AS "userAgent",created_at AS "createdAt"
    FROM (
      SELECT 'audit:'||id::text AS id,actor_id,CASE WHEN actor_id IS NULL THEN 'system' ELSE 'user' END AS actor_type,
        action,entity_type,entity_id,workspace_id,NULL::text AS result,ip_address,user_agent,created_at FROM audit_log
      UNION ALL
      SELECT 'security:'||id::text,user_id,'security',event_type,'security_event',NULL,workspace_id,
        metadata->>'outcome',NULL,NULL,created_at FROM security_events
    ) history
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return rows;
}

export async function listConversations(limit = 100, offset = 0) {
  const { rows } = await query(`
    SELECT
      c.id, c.workspace_id AS "workspaceId", w.name AS "workspaceName",
      ch.channel_type AS channel, c.subject, c.status, c.priority,
      NULL AS "externalId",
      c.last_message_at AS "lastMessageAt",
      (SELECT COUNT(*)::int FROM omni_messages m WHERE m.workspace_id=c.workspace_id AND m.conversation_id=c.id) AS "messageCount",
      c.created_at AS "createdAt", c.updated_at AS "updatedAt"
    FROM omni_conversations c
    JOIN omni_channels ch ON ch.id=c.channel_id
    LEFT JOIN workspaces w ON w.id = c.workspace_id
    WHERE w.deleted_at IS NULL
    ORDER BY c.last_message_at DESC NULLS LAST
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return rows;
}

export async function listFiles(limit = 100, offset = 0) {
  const { rows } = await query(`
    SELECT
      f.id, f.workspace_id AS "workspaceId", w.name AS "workspaceName",
      f.uploaded_by AS "uploadedById", u.email AS "uploadedByEmail",
      f.file_name AS "fileName", f.mime_type AS "mimeType",
      f.size_bytes::bigint AS "fileSizeBytes",
      f.source,
      f.created_at AS "uploadedAt", NULL AS "lastAccessedAt",
      NULL AS "purgeScheduledAt", NULL AS "purgedAt"
    FROM (
      SELECT id, workspace_id, uploaded_by, file_name, mime_type, size_bytes, created_at, 'onboarding' AS source FROM onboarding_documents
      UNION ALL
      SELECT id, workspace_id, uploaded_by, file_name, mime_type, size_bytes, created_at, 'record' FROM record_attachments
      UNION ALL
      SELECT id, workspace_id, NULL::uuid, file_name, mime_type, size_bytes, created_at, 'omnichannel' FROM omni_message_attachments
      UNION ALL
      SELECT id, workspace_id, NULL::uuid, COALESCE(title,'Product media'),NULL::text,NULL::bigint,created_at,'product_media'
      FROM product_media WHERE external_url IS NULL
    ) f
    LEFT JOIN workspaces w ON w.id = f.workspace_id
    LEFT JOIN users u ON u.id = f.uploaded_by
    ORDER BY f.created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return rows;
}

export async function getUploadedFile(source: string, id: string) {
  // Only persisted customer uploads; never accept a filesystem path or storage
  // key supplied by the caller. Provider-only media is not a local upload.
  const sources: Record<string,string> = {
    onboarding: 'SELECT workspace_id,file_name,storage_key,content,size_bytes FROM onboarding_documents WHERE id=$1',
    record: 'SELECT workspace_id,file_name,storage_key,NULL::bytea AS content,size_bytes FROM record_attachments WHERE id=$1',
    omnichannel: "SELECT workspace_id,file_name,storage_reference AS storage_key,NULL::bytea AS content,size_bytes FROM omni_message_attachments WHERE id=$1 AND status='READY' AND provider_media_id IS NULL",
  };
  const sql=sources[source];
  if(!sql) throw new AppError(404,'FILE_NOT_FOUND','Customer upload not found');
  const file=(await query(sql,[id])).rows[0];
  if(!file) throw new AppError(404,'FILE_NOT_FOUND','Customer upload not found');
  if(Number(file.size_bytes)>26214400) throw new AppError(413,'FILE_TOO_LARGE','This download exceeds the supported size');
  return file;
}

export async function listJobs(limit = 100, offset = 0) {
  const { rows } = await query(`
    SELECT
      id, job_type AS "jobType", status,
      workspace_id AS "workspaceId",
      attempts::int AS "attempt", max_attempts::int AS "maxAttempts",
      scheduled_at AS "scheduledAt", started_at AS "startedAt",
      completed_at AS "completedAt", CASE WHEN status='failed' THEN updated_at END AS "failedAt",
      error_message AS "errorMessage",
      NULL AS "correlationId",
      created_at AS "createdAt"
    FROM (
      SELECT id,job_type,status,workspace_id,attempts,max_attempts,scheduled_at,started_at,completed_at,
        CASE WHEN error_message IS NOT NULL THEN 'JOB_EXECUTION_FAILED' END AS error_message,created_at,updated_at
      FROM background_jobs
      UNION ALL
      SELECT id,'event:'||event_type,status,workspace_id,attempts,max_attempts,available_at,locked_at,processed_at,
        CASE WHEN last_error IS NOT NULL THEN 'EVENT_EXECUTION_FAILED' END,occurred_at,COALESCE(dead_lettered_at,processed_at,occurred_at)
      FROM domain_events
      UNION ALL
      SELECT j.id,'website_generation',j.status,s.workspace_id,NULL::int,NULL::int,j.created_at,NULL::timestamptz,NULL::timestamptz,
        j.error_code,j.created_at,j.updated_at FROM website_generation_jobs j JOIN workspace_sites s ON s.id=j.site_id
      UNION ALL
      SELECT id,'email_sync',status,workspace_id,NULL::int,NULL::int,created_at,started_at,finished_at,error_code,created_at,updated_at FROM email_sync_jobs
      UNION ALL
      SELECT id,'calendar_sync',status,workspace_id,NULL::int,NULL::int,created_at,started_at,finished_at,error_code,created_at,updated_at FROM calendar_sync_jobs
      UNION ALL
      SELECT id,'content_refresh',status,workspace_id,attempt_count,NULL::int,created_at,started_at,completed_at,
        CASE WHEN error_message IS NOT NULL THEN 'CONTENT_REFRESH_FAILED' END,created_at,updated_at FROM workspace_content_refresh_jobs
    ) jobs
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
  return rows;
}

export async function globalAdminSearch(queryStr: string, _limit = 50) {
  const search = `%${queryStr}%`;
  const [users, workspaces, records, websites] = await Promise.all([
    query(`
      SELECT 'user' AS "type", id, email AS "title",
             COALESCE(first_name || ' ' || last_name, email) AS "subtitle",
             created_at AS "timestamp"
      FROM users
      WHERE deleted_at IS NULL AND (email ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1)
      LIMIT 15
    `, [search]),
    query(`
      SELECT 'workspace' AS "type", id, name AS "title",
             COALESCE(industry, country_region, '') AS "subtitle",
             created_at AS "timestamp"
      FROM workspaces
      WHERE deleted_at IS NULL AND (name ILIKE $1 OR slug ILIKE $1 OR industry ILIKE $1)
      LIMIT 15
    `, [search]),
    query(`
      SELECT 'crm' AS "type", id, name AS "title",
             resource_type || ' · ' || COALESCE(status, '') AS "subtitle",
             updated_at AS "timestamp"
      FROM workspace_records
      WHERE deleted_at IS NULL AND (name ILIKE $1 OR description ILIKE $1)
      LIMIT 10
    `, [search]),
    query(`
      SELECT 'website' AS "type", id, title AS "title",
             platform || ' · ' || COALESCE(status, '') || COALESCE(' · ' || domain, '') AS "subtitle",
             updated_at AS "timestamp"
      FROM websites
      WHERE deleted_at IS NULL AND (title ILIKE $1 OR domain ILIKE $1)
      LIMIT 10
    `, [search]).catch(() => ({ rows: [] as any[], rowCount: 0 })),
  ]);
  return {
    users: users.rows,
    workspaces: workspaces.rows,
    crm: records.rows,
    websites: websites.rows,
  };
}

export async function listSettings() {
  const { rows } = await query(`
    SELECT key, value, updated_at AS "updatedAt", updated_by AS "updatedBy"
    FROM system_settings
    ORDER BY key
  `).catch(() => {
    return {
      rows: [
        { key: 'onboarding.purge_days', value: '5', updatedAt: new Date().toISOString(), updatedBy: 'system' },
        { key: 'default_plan', value: 'starter', updatedAt: new Date().toISOString(), updatedBy: 'system' },
        { key: 'trial_days', value: '14', updatedAt: new Date().toISOString(), updatedBy: 'system' },
        { key: 'max_upload_size_mb', value: '50', updatedAt: new Date().toISOString(), updatedBy: 'system' },
        { key: 'session_timeout_minutes', value: '60', updatedAt: new Date().toISOString(), updatedBy: 'system' },
        { key: 'maintenance_mode', value: 'false', updatedAt: new Date().toISOString(), updatedBy: 'system' },
      ],
    };
  });
  return rows;
}

export async function listSupportTickets(limit = 100, offset = 0) {
  const { rows } = await query(`
    SELECT
      t.id, t.workspace_id AS "workspaceId", w.name AS "workspaceName",
      t.subject, t.status, t.priority, t.category,
      u.email AS "requesterEmail",
      t.assignee_id AS "assigneeId",
      t.sla_due_at AS "slaDueAt",
      t.created_at AS "createdAt", t.updated_at AS "updatedAt",
      t.closed_at AS "closedAt"
    FROM support_tickets t
    LEFT JOIN workspaces w ON w.id = t.workspace_id
    LEFT JOIN users u ON u.id = t.requester_id
    ORDER BY t.created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]).catch(() => ({ rows: [] as any[], rowCount: 0 }));
  return rows;
}

