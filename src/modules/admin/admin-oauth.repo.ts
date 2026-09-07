import { query } from '../../db/pool.js';

export const LULU_MANAGED_PROVIDERS = ['google-ads', 'google-analytics', 'meta', 'linkedin', 'tiktok-ads'] as const;
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
  return rows[0];
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
  const { rowCount } = await query(
    `DELETE FROM lulu_managed_oauth_connections WHERE provider = $1`,
    [provider],
  );
  return Boolean(rowCount);
}
