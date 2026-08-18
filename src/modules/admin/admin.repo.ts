import { query } from '../../db/pool.js';

export async function listCustomerBillingOverview(periodStart: string, periodEnd: string) {
  const { rows } = await query(`
    SELECT
      w.id,
      u.first_name AS "firstName",
      u.last_name AS "lastName",
      u.email,
      w.name AS "companyName",
      COALESCE(ws.plan_key, 'explorer') AS "planKey",
      COALESCE(ws.status, 'inactive') AS "subscriptionStatus",
      COALESCE(ws.current_period_starts_at, ws.created_at, w.created_at) AS "startDate",
      COALESCE(ws.current_period_ends_at, ws.trial_ends_at) AS "expiryDate",
      COALESCE(SUM(CASE WHEN uc.metric_key IN ('api_cost_minor', 'api_cost_cny_minor') THEN uc.quantity ELSE 0 END), 0)::numeric AS "apiCostMinor",
      COALESCE(SUM(CASE WHEN uc.metric_key IN ('storage_cost_minor', 'server_storage_cost_minor') THEN uc.quantity ELSE 0 END), 0)::numeric AS "storageCostMinor",
      COALESCE(SUM(CASE WHEN uc.metric_key IN ('storage_bytes', 'server_storage_bytes') THEN uc.quantity ELSE 0 END), 0)::numeric AS "storageBytes"
    FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.role = 'owner'
    JOIN users u ON u.id = wm.user_id AND u.deleted_at IS NULL
    LEFT JOIN workspace_subscriptions ws ON ws.workspace_id = w.id
    LEFT JOIN workspace_usage_counters uc
      ON uc.workspace_id = w.id
     AND uc.period_start >= $1::date
     AND uc.period_end <= $2::date
    WHERE w.deleted_at IS NULL
    GROUP BY w.id, u.first_name, u.last_name, u.email, w.name,
             ws.plan_key, ws.status, ws.current_period_starts_at,
             ws.current_period_ends_at, ws.trial_ends_at, ws.created_at, w.created_at
    ORDER BY w.created_at DESC
  `, [periodStart, periodEnd]);
  return rows;
}

export async function updatePlan(workspaceId: string, planKey: 'explorer' | 'starter' | 'ai') {
  const { rows } = await query(
    `UPDATE workspace_subscriptions
     SET plan_key = $2, updated_at = NOW()
     WHERE workspace_id = $1
     RETURNING workspace_id AS "workspaceId", plan_key AS "planKey", status`,
    [workspaceId, planKey],
  );
  return rows[0];
}
