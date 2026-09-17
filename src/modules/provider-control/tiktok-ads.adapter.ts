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

type TikTokAdvertiser = { id: string; name: string | null; currency: string | null; status: string | null; country: string | null };

async function accessToken(workspaceId: string) {
  const credential = await getPlatformOAuthCredential(workspaceId, 'tiktok-ads');
  if (!credential) throw new AppError(409, 'TIKTOK_ADS_NOT_CONNECTED', 'Connect TikTok Ads before running advertising checks.');
  // TikTok Business long-lived tokens are invalidated by the advertiser rather
  // than refreshed on every request. Keep the refresh path for deployments
  // that still have a refresh token recorded, but never claim success when a
  // token is missing or cannot be decrypted.
  const expiresAt = credential.tokenExpiresAt ? Date.parse(credential.tokenExpiresAt) : null;
  if (expiresAt !== null && expiresAt <= Date.now() + 300_000 && credential.encryptedRefreshToken) {
    return refreshStoredOAuthCredential({ workspaceId, provider: 'tiktok-ads', encryptedRefreshToken: credential.encryptedRefreshToken });
  }
  return decryptSecret(credential.encryptedAccessToken);
}

async function tiktokJson(workspaceId: string, url: string, init?: RequestInit) {
  const token = await accessToken(workspaceId);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { 'Access-Token': token, Accept: 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new AppError(502, 'TIKTOK_ADS_NETWORK_ERROR', 'TikTok Ads did not return a definitive response.', { cause: error instanceof Error ? error.message : String(error) });
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  const code = typeof body.code === 'number' ? body.code : 0;
  if (!response.ok || code !== 0) {
    const status = response.status === 401 || code === 40100 || code === 40101 ? 401 : response.status === 403 ? 403 : 502;
    throw new AppError(status, status === 401 ? 'TIKTOK_ADS_REAUTH_REQUIRED' : status === 403 ? 'TIKTOK_ADS_PERMISSION_DENIED' : 'TIKTOK_ADS_API_FAILED', 'TikTok Ads rejected the current API request.', { providerHttpStatus: response.status, providerCode: code, requestId: body.request_id });
  }
  return body;
}

async function listAdvertisers(workspaceId: string, externalAccountId?: string | null): Promise<TikTokAdvertiser[]> {
  const ids = externalAccountId ? [externalAccountId] : [];
  const listUrl = new URL('https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/');
  const listBody = await tiktokJson(workspaceId, listUrl.toString());
  const data = listBody.data && typeof listBody.data === 'object' ? listBody.data as Record<string, unknown> : {};
  const rawIds = Array.isArray(data.list) ? data.list : Array.isArray(data.advertiser_ids) ? data.advertiser_ids : [];
  for (const item of rawIds) {
    const id = typeof item === 'string' || typeof item === 'number' ? String(item) : item && typeof item === 'object' && typeof (item as { advertiser_id?: unknown }).advertiser_id === 'string' ? (item as { advertiser_id: string }).advertiser_id : null;
    if (id && !ids.includes(id)) ids.push(id);
  }
  if (!ids.length) return [];
  const infoUrl = new URL('https://business-api.tiktok.com/open_api/v1.3/advertiser/info/');
  infoUrl.searchParams.set('advertiser_ids', JSON.stringify(ids.slice(0, 100)));
  infoUrl.searchParams.set('fields', JSON.stringify(['advertiser_id', 'name', 'currency', 'status', 'country']));
  const infoBody = await tiktokJson(workspaceId, infoUrl.toString());
  const infoData = infoBody.data && typeof infoBody.data === 'object' ? infoBody.data as Record<string, unknown> : {};
  const rows = Array.isArray(infoData.list) ? infoData.list : Array.isArray(infoData.advertisers) ? infoData.advertisers : [];
  return rows.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object')).map((row) => ({
    id: typeof row.advertiser_id === 'string' || typeof row.advertiser_id === 'number' ? String(row.advertiser_id) : '',
    name: typeof row.name === 'string' ? row.name : null,
    currency: typeof row.currency === 'string' ? row.currency : null,
    status: typeof row.status === 'string' ? row.status : null,
    country: typeof row.country === 'string' ? row.country : null,
  })).filter((row) => row.id.length > 0);
}

async function readSpend(workspaceId: string, advertiserId: string) {
  const end = new Date();
  const start = new Date(end.getTime() - 28 * 24 * 60 * 60 * 1000);
  const url = new URL('https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/');
  url.searchParams.set('advertiser_id', advertiserId);
  url.searchParams.set('page', '1');
  url.searchParams.set('page_size', '100');
  url.searchParams.set('report_type', 'BASIC');
  url.searchParams.set('data_level', 'AUCTION_ADVERTISER');
  url.searchParams.set('dimensions', JSON.stringify(['stat_time_day']));
  url.searchParams.set('metrics', JSON.stringify(['spend', 'impressions', 'clicks']));
  url.searchParams.set('start_date', start.toISOString().slice(0, 10));
  url.searchParams.set('end_date', end.toISOString().slice(0, 10));
  return tiktokJson(workspaceId, url.toString());
}

function errorState(error: unknown) {
  if (error instanceof AppError && error.code === 'TIKTOK_ADS_NOT_CONNECTED') return { status: 'AUTHORIZATION_REQUIRED' as const, authorizationState: 'NOT_AUTHORIZED' as const, healthStatus: 'AUTHORIZATION_REQUIRED' as const };
  if (error instanceof AppError && (error.status === 401 || error.code === 'OAUTH_REFRESH_TOKEN_MISSING')) return { status: 'AUTHORIZATION_REQUIRED' as const, authorizationState: 'REAUTH_REQUIRED' as const, healthStatus: 'AUTHORIZATION_REQUIRED' as const };
  if (error instanceof AppError && error.status === 403) return { status: 'PROVIDER_REVIEW' as const, authorizationState: 'AUTHORIZED' as const, healthStatus: 'PROVIDER_REVIEW' as const };
  return { status: 'ERROR' as const, authorizationState: 'UNKNOWN' as const, healthStatus: 'ERROR' as const };
}

export class TikTokAdsAdapter implements ProviderAdapter {
  readonly providerKey = 'tiktok_ads';
  readonly runtimeFeatures = ['verification', 'health', 'capabilities', 'discovery', 'sync'] as const;

  async verifyConnection(context: ProviderAdapterContext): Promise<ProviderVerificationResult> {
    if (!context.workspaceId) return { verified: false, status: 'AUTHORIZATION_REQUIRED', authorizationState: 'NOT_AUTHORIZED', healthStatus: 'AUTHORIZATION_REQUIRED', reason: 'TikTok Ads verification requires a workspace context.' };
    try {
      const accounts = await listAdvertisers(context.workspaceId, context.externalAccountId);
      return { verified: accounts.length > 0, status: accounts.length > 0 ? 'CONNECTED' : 'PROVIDER_REVIEW', authorizationState: 'AUTHORIZED', healthStatus: accounts.length > 0 ? 'HEALTHY' : 'PROVIDER_REVIEW', reason: accounts.length > 0 ? `TikTok Ads API is reachable; ${accounts.length} advertiser account${accounts.length === 1 ? '' : 's'} discovered.` : 'TikTok OAuth is valid, but no advertiser account was discovered.', lastSuccessAt: accounts.length > 0 ? new Date().toISOString() : null };
    } catch (error) {
      const state = errorState(error);
      return { verified: false, ...state, reason: error instanceof Error ? error.message : 'TikTok Ads verification failed.' };
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
      return [{ capabilityKey: 'tiktok_ads.accounts.read', status, reason: result.reason }, { capabilityKey: 'tiktok_ads.spend.read', status, reason: result.reason }];
    }
    let spendStatus: ProviderCapabilityStatus = 'PROVIDER_REVIEW';
    let spendReason = 'Advertiser discovery succeeded; reporting access still needs a real consolidated report.';
    try {
      const accounts = await listAdvertisers(context.workspaceId!, context.externalAccountId);
      if (accounts[0]) {
        await readSpend(context.workspaceId!, accounts[0].id);
        spendStatus = 'AVAILABLE';
        spendReason = 'TikTok consolidated reporting returned a real advertiser report.';
      }
    } catch (error) {
      const state = errorState(error);
      spendStatus = state.status === 'AUTHORIZATION_REQUIRED' ? 'AUTHORIZATION_REQUIRED' : state.status === 'PROVIDER_REVIEW' ? 'PROVIDER_REVIEW' : 'ERROR';
      spendReason = error instanceof Error ? error.message : spendReason;
    }
    return [{ capabilityKey: 'tiktok_ads.accounts.read', status: 'AVAILABLE' as const, reason: result.reason }, { capabilityKey: 'tiktok_ads.spend.read', status: spendStatus, reason: spendReason }];
  }

  async discoverAccounts(context: ProviderAdapterContext): Promise<ProviderDiscoveredAccount[]> {
    if (!context.workspaceId) return [];
    try {
      const accounts = await listAdvertisers(context.workspaceId, context.externalAccountId);
      return accounts.map((account) => ({ externalAccountId: account.id, name: account.name ?? `TikTok Advertiser ${account.id}`, accountType: 'advertiser', status: account.status === 'STATUS_ENABLE' || account.status === 'ACTIVE' ? 'CONNECTED' : 'UNKNOWN', currency: account.currency, country: account.country }));
    } catch { return []; }
  }

  async discoverAssets(context: ProviderAdapterContext, account: ProviderDiscoveredAccount): Promise<ProviderDiscoveredAsset[]> {
    const accounts = await this.discoverAccounts(context);
    if (!accounts.some((candidate) => candidate.externalAccountId === account.externalAccountId)) return [];
    return [{ externalAssetId: `tiktok:${account.externalAccountId}:spend`, assetType: 'ad_reporting', displayName: 'TikTok advertiser spend reporting', status: 'CONNECTED', capabilities: { read: true }, metadata: { advertiserId: account.externalAccountId } }];
  }

  async sync(context: ProviderAdapterContext, syncType: string) {
    if (!context.workspaceId) return { status: 'FAILED' as const, details: { syncType, provider: this.providerKey, reason: 'A workspace context is required for TikTok Ads reporting.' } };
    try {
      const accounts = await listAdvertisers(context.workspaceId, context.externalAccountId);
      const account = accounts.find((item) => item.id === context.externalAccountId) ?? accounts[0];
      if (!account) return { status: 'FAILED' as const, details: { syncType, provider: this.providerKey, reason: 'No accessible TikTok advertiser account was discovered.' } };
      const report = await readSpend(context.workspaceId, account.id);
      const data = report.data && typeof report.data === 'object' ? report.data as Record<string, unknown> : {};
      return { status: 'SUCCESS' as const, details: { syncType, provider: this.providerKey, advertiserId: account.id, reportRows: Array.isArray(data.list) ? data.list.length : 0, reportStatus: report.message ?? 'OK' } };
    } catch (error) {
      return { status: 'FAILED' as const, details: { syncType, provider: this.providerKey, reason: error instanceof Error ? error.message : 'TikTok Ads report failed.' } };
    }
  }
}
