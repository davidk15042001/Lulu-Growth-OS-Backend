import { query, withTransaction } from '../../db/pool.js';
import { decryptSecret, encryptSecret, secretNeedsRotation } from '../../utils/secret-box.js';
import { env } from '../../config/env.js';
import { recordSecurityEvent } from './security-event.service.js';

const stores = {
  email: { table: 'email_accounts', id: 'id', fields: { encryptedAccessToken: 'encrypted_access_token', encryptedRefreshToken: 'encrypted_refresh_token', encryptedPassword: 'encrypted_password' } },
  calendar: { table: 'calendar_accounts', id: 'id', fields: { encryptedAccessToken: 'encrypted_access_token', encryptedRefreshToken: 'encrypted_refresh_token', encryptedApiKey: 'encrypted_api_key' } },
  platform: { table: 'workspace_platform_oauth_credentials', id: 'platform_id', fields: { encryptedAccessToken: 'encrypted_access_token', encryptedRefreshToken: 'encrypted_refresh_token' } },
} as const;

/** CAS prevents lazy rotation from overwriting a concurrent provider token refresh. */
export async function rotateStoredCredentials<T extends object>(kind: keyof typeof stores, workspaceId: string, id: string, row: T): Promise<T> {
  const store = stores[kind];
  for (const [field, column] of Object.entries(store.fields)) {
    const old = (row as Record<string,unknown>)[field];
    if (typeof old !== 'string' || !secretNeedsRotation(old)) continue;
    const replacement = encryptSecret(decryptSecret(old));
    await withTransaction(async client => {
      const scope = kind === 'platform'
        ? 'platform_id IN (SELECT id FROM workspace_platforms WHERE workspace_id=$4 AND deleted_at IS NULL)'
        : 'workspace_id=$4';
      const result = await query(`UPDATE ${store.table} SET ${column}=$2 WHERE ${store.id}=$1 AND ${column}=$3 AND ${scope}`,
        [id, replacement, old, workspaceId], client);
      if (result.rowCount) {
        (row as Record<string,unknown>)[field] = replacement;
        await recordSecurityEvent({ eventType: 'PROVIDER_CREDENTIAL_CHANGED', workspaceId,
          metadata: { action: 'key_rotated', targetId: id, provider: kind, keyVersion: env.PROVIDER_CREDENTIAL_KEY_VERSION } }, client);
      }
    });
  }
  return row;
}
