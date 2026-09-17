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

type LinkedInIdentity = { sub: string | null; name: string | null; email: string | null };
type LinkedInAdAccount = { id: string; name: string | null; currency: string | null; status: string | null; reference: string | null };

async function accessToken(workspaceId: string) {
  const credential = await getPlatformOAuthCredential(workspaceId, 'linkedin');
  if (!credential) throw new AppError(409, 'LINKEDIN_NOT_CONNECTED', 'Connect LinkedIn Ads before running advertising checks.');
  const expiresAt = credential.tokenExpiresAt ? Date.parse(credential.tokenExpiresAt) : null;
  if (expiresAt !== null && expiresAt <= Date.now() + 300_000) {
    return refreshStoredOAuthCredential({ workspaceId, provider: 'linkedin', encryptedRefreshToken: credential.encryptedRefreshToken });
  }
  return decryptSecret(credential.encryptedAccessToken);
}

async function linkedinJson(workspaceId: string, url: string, init?: RequestInit) {
  const token = await accessToken(workspaceId);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Linkedin-Version': '202601',
        'X-Restli-Protocol-Version': '2.0.0',
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new AppError(502, 'LINKEDIN_NETWORK_ERROR', 'LinkedIn Ads did not return a definitive response.', { cause: error instanceof Error ? error.message : String(error) });
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new AppError(response.status === 401 ? 401 : response.status === 403 ? 403 : 502, response.status === 401 ? 'LINKEDIN_REAUTH_REQUIRED' : response.status === 403 ? 'LINKEDIN_PERMISSION_DENIED' : 'LINKEDIN_API_FAILED', 'LinkedIn Ads rejected the current API request.', { providerHttpStatus: response.status, body });
  }
  return body;
}

async function readIdentity(workspaceId: string): Promise<LinkedInIdentity> {
  const body = await linkedinJson(workspaceId, 'https://api.linkedin.com/v2/userinfo');
  return { sub: typeof body.sub === 'string' ? body.sub : null, name: typeof body.name === 'string' ? body.name : null, email: typeof body.email === 'string' ? body.email : null };
}

async function listAdAccounts(workspaceId: string): Promise<LinkedInAdAccount[]> {
  const body = await linkedinJson(workspaceId, 'https://api.linkedin.com/rest/adAccounts?q=search&count=100');
  const rows = Array.isArray(body.elements) ? body.elements : [];
  return rows.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && (typeof (row as { id?: unknown }).id === 'number' || typeof (row as { id?: unknown }).id === 'string'))).map((row) => ({
    id: String(row.id),
    name: typeof row.name === 'string' ? row.name : null,
    currency: typeof row.currency === 'string' ? row.currency : null,
    status: typeof row.status === 'string' ? row.status : null,
    reference: typeof row.reference === 'string' ? row.reference : null,
  }));
}

async function readSpend(workspaceId: string, accountId: string) {
  const now = new Date();
  const url = new URL('https://api.linkedin.com/rest/adAnalytics');
  url.searchParams.set('q', 'analytics');
  url.searchParams.set('pivot', 'ACCOUNT');
  url.searchParams.set('timeGranularity', 'ALL');
  url.searchParams.set('accounts', `List(urn:li:sponsoredAccount:${accountId})`);
  url.searchParams.set('dateRange.start.year', String(now.getUTCFullYear()));
  url.searchParams.set('dateRange.start.month', '1');
  url.searchParams.set('dateRange.start.day', '1');
  url.searchParams.set('dateRange.end.year', String(now.getUTCFullYear()));
  url.searchParams.set('dateRange.end.month', String(now.getUTCMonth() + 1));
  url.searchParams.set('dateRange.end.day', String(now.getUTCDate()));
  return linkedinJson(workspaceId, url.toString());
}

function errorState(error: unknown) {
  if (error instanceof AppError && error.code === 'LINKEDIN_NOT_CONNECTED') return { status: 'AUTHORIZATION_REQUIRED' as const, authorizationState: 'NOT_AUTHORIZED' as const, healthStatus: 'AUTHORIZATION_REQUIRED' as const };
  if (error instanceof AppError && (error.status === 401 || error.code === 'OAUTH_REFRESH_TOKEN_MISSING')) return { status: 'AUTHORIZATION_REQUIRED' as const, authorizationState: 'REAUTH_REQUIRED' as const, healthStatus: 'AUTHORIZATION_REQUIRED' as const };
  if (error instanceof AppError && error.status === 403) return { status: 'PROVIDER_REVIEW' as const, authorizationState: 'AUTHORIZED' as const, healthStatus: 'PROVIDER_REVIEW' as const };
  return { status: 'ERROR' as const, authorizationState: 'UNKNOWN' as const, healthStatus: 'ERROR' as const };
}

export class LinkedInAdsAdapter implements ProviderAdapter {
  readonly providerKey = 'linkedin';
  readonly runtimeFeatures = ['verification', 'health', 'capabilities', 'discovery', 'sync'] as const;

  async verifyConnection(context: ProviderAdapterContext): Promise<ProviderVerificationResult> {
    if (!context.workspaceId) return { verified: false, status: 'AUTHORIZATION_REQUIRED', authorizationState: 'NOT_AUTHORIZED', healthStatus: 'AUTHORIZATION_REQUIRED', reason: 'LinkedIn Ads verification requires a workspace context.' };
    try {
      const identity = await readIdentity(context.workspaceId);
      const accounts = await listAdAccounts(context.workspaceId);
      return { verified: true, status: 'CONNECTED', authorizationState: 'AUTHORIZED', healthStatus: 'HEALTHY', reason: `LinkedIn Ads API is reachable${identity.name ? ` for ${identity.name}` : ''}; ${accounts.length} ad account${accounts.length === 1 ? '' : 's'} discovered.`, lastSuccessAt: new Date().toISOString() };
    } catch (error) {
      const state = errorState(error);
      return { verified: false, ...state, reason: error instanceof Error ? error.message : 'LinkedIn Ads verification failed.' };
    }
  }

  async getHealth(context: ProviderAdapterContext): Promise<{ status: ProviderHealthStatus; reason: string }> {
    const result = await this.verifyConnection(context);
    return { status: result.healthStatus, reason: result.reason };
  }

  async getCapabilities(context: ProviderAdapterContext) {
    const result = await this.verifyConnection(context);
    if (result.status !== 'CONNECTED') {
      const status: ProviderCapabilityStatus = result.status === 'AUTHORIZATION_REQUIRED' ? 'AUTHORIZATION_REQUIRED' : result.status === 'PROVIDER_REVIEW' ? 'PROVIDER_REVIEW' : 'ERROR';
      return [
        { capabilityKey: 'linkedin.ads.accounts.read', status, reason: result.reason },
        { capabilityKey: 'linkedin.ads.spend.read', status, reason: result.reason },
      ];
    }
    let spendStatus: ProviderCapabilityStatus = 'PROVIDER_REVIEW';
    let spendReason = 'Ad-account discovery succeeded; reporting access still needs a real analytics read.';
    try {
      const accounts = await listAdAccounts(context.workspaceId!);
      if (accounts[0]) {
        await readSpend(context.workspaceId!, accounts[0].id);
        spendStatus = 'AVAILABLE';
        spendReason = 'LinkedIn Ad Analytics returned a real account-level report.';
      }
    } catch (error) {
      const state = errorState(error);
      spendStatus = state.status === 'AUTHORIZATION_REQUIRED' ? 'AUTHORIZATION_REQUIRED' : state.status === 'PROVIDER_REVIEW' ? 'PROVIDER_REVIEW' : 'ERROR';
      spendReason = error instanceof Error ? error.message : spendReason;
    }
    return [
      { capabilityKey: 'linkedin.ads.accounts.read', status: 'AVAILABLE' as const, reason: result.reason },
      { capabilityKey: 'linkedin.ads.spend.read', status: spendStatus, reason: spendReason },
    ];
  }

  async discoverAccounts(context: ProviderAdapterContext): Promise<ProviderDiscoveredAccount[]> {
    if (!context.workspaceId) return [];
    try {
      const accounts = await listAdAccounts(context.workspaceId);
      return accounts.map((account) => ({ externalAccountId: account.id, name: account.name ?? `LinkedIn Ad Account ${account.id}`, accountType: 'sponsored_account', status: account.status === 'ACTIVE' ? 'CONNECTED' : 'UNKNOWN', currency: account.currency, metadata: { reference: account.reference } }));
    } catch { return []; }
  }

  async discoverAssets(context: ProviderAdapterContext, account: ProviderDiscoveredAccount): Promise<ProviderDiscoveredAsset[]> {
    const accounts = await this.discoverAccounts(context);
    if (!accounts.some((candidate) => candidate.externalAccountId === account.externalAccountId)) return [];
    return [{ externalAssetId: `linkedin:${account.externalAccountId}:spend`, assetType: 'ad_analytics', displayName: 'LinkedIn account spend reporting', status: 'CONNECTED', capabilities: { read: true }, metadata: { accountId: account.externalAccountId } }];
  }

  async sync(context: ProviderAdapterContext, syncType: string) {
    if (!context.workspaceId) return { status: 'FAILED' as const, details: { syncType, provider: this.providerKey, reason: 'A workspace context is required for LinkedIn Ads reporting.' } };
    try {
      const accounts = await listAdAccounts(context.workspaceId);
      const account = accounts.find((item) => item.id === context.externalAccountId) ?? accounts[0];
      if (!account) return { status: 'FAILED' as const, details: { syncType, provider: this.providerKey, reason: 'No accessible LinkedIn ad account was discovered.' } };
      const report = await readSpend(context.workspaceId, account.id);
      return { status: 'SUCCESS' as const, details: { syncType, provider: this.providerKey, accountId: account.id, reportElements: Array.isArray(report.elements) ? report.elements.length : 0, reportStatus: report.status ?? null } };
    } catch (error) {
      return { status: 'FAILED' as const, details: { syncType, provider: this.providerKey, reason: error instanceof Error ? error.message : 'LinkedIn Ads report failed.' } };
    }
  }
}
