import { decryptSecret } from '../../utils/secret-box.js';
import { getPlatformOAuthCredential } from '../onboarding/onboarding.repo.js';
import { refreshStoredOAuthCredential } from '../onboarding/oauth.service.js';
import { createMetaGraphClient, MetaGraphError } from '../social-publishing/meta-graph.client.js';
import type { ProviderAdapter, ProviderAdapterContext, ProviderCapabilityStatus, ProviderDiscoveredAccount, ProviderDiscoveredAsset, ProviderHealthStatus, ProviderVerificationResult } from './provider.types.js';

function stateFor(error: unknown): Pick<ProviderVerificationResult, 'status' | 'authorizationState' | 'healthStatus'> {
  if (error instanceof MetaGraphError && (error.kind === 'UNAVAILABLE' || error.code.includes('CREDENTIAL'))) return { status: 'AUTHORIZATION_REQUIRED', authorizationState: 'REAUTH_REQUIRED', healthStatus: 'AUTHORIZATION_REQUIRED' };
  if (error instanceof MetaGraphError && error.kind === 'BLOCKED') return { status: 'PROVIDER_REVIEW', authorizationState: 'AUTHORIZED', healthStatus: 'PROVIDER_REVIEW' };
  return { status: 'ERROR', authorizationState: 'UNKNOWN', healthStatus: 'ERROR' };
}

function adAccountId(context: ProviderAdapterContext) {
  const value = context.externalAccountId?.trim() ?? '';
  return value && /^act_?\d+$/i.test(value) ? value : null;
}

async function accessToken(workspaceId: string) {
  const credential = await getPlatformOAuthCredential(workspaceId, 'meta');
  if (!credential?.encryptedAccessToken) throw new MetaGraphError('META_ADS_CREDENTIAL_UNAVAILABLE', 'The Meta Marketing credential is unavailable.', 'UNAVAILABLE');
  const expiresAt = credential.tokenExpiresAt ? new Date(credential.tokenExpiresAt).getTime() : null;
  if (expiresAt !== null && expiresAt <= Date.now() + 300_000 && credential.encryptedRefreshToken) {
    return refreshStoredOAuthCredential({ workspaceId, provider: 'meta', encryptedRefreshToken: credential.encryptedRefreshToken });
  }
  return decryptSecret(credential.encryptedAccessToken);
}

/** Read-only Meta Marketing adapter. It proves account reachability and
 * discovers campaigns, while leaving campaign/budget mutations fail-closed
 * until the prepaid Meta payer contract is implemented and verified. */
export class MetaAdsAdapter implements ProviderAdapter {
  readonly providerKey = 'meta';
  readonly runtimeFeatures = ['verification', 'health', 'capabilities', 'discovery', 'sync'] as const;

  private async probe(context: ProviderAdapterContext) {
    if (!context.workspaceId) throw new MetaGraphError('META_ADS_WORKSPACE_REQUIRED', 'Meta Ads verification requires a workspace context.', 'BLOCKED');
    const account = adAccountId(context);
    if (!account) throw new MetaGraphError('META_AD_ACCOUNT_REQUIRED', 'A Meta ad account ID is required before verification.', 'BLOCKED');
    const token = await accessToken(context.workspaceId);
    const graph = createMetaGraphClient();
    const verified = await graph.verifyAdAccount({ accessToken: token, adAccountId: account });
    return { token, graph, account, verified };
  }

  async verifyConnection(context: ProviderAdapterContext): Promise<ProviderVerificationResult> {
    try {
      const { verified } = await this.probe(context);
      return { verified: true, status: 'CONNECTED', authorizationState: 'AUTHORIZED', healthStatus: 'HEALTHY', reason: `Meta ad account ${verified.adAccountId} is reachable through the verified Marketing API.`, lastSuccessAt: new Date().toISOString() };
    } catch (error) {
      const state = stateFor(error);
      return { verified: false, ...state, reason: error instanceof Error ? error.message : 'Meta Ads verification failed.' };
    }
  }

  async getHealth(context: ProviderAdapterContext): Promise<{ status: ProviderHealthStatus; reason: string }> {
    const result = await this.verifyConnection(context);
    return { status: result.healthStatus, reason: result.reason };
  }

  async getCapabilities(context: ProviderAdapterContext) {
    const verification = await this.verifyConnection(context);
    const readStatus: ProviderCapabilityStatus = verification.status === 'CONNECTED' ? 'AVAILABLE' : verification.status === 'AUTHORIZATION_REQUIRED' ? 'AUTHORIZATION_REQUIRED' : verification.status === 'PROVIDER_REVIEW' ? 'PROVIDER_REVIEW' : 'ERROR';
    return [
      { capabilityKey: 'meta.ads.read_spend', status: readStatus, reason: verification.reason },
      { capabilityKey: 'meta.ads.manage', status: readStatus === 'AVAILABLE' ? 'PROVIDER_REVIEW' as const : readStatus, reason: readStatus === 'AVAILABLE' ? 'Meta campaign mutations remain disabled until a prepaid payer contract and observed-cost settlement pass verification.' : verification.reason },
    ];
  }

  async discoverAccounts(context: ProviderAdapterContext): Promise<ProviderDiscoveredAccount[]> {
    try {
      const { verified } = await this.probe(context);
      return [{ externalAccountId: verified.adAccountId, name: verified.name ?? `Meta Ads ${verified.adAccountId}`, accountType: 'ad_account', status: 'CONNECTED', currency: verified.currency, metadata: { accountStatus: verified.accountStatus, providerRequestId: verified.providerRequestId } }];
    } catch { return []; }
  }

  async discoverAssets(context: ProviderAdapterContext, account: ProviderDiscoveredAccount): Promise<ProviderDiscoveredAsset[]> {
    const discovered = await this.discoverAccounts(context);
    if (!discovered.some((candidate) => candidate.externalAccountId === account.externalAccountId)) return [];
    try {
      const { token, graph } = await this.probe(context);
      const campaigns = await graph.listAdCampaigns({ accessToken: token, adAccountId: account.externalAccountId });
      return [{ externalAssetId: `${account.externalAccountId}:campaigns`, assetType: 'meta_ads_campaigns', displayName: 'Meta Ads campaigns', status: 'CONNECTED', capabilities: { read: true, mutate: false }, metadata: { count: campaigns.campaigns.length, providerRequestId: campaigns.providerRequestId } }];
    } catch {
      return [{ externalAssetId: `${account.externalAccountId}:campaigns`, assetType: 'meta_ads_campaigns', displayName: 'Meta Ads campaigns', status: 'UNKNOWN', capabilities: { read: true, mutate: false }, metadata: { provider: 'meta' } }];
    }
  }

  async sync(context: ProviderAdapterContext, syncType: string) {
    const verification = await this.verifyConnection(context);
    return verification.verified ? { status: 'SUCCESS' as const, details: { syncType, provider: 'meta', account: adAccountId(context) } } : { status: 'FAILED' as const, details: { syncType, provider: 'meta', reason: verification.reason } };
  }
}
