import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { buildUpdateSet } from '../../db/update-builder.js';
import { query, withTransaction } from '../../db/pool.js';
import { getLatestPaygPaymentMethodSetup, isBillingAdminUser } from '../billing/payg-billing.repo.js';
import { getPaygDirectPaymentMethods } from '../billing/payg-payment-methods.js';
import type {
  CreateSavedViewInput,
  InviteMemberInput,
  ListAuditQuery,
  ListSavedViewsQuery,
  ListUsageQuery,
  UpdateWorkspaceSettingsInput,
  UpdateMemberInput,
  UpdateSavedViewInput,
} from './workspace-app.validator.js';

export type WorkspaceSettings = {
  workspaceId: string;
  settings: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
};

export type WorkspaceMember = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  joinedAt: string;
};

export type WorkspaceInvitation = {
  id: string;
  email: string;
  role: 'admin' | 'member' | 'viewer';
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
};

const memberSelect = `
  u.id,
  u.email,
  u.first_name AS "firstName",
  u.last_name AS "lastName",
  wm.role,
  wm.joined_at AS "joinedAt"
`;

const invitationSelect = `
  wi.id,
  wi.email,
  wi.role,
  wi.invited_by AS "invitedBy",
  wi.expires_at AS "expiresAt",
  wi.created_at AS "createdAt"
`;

export async function getBootstrapStats(workspaceId: string, userId: string) {
  const [records, metrics, notifications, approvals, integrations, members, recentActivity] = await Promise.all([
    query<{ domain: string; resourceType: string; total: number }>(
      `SELECT rt.domain, wr.resource_type AS "resourceType", count(*)::int AS total
       FROM resource_types rt
       LEFT JOIN workspace_records wr
         ON wr.resource_type = rt.key AND wr.workspace_id = $1 AND wr.deleted_at IS NULL
       GROUP BY rt.domain, wr.resource_type
       HAVING count(wr.id) > 0
       ORDER BY rt.domain, wr.resource_type`,
      [workspaceId]
    ),
    query<{ id: string; key: string; name: string; domain: string; unit: string; value: string | null; recordedAt: string | null }>(
      `SELECT md.id, md.key, md.name, md.domain, md.unit,
              latest.value, latest.recorded_at AS "recordedAt"
       FROM metric_definitions md
       LEFT JOIN LATERAL (
         SELECT mp.value, mp.recorded_at
         FROM metric_points mp
         WHERE mp.metric_id = md.id
         ORDER BY mp.recorded_at DESC
         LIMIT 1
       ) latest ON TRUE
       WHERE md.workspace_id = $1 AND md.deleted_at IS NULL
       ORDER BY md.domain, md.name`,
      [workspaceId]
    ),
    query<{ total: number }>(
      `SELECT count(*)::int AS total
       FROM notifications
       WHERE workspace_id = $1 AND user_id = $2 AND read_at IS NULL AND dismissed_at IS NULL`,
      [workspaceId, userId]
    ),
    query<{ total: number }>(
      `SELECT count(*)::int AS total
       FROM approval_requests
       WHERE workspace_id = $1 AND status = 'pending'
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [workspaceId]
    ),
    query<{ status: string; total: number }>(
      `SELECT connection_status AS status, count(*)::int AS total
       FROM workspace_platforms
       WHERE workspace_id = $1 AND deleted_at IS NULL
       GROUP BY connection_status`,
      [workspaceId]
    ),
    query<{ total: number }>(
      'SELECT count(*)::int AS total FROM workspace_members WHERE workspace_id = $1',
      [workspaceId]
    ),
    query<{ id: string; action: string; entityType: string; entityId: string | null; actorId: string | null; createdAt: string }>(
      `SELECT id::text, action, entity_type AS "entityType", entity_id AS "entityId",
              actor_id AS "actorId", created_at AS "createdAt"
       FROM audit_log
       WHERE workspace_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 20`,
      [workspaceId]
    ),
  ]);

  const recordCounts = Object.fromEntries(records.rows.map((row) => [row.resourceType, row.total]));
  const domainCounts = records.rows.reduce<Record<string, number>>((result, row) => {
    result[row.domain] = (result[row.domain] ?? 0) + row.total;
    return result;
  }, {});

  return {
    records: { total: Object.values(recordCounts).reduce((sum, total) => sum + total, 0), byType: recordCounts, byDomain: domainCounts },
    metrics: metrics.rows,
    notifications: { unread: notifications.rows[0]?.total ?? 0 },
    approvals: { pending: approvals.rows[0]?.total ?? 0 },
    integrations: Object.fromEntries(integrations.rows.map((row) => [row.status, row.total])),
    members: { total: members.rows[0]?.total ?? 0 },
    recentActivity: recentActivity.rows,
  };
}

export async function listMembers(workspaceId: string) {
  const [members, invitations] = await Promise.all([
    query<WorkspaceMember>(
      `SELECT ${memberSelect}
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1 AND u.deleted_at IS NULL
       ORDER BY CASE wm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
                lower(u.email)`,
      [workspaceId]
    ),
    query<WorkspaceInvitation>(
      `SELECT ${invitationSelect}
       FROM workspace_invitations wi
       WHERE wi.workspace_id = $1 AND wi.accepted_at IS NULL AND wi.revoked_at IS NULL
         AND wi.expires_at > NOW()
       ORDER BY wi.created_at DESC`,
      [workspaceId]
    ),
  ]);
  return { members: members.rows, invitations: invitations.rows };
}

export async function createInvitation(
  workspaceId: string,
  invitedBy: string,
  input: InviteMemberInput
) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const invitation = await withTransaction(async (client) => {
    await query(
      `UPDATE workspace_invitations
       SET revoked_at = NOW()
       WHERE workspace_id = $1 AND lower(email) = lower($2)
         AND accepted_at IS NULL AND revoked_at IS NULL`,
      [workspaceId, input.email],
      client
    );
    const { rows } = await query<WorkspaceInvitation>(
      `INSERT INTO workspace_invitations (
         workspace_id, email, role, token_hash, invited_by, expires_at
       ) VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days')
       RETURNING id, email, role, invited_by AS "invitedBy",
                 expires_at AS "expiresAt", created_at AS "createdAt"`,
      [workspaceId, input.email, input.role, tokenHash, invitedBy],
      client
    );
    return rows[0];
  });

  return { invitation, token };
}

export async function acceptInvitation(rawToken: string, userId: string, userEmail: string) {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  return withTransaction(async (client) => {
    const { rows } = await query<{
      id: string;
      workspaceId: string;
      email: string;
      role: 'admin' | 'member' | 'viewer';
    }>(
      `SELECT id, workspace_id AS "workspaceId", email, role
       FROM workspace_invitations
       WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL
         AND expires_at > NOW()
       FOR UPDATE`,
      [tokenHash],
      client
    );
    const invitation = rows[0];
    if (!invitation || invitation.email.toLowerCase() !== userEmail.toLowerCase()) return undefined;

    await query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET
         role = CASE WHEN workspace_members.role = 'owner' THEN 'owner' ELSE EXCLUDED.role END`,
      [invitation.workspaceId, userId, invitation.role],
      client
    );
    await query(
      `UPDATE workspace_invitations
       SET accepted_by = $2, accepted_at = NOW()
       WHERE id = $1`,
      [invitation.id, userId],
      client
    );
    return invitation;
  });
}

export async function updateMember(workspaceId: string, memberId: string, input: UpdateMemberInput) {
  return withTransaction(async (client) => {
    const updated = await query(
      `UPDATE workspace_members
       SET role = $3
       WHERE workspace_id = $1 AND user_id = $2 AND role <> 'owner'
       RETURNING user_id`,
      [workspaceId, memberId, input.role],
      client
    );
    if (updated.rowCount === 0) return undefined;

    const { rows } = await query<WorkspaceMember>(
      `SELECT ${memberSelect}
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1 AND wm.user_id = $2 AND u.deleted_at IS NULL`,
      [workspaceId, memberId],
      client
    );
    return rows[0];
  });
}

export async function removeMember(workspaceId: string, memberId: string) {
  const { rowCount } = await query(
    `DELETE FROM workspace_members
     WHERE workspace_id = $1 AND user_id = $2 AND role <> 'owner'`,
    [workspaceId, memberId]
  );
  return rowCount > 0;
}

type SavedView = {
  id: string;
  workspaceId: string;
  userId: string;
  resourceType: string;
  name: string;
  filters: Record<string, unknown>;
  sorting: Record<string, unknown>;
  isDefault: boolean;
  isShared: boolean;
  createdAt: string;
  updatedAt: string;
};

const savedViewSelect = `
  id,
  workspace_id AS "workspaceId",
  user_id AS "userId",
  resource_type AS "resourceType",
  name,
  filters,
  sorting,
  is_default AS "isDefault",
  is_shared AS "isShared",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export async function listSavedViews(workspaceId: string, userId: string, filters: ListSavedViewsQuery) {
  const values: unknown[] = [workspaceId, userId];
  const conditions = ['workspace_id = $1', '(user_id = $2 OR is_shared = TRUE)'];
  if (filters.resourceType) {
    values.push(filters.resourceType);
    conditions.push(`resource_type = $${values.length}`);
  }
  const { rows } = await query<SavedView>(
    `SELECT ${savedViewSelect}
     FROM saved_views
     WHERE ${conditions.join(' AND ')}
     ORDER BY is_default DESC, name`,
    values
  );
  return rows;
}

export async function createSavedView(workspaceId: string, userId: string, input: CreateSavedViewInput) {
  return withTransaction(async (client) => {
    if (input.isDefault) {
      await clearDefaultSavedViews(client, workspaceId, userId, input.resourceType);
    }
    const { rows } = await query<SavedView>(
      `INSERT INTO saved_views (
         workspace_id, user_id, resource_type, name, filters, sorting, is_default, is_shared
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${savedViewSelect}`,
      [workspaceId, userId, input.resourceType, input.name, input.filters, input.sorting, input.isDefault, input.isShared],
      client
    );
    return rows[0];
  });
}

async function clearDefaultSavedViews(client: PoolClient, workspaceId: string, userId: string, resourceType: string) {
  await query(
    `UPDATE saved_views SET is_default = FALSE
     WHERE workspace_id = $1 AND user_id = $2 AND resource_type = $3 AND is_default = TRUE`,
    [workspaceId, userId, resourceType],
    client
  );
}

const savedViewUpdateColumns: Partial<Record<keyof UpdateSavedViewInput, string>> = {
  name: 'name',
  filters: 'filters',
  sorting: 'sorting',
  isDefault: 'is_default',
  isShared: 'is_shared',
};

export async function updateSavedView(
  workspaceId: string,
  userId: string,
  viewId: string,
  input: UpdateSavedViewInput
) {
  return withTransaction(async (client) => {
    const current = await query<{ resourceType: string }>(
      `SELECT resource_type AS "resourceType" FROM saved_views
       WHERE id = $1 AND workspace_id = $2 AND user_id = $3`,
      [viewId, workspaceId, userId],
      client
    );
    if (!current.rows[0]) return undefined;
    if (input.isDefault) {
      await clearDefaultSavedViews(client, workspaceId, userId, current.rows[0].resourceType);
    }
    const update = buildUpdateSet(input, savedViewUpdateColumns, 3);
    const { rows } = await query<SavedView>(
      `UPDATE saved_views
       SET ${update.assignments.join(', ')}
       WHERE id = $1 AND workspace_id = $2 AND user_id = $3
       RETURNING ${savedViewSelect}`,
      [viewId, workspaceId, userId, ...update.values],
      client
    );
    return rows[0];
  });
}

export async function deleteSavedView(workspaceId: string, userId: string, viewId: string) {
  const { rowCount } = await query(
    'DELETE FROM saved_views WHERE id = $1 AND workspace_id = $2 AND user_id = $3',
    [viewId, workspaceId, userId]
  );
  return rowCount > 0;
}

export async function listAudit(workspaceId: string, filters: ListAuditQuery) {
  const values: unknown[] = [workspaceId];
  const conditions = ['a.workspace_id = $1'];
  if (filters.action) {
    values.push(filters.action);
    conditions.push(`a.action = $${values.length}`);
  }
  if (filters.entityType) {
    values.push(filters.entityType);
    conditions.push(`a.entity_type = $${values.length}`);
  }
  if (filters.entityId) {
    values.push(filters.entityId);
    conditions.push(`a.entity_id = $${values.length}`);
  }
  const where = conditions.join(' AND ');
  const offset = (filters.page - 1) * filters.limit;
  const [items, count] = await Promise.all([
    query(
      `SELECT a.id::text, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId",
              a.actor_id AS "actorId", u.email AS "actorEmail", a.request_id AS "requestId",
              a.before_data AS "beforeData", a.after_data AS "afterData", a.created_at AS "createdAt"
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
       WHERE ${where}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, filters.limit, offset]
    ),
    query<{ total: string }>(`SELECT count(*)::text AS total FROM audit_log a WHERE ${where}`, values),
  ]);
  const total = Number.parseInt(count.rows[0]?.total ?? '0', 10);
  return { items: items.rows, pagination: { page: filters.page, limit: filters.limit, total, pages: Math.ceil(total / filters.limit) } };
}

export async function getBilling(workspaceId: string, userId: string, filters: ListUsageQuery) {
  const values: unknown[] = [workspaceId];
  const usageConditions = ['workspace_id = $1'];
  if (filters.from) {
    values.push(filters.from);
    usageConditions.push(`period_end >= $${values.length}`);
  }
  if (filters.to) {
    values.push(filters.to);
    usageConditions.push(`period_start <= $${values.length}`);
  }
  const [subscription, usage, paygCurrent, paygInvoices, latestPaygPaymentSetup] = await Promise.all([
    query(
      `SELECT workspace_id AS "workspaceId", provider, plan_key AS "planKey", status, seats,
              trial_ends_at AS "trialEndsAt", current_period_starts_at AS "currentPeriodStartsAt",
              current_period_ends_at AS "currentPeriodEndsAt",
              cancel_at_period_end AS "cancelAtPeriodEnd", metadata, created_at AS "createdAt",
              updated_at AS "updatedAt"
       FROM workspace_subscriptions WHERE workspace_id = $1`,
      [workspaceId]
    ),
    query(
      `SELECT metric_key AS "metricKey", period_start AS "periodStart", period_end AS "periodEnd",
              quantity, metadata, updated_at AS "updatedAt"
       FROM workspace_usage_counters
       WHERE ${usageConditions.join(' AND ')}
       ORDER BY period_start DESC, metric_key`,
      values
    ),
    query<{
      enabled: boolean;
      currency: string;
      intervalDays: number;
      periodStart: string;
      periodEnd: string;
      collectionMethod: string;
      preferredPaymentMethod: 'card' | 'wechatpay' | 'alipaycn' | null;
      paymentSourceConfigured: boolean;
      aiAccessBlocked: boolean;
      blockedAt: string | null;
      blockReason: string | null;
      paymentLink: string | null;
      apiCostUsd: string;
      serverCostUsd: string;
      inputTokens: string;
      outputTokens: string;
      apiEvents: number;
      serverDays: number;
    }>(
      `SELECT p.enabled, p.currency, p.interval_days AS "intervalDays",
              p.current_period_start AS "periodStart",
              p.current_period_end AS "periodEnd",
              p.collection_method AS "collectionMethod",
              p.preferred_payment_method AS "preferredPaymentMethod",
              p.provider_payment_source_id IS NOT NULL AS "paymentSourceConfigured",
              p.ai_access_blocked AS "aiAccessBlocked",
              p.blocked_at AS "blockedAt",
              p.block_reason AS "blockReason",
              blocked.hosted_invoice_url AS "paymentLink",
              COALESCE(api.customer_cost_usd, 0)::numeric AS "apiCostUsd",
              COALESCE(server.customer_cost_usd, 0)::numeric AS "serverCostUsd",
              COALESCE(api.input_tokens, 0)::bigint AS "inputTokens",
              COALESCE(api.output_tokens, 0)::bigint AS "outputTokens",
              COALESCE(api.event_count, 0)::int AS "apiEvents",
              COALESCE(server.usage_days, 0)::int AS "serverDays"
       FROM workspace_payg_profiles p
       LEFT JOIN workspace_payg_periods blocked ON blocked.id=p.blocked_period_id
       LEFT JOIN LATERAL (
         SELECT SUM(customer_cost_usd) AS customer_cost_usd,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                COUNT(*) AS event_count
         FROM ai_usage_ledger
         WHERE workspace_id=p.workspace_id
           AND payg_period_id IS NULL
           AND created_at >= p.current_period_start
           AND created_at < p.current_period_end
       ) api ON TRUE
       LEFT JOIN LATERAL (
         SELECT SUM(customer_cost_usd) AS customer_cost_usd,
                COUNT(*) AS usage_days
         FROM workspace_server_usage_ledger
         WHERE workspace_id=p.workspace_id
           AND payg_period_id IS NULL
           AND created_at >= p.current_period_start
           AND created_at < p.current_period_end
       ) server ON TRUE
       WHERE p.workspace_id=$1`,
      [workspaceId],
    ),
    query<{
      id: string;
      periodStart: string;
      periodEnd: string;
      status: string;
      currency: string;
      apiCostUsd: string;
      serverCostUsd: string;
      totalCostUsd: string;
      hostedInvoiceUrl: string | null;
      invoicePdfUrl: string | null;
      finalizedAt: string | null;
      paidAt: string | null;
      billingMode: 'weekly' | 'api_pay_now';
    }>(
      `SELECT id, period_start AS "periodStart", period_end AS "periodEnd",
              status, currency, api_cost_usd AS "apiCostUsd",
              server_cost_usd AS "serverCostUsd", total_cost_usd AS "totalCostUsd",
              hosted_invoice_url AS "hostedInvoiceUrl", invoice_pdf_url AS "invoicePdfUrl",
              finalized_at AS "finalizedAt", paid_at AS "paidAt",
              billing_mode AS "billingMode"
       FROM workspace_payg_periods
       WHERE workspace_id=$1
       ORDER BY period_end DESC
       LIMIT 12`,
      [workspaceId],
    ),
    getLatestPaygPaymentMethodSetup(workspaceId),
  ]);
  const current = paygCurrent.rows[0];
  const subscriptionRow = subscription.rows[0] ?? null;
  const adminBillingBypass = await isBillingAdminUser(userId);
  return {
    subscription: subscriptionRow,
    usage: usage.rows,
    paygConfiguration: {
      availablePaymentMethods: getPaygDirectPaymentMethods(),
      selectedPaymentMethod: current?.preferredPaymentMethod ?? latestPaygPaymentSetup?.paymentMethod ?? null,
      status: current?.paymentSourceConfigured || (current?.preferredPaymentMethod && current.preferredPaymentMethod !== 'card')
        ? 'active'
        : latestPaygPaymentSetup?.status === 'PENDING'
          ? 'pending'
          : latestPaygPaymentSetup?.status === 'FAILED'
            ? 'failed'
            : 'not_configured',
      automaticCollection: Boolean(current?.paymentSourceConfigured),
      paymentSourceConfigured: Boolean(current?.paymentSourceConfigured),
      latestSetup: latestPaygPaymentSetup ? {
        id: latestPaygPaymentSetup.id,
        status: latestPaygPaymentSetup.status,
        paymentMethod: latestPaygPaymentSetup.paymentMethod,
      } : null,
    },
    payg: current ? {
      enabled: current.enabled,
      currency: current.currency,
      intervalDays: current.intervalDays,
      periodStart: current.periodStart,
      periodEnd: current.periodEnd,
      nextInvoiceAt: current.periodEnd,
      collectionMethod: current.collectionMethod,
      preferredPaymentMethod: current.preferredPaymentMethod,
      aiAccessBlocked: adminBillingBypass ? false : current.aiAccessBlocked,
      blockedAt: adminBillingBypass ? null : current.blockedAt,
      blockReason: adminBillingBypass ? null : current.blockReason,
      paymentLink: adminBillingBypass ? null : current.paymentLink,
      apiCost: Number(current.apiCostUsd),
      serverCost: Number(current.serverCostUsd),
      estimatedTotal: Number(current.apiCostUsd) + Number(current.serverCostUsd),
      inputTokens: Number(current.inputTokens),
      outputTokens: Number(current.outputTokens),
      apiEvents: current.apiEvents,
      serverDays: current.serverDays,
      paymentMethods: getPaygDirectPaymentMethods(),
      invoices: paygInvoices.rows.map((invoice) => ({
        ...invoice,
        apiCost: Number(invoice.apiCostUsd),
        serverCost: Number(invoice.serverCostUsd),
        totalCost: Number(invoice.totalCostUsd),
      })),
    } : null,
  };
}

export async function getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettings> {
  const { rows } = await query<WorkspaceSettings>(
    `SELECT workspace_id AS "workspaceId", settings,
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM workspace_settings
     WHERE workspace_id = $1`,
    [workspaceId],
  );
  return rows[0] ?? { workspaceId, settings: {}, createdAt: null, updatedAt: null };
}

export async function updateWorkspaceSettings(
  workspaceId: string,
  userId: string,
  input: UpdateWorkspaceSettingsInput,
): Promise<WorkspaceSettings> {
  return withTransaction(async (client) => {
    const beforeResult = await query<WorkspaceSettings>(
      `SELECT workspace_id AS "workspaceId", settings,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM workspace_settings
       WHERE workspace_id = $1
       FOR UPDATE`,
      [workspaceId],
      client,
    );
    const before = beforeResult.rows[0] ?? null;
    const { rows } = await query<WorkspaceSettings>(
      `INSERT INTO workspace_settings (workspace_id, settings)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (workspace_id) DO UPDATE
         SET settings = workspace_settings.settings || EXCLUDED.settings
       RETURNING workspace_id AS "workspaceId", settings,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [workspaceId, JSON.stringify(input)],
      client,
    );
    const settings = rows[0]!;
    await query(
      `INSERT INTO audit_log (
         workspace_id, actor_id, action, entity_type, entity_id, before_data, after_data
       ) VALUES ($1, $2, 'workspace_settings.updated', 'workspace_settings', $1, $3::jsonb, $4::jsonb)`,
      [workspaceId, userId, JSON.stringify(before?.settings ?? {}), JSON.stringify(settings.settings)],
      client,
    );
    return settings;
  });
}

export async function queueIntegrationSync(workspaceId: string, platformId: string) {
  return withTransaction(async (client) => {
    const platform = await query<{ id: string }>(
      `SELECT id FROM workspace_platforms
       WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [platformId, workspaceId],
      client
    );
    if (!platform.rows[0]) return undefined;
    const job = await query<{ id: string }>(
      `INSERT INTO background_jobs (workspace_id, job_type, payload)
       VALUES ($1, 'integration.sync', jsonb_build_object('platformId', $2::text))
       RETURNING id`,
      [workspaceId, platformId],
      client
    );
    const jobId = job.rows[0]?.id;
    if (!jobId) throw new Error('Integration job insert did not return an id');
    const run = await query(
      `INSERT INTO integration_sync_runs (platform_id, job_id)
       VALUES ($1, $2)
       RETURNING id, platform_id AS "platformId", job_id AS "jobId", status, created_at AS "createdAt"`,
      [platformId, jobId],
      client
    );
    await query(
      `UPDATE workspace_platforms SET connection_status = 'syncing', last_error = NULL WHERE id = $1`,
      [platformId],
      client
    );
    return run.rows[0];
  });
}
