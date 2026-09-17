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
    const status: ProviderCapabilityStatus = result.status === 'CONNECTED' ? 'AVAILABLE' : result.status === 'AUTHORIZATION_REQUIRED' ? 'AUTHORIZATION_REQUIRED' : 'ERROR';
    return [{ capabilityKey: 'google_analytics.reporting.read', status, reason: result.reason }];
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
    return [{ externalAssetId: `${account.externalAccountId}:reporting`, assetType: 'analytics_reporting', displayName: 'Google Analytics reporting access', status: 'CONNECTED', capabilities: { read: true }, metadata: { accountId: account.externalAccountId } }];
  }

  async sync(context: ProviderAdapterContext, syncType: string) {
    const result = await this.verifyConnection(context);
    return result.verified ? { status: 'SUCCESS' as const, details: { syncType, provider: this.providerKey } } : { status: 'FAILED' as const, details: { syncType, provider: this.providerKey, reason: result.reason } };
  }
}
