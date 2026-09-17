import { decryptSecret } from '../../utils/secret-box.js';
import { getSocialProviderContext, listAccounts } from '../social-publishing/social-publishing.repo.js';
import { createMetaGraphClient, MetaGraphError } from '../social-publishing/meta-graph.client.js';
import type { SocialAccount } from '../social-publishing/social-publishing.types.js';
import type {
  ProviderAdapter,
  ProviderAdapterContext,
  ProviderCapabilityStatus,
  ProviderDiscoveredAccount,
  ProviderDiscoveredAsset,
  ProviderHealthStatus,
  ProviderVerificationResult,
} from './provider.types.js';

type MetaSocialProvider = 'facebook' | 'instagram';

function accountProvider(account: SocialAccount) {
  return account.provider.toLowerCase() as MetaSocialProvider;
}

function stateFor(error: unknown) {
  if (error instanceof MetaGraphError && (error.kind === 'UNAVAILABLE' || error.code.includes('CREDENTIAL'))) {
    return { status: 'AUTHORIZATION_REQUIRED' as const, authorizationState: 'REAUTH_REQUIRED' as const, healthStatus: 'AUTHORIZATION_REQUIRED' as const };
  }
  if (error instanceof MetaGraphError && error.kind === 'BLOCKED') {
    return { status: 'PROVIDER_REVIEW' as const, authorizationState: 'AUTHORIZED' as const, healthStatus: 'PROVIDER_REVIEW' as const };
  }
  return { status: 'ERROR' as const, authorizationState: 'UNKNOWN' as const, healthStatus: 'ERROR' as const };
}

/**
 * Canonical read-only adapter for the Facebook Page and Instagram Business
 * accounts already used by the social publishing service. Verification calls
 * Meta's page identity endpoint only; no post, media container, or delivery
 * mutation is created.
 */
export class MetaSocialAdapter implements ProviderAdapter {
  readonly runtimeFeatures = ['verification', 'health', 'capabilities', 'discovery', 'sync'] as const;

  constructor(public readonly providerKey: MetaSocialProvider) {}

  private async account(context: ProviderAdapterContext) {
    if (!context.workspaceId) return null;
    const accounts = await listAccounts(context.workspaceId);
    return accounts.find((candidate) => candidate.providerConnectionId === context.connectionId && accountProvider(candidate) === this.providerKey) ?? null;
  }

  private async verifyAccount(context: ProviderAdapterContext, account: SocialAccount) {
    const providerContext = await getSocialProviderContext(context.workspaceId!, context.connectionId);
    if (!providerContext?.encryptedAccessToken) throw new MetaGraphError('META_SOCIAL_CREDENTIAL_UNAVAILABLE', 'The Meta social credential is unavailable.', 'UNAVAILABLE');
    if (providerContext.grantedScopes.length === 0) throw new MetaGraphError('META_SOCIAL_SCOPE_MISSING', 'The Meta social connection has no recorded scopes.', 'BLOCKED');
    const token = decryptSecret(providerContext.encryptedAccessToken);
    return createMetaGraphClient().verifyPage({
      accessToken: token,
      facebookPageId: account.facebookPageId,
      ...(this.providerKey === 'instagram' ? { expectedInstagramBusinessAccountId: account.instagramBusinessAccountId } : {}),
    });
  }

  async verifyConnection(context: ProviderAdapterContext): Promise<ProviderVerificationResult> {
    if (!context.workspaceId) return { verified: false, status: 'AUTHORIZATION_REQUIRED', authorizationState: 'NOT_AUTHORIZED', healthStatus: 'AUTHORIZATION_REQUIRED', reason: 'Meta social verification requires a workspace context.' };
    const account = await this.account(context);
    if (!account) return { verified: false, status: 'PROVIDER_REVIEW', authorizationState: 'AUTHORIZED', healthStatus: 'PROVIDER_REVIEW', reason: `No configured ${this.providerKey} social account is attached to this provider connection.` };
    try {
      const verified = await this.verifyAccount(context, account);
      return { verified: true, status: 'CONNECTED', authorizationState: 'AUTHORIZED', healthStatus: 'HEALTHY', reason: `${this.providerKey} account ${verified.pageName ?? account.displayName} is reachable and its publishing identity is verified.`, lastSuccessAt: new Date().toISOString() };
    } catch (error) {
      const state = stateFor(error);
      return { verified: false, ...state, reason: error instanceof Error ? error.message : `The ${this.providerKey} account could not be verified.` };
    }
  }

  async getHealth(context: ProviderAdapterContext): Promise<{ status: ProviderHealthStatus; reason: string }> {
    const result = await this.verifyConnection(context);
    return { status: result.healthStatus, reason: result.reason };
  }

  async getCapabilities(context: ProviderAdapterContext) {
    const result = await this.verifyConnection(context);
    const status: ProviderCapabilityStatus = result.status === 'CONNECTED' ? 'AVAILABLE' : result.status === 'AUTHORIZATION_REQUIRED' ? 'AUTHORIZATION_REQUIRED' : result.status === 'PROVIDER_REVIEW' ? 'PROVIDER_REVIEW' : 'ERROR';
    return [{ capabilityKey: this.providerKey === 'facebook' ? 'facebook.pages.publish' : 'instagram.content.publish', status, reason: result.reason }];
  }

  async discoverAccounts(context: ProviderAdapterContext): Promise<ProviderDiscoveredAccount[]> {
    if (!context.workspaceId) return [];
    const accounts = (await listAccounts(context.workspaceId)).filter((account) => account.providerConnectionId === context.connectionId && accountProvider(account) === this.providerKey);
    return accounts.map((account) => ({ externalAccountId: account.id, name: account.displayName, accountType: this.providerKey === 'facebook' ? 'facebook_page' : 'instagram_business', status: account.status === 'AVAILABLE' ? 'CONNECTED' : account.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'UNKNOWN', metadata: { facebookPageId: account.facebookPageId, instagramBusinessAccountId: account.instagramBusinessAccountId, providerStatus: account.status } }));
  }

  async discoverAssets(context: ProviderAdapterContext, account: ProviderDiscoveredAccount): Promise<ProviderDiscoveredAsset[]> {
    const socialAccount = await this.account(context);
    if (!socialAccount || socialAccount.id !== account.externalAccountId) return [];
    const assets: ProviderDiscoveredAsset[] = [{ externalAssetId: socialAccount.facebookPageId, assetType: 'facebook_page', displayName: socialAccount.displayName, status: socialAccount.status === 'AVAILABLE' ? 'CONNECTED' : 'UNKNOWN', metadata: { socialAccountId: socialAccount.id } }];
    if (this.providerKey === 'instagram' && socialAccount.instagramBusinessAccountId) assets.push({ externalAssetId: socialAccount.instagramBusinessAccountId, assetType: 'instagram_business_account', displayName: socialAccount.providerUsername ?? socialAccount.displayName, status: socialAccount.status === 'AVAILABLE' ? 'CONNECTED' : 'UNKNOWN', metadata: { socialAccountId: socialAccount.id } });
    return assets;
  }

  async sync(context: ProviderAdapterContext, syncType: string) {
    const result = await this.verifyConnection(context);
    return result.verified ? { status: 'SUCCESS' as const, details: { syncType, provider: this.providerKey } } : { status: 'FAILED' as const, details: { syncType, provider: this.providerKey, reason: result.reason } };
  }
}
