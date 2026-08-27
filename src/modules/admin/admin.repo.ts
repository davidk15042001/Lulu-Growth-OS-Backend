import { query } from '../../db/pool.js';

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
    FROM websites WHERE deleted_at IS NULL`),
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
      (SELECT COUNT(*) FROM refresh_tokens rt WHERE rt.user_id = u.id AND rt.revoked = FALSE)::int AS "activeSessions"
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

  const [workspaces, sessions, usage] = await Promise.all([
    query(`
      SELECT w.id, w.name AS "companyName", wm.role, w.onboarding_step AS "onboardingStep",
             w.onboarding_completed_at AS "onboardingCompletedAt", w.created_at AS "joinedAt"
      FROM workspace_members wm
      JOIN workspaces w ON w.id = wm.workspace_id AND w.deleted_at IS NULL
      WHERE wm.user_id = $1
      ORDER BY wm.role = 'owner' DESC, w.created_at ASC
    `, [userId]),
    query(`
      SELECT id, selector, user_agent AS "userAgent", ip_address AS "ipAddress",
             created_at AS "createdAt", last_used_at AS "lastUsedAt",
             expires_at AS "expiresAt", revoked
      FROM refresh_tokens
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
  ]);

  return {
    ...userResult.rows[0],
    workspaces: workspaces.rows,
    sessions: sessions.rows,
    usage: usage.rows,
  };
}

export async function updateUserStatus(userId: string, action: 'lock' | 'unlock' | 'verify' | 'reset-sessions') {
  switch (action) {
    case 'lock':
      await query(`UPDATE users SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`, [userId]);
      break;
    case 'unlock':
      await query(`UPDATE users SET deleted_at = NULL WHERE id = $1`, [userId]);
      break;
    case 'verify':
      await query(`UPDATE users SET verified_at = NOW() WHERE id = $1 AND verified_at IS NULL`, [userId]);
      break;
    case 'reset-sessions':
      await query(`UPDATE users SET token_version = token_version + 1 WHERE id = $1`, [userId]);
      await query(`UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1 AND revoked = FALSE`, [userId]);
      break;
  }
  return getUserDetail(userId);
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

  const [members, records, websites, usage] = await Promise.all([
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
    `, [workspaceId]),
    query(`
      SELECT metric_key AS "metricKey", SUM(quantity)::numeric AS "total",
             MIN(period_start) AS "periodStart", MAX(period_end) AS "periodEnd"
      FROM workspace_usage_counters
      WHERE workspace_id = $1
      GROUP BY metric_key
    `, [workspaceId]),
  ]);

  return {
    ...wsResult.rows[0],
    members: members.rows,
    crmByType: records.rows,
    websites: websites.rows,
    usage: usage.rows,
  };
}

export async function updateWorkspaceStatus(workspaceId: string, action: 'lock' | 'unlock' | 'reset-onboarding' | 'set-plan', planKey?: string) {
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
      (SELECT COUNT(*) FROM agent_runs ar WHERE ar.agent_id = a.id)::int AS "runCount"
    FROM agents a
    LEFT JOIN workspaces w ON w.id = a.workspace_id
    WHERE a.deleted_at IS NULL
    ORDER BY a.updated_at DESC
    LIMIT $1 OFFSET $2
  `, [limit, offset]);
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
  `, [limit, offset]);
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
    `, [limit, offset]);
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
    `, [limit, offset]);
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
    `, [limit, offset]);
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
    `, [search]),
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

