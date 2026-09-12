import { query, withTransaction } from '../../db/pool.js';
import { disconnectLuluManagedControlConnection, upsertLuluManagedControlConnection } from '../provider-control/provider.repo.js';

export const LULU_MANAGED_PROVIDERS = ['google-ads', 'google-analytics', 'meta', 'facebook', 'instagram', 'whatsapp', 'linkedin', 'tiktok-ads'] as const;
export type LuluManagedProvider = (typeof LULU_MANAGED_PROVIDERS)[number];

export function isLuluManagedProvider(value: string): value is LuluManagedProvider {
  return (LULU_MANAGED_PROVIDERS as readonly string[]).includes(value);
}

export async function upsertManagedOAuthConnection(input: {
  provider: LuluManagedProvider;
  displayName: string;
  externalAccountId: string | null;
  grantedScopes: string[];
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  tokenExpiresAt: string | null;
  settings: Record<string, unknown>;
  connectedBy: string;
}) {
  const { rows } = await query(`
    INSERT INTO lulu_managed_oauth_connections (
      provider, display_name, external_account_id, granted_scopes,
      encrypted_access_token, encrypted_refresh_token, token_expires_at,
      status, settings, last_error, connected_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'connected', $8, NULL, $9)
    ON CONFLICT (provider) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      external_account_id = EXCLUDED.external_account_id,
      granted_scopes = EXCLUDED.granted_scopes,
      encrypted_access_token = EXCLUDED.encrypted_access_token,
      encrypted_refresh_token = COALESCE(EXCLUDED.encrypted_refresh_token, lulu_managed_oauth_connections.encrypted_refresh_token),
      token_expires_at = EXCLUDED.token_expires_at,
      status = 'connected',
      settings = EXCLUDED.settings,
      last_error = NULL,
      connected_by = EXCLUDED.connected_by,
      updated_at = NOW()
    RETURNING
      id, provider, display_name AS "displayName", external_account_id AS "externalAccountId",
      granted_scopes AS "grantedScopes", status, token_expires_at AS "tokenExpiresAt",
      settings, last_synced_at AS "lastSyncedAt", last_error AS "lastError",
      connected_by AS "connectedBy", created_at AS "createdAt", updated_at AS "updatedAt"
  `, [
    input.provider,
    input.displayName,
    input.externalAccountId,
    input.grantedScopes,
    input.encryptedAccessToken,
    input.encryptedRefreshToken,
    input.tokenExpiresAt,
    JSON.stringify(input.settings),
    input.connectedBy,
  ]);
  const connection = rows[0];
  if (connection) {
    await upsertLuluManagedControlConnection({
      sourceId: String(connection.id),
      provider: input.provider,
      displayName: input.displayName,
      externalAccountId: input.externalAccountId,
      grantedScopes: input.grantedScopes,
      status: 'connected',
      settings: input.settings,
      connectedBy: input.connectedBy,
      credentialReference: `lulu_managed_oauth_connections:${connection.id}`,
    });
  }
  return connection;
}

export async function getManagedOAuthCredential(provider: LuluManagedProvider) {
  const { rows } = await query<{
    id: string;
    provider: LuluManagedProvider;
    displayName: string;
    externalAccountId: string | null;
    encryptedAccessToken: string;
    encryptedRefreshToken: string | null;
    tokenExpiresAt: string | null;
    status: string;
  }>(`
    SELECT id, provider, display_name AS "displayName", external_account_id AS "externalAccountId",
           encrypted_access_token AS "encryptedAccessToken", encrypted_refresh_token AS "encryptedRefreshToken",
           token_expires_at AS "tokenExpiresAt", status
    FROM lulu_managed_oauth_connections
    WHERE provider = $1
  `, [provider]);
  return rows[0] ?? null;
}

export async function disconnectManagedOAuthConnection(provider: LuluManagedProvider) {
  const { rows, rowCount } = await query<{ id: string }>(
    `DELETE FROM lulu_managed_oauth_connections WHERE provider = $1 RETURNING id`,
    [provider],
  );
  for (const row of rows) await disconnectLuluManagedControlConnection(String(row.id));
  return Boolean(rowCount);
}

export async function isWorkspaceOAuthSelfServiceAllowed(workspaceId: string, provider: LuluManagedProvider) {
  const { rows } = await query<{ allowed: boolean }>(
    `SELECT allowed
       FROM workspace_oauth_self_service_permissions
      WHERE workspace_id = $1 AND provider = $2`,
    [workspaceId, provider],
  );
  return rows[0]?.allowed === true;
}

export async function listWorkspaceOAuthSelfServiceProviders(workspaceId: string) {
  const { rows } = await query<{ provider: LuluManagedProvider }>(
    `SELECT provider
       FROM workspace_oauth_self_service_permissions
      WHERE workspace_id = $1 AND allowed = TRUE
      ORDER BY provider`,
    [workspaceId],
  );
  return rows.map((row) => row.provider);
}

export async function listWorkspaceOAuthSelfServicePermissions(search?: string) {
  const values: unknown[] = [];
  let filter = `w.deleted_at IS NULL`;
  if (search?.trim()) {
    values.push(`%${search.trim()}%`);
    filter += ` AND (w.name ILIKE $1 OR w.slug ILIKE $1 OR EXISTS (
      SELECT 1 FROM workspace_members wm_search
      JOIN users u_search ON u_search.id = wm_search.user_id
      WHERE wm_search.workspace_id = w.id AND u_search.email ILIKE $1
    ))`;
  }
  const { rows } = await query<{
    workspaceId: string;
    workspaceName: string;
    ownerEmail: string | null;
    allowedProviders: LuluManagedProvider[];
  }>(`
    SELECT w.id AS "workspaceId", w.name AS "workspaceName",
      (SELECT u.email FROM workspace_members wm
        JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = w.id AND wm.role = 'owner'
       ORDER BY wm.joined_at ASC NULLS LAST LIMIT 1) AS "ownerEmail",
      COALESCE(array_agg(p.provider ORDER BY p.provider)
        FILTER (WHERE p.allowed = TRUE), '{}') AS "allowedProviders"
    FROM workspaces w
    LEFT JOIN workspace_oauth_self_service_permissions p ON p.workspace_id = w.id
    WHERE ${filter}
    GROUP BY w.id, w.name, w.created_at
    ORDER BY w.created_at DESC
    LIMIT 500
  `, values);
  return rows;
}

export async function setWorkspaceOAuthSelfServicePermission(input: {
  workspaceId: string;
  provider: LuluManagedProvider;
  allowed: boolean;
  actorId: string;
}) {
  return withTransaction(async (client) => {
    const workspace = await query<{ id: string }>(
      `SELECT id FROM workspaces WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [input.workspaceId],
      client,
    );
    if (!workspace.rows[0]) return null;

    const previous = await query<{ allowed: boolean }>(
      `SELECT allowed FROM workspace_oauth_self_service_permissions
        WHERE workspace_id = $1 AND provider = $2`,
      [input.workspaceId, input.provider],
      client,
    );
    await query(
      `INSERT INTO workspace_oauth_self_service_permissions
        (workspace_id, provider, allowed, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, provider) DO UPDATE SET
         allowed = EXCLUDED.allowed,
         granted_by = EXCLUDED.granted_by,
         updated_at = NOW()`,
      [input.workspaceId, input.provider, input.allowed, input.actorId],
      client,
    );

    if (!input.allowed) {
      const affectedPlatforms = await query<{ id: string }>(
        `SELECT id FROM workspace_platforms
          WHERE workspace_id = $1 AND integration_key = $2 AND deleted_at IS NULL`,
        [input.workspaceId, input.provider],
        client,
      );
      const platformIds = affectedPlatforms.rows.map((row) => row.id);
      if (platformIds.length > 0) {
        await query(
          `DELETE FROM workspace_platform_oauth_credentials
            WHERE platform_id = ANY($1::uuid[])`,
          [platformIds],
          client,
        );
        await query(
          `DELETE FROM provider_connections
            WHERE workspace_id = $1 AND source_type = 'workspace_platform'
              AND source_id = ANY($2::uuid[])`,
          [input.workspaceId, platformIds],
          client,
        );
        await query(
          `UPDATE workspace_platforms SET
             connection_status = 'disconnected', external_account_id = NULL,
             granted_scopes = '{}', settings = '{}'::jsonb, last_error = NULL,
             updated_at = NOW()
           WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
          [input.workspaceId, platformIds],
          client,
        );
      }
    }

    if (input.provider === 'whatsapp') {
      if (input.allowed) {
        await query(
          `UPDATE twilio_workspace_accounts SET
             status=CASE WHEN upper(sender_status)='ONLINE' THEN 'CONNECTED' ELSE 'PROVISIONING' END,
             last_error=NULL,updated_at=NOW()
           WHERE workspace_id=$1 AND status='DISABLED'`,
          [input.workspaceId],
          client,
        );
        await query(
          `UPDATE omni_channel_identities i SET
             status=CASE WHEN upper(a.sender_status)='ONLINE' THEN 'ACTIVE' ELSE 'CONNECTING' END,
             updated_at=NOW()
           FROM twilio_workspace_accounts a
           WHERE a.workspace_id=$1 AND i.workspace_id=a.workspace_id
             AND i.external_identity_id=a.sender_address`,
          [input.workspaceId],
          client,
        );
        await query(
          `UPDATE workspace_platforms p SET
             connection_status=CASE WHEN upper(a.sender_status)='ONLINE' THEN 'connected' ELSE 'pending' END,
             last_error=NULL,updated_at=NOW()
           FROM twilio_workspace_accounts a
           WHERE a.workspace_id=$1 AND p.workspace_id=a.workspace_id
             AND p.integration_key='whatsapp' AND p.deleted_at IS NULL`,
          [input.workspaceId],
          client,
        );
        await query(
          `UPDATE provider_connections c SET
             status=CASE WHEN upper(a.sender_status)='ONLINE' THEN 'CONNECTED' ELSE 'CONNECTING' END,
             authorization_state='AUTHORIZED',
             health_status=CASE WHEN upper(a.sender_status)='ONLINE' THEN 'HEALTHY' ELSE 'UNKNOWN' END,
             updated_at=NOW()
           FROM twilio_workspace_accounts a
           WHERE a.workspace_id=$1 AND c.workspace_id=a.workspace_id AND c.provider_key='whatsapp'`,
          [input.workspaceId],
          client,
        );
      } else {
        await query(`UPDATE twilio_workspace_accounts SET status='DISABLED',updated_at=NOW() WHERE workspace_id=$1`, [input.workspaceId], client);
        await query(
          `UPDATE omni_channel_identities i SET status='DISCONNECTED',updated_at=NOW()
           FROM twilio_workspace_accounts a
           WHERE a.workspace_id=$1 AND i.workspace_id=a.workspace_id
             AND i.external_identity_id=a.sender_address`,
          [input.workspaceId],
          client,
        );
        await query(
          `UPDATE workspace_platforms SET connection_status='disconnected',last_error=NULL,updated_at=NOW()
           WHERE workspace_id=$1 AND integration_key='whatsapp' AND deleted_at IS NULL`,
          [input.workspaceId],
          client,
        );
        await query(
          `UPDATE provider_connections SET status='DISCONNECTED',authorization_state='NOT_AUTHORIZED',
             health_status='DISCONNECTED',updated_at=NOW()
           WHERE workspace_id=$1 AND provider_key='whatsapp'`,
          [input.workspaceId],
          client,
        );
      }
    }

    await query(
      `INSERT INTO audit_log
        (workspace_id, actor_id, action, entity_type, entity_id, before_data, after_data)
       VALUES ($1, $2, 'workspace.oauth_self_service_changed',
         'workspace_oauth_self_service_permission', $3,
         $4::jsonb, $5::jsonb)`,
      [
        input.workspaceId,
        input.actorId,
        `${input.workspaceId}:${input.provider}`,
        JSON.stringify({ allowed: previous.rows[0]?.allowed ?? false, provider: input.provider }),
        JSON.stringify({ allowed: input.allowed, provider: input.provider }),
      ],
      client,
    );
    return { workspaceId: input.workspaceId, provider: input.provider, allowed: input.allowed };
  });
}
