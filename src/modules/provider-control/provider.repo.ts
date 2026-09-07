import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { canonicalProviderKey, isProviderRegistered, providerError } from './provider-registry.js';
import type {
  ProviderCapabilityStatus,
  ProviderConnectionStatus,
  ProviderHealthStatus,
  ProviderMode,
  ProviderScopeType,
  ProviderSyncStatus,
} from './provider.types.js';

export type ProviderCapabilityState = {
  id: string;
  capabilityKey: string;
  status: ProviderCapabilityStatus;
  source: string;
  grantedScopes: string[];
  lastCheckedAt: string | null;
  lastError: string | null;
};

export type ProviderAsset = {
  id: string;
  providerKey: string;
  assetType: string;
  externalAssetId: string;
  displayName: string | null;
  status: string;
  capabilities: Record<string, unknown>;
  metadata: Record<string, unknown>;
  lastSyncedAt: string | null;
};

export type ProviderAccount = {
  id: string;
  providerKey: string;
  externalAccountId: string;
  name: string | null;
  accountType: string | null;
  status: string;
  currency: string | null;
  timezone: string | null;
  country: string | null;
  metadata: Record<string, unknown>;
  lastSyncedAt: string | null;
  assets: ProviderAsset[];
};

export type ProviderConnection = {
  id: string;
  scopeType: ProviderScopeType;
  workspaceId: string | null;
  organizationId: string | null;
  providerKey: string;
  displayName: string;
  mode: ProviderMode;
  status: ProviderConnectionStatus;
  authorizationState: string;
  externalAccountId: string | null;
  grantedScopes: string[];
  hasCredentialReference: boolean;
  sourceType: string | null;
  sourceId: string | null;
  sharedGrantedCapabilities: string[] | null;
  healthStatus: ProviderHealthStatus;
  healthReason: string | null;
  lastVerifiedAt: string | null;
  lastSuccessAt: string | null;
  lastWebhookAt: string | null;
  rateLimitResetAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  accounts: ProviderAccount[];
  capabilities: ProviderCapabilityState[];
  syncStates: Array<{
    id: string;
    subjectType: string;
    subjectId: string;
    syncType: string;
    cursor: string | null;
    status: ProviderSyncStatus;
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    lastError: string | null;
    retryCount: number;
  }>;
};

const connectionSelect = `
  c.id,
  c.scope_type AS "scopeType",
  c.workspace_id AS "workspaceId",
  c.organization_id AS "organizationId",
  c.provider_key AS "providerKey",
  COALESCE(r.display_name, c.provider_key) AS "displayName",
  c.mode,
  c.status,
  c.authorization_state AS "authorizationState",
  c.external_account_id AS "externalAccountId",
  c.granted_scopes AS "grantedScopes",
  (c.credential_ref IS NOT NULL) AS "hasCredentialReference",
  c.source_type AS "sourceType",
  c.source_id AS "sourceId",
  c.health_status AS "healthStatus",
  c.health_reason AS "healthReason",
  c.last_verified_at AS "lastVerifiedAt",
  c.last_success_at AS "lastSuccessAt",
  c.last_webhook_at AS "lastWebhookAt",
  c.rate_limit_reset_at AS "rateLimitResetAt",
  c.consecutive_failures AS "consecutiveFailures",
  c.last_error AS "lastError",
  c.created_at AS "createdAt",
  c.updated_at AS "updatedAt"
`;

function legacyConnectionStatus(status: string): { status: ProviderConnectionStatus; authorizationState: string; healthStatus: ProviderHealthStatus } {
  if (status === 'connected' || status === 'active') return { status: 'CONNECTED', authorizationState: 'AUTHORIZED', healthStatus: 'UNKNOWN' };
  if (status === 'pending' || status === 'syncing') return { status: 'CONNECTING', authorizationState: 'UNKNOWN', healthStatus: 'UNKNOWN' };
  if (status === 'error' || status === 'failed') return { status: 'ERROR', authorizationState: 'UNKNOWN', healthStatus: 'ERROR' };
  if (status === 'disconnected' || status === 'not_connected') return { status: 'DISCONNECTED', authorizationState: 'NOT_AUTHORIZED', healthStatus: 'DISCONNECTED' };
  return { status: 'AUTHORIZATION_REQUIRED', authorizationState: 'UNKNOWN', healthStatus: 'UNKNOWN' };
}

function registeredProviderKey(value: string) {
  const key = canonicalProviderKey(value);
  return isProviderRegistered(key) ? key : 'custom';
}

function sanitizeProviderValue(value: unknown, key?: string): unknown {
  const secretKey = /(token|secret|password|credential|private.?key|api.?key)/i;
  if (key && secretKey.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((entry) => sanitizeProviderValue(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [entryKey, sanitizeProviderValue(entry, entryKey)]));
  }
  return value;
}

function sanitizeProviderMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeProviderValue(value) as Record<string, unknown>;
}

/** Synchronizes a legacy OAuth/platform record into the canonical layer. */
export async function upsertLegacyPlatformControlConnection(input: {
  workspaceId: string;
  platformId: string;
  integrationKey: string | null;
  name: string;
  category: string;
  connectionStatus: string;
  externalAccountId: string | null;
  grantedScopes: string[];
  lastSyncedAt?: string | null;
  lastError?: string | null;
  credentialReference?: string | null;
}, client?: PoolClient) {
  const providerKey = registeredProviderKey(input.integrationKey ?? 'custom');
  const state = legacyConnectionStatus(input.connectionStatus);
  const { rows } = await query<{ id: string }>(`INSERT INTO provider_connections(scope_type,workspace_id,provider_key,mode,status,authorization_state,credential_ref,source_type,source_id,external_account_id,granted_scopes,metadata,health_status,last_success_at,last_error,created_at,updated_at) VALUES('WORKSPACE',$1,$2,'CUSTOMER_OWNED',$3,$4,$5,'workspace_platform',$6,$7,$8,$9::jsonb,$10,$11,$12,NOW(),NOW()) ON CONFLICT(source_type,source_id) DO UPDATE SET provider_key=EXCLUDED.provider_key, status=EXCLUDED.status, authorization_state=EXCLUDED.authorization_state, credential_ref=COALESCE(EXCLUDED.credential_ref,provider_connections.credential_ref), external_account_id=EXCLUDED.external_account_id, granted_scopes=EXCLUDED.granted_scopes, metadata=EXCLUDED.metadata, health_status=EXCLUDED.health_status, last_success_at=EXCLUDED.last_success_at, last_error=EXCLUDED.last_error, updated_at=NOW() RETURNING id`, [input.workspaceId, providerKey, state.status, state.authorizationState, input.credentialReference ?? null, input.platformId, input.externalAccountId, input.grantedScopes, JSON.stringify({ legacyPlatformId: input.platformId, integrationKey: input.integrationKey, name: input.name, category: input.category }), state.healthStatus, input.lastSyncedAt ?? null, input.lastError ?? null], client);
  const connectionId = rows[0]?.id;
  if (!connectionId) throw new Error('Provider control connection upsert did not return an id');
  if (input.externalAccountId) {
    const account = await query<{ id: string }>(`INSERT INTO provider_accounts(provider_connection_id,provider_key,external_account_id,name,account_type,status,metadata,last_synced_at) VALUES($1,$2,$3,$4,'legacy_connection',$5,$6::jsonb,$7) ON CONFLICT(provider_connection_id,external_account_id) DO UPDATE SET provider_key=EXCLUDED.provider_key,name=EXCLUDED.name,status=EXCLUDED.status,metadata=EXCLUDED.metadata,last_synced_at=EXCLUDED.last_synced_at,updated_at=NOW() RETURNING id`, [connectionId, providerKey, input.externalAccountId, input.name, state.status === 'CONNECTED' ? 'CONNECTED' : 'UNKNOWN', JSON.stringify({ legacyPlatformId: input.platformId, category: input.category }), input.lastSyncedAt ?? null], client);
    const accountId = account.rows[0]?.id;
    if (accountId) await query(`INSERT INTO provider_assets(provider_account_id,provider_key,asset_type,external_asset_id,display_name,status,metadata,last_synced_at) VALUES($1,$2,'legacy_workspace_platform',$3,$4,$5,$6::jsonb,$7) ON CONFLICT(provider_account_id,asset_type,external_asset_id) DO UPDATE SET display_name=EXCLUDED.display_name,status=EXCLUDED.status,metadata=EXCLUDED.metadata,last_synced_at=EXCLUDED.last_synced_at,updated_at=NOW()`, [accountId, providerKey, `legacy:${input.platformId}`, input.name, state.status === 'CONNECTED' ? 'CONNECTED' : 'UNKNOWN', JSON.stringify({ legacyPlatformId: input.platformId }), input.lastSyncedAt ?? null], client);
  }
  return connectionId;
}

export async function upsertLuluManagedControlConnection(input: {
  sourceId: string;
  provider: string;
  displayName: string;
  externalAccountId: string | null;
  grantedScopes: string[];
  status: string;
  settings: Record<string, unknown>;
  connectedBy?: string | null;
  credentialReference?: string | null;
}, client?: PoolClient) {
  const providerKey = registeredProviderKey(input.provider);
  const state = legacyConnectionStatus(input.status);
  const safeSettings = sanitizeProviderMetadata(input.settings);
  const { rows } = await query<{ id: string }>(`INSERT INTO provider_connections(scope_type,provider_key,mode,status,authorization_state,credential_ref,source_type,source_id,external_account_id,granted_scopes,metadata,health_status,last_error,created_by) VALUES('LULU_PLATFORM',$1,'LULU_MANAGED',$2,$3,$4,'lulu_managed_oauth',$5,$6,$7,$8::jsonb,$9,NULL,$10) ON CONFLICT(source_type,source_id) DO UPDATE SET provider_key=EXCLUDED.provider_key,status=EXCLUDED.status,authorization_state=EXCLUDED.authorization_state,credential_ref=COALESCE(EXCLUDED.credential_ref,provider_connections.credential_ref),external_account_id=EXCLUDED.external_account_id,granted_scopes=EXCLUDED.granted_scopes,metadata=EXCLUDED.metadata,health_status=EXCLUDED.health_status,created_by=EXCLUDED.created_by,updated_at=NOW() RETURNING id`, [providerKey, state.status, state.authorizationState, input.credentialReference ?? null, input.sourceId, input.externalAccountId, input.grantedScopes, JSON.stringify({ displayName: input.displayName, settings: safeSettings }), state.healthStatus, input.connectedBy ?? null], client);
  const connectionId = rows[0]?.id;
  if (!connectionId) throw new Error('Lulu-managed provider connection upsert did not return an id');
  if (input.externalAccountId) await query(`INSERT INTO provider_accounts(provider_connection_id,provider_key,external_account_id,name,account_type,status,metadata) VALUES($1,$2,$3,$4,'managed_connection',$5,$6::jsonb) ON CONFLICT(provider_connection_id,external_account_id) DO UPDATE SET name=EXCLUDED.name,status=EXCLUDED.status,metadata=EXCLUDED.metadata,updated_at=NOW()`, [connectionId, providerKey, input.externalAccountId, input.displayName, state.status === 'CONNECTED' ? 'CONNECTED' : 'UNKNOWN', JSON.stringify(safeSettings)], client);
  return connectionId;
}

/** Keeps the canonical control-plane record in sync when a platform-scoped
 * legacy OAuth connection is removed by an administrator. */
export async function disconnectLuluManagedControlConnection(sourceId: string) {
  const { rowCount } = await query(
    `UPDATE provider_connections
        SET status='DISCONNECTED',
            authorization_state='NOT_AUTHORIZED',
            health_status='DISCONNECTED',
            health_reason='Disconnected by Lulu administrator',
            credential_ref=NULL,
            updated_at=NOW()
      WHERE source_type='lulu_managed_oauth' AND source_id=$1`,
    [sourceId],
  );
  return Boolean(rowCount);
}

export async function upsertLegacyAccountControlConnection(input: {
  workspaceId: string;
  sourceType: 'email_account' | 'calendar_account';
  sourceId: string;
  provider: string;
  externalAccountId: string | null;
  displayName: string;
  status: string;
  metadata?: Record<string, unknown>;
  lastSyncedAt?: string | null;
  lastError?: string | null;
  connectedBy?: string | null;
  credentialReference?: string | null;
}, client?: PoolClient) {
  const providerKey = registeredProviderKey(input.provider === 'google' && input.sourceType === 'email_account' ? 'gmail' : input.provider === 'microsoft' && input.sourceType === 'email_account' ? 'microsoft_email' : input.provider === 'google' && input.sourceType === 'calendar_account' ? 'google_calendar' : input.provider === 'microsoft' && input.sourceType === 'calendar_account' ? 'microsoft_calendar' : input.provider);
  const state = legacyConnectionStatus(input.status);
  const safeMetadata = sanitizeProviderMetadata(input.metadata ?? { displayName: input.displayName, provider: input.provider });
  const { rows } = await query<{ id: string }>(`INSERT INTO provider_connections(scope_type,workspace_id,provider_key,mode,status,authorization_state,credential_ref,source_type,source_id,external_account_id,metadata,health_status,last_success_at,last_error,created_by) VALUES('WORKSPACE',$1,$2,'CUSTOMER_OWNED',$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13) ON CONFLICT(source_type,source_id) DO UPDATE SET provider_key=EXCLUDED.provider_key,status=EXCLUDED.status,authorization_state=EXCLUDED.authorization_state,credential_ref=COALESCE(EXCLUDED.credential_ref,provider_connections.credential_ref),external_account_id=EXCLUDED.external_account_id,metadata=EXCLUDED.metadata,health_status=EXCLUDED.health_status,last_success_at=EXCLUDED.last_success_at,last_error=EXCLUDED.last_error,created_by=EXCLUDED.created_by,updated_at=NOW() RETURNING id`, [input.workspaceId, providerKey, state.status, state.authorizationState, input.credentialReference ?? null, input.sourceType, input.sourceId, input.externalAccountId, JSON.stringify(safeMetadata), state.healthStatus, input.lastSyncedAt ?? null, input.lastError ?? null, input.connectedBy ?? null], client);
  const connectionId = rows[0]?.id;
  if (!connectionId) throw new Error('Provider account connection upsert did not return an id');
  if (input.externalAccountId) {
    const account = await query<{ id: string }>(`INSERT INTO provider_accounts(provider_connection_id,provider_key,external_account_id,name,account_type,status,metadata,last_synced_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(provider_connection_id,external_account_id) DO UPDATE SET name=EXCLUDED.name,status=EXCLUDED.status,metadata=EXCLUDED.metadata,last_synced_at=EXCLUDED.last_synced_at,updated_at=NOW() RETURNING id`, [connectionId, providerKey, input.externalAccountId, input.displayName, input.sourceType === 'email_account' ? 'mailbox' : 'calendar', state.status === 'CONNECTED' ? 'CONNECTED' : 'UNKNOWN', JSON.stringify(safeMetadata), input.lastSyncedAt ?? null], client);
    const accountId = account.rows[0]?.id;
    if (accountId) await query(`INSERT INTO provider_assets(provider_account_id,provider_key,asset_type,external_asset_id,display_name,status,metadata,last_synced_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(provider_account_id,asset_type,external_asset_id) DO UPDATE SET display_name=EXCLUDED.display_name,status=EXCLUDED.status,metadata=EXCLUDED.metadata,last_synced_at=EXCLUDED.last_synced_at,updated_at=NOW()`, [accountId, providerKey, input.sourceType === 'email_account' ? 'mailbox' : 'calendar', input.externalAccountId, input.displayName, state.status === 'CONNECTED' ? 'CONNECTED' : 'UNKNOWN', JSON.stringify(safeMetadata), input.lastSyncedAt ?? null], client);
  }
  return connectionId;
}

export async function syncLegacyControlStatus(input: { sourceType: 'workspace_platform' | 'email_account' | 'calendar_account'; sourceId: string; status: string; lastSyncedAt?: string | null; lastError?: string | null }) {
  const state = legacyConnectionStatus(input.status);
  await query(`UPDATE provider_connections SET status=$3, authorization_state=$4, health_status=$5, last_success_at=COALESCE($6,last_success_at), last_error=$7, updated_at=NOW() WHERE source_type=$1 AND source_id=$2`, [input.sourceType, input.sourceId, state.status, state.authorizationState, state.healthStatus, input.lastSyncedAt ?? null, input.lastError ?? null]);
}

async function rowsForConnections(connectionRows: Array<Record<string, unknown>>, client?: PoolClient): Promise<ProviderConnection[]> {
  if (connectionRows.length === 0) return [];
  const ids = connectionRows.map((row) => String(row.id));
  const accounts = (await query<Record<string, unknown>>(`
    SELECT id, provider_connection_id AS "providerConnectionId", provider_key AS "providerKey",
           external_account_id AS "externalAccountId", name, account_type AS "accountType", status,
           currency, timezone, country, metadata, last_synced_at AS "lastSyncedAt"
      FROM provider_accounts
     WHERE provider_connection_id = ANY($1::uuid[])
     ORDER BY created_at
  `, [ids], client)).rows;
  const accountIds = accounts.map((row) => String(row.id));
  const assets = accountIds.length === 0 ? [] : (await query<Record<string, unknown>>(`
    SELECT id, provider_account_id AS "providerAccountId", provider_key AS "providerKey",
           asset_type AS "assetType", external_asset_id AS "externalAssetId", display_name AS "displayName",
           status, capabilities, metadata, last_synced_at AS "lastSyncedAt"
      FROM provider_assets
     WHERE provider_account_id = ANY($1::uuid[])
     ORDER BY created_at
  `, [accountIds], client)).rows;
  const capabilities = (await query<Record<string, unknown>>(`
    SELECT id, provider_connection_id AS "providerConnectionId", capability_key AS "capabilityKey",
           status, source, granted_scopes AS "grantedScopes", last_checked_at AS "lastCheckedAt", last_error AS "lastError"
      FROM provider_capability_states
     WHERE provider_connection_id = ANY($1::uuid[])
     ORDER BY capability_key
  `, [ids], client)).rows;
  const providerKeys = [...new Set(connectionRows.map((row) => String(row.providerKey)))];
  const definitions = providerKeys.length === 0 ? [] : (await query<Record<string, unknown>>(`
    SELECT provider_key AS "providerKey", capability_key AS "capabilityKey",
           display_name AS "displayName", default_status AS "defaultStatus"
      FROM provider_capability_definitions
     WHERE provider_key = ANY($1::text[])
     ORDER BY provider_key, capability_key
  `, [providerKeys], client)).rows;
  const syncStates = (await query<Record<string, unknown>>(`
    SELECT id, provider_connection_id AS "providerConnectionId", subject_type AS "subjectType", subject_id AS "subjectId",
           sync_type AS "syncType", cursor, status, last_success_at AS "lastSuccessAt", last_attempt_at AS "lastAttemptAt",
           last_error AS "lastError", retry_count AS "retryCount"
      FROM provider_sync_states
     WHERE provider_connection_id = ANY($1::uuid[])
     ORDER BY last_attempt_at DESC NULLS LAST
  `, [ids], client)).rows;

  return connectionRows.map((row) => {
    const connectionId = String(row.id);
    const connectionAccounts = accounts.filter((account) => String(account.providerConnectionId) === connectionId).map((account) => ({
      id: String(account.id), providerKey: String(account.providerKey), externalAccountId: String(account.externalAccountId),
      name: account.name == null ? null : String(account.name), accountType: account.accountType == null ? null : String(account.accountType),
      status: String(account.status), currency: account.currency == null ? null : String(account.currency), timezone: account.timezone == null ? null : String(account.timezone), country: account.country == null ? null : String(account.country),
      metadata: sanitizeProviderMetadata((account.metadata ?? {}) as Record<string, unknown>), lastSyncedAt: account.lastSyncedAt == null ? null : String(account.lastSyncedAt),
      assets: assets.filter((asset) => String(asset.providerAccountId) === String(account.id)).map((asset) => ({
        id: String(asset.id), providerKey: String(asset.providerKey), assetType: String(asset.assetType), externalAssetId: String(asset.externalAssetId), displayName: asset.displayName == null ? null : String(asset.displayName), status: String(asset.status), capabilities: (asset.capabilities ?? {}) as Record<string, unknown>, metadata: sanitizeProviderMetadata((asset.metadata ?? {}) as Record<string, unknown>), lastSyncedAt: asset.lastSyncedAt == null ? null : String(asset.lastSyncedAt),
      })),
    }));
    return {
      id: connectionId, scopeType: String(row.scopeType) as ProviderScopeType, workspaceId: row.workspaceId == null ? null : String(row.workspaceId), organizationId: row.organizationId == null ? null : String(row.organizationId), providerKey: String(row.providerKey), displayName: String(row.displayName), mode: String(row.mode) as ProviderMode, status: String(row.status) as ProviderConnectionStatus, authorizationState: String(row.authorizationState), externalAccountId: row.externalAccountId == null ? null : String(row.externalAccountId), grantedScopes: Array.isArray(row.grantedScopes) ? row.grantedScopes.map(String) : [], hasCredentialReference: Boolean(row.hasCredentialReference), sourceType: row.sourceType == null ? null : String(row.sourceType), sourceId: row.sourceId == null ? null : String(row.sourceId), sharedGrantedCapabilities: Array.isArray(row.sharedGrantedCapabilities) ? row.sharedGrantedCapabilities.map(String) : null, healthStatus: String(row.healthStatus) as ProviderHealthStatus, healthReason: row.healthReason == null ? null : String(row.healthReason), lastVerifiedAt: row.lastVerifiedAt == null ? null : String(row.lastVerifiedAt), lastSuccessAt: row.lastSuccessAt == null ? null : String(row.lastSuccessAt), lastWebhookAt: row.lastWebhookAt == null ? null : String(row.lastWebhookAt), rateLimitResetAt: row.rateLimitResetAt == null ? null : String(row.rateLimitResetAt), consecutiveFailures: Number(row.consecutiveFailures ?? 0), lastError: row.lastError == null ? null : String(row.lastError), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt), accounts: connectionAccounts,
      capabilities: (() => {
        const states = capabilities.filter((capability) => String(capability.providerConnectionId) === connectionId).map((capability) => ({ id: String(capability.id), capabilityKey: String(capability.capabilityKey), status: String(capability.status) as ProviderCapabilityStatus, source: String(capability.source), grantedScopes: Array.isArray(capability.grantedScopes) ? capability.grantedScopes.map(String) : [], lastCheckedAt: capability.lastCheckedAt == null ? null : String(capability.lastCheckedAt), lastError: capability.lastError == null ? null : String(capability.lastError) }));
        const known = new Set(states.map((state) => state.capabilityKey));
        for (const definition of definitions.filter((item) => String(item.providerKey) === String(row.providerKey))) {
          const capabilityKey = String(definition.capabilityKey);
          if (known.has(capabilityKey)) continue;
          states.push({ id: `definition:${String(row.providerKey)}:${capabilityKey}`, capabilityKey, status: String(definition.defaultStatus) as ProviderCapabilityStatus, source: 'REGISTRY', grantedScopes: [], lastCheckedAt: null, lastError: null });
        }
        return states;
      })(),
      syncStates: syncStates.filter((sync) => String(sync.providerConnectionId) === connectionId).map((sync) => ({ id: String(sync.id), subjectType: String(sync.subjectType), subjectId: String(sync.subjectId), syncType: String(sync.syncType), cursor: sync.cursor == null ? null : String(sync.cursor), status: String(sync.status) as ProviderSyncStatus, lastSuccessAt: sync.lastSuccessAt == null ? null : String(sync.lastSuccessAt), lastAttemptAt: sync.lastAttemptAt == null ? null : String(sync.lastAttemptAt), lastError: sync.lastError == null ? null : String(sync.lastError), retryCount: Number(sync.retryCount ?? 0) })),
    };
  });
}

export async function listProviderConnections(workspaceId: string) {
  const { rows } = await query<Record<string, unknown>>(`SELECT ${connectionSelect}, access.granted_capabilities AS "sharedGrantedCapabilities" FROM provider_connections c JOIN provider_registry r ON r.provider_key=c.provider_key LEFT JOIN provider_connection_workspace_access access ON access.provider_connection_id=c.id AND access.workspace_id=$1 AND access.access_status='ACTIVE' WHERE c.workspace_id=$1 OR access.provider_connection_id IS NOT NULL ORDER BY c.updated_at DESC`, [workspaceId]);
  return rowsForConnections(rows);
}

export async function grantProviderConnectionAccess(input: { providerConnectionId: string; workspaceId: string; grantedBy: string; grantedCapabilities: string[] }) {
  const connection = await getProviderConnectionInternal(input.providerConnectionId);
  if (!connection || String(connection.scopeType) === 'WORKSPACE') throw providerError('PROVIDER_SHARED_ACCESS_INVALID', 'Only shared provider connections can be granted to a workspace', undefined, 409);
  const { rows } = await query<Record<string, unknown>>(
    `INSERT INTO provider_connection_workspace_access(provider_connection_id,workspace_id,access_status,granted_capabilities,granted_by)
     VALUES($1,$2,'ACTIVE',$3,$4)
     ON CONFLICT(provider_connection_id,workspace_id) DO UPDATE SET access_status='ACTIVE', granted_capabilities=EXCLUDED.granted_capabilities, granted_by=EXCLUDED.granted_by, updated_at=NOW()
     RETURNING provider_connection_id AS "providerConnectionId", workspace_id AS "workspaceId", access_status AS "accessStatus", granted_capabilities AS "grantedCapabilities", granted_by AS "grantedBy"`,
    [input.providerConnectionId, input.workspaceId, input.grantedCapabilities, input.grantedBy],
  );
  return rows[0] ?? null;
}

export async function revokeProviderConnectionAccess(providerConnectionId: string, workspaceId: string) {
  const { rows } = await query<Record<string, unknown>>(
    `UPDATE provider_connection_workspace_access SET access_status='REVOKED', updated_at=NOW()
      WHERE provider_connection_id=$1 AND workspace_id=$2
      RETURNING provider_connection_id AS "providerConnectionId", workspace_id AS "workspaceId", access_status AS "accessStatus"`,
    [providerConnectionId, workspaceId],
  );
  return rows[0] ?? null;
}

export async function getProviderConnection(workspaceId: string, connectionId: string) {
  const { rows } = await query<Record<string, unknown>>(`SELECT ${connectionSelect}, access.granted_capabilities AS "sharedGrantedCapabilities" FROM provider_connections c JOIN provider_registry r ON r.provider_key=c.provider_key LEFT JOIN provider_connection_workspace_access access ON access.provider_connection_id=c.id AND access.workspace_id=$1 AND access.access_status='ACTIVE' WHERE c.id=$2 AND (c.workspace_id=$1 OR access.provider_connection_id IS NOT NULL)`, [workspaceId, connectionId]);
  return (await rowsForConnections(rows))[0] ?? null;
}

/** Returns the connection only when it is owned by, or explicitly shared with,
 * the workspace. Shared platform resources must never be treated as owned
 * merely because their UUID is known. */
async function getAccessibleConnection(workspaceId: string, connectionId: string, client?: PoolClient) {
  const { rows } = await query<{ id: string; workspaceId: string | null; scopeType: ProviderScopeType; providerKey: string; status: string; grantedCapabilities: string[] | null }>(
    `SELECT c.id, c.workspace_id AS "workspaceId", c.scope_type AS "scopeType", c.provider_key AS "providerKey", c.status,
            access.granted_capabilities AS "grantedCapabilities"
       FROM provider_connections c
       LEFT JOIN provider_connection_workspace_access access
         ON access.provider_connection_id=c.id
        AND access.workspace_id=$1
        AND access.access_status='ACTIVE'
      WHERE c.id=$2
        AND (c.workspace_id=$1 OR access.provider_connection_id IS NOT NULL)
      LIMIT 1`,
    [workspaceId, connectionId],
    client,
  );
  return rows[0] ?? null;
}

export async function getProviderConnectionInternal(connectionId: string, client?: PoolClient) {
  const { rows } = await query<Record<string, unknown>>(`SELECT ${connectionSelect}, c.credential_ref AS "credentialRef", c.granted_scopes AS "grantedScopesRaw", c.metadata AS "metadataRaw" FROM provider_connections c JOIN provider_registry r ON r.provider_key=c.provider_key WHERE c.id=$1`, [connectionId], client);
  return rows[0] ?? null;
}

export async function listProviderCatalog() {
  const registry = (await query<Record<string, unknown>>(`SELECT provider_key AS "providerKey", display_name AS "displayName", category, implementation_status AS "implementationStatus", default_mode AS "defaultMode" FROM provider_registry ORDER BY category, display_name`)).rows;
  const capabilities = (await query<Record<string, unknown>>(`SELECT provider_key AS "providerKey", capability_key AS "capabilityKey", display_name AS "displayName", required_scopes AS "requiredScopes", default_status AS "defaultStatus" FROM provider_capability_definitions ORDER BY provider_key, capability_key`)).rows;
  return registry.map((entry) => ({ ...entry, capabilities: capabilities.filter((capability) => capability.providerKey === entry.providerKey) }));
}

export async function listAdminProviderConnections() {
  const { rows } = await query<Record<string, unknown>>(`SELECT ${connectionSelect}, w.name AS "workspaceName", r.display_name AS "providerDisplayName" FROM provider_connections c JOIN provider_registry r ON r.provider_key=c.provider_key LEFT JOIN workspaces w ON w.id=c.workspace_id WHERE c.scope_type <> 'WORKSPACE' OR c.workspace_id IS NOT NULL ORDER BY c.updated_at DESC`);
  return rows.map((row) => ({ ...row, hasCredentialReference: Boolean(row.hasCredentialReference) }));
}

export async function updateConnectionVerification(input: { workspaceId: string; connectionId: string; status: ProviderConnectionStatus; authorizationState: string; healthStatus: ProviderHealthStatus; healthReason: string; lastVerifiedAt: Date; lastSuccessAt?: Date | null; lastError?: string | null }) {
  const { rows } = await query<Record<string, unknown>>(`UPDATE provider_connections SET status=$3, authorization_state=$4, health_status=$5, health_reason=$6, last_verified_at=$7, last_success_at=COALESCE($8,last_success_at), last_error=$9, consecutive_failures=CASE WHEN $5 IN ('ERROR','DEGRADED') THEN consecutive_failures+1 ELSE 0 END, updated_at=NOW() WHERE workspace_id=$1 AND id=$2 RETURNING id`, [input.workspaceId, input.connectionId, input.status, input.authorizationState, input.healthStatus, input.healthReason.slice(0, 500), input.lastVerifiedAt, input.lastSuccessAt ?? null, input.lastError ?? null]);
  return Boolean(rows[0]);
}

export async function updateConnectionMode(workspaceId: string, connectionId: string, mode: ProviderMode) {
  const { rows } = await query<Record<string, unknown>>(`UPDATE provider_connections SET mode=$3, updated_at=NOW() WHERE workspace_id=$1 AND id=$2 RETURNING id`, [workspaceId, connectionId, mode]);
  return Boolean(rows[0]);
}

export async function disconnectConnection(workspaceId: string, connectionId: string) {
  return withTransaction(async (client) => {
    const row = await getProviderConnectionInternal(connectionId, client);
    if (!row || String(row.workspaceId) !== workspaceId) return false;
    await query(`UPDATE provider_connections SET status='DISCONNECTED', authorization_state='NOT_AUTHORIZED', health_status='DISCONNECTED', health_reason='Disconnected by workspace administrator', updated_at=NOW() WHERE id=$1`, [connectionId], client);
    const sourceType = row.sourceType == null ? null : String(row.sourceType);
    const sourceId = row.sourceId == null ? null : String(row.sourceId);
    if (sourceType === 'workspace_platform' && sourceId) await query(`UPDATE workspace_platforms SET connection_status='disconnected', last_error=NULL, updated_at=NOW() WHERE id=$1 AND workspace_id=$2`, [sourceId, workspaceId], client);
    if (sourceType === 'email_account' && sourceId) await query(`UPDATE email_accounts SET status='disconnected', updated_at=NOW() WHERE id=$1 AND workspace_id=$2`, [sourceId, workspaceId], client);
    if (sourceType === 'calendar_account' && sourceId) await query(`UPDATE calendar_accounts SET status='disconnected', updated_at=NOW() WHERE id=$1 AND workspace_id=$2`, [sourceId, workspaceId], client);
    await appendDomainEvent({ workspaceId, type: 'provider.connection.disconnected', aggregateType: 'provider_connection', aggregateId: connectionId, payload: { providerKey: String(row.providerKey), sourceType }, metadata: { source: 'provider_control_plane' } }, client);
    return true;
  });
}

export async function upsertCapabilityState(input: { connectionId: string; subjectType: 'CONNECTION' | 'ACCOUNT' | 'ASSET'; subjectId: string; capabilityKey: string; status: ProviderCapabilityStatus; source: string; grantedScopes: string[]; reason?: string | null }) {
  const { rows } = await query<Record<string, unknown>>(`INSERT INTO provider_capability_states (provider_connection_id,subject_type,subject_id,capability_key,status,source,granted_scopes,last_checked_at,last_error) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8) ON CONFLICT (provider_connection_id,subject_type,subject_id,capability_key) DO UPDATE SET status=EXCLUDED.status, source=EXCLUDED.source, granted_scopes=EXCLUDED.granted_scopes, last_checked_at=NOW(), last_error=EXCLUDED.last_error, updated_at=NOW() RETURNING id`, [input.connectionId, input.subjectType, input.subjectId, input.capabilityKey, input.status, input.source, input.grantedScopes, input.reason ?? null]);
  return rows[0]?.id ? String(rows[0].id) : null;
}

export async function listCapabilityDefinitions(providerKey: string) {
  const { rows } = await query<Record<string, unknown>>(`SELECT capability_key AS "capabilityKey", required_scopes AS "requiredScopes", default_status AS "defaultStatus" FROM provider_capability_definitions WHERE provider_key=$1 ORDER BY capability_key`, [providerKey]);
  return rows;
}

export async function createSyncState(connectionId: string, subjectType: 'CONNECTION' | 'ACCOUNT' | 'ASSET', subjectId: string, syncType: string) {
  const { rows } = await query<Record<string, unknown>>(`INSERT INTO provider_sync_states(provider_connection_id,subject_type,subject_id,sync_type,status,last_attempt_at) VALUES($1,$2,$3,$4,'RUNNING',NOW()) ON CONFLICT (provider_connection_id,subject_type,subject_id,sync_type) DO UPDATE SET status='RUNNING', last_attempt_at=NOW(), last_error=NULL, retry_count=provider_sync_states.retry_count+1, updated_at=NOW() RETURNING id, status`, [connectionId, subjectType, subjectId, syncType]);
  return rows[0] ?? null;
}

export async function queueProviderSync(workspaceId: string, connectionId: string, requestedBy: string, syncType = 'full') {
  return withTransaction(async (client) => {
    const connection = await getAccessibleConnection(workspaceId, connectionId, client);
    if (!connection) return null;
    if (String(connection.status) === 'DISCONNECTED') throw providerError('PROVIDER_CONNECTION_DISCONNECTED', 'This provider connection is disconnected', undefined, 409);
    // Serialize the lookup and insert for one connection/sync type. This is
    // safer than relying on a cleanup-sensitive partial unique index and keeps
    // retries idempotent when two users click Sync at the same time.
    await query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`provider.sync:${connectionId}:${syncType}`], client);
    const existing = await query<{ id: string; status: 'queued' | 'running' }>(
      `SELECT id, status
         FROM background_jobs
        WHERE job_type='provider.sync'
          AND status IN ('queued','running')
          AND payload->>'providerConnectionId'=$1
          AND payload->>'syncType'=$2
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE`,
      [connectionId, syncType],
      client,
    );
    if (existing.rows[0]) {
      return {
        jobId: existing.rows[0].id,
        connectionId,
        providerKey: String(connection.providerKey),
        syncType,
        status: existing.rows[0].status === 'queued' ? 'QUEUED' as const : 'RUNNING' as const,
        deduplicated: true as const,
      };
    }
    const job = await query<{ id: string }>(`INSERT INTO background_jobs(workspace_id,job_type,payload) VALUES($1,'provider.sync',$2::jsonb) RETURNING id`, [workspaceId, JSON.stringify({ providerConnectionId: connectionId, syncType })], client);
    await query(`INSERT INTO provider_sync_states(provider_connection_id,subject_type,subject_id,sync_type,status,last_attempt_at) VALUES($1,'CONNECTION',$1,$2,'RUNNING',NOW()) ON CONFLICT (provider_connection_id,subject_type,subject_id,sync_type) DO UPDATE SET status='RUNNING',last_attempt_at=NOW(),last_error=NULL,updated_at=NOW()`, [connectionId, syncType], client);
    await appendDomainEvent({ workspaceId, type: 'provider.sync.started', aggregateType: 'provider_connection', aggregateId: connectionId, payload: { providerKey: String(connection.providerKey), syncType, jobId: job.rows[0]?.id }, metadata: { actorId: requestedBy, source: 'provider_control_plane' }, idempotencyKey: `provider-sync:${connectionId}:${syncType}:${job.rows[0]?.id}` }, client);
    return { jobId: job.rows[0]?.id, connectionId, providerKey: String(connection.providerKey), syncType, status: 'RUNNING' as const, deduplicated: false as const };
  });
}

export type ProviderSyncJob = {
  id: string;
  workspaceId: string;
  providerConnectionId: string;
  syncType: string;
  attempts: number;
};

export async function claimNextProviderSyncJob(workerId: string, leaseSeconds: number, maxAttempts: number) {
  return withTransaction(async (client) => {
    await query(
      `UPDATE background_jobs
          SET status='failed', completed_at=NOW(), error_message='Provider sync exceeded the retry limit', worker_id=NULL, heartbeat_at=NULL
        WHERE job_type='provider.sync'
          AND status IN ('queued','running')
          AND attempts >= max_attempts
          AND (status='queued' OR started_at < NOW() - ($1::integer * INTERVAL '1 second'))`,
      [leaseSeconds],
      client,
    );
    const { rows } = await query<ProviderSyncJob>(
      `WITH candidate AS (
         SELECT id
           FROM background_jobs
          WHERE job_type='provider.sync'
            AND attempts < LEAST(max_attempts, $2::integer)
            AND (
              (status='queued' AND scheduled_at <= NOW())
              OR (status='running' AND COALESCE(heartbeat_at, started_at, updated_at) < NOW() - ($1::integer * INTERVAL '1 second'))
            )
          ORDER BY scheduled_at ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE background_jobs job
          SET status='running', attempts=job.attempts+1, started_at=NOW(), heartbeat_at=NOW(), worker_id=$3, completed_at=NULL, error_message=NULL, updated_at=NOW()
         FROM candidate
        WHERE job.id=candidate.id
        RETURNING job.id, job.workspace_id AS "workspaceId", job.payload->>'providerConnectionId' AS "providerConnectionId", job.payload->>'syncType' AS "syncType", job.attempts`,
      [leaseSeconds, maxAttempts, workerId],
      client,
    );
    const job = rows[0];
    if (!job) return null;
    await query(
      `UPDATE provider_sync_states
          SET status='RUNNING', last_attempt_at=NOW(), last_error=NULL, updated_at=NOW()
        WHERE provider_connection_id=$1 AND subject_type='CONNECTION' AND subject_id=$1 AND sync_type=$2`,
      [job.providerConnectionId, job.syncType],
      client,
    );
    return job;
  });
}

export async function heartbeatProviderSyncJob(jobId: string, workerId: string) {
  await query(`UPDATE background_jobs SET heartbeat_at=NOW(), updated_at=NOW() WHERE id=$1 AND job_type='provider.sync' AND worker_id=$2 AND status='running'`, [jobId, workerId]);
}

export async function finishProviderSyncJob(input: { job: ProviderSyncJob; workerId: string; status: 'succeeded' | 'failed'; errorMessage?: string | null }) {
  await query(
    `UPDATE background_jobs
        SET status=$4, completed_at=NOW(), heartbeat_at=NULL, worker_id=NULL, error_message=$5, updated_at=NOW()
      WHERE id=$1 AND job_type='provider.sync' AND worker_id=$2 AND status='running' AND workspace_id=$3`,
    [input.job.id, input.workerId, input.job.workspaceId, input.status, input.errorMessage ? input.errorMessage.slice(0, 1_000) : null],
  );
}

export async function finishProviderSyncState(input: { connectionId: string; syncType: string; status: ProviderSyncStatus; cursor?: string | null; error?: string | null }) {
  await query(
    `UPDATE provider_sync_states
        SET status=$3, cursor=COALESCE($4,cursor), last_success_at=CASE WHEN $3 IN ('SUCCESS','PARTIAL') THEN NOW() ELSE last_success_at END, last_error=$5, updated_at=NOW()
      WHERE provider_connection_id=$1 AND subject_type='CONNECTION' AND subject_id=$1 AND sync_type=$2`,
    [input.connectionId, input.syncType, input.status, input.cursor ?? null, input.error ? input.error.slice(0, 1_000) : null],
  );
}

/** Claims a provider mutation idempotently. Retries reuse the same operation
 * row and therefore cannot create duplicate external requests accidentally. */
export async function claimProviderOperation(input: {
  workspaceId: string;
  providerConnectionId: string;
  operationKey: string;
  operationType: string;
  externalRequestId?: string | null;
}) {
  return withTransaction(async (client) => {
    const connection = await getAccessibleConnection(input.workspaceId, input.providerConnectionId, client);
    if (!connection) {
      throw providerError('PROVIDER_TENANT_SCOPE_MISMATCH', 'The provider connection does not belong to this workspace', undefined, 403);
    }
    const inserted = (await query<Record<string, unknown>>(
      `INSERT INTO provider_operations(workspace_id,provider_connection_id,operation_key,operation_type,external_request_id,status)
       VALUES($1,$2,$3,$4,$5,'PENDING')
       ON CONFLICT(provider_connection_id,operation_key) DO NOTHING
       RETURNING id, workspace_id AS "workspaceId", provider_connection_id AS "providerConnectionId",
                 operation_key AS "operationKey", operation_type AS "operationType",
                 external_request_id AS "externalRequestId", status, result_reference AS "resultReference",
                 last_error AS "lastError"`,
      [input.workspaceId, input.providerConnectionId, input.operationKey, input.operationType, input.externalRequestId ?? null],
      client,
    )).rows[0];
    if (inserted) return { created: true as const, operation: inserted };
    const existing = (await query<Record<string, unknown>>(
      `SELECT id, workspace_id AS "workspaceId", provider_connection_id AS "providerConnectionId",
              operation_key AS "operationKey", operation_type AS "operationType",
              external_request_id AS "externalRequestId", status, result_reference AS "resultReference",
              last_error AS "lastError"
         FROM provider_operations
        WHERE provider_connection_id=$1 AND operation_key=$2`,
      [input.providerConnectionId, input.operationKey],
      client,
    )).rows[0];
    if (!existing) throw new Error('Provider operation claim did not return an operation');
    return { created: false as const, operation: existing };
  });
}

export async function completeProviderOperation(input: {
  workspaceId: string;
  providerConnectionId: string;
  operationKey: string;
  status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  resultReference?: string | null;
  lastError?: string | null;
}) {
  const { rows } = await query<Record<string, unknown>>(
    `UPDATE provider_operations
        SET status=$4, result_reference=$5, last_error=$6, updated_at=NOW()
      WHERE workspace_id=$1 AND provider_connection_id=$2 AND operation_key=$3
      RETURNING id, status, result_reference AS "resultReference", last_error AS "lastError"`,
    [input.workspaceId, input.providerConnectionId, input.operationKey, input.status, input.resultReference ?? null, input.lastError ?? null],
  );
  return rows[0] ?? null;
}

export async function createObjectMapping(input: { workspaceId: string; providerConnectionId: string; providerAccountId: string; providerAssetId?: string | null; luluObjectType: string; luluObjectId: string; externalObjectType: string; externalObjectId: string; sourceOfTruth: string; }) {
  const owner = await query<{ workspaceId: string; connectionId: string; accountId: string; assetId: string | null }>(`SELECT c.workspace_id AS "workspaceId", c.id AS "connectionId", a.id AS "accountId", pa.id AS "assetId" FROM provider_accounts a JOIN provider_connections c ON c.id=a.provider_connection_id LEFT JOIN provider_assets pa ON pa.id=$4 AND pa.provider_account_id=a.id LEFT JOIN provider_connection_workspace_access access ON access.provider_connection_id=c.id AND access.workspace_id=$1 AND access.access_status='ACTIVE' WHERE c.id=$2 AND a.id=$3 AND (c.workspace_id=$1 OR access.provider_connection_id IS NOT NULL)`, [input.workspaceId, input.providerConnectionId, input.providerAccountId, input.providerAssetId ?? null]);
  if (!owner.rows[0] || (input.providerAssetId && !owner.rows[0].assetId)) throw providerError('PROVIDER_TENANT_SCOPE_MISMATCH', 'The provider account or asset does not belong to this workspace connection', undefined, 403);
  try {
    const { rows } = await query<Record<string, unknown>>(`INSERT INTO provider_object_mappings(workspace_id,provider_connection_id,provider_account_id,provider_asset_id,lulu_object_type,lulu_object_id,external_object_type,external_object_id,source_of_truth) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, workspace_id AS "workspaceId", provider_connection_id AS "providerConnectionId", provider_account_id AS "providerAccountId", provider_asset_id AS "providerAssetId", lulu_object_type AS "luluObjectType", lulu_object_id AS "luluObjectId", external_object_type AS "externalObjectType", external_object_id AS "externalObjectId", source_of_truth AS "sourceOfTruth", sync_status AS "syncStatus", last_synced_at AS "lastSyncedAt"`, [input.workspaceId, input.providerConnectionId, input.providerAccountId, input.providerAssetId ?? null, input.luluObjectType, input.luluObjectId, input.externalObjectType, input.externalObjectId, input.sourceOfTruth]);
    return rows[0];
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === '23505') throw providerError('PROVIDER_MAPPING_CONFLICT', 'This Lulu object or external object is already mapped for the provider account', undefined, 409);
    throw error;
  }
}

export async function listObjectMappings(workspaceId: string, luluObjectType?: string, luluObjectId?: string) {
  const { rows } = await query<Record<string, unknown>>(`SELECT m.id, m.workspace_id AS "workspaceId", m.provider_connection_id AS "providerConnectionId", m.provider_account_id AS "providerAccountId", m.provider_asset_id AS "providerAssetId", m.lulu_object_type AS "luluObjectType", m.lulu_object_id AS "luluObjectId", m.external_object_type AS "externalObjectType", m.external_object_id AS "externalObjectId", m.source_of_truth AS "sourceOfTruth", m.sync_status AS "syncStatus", m.last_synced_at AS "lastSyncedAt", c.provider_key AS "providerKey" FROM provider_object_mappings m JOIN provider_connections c ON c.id=m.provider_connection_id WHERE m.workspace_id=$1 AND ($2::text IS NULL OR m.lulu_object_type=$2) AND ($3::uuid IS NULL OR m.lulu_object_id=$3) ORDER BY m.updated_at DESC`, [workspaceId, luluObjectType ?? null, luluObjectId ?? null]);
  return rows;
}

export async function claimWebhookEvent(input: { providerKey: string; externalEventId: string; payloadHash: string; eventType: string; providerConnectionId?: string | null; providerAccountId?: string | null; correlationId?: string | null; normalizedMetadata?: Record<string, unknown> }) {
  return withTransaction(async (client) => {
    const connection = input.providerConnectionId ? await getProviderConnectionInternal(input.providerConnectionId, client) : null;
    if (input.providerConnectionId && (!connection || String(connection.providerKey) !== input.providerKey)) {
      throw providerError('PROVIDER_WEBHOOK_CONNECTION_INVALID', 'The webhook connection does not match the registered provider', undefined, 403);
    }
    if (input.providerAccountId) {
      const account = await query<{ id: string }>(
        `SELECT a.id
           FROM provider_accounts a
           JOIN provider_connections c ON c.id=a.provider_connection_id
          WHERE a.id=$1
            AND c.provider_key=$2
            AND ($3::uuid IS NULL OR a.provider_connection_id=$3)`,
        [input.providerAccountId, input.providerKey, input.providerConnectionId ?? null],
        client,
      );
      if (!account.rows[0]) throw providerError('PROVIDER_WEBHOOK_ACCOUNT_INVALID', 'The webhook account does not belong to the registered provider connection', undefined, 403);
    }
    const { rows } = await query<Record<string, unknown>>(`INSERT INTO provider_webhook_events(provider_key,provider_connection_id,provider_account_id,external_event_id,event_type,payload_hash,status,attempts,correlation_id,normalized_metadata) VALUES($1,$2,$3,$4,$5,$6,'RECEIVED',0,$7,$8::jsonb) ON CONFLICT (provider_key,external_event_id) DO NOTHING RETURNING id, provider_key AS "providerKey", external_event_id AS "externalEventId", event_type AS "eventType", status, attempts`, [input.providerKey, input.providerConnectionId ?? null, input.providerAccountId ?? null, input.externalEventId, input.eventType, input.payloadHash, input.correlationId ?? null, JSON.stringify(input.normalizedMetadata ?? {})], client);
    if (rows.length === 0) {
      const existing = await query<Record<string, unknown>>(`SELECT id, provider_key AS "providerKey", external_event_id AS "externalEventId", event_type AS "eventType", payload_hash AS "payloadHash", status, attempts FROM provider_webhook_events WHERE provider_key=$1 AND external_event_id=$2`, [input.providerKey, input.externalEventId], client);
      if (existing.rows[0] && String(existing.rows[0].payloadHash) !== input.payloadHash) {
        throw providerError('PROVIDER_WEBHOOK_REPLAY_CONFLICT', 'The provider reused an event ID with a different payload', undefined, 409);
      }
      return { duplicate: true as const, event: existing.rows[0] ?? null };
    }
    const inserted = rows[0];
    if (!inserted) throw new Error('Provider webhook insert did not return an event');
    const workspaceId = connection?.workspaceId == null ? null : String(connection.workspaceId);
    await appendDomainEvent({ workspaceId, type: 'provider.webhook.received', aggregateType: 'provider_webhook_event', aggregateId: String(inserted.id), payload: { providerKey: input.providerKey, externalEventId: input.externalEventId, eventType: input.eventType, providerConnectionId: input.providerConnectionId ?? null }, metadata: { source: 'provider_webhook', correlationId: input.correlationId ?? null }, idempotencyKey: `provider-webhook:${input.providerKey}:${input.externalEventId}` }, client);
    return { duplicate: false as const, event: { ...inserted, status: 'RECEIVED' } };
  });
}

export type ProviderWebhookEvent = {
  id: string;
  providerKey: string;
  providerConnectionId: string | null;
  providerAccountId: string | null;
  externalEventId: string;
  eventType: string;
  status: 'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'FAILED' | 'DEAD_LETTER' | 'IGNORED';
  attempts: number;
  correlationId: string | null;
  normalizedMetadata: Record<string, unknown>;
};

export async function claimNextProviderWebhookEvent(workerId: string, leaseSeconds: number, maxAttempts: number) {
  return withTransaction(async (client) => {
    await query(
      `UPDATE provider_webhook_events
          SET status='DEAD_LETTER', processed_at=NOW(), worker_id=NULL, locked_at=NULL,
              last_error=COALESCE(last_error,'Provider webhook exceeded the retry limit')
        WHERE status IN ('RECEIVED','FAILED','PROCESSING')
          AND attempts >= $2
          AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
          AND (status <> 'PROCESSING' OR locked_at < NOW() - ($1::integer * INTERVAL '1 second'))`,
      [leaseSeconds, maxAttempts],
      client,
    );
    const { rows } = await query<ProviderWebhookEvent>(
      `WITH candidate AS (
         SELECT id
           FROM provider_webhook_events
          WHERE attempts < $2
            AND (
              status IN ('RECEIVED','FAILED')
              OR (status='PROCESSING' AND locked_at < NOW() - ($1::integer * INTERVAL '1 second'))
            )
            AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
          ORDER BY received_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE provider_webhook_events event
          SET status='PROCESSING', attempts=event.attempts+1, worker_id=$3, locked_at=NOW(), last_error=NULL
         FROM candidate
        WHERE event.id=candidate.id
        RETURNING event.id, event.provider_key AS "providerKey", event.provider_connection_id AS "providerConnectionId",
          event.provider_account_id AS "providerAccountId", event.external_event_id AS "externalEventId",
          event.event_type AS "eventType", event.status, event.attempts, event.correlation_id AS "correlationId",
          event.normalized_metadata AS "normalizedMetadata"`,
      [leaseSeconds, maxAttempts, workerId],
      client,
    );
    return rows[0] ?? null;
  });
}

export async function markProviderWebhookProcessed(event: ProviderWebhookEvent, workerId: string, ignored = false) {
  await query(
    `UPDATE provider_webhook_events
        SET status=$4, processed_at=NOW(), worker_id=NULL, locked_at=NULL, next_attempt_at=NULL, last_error=NULL
      WHERE id=$1 AND worker_id=$2 AND status='PROCESSING' AND provider_key=$3`,
    [event.id, workerId, event.providerKey, ignored ? 'IGNORED' : 'PROCESSED'],
  );
  if (event.providerConnectionId) {
    await query(`UPDATE provider_connections SET last_webhook_at=NOW(), updated_at=NOW() WHERE id=$1`, [event.providerConnectionId]);
  }
}

export async function markProviderWebhookFailed(event: ProviderWebhookEvent, workerId: string, errorMessage: string, delayMs: number, maxAttempts: number) {
  const terminal = event.attempts >= maxAttempts;
  await query(
    `UPDATE provider_webhook_events
        SET status=CASE WHEN $4 THEN 'DEAD_LETTER' ELSE 'FAILED' END,
            processed_at=CASE WHEN $4 THEN NOW() ELSE NULL END,
            worker_id=NULL, locked_at=NULL,
            next_attempt_at=CASE WHEN $4 THEN NULL ELSE NOW() + ($5::integer * INTERVAL '1 millisecond') END,
            last_error=$3
      WHERE id=$1 AND worker_id=$2 AND status='PROCESSING'`,
    [event.id, workerId, errorMessage.slice(0, 1_000), terminal, Math.max(0, Math.floor(delayMs))],
  );
}
