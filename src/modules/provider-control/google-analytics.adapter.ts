import { AppError } from '../../utils/app-error.js';
import { decryptSecret } from '../../utils/secret-box.js';
import { getPlatformOAuthCredential } from '../onboarding/onboarding.repo.js';
import { refreshStoredOAuthCredential } from '../onboarding/oauth.service.js';
import type {
  ProviderAdapter,
  ProviderAdapterContext,
  ProviderCapabilityStatus,
  ProviderDiscoveredAccount,
  ProviderDiscoveredAsset,
  ProviderHealthStatus,
  ProviderVerificationResult,
} from './provider.types.js';

type GoogleIdentity = { sub: string | null; email: string | null; name: string | null };
type GoogleProperty = { name: string; displayName: string | null; propertyType: string | null; parent: string | null };

async function accessToken(workspaceId: string) {
  const credential = await getPlatformOAuthCredential(workspaceId, 'google-analytics');
  if (!credential) throw new AppError(409, 'GOOGLE_ANALYTICS_NOT_CONNECTED', 'Connect Google Analytics before running reporting checks.');
  const expiresAt = credential.tokenExpiresAt ? Date.parse(credential.tokenExpiresAt) : null;
  if (expiresAt !== null && expiresAt <= Date.now() + 300_000) {
    return refreshStoredOAuthCredential({ workspaceId, provider: 'google-analytics', encryptedRefreshToken: credential.encryptedRefreshToken });
  }
  return decryptSecret(credential.encryptedAccessToken);
}

async function readIdentity(workspaceId: string): Promise<GoogleIdentity> {
  const token = await accessToken(workspaceId);
  let response: Response;
  try {
    response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new AppError(502, 'GOOGLE_ANALYTICS_NETWORK_ERROR', 'Google Analytics identity verification did not return a definitive response.', { cause: error instanceof Error ? error.message : String(error) });
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new AppError(response.status === 401 ? 401 : 502, response.status === 401 ? 'GOOGLE_ANALYTICS_REAUTH_REQUIRED' : 'GOOGLE_ANALYTICS_ACCOUNT_READ_FAILED', 'Google Analytics rejected the current OAuth access token.', { providerHttpStatus: response.status });
  return { sub: typeof body.sub === 'string' ? body.sub : null, email: typeof body.email === 'string' ? body.email : null, name: typeof body.name === 'string' ? body.name : null };
}

async function googleJson(workspaceId: string, url: string, init?: RequestInit) {
  const token = await accessToken(workspaceId);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new AppError(502, 'GOOGLE_ANALYTICS_NETWORK_ERROR', 'Google Analytics did not return a definitive response.', { cause: error instanceof Error ? error.message : String(error) });
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new AppError(response.status === 401 ? 401 : response.status === 403 ? 403 : 502, response.status === 401 ? 'GOOGLE_ANALYTICS_REAUTH_REQUIRED' : response.status === 403 ? 'GOOGLE_ANALYTICS_PERMISSION_DENIED' : 'GOOGLE_ANALYTICS_API_FAILED', 'Google Analytics rejected the current API request.', { providerHttpStatus: response.status, body });
  }
  return body;
}

async function listProperties(workspaceId: string): Promise<GoogleProperty[]> {
  const properties: GoogleProperty[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL('https://analyticsadmin.googleapis.com/v1beta/properties');
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const body = await googleJson(workspaceId, url.toString());
    const rows = Array.isArray(body.properties) ? body.properties : [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof (row as { name?: unknown }).name !== 'string') continue;
      const property = row as { name: string; displayName?: unknown; propertyType?: unknown; parent?: unknown };
      properties.push({ name: property.name, displayName: typeof property.displayName === 'string' ? property.displayName : null, propertyType: typeof property.propertyType === 'string' ? property.propertyType : null, parent: typeof property.parent === 'string' ? property.parent : null });
    }
    pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken.length > 0 ? body.nextPageToken : undefined;
  } while (pageToken && properties.length < 500);
  return properties;
}

async function readPropertyReport(workspaceId: string, propertyName: string) {
  const propertyId = propertyName.startsWith('properties/') ? propertyName : `properties/${propertyName}`;
  return googleJson(workspaceId, `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`, {
    method: 'POST',
    body: JSON.stringify({
      dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'conversions' }],
      limit: '1000',
    }),
  });
}

function errorState(error: unknown) {
  if (error instanceof AppError && error.code === 'GOOGLE_ANALYTICS_NOT_CONNECTED') return { status: 'AUTHORIZATION_REQUIRED' as const, authorizationState: 'NOT_AUTHORIZED' as const, healthStatus: 'AUTHORIZATION_REQUIRED' as const };
  if (error instanceof AppError && (error.status === 401 || error.code === 'OAUTH_REFRESH_TOKEN_MISSING')) return { status: 'AUTHORIZATION_REQUIRED' as const, authorizationState: 'REAUTH_REQUIRED' as const, healthStatus: 'AUTHORIZATION_REQUIRED' as const };
  return { status: 'ERROR' as const, authorizationState: 'UNKNOWN' as const, healthStatus: 'ERROR' as const };
}

export class GoogleAnalyticsAdapter implements ProviderAdapter {
  readonly providerKey = 'google_analytics';
  readonly runtimeFeatures = ['verification', 'health', 'capabilities', 'discovery', 'sync'] as const;

  async verifyConnection(context: ProviderAdapterContext): Promise<ProviderVerificationResult> {
    if (!context.workspaceId) return { verified: false, status: 'AUTHORIZATION_REQUIRED', authorizationState: 'NOT_AUTHORIZED', healthStatus: 'AUTHORIZATION_REQUIRED', reason: 'Google Analytics verification requires a workspace context.' };
    try {
      const identity = await readIdentity(context.workspaceId);
      return { verified: true, status: 'CONNECTED', authorizationState: 'AUTHORIZED', healthStatus: 'HEALTHY', reason: `Google Analytics OAuth is valid${identity.email ? ` for ${identity.email}` : ''}.`, lastSuccessAt: new Date().toISOString() };
    } catch (error) {
      const state = errorState(error);
      return { verified: false, ...state, reason: error instanceof Error ? error.message : 'Google Analytics verification failed.' };
    }
  }

  async getHealth(context: ProviderAdapterContext): Promise<{ status: ProviderHealthStatus; reason: string }> {
    const result = await this.verifyConnection(context);
    return { status: result.healthStatus, reason: result.reason };
  }

  async getCapabilities(context: ProviderAdapterContext) {
    const result = await this.verifyConnection(context);
    if (result.status !== 'CONNECTED') {
      const status: ProviderCapabilityStatus = result.status === 'AUTHORIZATION_REQUIRED' ? 'AUTHORIZATION_REQUIRED' : 'ERROR';
      return [{ capabilityKey: 'google_analytics.reporting.read', status, reason: result.reason }];
    }
    try {
      const properties = await listProperties(context.workspaceId!);
      const status: ProviderCapabilityStatus = properties.length > 0 ? 'AVAILABLE' : 'PROVIDER_REVIEW';
      return [{ capabilityKey: 'google_analytics.reporting.read', status, reason: properties.length > 0 ? `Google Analytics Data API is reachable with ${properties.length} accessible GA4 propert${properties.length === 1 ? 'y' : 'ies'}.` : 'OAuth is valid, but no accessible GA4 property was discovered.' }];
    } catch (error) {
      const state = errorState(error);
      return [{ capabilityKey: 'google_analytics.reporting.read', status: state.status, reason: error instanceof Error ? error.message : 'Google Analytics property discovery failed.' }];
    }
  }

  async discoverAccounts(context: ProviderAdapterContext): Promise<ProviderDiscoveredAccount[]> {
    if (!context.workspaceId) return [];
    try {
      const identity = await readIdentity(context.workspaceId);
      return [{ externalAccountId: identity.sub ?? context.externalAccountId ?? 'google-analytics-account', name: identity.name ?? identity.email ?? 'Google Analytics account', accountType: 'google_identity', status: 'CONNECTED', metadata: { email: identity.email } }];
    } catch { return []; }
  }

  async discoverAssets(context: ProviderAdapterContext, account: ProviderDiscoveredAccount): Promise<ProviderDiscoveredAsset[]> {
    const accounts = await this.discoverAccounts(context);
    if (!accounts.some((candidate) => candidate.externalAccountId === account.externalAccountId)) return [];
    try {
      const properties = await listProperties(context.workspaceId!);
      return properties.map((property) => ({ externalAssetId: property.name, assetType: 'ga4_property', displayName: property.displayName ?? property.name, status: 'CONNECTED' as const, capabilities: { read: true, reporting: true }, metadata: { accountId: account.externalAccountId, propertyType: property.propertyType, parent: property.parent } }));
    } catch { return []; }
  }

  async sync(context: ProviderAdapterContext, syncType: string) {
    if (!context.workspaceId) return { status: 'FAILED' as const, details: { syncType, provider: this.providerKey, reason: 'A workspace context is required for Google Analytics reporting.' } };
    try {
      const properties = await listProperties(context.workspaceId);
      const propertyName = context.externalAccountId?.startsWith('properties/') ? context.externalAccountId : properties[0]?.name;
      if (!propertyName) return { status: 'FAILED' as const, details: { syncType, provider: this.providerKey, reason: 'No accessible GA4 property was discovered.' } };
      const report = await readPropertyReport(context.workspaceId, propertyName);
      const rows = Array.isArray(report.rows) ? report.rows : [];
      return { status: 'SUCCESS' as const, details: { syncType, provider: this.providerKey, property: propertyName, rowCount: rows.length, metricHeaders: report.metricHeaders ?? [], sampled: false } };
    } catch (error) {
      return { status: 'FAILED' as const, details: { syncType, provider: this.providerKey, reason: error instanceof Error ? error.message : 'Google Analytics report failed.' } };
    }
  }
}
