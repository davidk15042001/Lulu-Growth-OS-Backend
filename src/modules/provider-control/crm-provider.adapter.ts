import { decryptSecret } from '../../utils/secret-box.js';
import { query } from '../../db/pool.js';
import { getPlatformOAuthCredential } from '../onboarding/onboarding.repo.js';
import { refreshStoredOAuthCredential } from '../onboarding/oauth.service.js';
import { AppError } from '../../utils/app-error.js';
import type {
  ProviderAdapter,
  ProviderAdapterContext,
  ProviderCapabilityStatus,
  ProviderDiscoveredAccount,
  ProviderDiscoveredAsset,
  ProviderHealthStatus,
  ProviderVerificationResult,
} from './provider.types.js';

type CrmProvider = 'salesforce' | 'hubspot' | 'pipedrive';
type CrmSettings = { instanceUrl: string | null; apiDomain: string | null };

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeHttpsOrigin(value: unknown, expectedHost: RegExp) {
  const raw = stringValue(value).replace(/\/$/, '');
  if (!raw) return null;
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    if (url.protocol !== 'https:' || !expectedHost.test(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}

function errorState(error: unknown) {
  if (error instanceof AppError && (error.status === 401 || error.code === 'CRM_NOT_CONNECTED' || error.code === 'CRM_REAUTH_REQUIRED')) return { status: 'AUTHORIZATION_REQUIRED' as const, authorizationState: 'REAUTH_REQUIRED' as const, healthStatus: 'AUTHORIZATION_REQUIRED' as const };
  if (error instanceof AppError && error.code === 'CRM_CONFIGURATION_MISSING') return { status: 'PROVIDER_REVIEW' as const, authorizationState: 'AUTHORIZED' as const, healthStatus: 'PROVIDER_REVIEW' as const };
  return { status: 'ERROR' as const, authorizationState: 'UNKNOWN' as const, healthStatus: 'ERROR' as const };
}

/** Read-only CRM provider contract shared by Salesforce, HubSpot and Pipedrive. */
export class CrmProviderAdapter implements ProviderAdapter {
  readonly runtimeFeatures = ['verification', 'health', 'capabilities', 'discovery', 'sync'] as const;

  constructor(public readonly providerKey: CrmProvider) {}

  private async settings(context: ProviderAdapterContext): Promise<CrmSettings> {
    if (!context.workspaceId) throw new AppError(400, 'CRM_WORKSPACE_REQUIRED', 'CRM provider verification requires a workspace context.');
    const platformId = stringValue(context.metadata.legacyPlatformId);
    if (!platformId) throw new AppError(503, 'CRM_CONFIGURATION_MISSING', 'The canonical CRM platform record is missing.');
    const result = await query<{ settings: unknown }>(`SELECT settings FROM workspace_platforms WHERE id=$1 AND workspace_id=$2 AND integration_key=$3 AND deleted_at IS NULL LIMIT 1`, [platformId, context.workspaceId, this.providerKey]);
    const row = result.rows[0];
    if (!row) throw new AppError(503, 'CRM_CONFIGURATION_MISSING', 'The canonical CRM platform record is missing.');
    const settings = objectValue(row.settings);
    return {
      instanceUrl: this.providerKey === 'salesforce' ? safeHttpsOrigin(settings.instanceUrl, /(^|\.)salesforce\.com$/i) : null,
      apiDomain: this.providerKey === 'pipedrive' ? safeHttpsOrigin(settings.apiDomain, /(^|\.)pipedrive\.com$/i) : null,
    };
  }

  private async token(context: ProviderAdapterContext) {
    if (!context.workspaceId) throw new AppError(400, 'CRM_WORKSPACE_REQUIRED', 'CRM provider verification requires a workspace context.');
    const credential = await getPlatformOAuthCredential(context.workspaceId, this.providerKey);
    if (!credential) throw new AppError(409, 'CRM_NOT_CONNECTED', `${this.providerKey} is not connected for this workspace.`);
    const expiresAt = credential.tokenExpiresAt ? Date.parse(credential.tokenExpiresAt) : null;
    if (expiresAt !== null && expiresAt <= Date.now() + 300_000) return refreshStoredOAuthCredential({ workspaceId: context.workspaceId, provider: this.providerKey, encryptedRefreshToken: credential.encryptedRefreshToken });
    return decryptSecret(credential.encryptedAccessToken);
  }

  private async request(context: ProviderAdapterContext, url: string) {
    const token = await this.token(context);
    let response: Response;
    try {
      response = await fetch(url, { headers: { accept: 'application/json', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      throw new AppError(502, 'CRM_NETWORK_ERROR', `${this.providerKey} did not return a definitive response.`, { cause: error instanceof Error ? error.message : String(error) });
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new AppError(response.status === 401 ? 401 : 502, response.status === 401 ? 'CRM_REAUTH_REQUIRED' : 'CRM_REQUEST_FAILED', `${this.providerKey} rejected the read-only provider check.`, { providerHttpStatus: response.status });
    return body;
  }

  private async companyProbe(context: ProviderAdapterContext) {
    const settings = await this.settings(context);
    let url: string;
    if (this.providerKey === 'salesforce') {
      if (!settings.instanceUrl) throw new AppError(503, 'CRM_CONFIGURATION_MISSING', 'Salesforce instance URL is missing.');
      url = `${settings.instanceUrl}/services/data/v61.0/query/?q=${encodeURIComponent('SELECT Id, Name FROM Account LIMIT 1')}`;
    } else if (this.providerKey === 'hubspot') {
      url = 'https://api.hubapi.com/crm/v3/objects/companies?limit=1&properties=name';
    } else {
      if (!settings.apiDomain) throw new AppError(503, 'CRM_CONFIGURATION_MISSING', 'Pipedrive API domain is missing.');
      url = `${settings.apiDomain}/api/v1/organizations?limit=1`; 
    }
    return { settings, body: await this.request(context, url) };
  }

  async verifyConnection(context: ProviderAdapterContext): Promise<ProviderVerificationResult> {
    try {
      await this.companyProbe(context);
      return { verified: true, status: 'CONNECTED', authorizationState: 'AUTHORIZED', healthStatus: 'HEALTHY', reason: `${this.providerKey} returned a real company/account read through its canonical API path.`, lastSuccessAt: new Date().toISOString() };
    } catch (error) {
      const state = errorState(error);
      return { verified: false, ...state, reason: error instanceof Error ? error.message : `${this.providerKey} verification failed.` };
    }
  }

  async getHealth(context: ProviderAdapterContext): Promise<{ status: ProviderHealthStatus; reason: string }> {
    const result = await this.verifyConnection(context);
    return { status: result.healthStatus, reason: result.reason };
  }

  async getCapabilities(context: ProviderAdapterContext) {
    const result = await this.verifyConnection(context);
    const read: ProviderCapabilityStatus = result.status === 'CONNECTED' ? 'AVAILABLE' : result.status === 'AUTHORIZATION_REQUIRED' ? 'AUTHORIZATION_REQUIRED' : result.status === 'PROVIDER_REVIEW' ? 'PROVIDER_REVIEW' : 'ERROR';
    return [{ capabilityKey: `${this.providerKey}.companies.read`, status: read, reason: result.reason }, { capabilityKey: `${this.providerKey}.companies.write`, status: read === 'AVAILABLE' ? 'PROVIDER_REVIEW' : read, reason: 'CRM mutations require a separate provider-scope and domain-service verification.' }];
  }

  async discoverAccounts(context: ProviderAdapterContext): Promise<ProviderDiscoveredAccount[]> {
    const { settings, body } = await this.companyProbe(context);
    const root = objectValue(body);
    const first = this.providerKey === 'salesforce' ? objectValue((Array.isArray(root.records) ? root.records : [])[0]) : this.providerKey === 'hubspot' ? objectValue((Array.isArray(root.results) ? root.results : [])[0]) : objectValue((Array.isArray(root.data) ? root.data : [])[0]);
    const accountId = stringValue(first.id) || context.externalAccountId || settings.instanceUrl || settings.apiDomain || `${this.providerKey}:account`;
    return [{ externalAccountId: accountId, name: stringValue(first.name) || this.providerKey, accountType: 'crm', status: 'CONNECTED', metadata: { provider: this.providerKey, companySampleAvailable: Object.keys(first).length > 0 } }];
  }

  async discoverAssets(context: ProviderAdapterContext, account: ProviderDiscoveredAccount): Promise<ProviderDiscoveredAsset[]> {
    const accounts = await this.discoverAccounts(context);
    if (!accounts.some((candidate) => candidate.externalAccountId === account.externalAccountId)) return [];
    return [{ externalAssetId: `${account.externalAccountId}:companies`, assetType: 'crm_companies', displayName: `${this.providerKey} companies`, status: 'CONNECTED', capabilities: { read: true, mutate: false }, metadata: { provider: this.providerKey } }];
  }

  async sync(context: ProviderAdapterContext, syncType: string) {
    const result = await this.verifyConnection(context);
    return result.verified ? { status: 'SUCCESS' as const, details: { syncType, provider: this.providerKey } } : { status: 'FAILED' as const, details: { syncType, provider: this.providerKey, reason: result.reason } };
  }
}
