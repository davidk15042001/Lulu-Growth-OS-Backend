import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { revokeSessionsInTransaction } from '../auth/auth.repo.js';

export async function listCustomerBillingOverview(periodStart: string, periodEnd: string) {
  const { rows } = await query(`
    SELECT
      w.id,
      u.first_name AS "firstName",
      u.last_name AS "lastName",
      u.email,
      w.name AS "companyName",
      COALESCE(ws.plan_key, 'starter') AS "planKey",
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
      COUNT(*) FILTER (WHERE platform = 'wordpress')::int AS "wordpress",
      COUNT(*) FILTER (WHERE platform = 'shopify')::int AS "shopify",
      COUNT(*) FILTER (WHERE platform = 'webflow')::int AS "webflow",
      COUNT(*) FILTER (WHERE platform = 'woocommerce')::int AS "woocommerce"
    FROM websites WHERE deleted_at IS NULL`).catch(() => ({ rows: [{ total: 0, published: 0, wordpress: 0, shopify: 0, webflow: 0, woocommerce: 0 }] })),
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

export async function claimNextUserDeletionJob() {
  const result = await query<Record<string, unknown>>(
    `WITH candidate AS (
       SELECT id
         FROM background_jobs
        WHERE job_type = $1
          AND (
            (status = 'queued' AND scheduled_at <= NOW())
            OR (status = 'running' AND started_at < NOW() - INTERVAL '15 minutes')
          )
        ORDER BY scheduled_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE background_jobs AS job
        SET status = 'running',
            attempts = attempts + 1,
            started_at = NOW(),
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
    [ADMIN_USER_DELETION_JOB_TYPE],
  );
  return result.rows[0] ? mapAdminUserDeletionJob(result.rows[0]) : null;
}

export async function markUserDeletionJobSucceeded(jobId: string, result: Record<string, unknown>) {
  await query(
    `UPDATE background_jobs
        SET status = 'succeeded', result = $2::jsonb, completed_at = NOW(), error_message = NULL
      WHERE id = $1 AND job_type = $3 AND status = 'running'`,
    [jobId, JSON.stringify(result), ADMIN_USER_DELETION_JOB_TYPE],
  );
}

export async function markUserDeletionJobFailed(jobId: string, errorMessage: string) {
  await query(
    `UPDATE background_jobs
        SET status = 'failed', error_message = $2, completed_at = NOW()
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

  const [members, records, websites, usage, credits] = await Promise.all([
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
  ]);

  return {
    ...wsResult.rows[0],
    members: members.rows,
    crmByType: records.rows,
    websites: websites.rows,
    usage: usage.rows,
    creditBalance: Number(credits.rows[0]?.balance ?? 0),
  };
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
  let where = 'ws.deleted_at IS NULL';
  if (search) {
    values.push(`%${search}%`);
    where += ` AND (ws.title ILIKE $${values.length} OR ws.domain ILIKE $${values.length})`;
  }
  const { rows } = await query(`
    SELECT
      ws.id, ws.workspace_id AS "workspaceId", w.name AS "workspaceName",
      ws.title, ws.platform, ws.status, ws.domain,
      ws.template_id AS "templateId", ws.version,
      ws.last_synced_at AS "lastSyncedAt", ws.published_at AS "publishedAt",
      ws.last_generated_at AS "lastGeneratedAt",
      ws.created_at AS "createdAt", ws.updated_at AS "updatedAt"
    FROM websites ws
    JOIN workspaces w ON w.id = ws.workspace_id
    WHERE ${where}
    ORDER BY ws.updated_at DESC
    LIMIT $1 OFFSET $2
  `, values).catch(() => ({ rows: [] as any[], rowCount: 0 }));
  return rows;
}

export async function listAgents(limit = 100, offset = 0) {
  const { rows } = await query(`
    SELECT
      a.id, a.workspace_id AS "workspaceId", w.name AS "workspaceName",
      a.name, a.agent_type AS "agentType", a.mode, a.status, a.version,
      a.model_provider AS "modelProvider", a.model_name AS "modelName",
      a.created_at AS "createdAt", a.updated_at AS "updatedAt",
      (SELECT COUNT(*) FROM agent_runs ar WHERE ar.agent_id = a.id)::int AS "runCount"
    FROM agents a
    LEFT JOIN workspaces w ON w.id = a.workspace_id
    WHERE a.deleted_at IS NULL
    ORDER BY a.updated_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]).catch(() => ({ rows: [] as any[], rowCount: 0 }));
  return rows;
}

export async function listIntegrations(limit = 100, offset = 0) {
  const { rows } = await query(`
    SELECT
      i.id, i.workspace_id AS "workspaceId", w.name AS "workspaceName",
      i.provider, i.status, i.scopes,
      i.created_at AS "connectedAt",
      i.expires_at AS "expiresAt",
      i.last_synced_at AS "lastSyncedAt",
      i.last_error AS "lastError",
      i.sync_count::int AS "syncCount"
    FROM integrations i
    LEFT JOIN workspaces w ON w.id = i.workspace_id
    WHERE i.deleted_at IS NULL
    ORDER BY i.updated_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]).catch(() => ({ rows: [] as any[], rowCount: 0 }));
  return rows;
}

/**
 * Return every persisted external OAuth connection without exposing secrets.
 * OAuth is currently stored in three domain-specific tables, so this view
 * deliberately normalizes their operational metadata for the admin console.
 */
export async function listOAuthConnections(limit = 100, offset = 0, search?: string) {
  const searchPattern = search?.trim() ? `%${search.trim()}%` : null;
  const { rows } = await query(`
    WITH oauth_connections AS (
      SELECT
        p.id,
        'platform'::text AS "connectionType",
        COALESCE(c.provider, p.integration_key) AS provider,
        p.name AS "displayName",
        p.workspace_id AS "workspaceId",
        w.name AS "workspaceName",
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
      id, "connectionType", provider, "displayName", "workspaceId", "workspaceName",
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
      a.approval_type AS "approvalType", a.status, a.reason,
      u.email AS "requesterEmail",
      a.created_at AS "createdAt", a.resolved_at AS "resolvedAt"
    FROM approvals a
    LEFT JOIN workspaces w ON w.id = a.workspace_id
    LEFT JOIN users u ON u.id = a.requester_id
    ORDER BY a.created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]).catch(() => ({ rows: [] as any[], rowCount: 0 }));
  return rows;
}

export async function listErrorEvents(limit = 100, offset = 0) {
  const { rows } = await query(`
    SELECT
      id, workspace_id AS "workspaceId", user_id AS "userId",
      level, message, source, status,
      request_id AS "requestId", correlation_id AS "correlationId",
      created_at AS "createdAt", resolved_at AS "resolvedAt",
      occurrence_count::int AS "occurrenceCount"
    FROM error_events
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]).catch(async () => {
    const fallback = await query(`
      SELECT
        n.id, n.workspace_id AS "workspaceId", n.user_id AS "userId",
        n.level, n.message, n.source_template AS "source", 'new' AS status,
        NULL AS "requestId", NULL AS "correlationId",
        n.created_at AS "createdAt", NULL AS "resolvedAt",
        1::int AS "occurrenceCount"
      FROM notification_events n
      ORDER BY n.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]).catch(() => ({ rows: [] as any[], rowCount: 0 }));
    return fallback;
  });
  return rows;
}

export async function listAuditLogs(limit = 100, offset = 0) {
  const { rows } = await query(`
    SELECT
      id, actor_id AS "actorId", actor_type AS "actorType",
      action, resource_type AS "resourceType", resource_id AS "resourceId",
      workspace_id AS "workspaceId",
      result, reason,
      ip_address AS "ipAddress", user_agent AS "userAgent",
      created_at AS "createdAt"
    FROM audit_logs
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]).catch(async () => {
    const fallback = await query(`
      SELECT
        n.id, n.user_id AS "actorId", 'user' AS "actorType",
        'notification' AS action, n.level AS "resourceType", NULL AS "resourceId",
        n.workspace_id AS "workspaceId",
        'sent' AS result, NULL AS reason,
        NULL AS "ipAddress", NULL AS "userAgent",
        n.created_at AS "createdAt"
      FROM notification_events n
      ORDER BY n.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]).catch(() => ({ rows: [] as any[], rowCount: 0 }));
    return fallback;
  });
  return rows;
}

export async function listConversations(limit = 100, offset = 0) {
  const { rows } = await query(`
    SELECT
      c.id, c.workspace_id AS "workspaceId", w.name AS "workspaceName",
      c.channel, c.subject, c.status, c.priority,
      c.external_id AS "externalId",
      c.last_message_at AS "lastMessageAt",
      c.message_count::int AS "messageCount",
      c.created_at AS "createdAt", c.updated_at AS "updatedAt"
    FROM conversations c
    LEFT JOIN workspaces w ON w.id = c.workspace_id
    WHERE c.deleted_at IS NULL
    ORDER BY c.last_message_at DESC NULLS LAST
    LIMIT $1 OFFSET $2
  `, [limit, offset]).catch(() => ({ rows: [] as any[], rowCount: 0 }));
  return rows;
}

export async function listFiles(limit = 100, offset = 0) {
  const { rows } = await query(`
    SELECT
      f.id, f.workspace_id AS "workspaceId", w.name AS "workspaceName",
      f.uploaded_by AS "uploadedById", u.email AS "uploadedByEmail",
      f.file_name AS "fileName", f.mime_type AS "mimeType",
      f.file_size_bytes::bigint AS "fileSizeBytes",
      f.storage_key AS "storageKey", f.source,
      f.created_at AS "uploadedAt", f.last_accessed_at AS "lastAccessedAt",
      f.purge_scheduled_at AS "purgeScheduledAt", f.purged_at AS "purgedAt"
    FROM files f
    LEFT JOIN workspaces w ON w.id = f.workspace_id
    LEFT JOIN users u ON u.id = f.uploaded_by
    ORDER BY f.created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]).catch(() => ({ rows: [] as any[], rowCount: 0 }));
  return rows;
}

export async function listJobs(limit = 100, offset = 0) {
  const { rows } = await query(`
    SELECT
      id, job_type AS "jobType", status,
      workspace_id AS "workspaceId",
      attempt::int AS "attempt", max_attempts::int AS "maxAttempts",
      scheduled_at AS "scheduledAt", started_at AS "startedAt",
      completed_at AS "completedAt", failed_at AS "failedAt",
      error_message AS "errorMessage",
      correlation_id AS "correlationId",
      created_at AS "createdAt"
    FROM background_jobs
    ORDER BY created_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]).catch(async () => {
    const fallback = await query(`
      SELECT
        id, 'onboarding_cleanup' AS "jobType",
        CASE WHEN executed_at IS NOT NULL THEN 'completed' ELSE 'pending' END AS status,
        workspace_id AS "workspaceId",
        1::int AS "attempt", 3::int AS "maxAttempts",
        scheduled_at AS "scheduledAt", NULL AS "startedAt",
        executed_at AS "completedAt", NULL AS "failedAt",
        NULL AS "errorMessage",
        NULL AS "correlationId",
        created_at AS "createdAt"
      FROM onboarding_cleanup_jobs
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]).catch(() => ({ rows: [] as any[], rowCount: 0 }));
    return fallback;
  });
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

