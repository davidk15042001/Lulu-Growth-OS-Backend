import type {
  ProviderAdapter,
  ProviderAdapterContext,
  ProviderCapabilityStatus,
  ProviderDiscoveredAccount,
  ProviderDiscoveredAsset,
  ProviderHealthStatus,
  ProviderVerificationResult,
} from './provider.types.js';
import * as websiteRepo from '../websites/website.repo.js';

/**
 * Adapter for Lulu's own managed-website runtime.
 *
 * The managed site is a canonical Lulu object, not a catalog-only provider.
 * Contract checks therefore read the same site/domain/job projection used by
 * the Website workspace and public storefront. No synthetic provider state is
 * created and no publish side effect is performed by a probe.
 */
export class ManagedWebsiteAdapter implements ProviderAdapter {
  readonly providerKey = 'lulu_managed_website';
  readonly runtimeFeatures = ['verification', 'health', 'capabilities', 'discovery', 'sync'] as const;

  private siteId(context: ProviderAdapterContext) {
    const metadataSiteId = context.metadata.legacySiteId;
    if (typeof metadataSiteId === 'string' && metadataSiteId.trim()) return metadataSiteId.trim();
    const external = context.externalAccountId ?? '';
    return external.startsWith('workspace-site:') ? external.slice('workspace-site:'.length) : external;
  }

  private async site(context: ProviderAdapterContext) {
    if (!context.workspaceId) return null;
    const siteId = this.siteId(context);
    if (!siteId) return null;
    return websiteRepo.getSite(context.workspaceId, siteId);
  }

  private state(site: Awaited<ReturnType<ManagedWebsiteAdapter['site']>>) {
    if (!site) return { status: 'AUTHORIZATION_REQUIRED' as const, authorizationState: 'NOT_AUTHORIZED' as const, healthStatus: 'AUTHORIZATION_REQUIRED' as const, reason: 'No Lulu-managed website exists for this provider connection.' };
    if (site.provider !== 'managed' || site.ownershipMode !== 'managed') return { status: 'PROVIDER_REVIEW' as const, authorizationState: 'UNKNOWN' as const, healthStatus: 'PROVIDER_REVIEW' as const, reason: 'The site is not owned by Lulu managed mode.' };
    if (site.status === 'disconnected') return { status: 'DISCONNECTED' as const, authorizationState: 'NOT_AUTHORIZED' as const, healthStatus: 'DISCONNECTED' as const, reason: 'The managed website is disconnected.' };
    if (site.status === 'error') return { status: 'ERROR' as const, authorizationState: 'AUTHORIZED' as const, healthStatus: 'ERROR' as const, reason: 'The managed website is in an error state and requires inspection.' };
    return { status: 'CONNECTED' as const, authorizationState: 'AUTHORIZED' as const, healthStatus: 'HEALTHY' as const, reason: 'The canonical Lulu-managed website is available.' };
  }

  async verifyConnection(context: ProviderAdapterContext): Promise<ProviderVerificationResult> {
    if (!context.workspaceId) return { verified: false, status: 'AUTHORIZATION_REQUIRED', authorizationState: 'NOT_AUTHORIZED', healthStatus: 'AUTHORIZATION_REQUIRED', reason: 'Lulu-managed websites require a workspace context.' };
    const state = this.state(await this.site(context));
    return { verified: state.status === 'CONNECTED', ...state, ...(state.status === 'CONNECTED' ? { lastSuccessAt: new Date().toISOString() } : {}) };
  }

  async getHealth(context: ProviderAdapterContext): Promise<{ status: ProviderHealthStatus; reason: string }> {
    const state = this.state(await this.site(context));
    return { status: state.healthStatus, reason: state.reason };
  }

  async getCapabilities(context: ProviderAdapterContext) {
    const state = this.state(await this.site(context));
    const status: ProviderCapabilityStatus = state.status === 'CONNECTED' ? 'AVAILABLE' : state.status === 'ERROR' ? 'ERROR' : state.status === 'DISCONNECTED' ? 'UNAVAILABLE' : state.status === 'AUTHORIZATION_REQUIRED' ? 'AUTHORIZATION_REQUIRED' : 'PROVIDER_REVIEW';
    return ['website.site.read', 'website.site.preview', 'website.site.publish', 'website.domain.verify']
      .map((capabilityKey) => ({ capabilityKey, status, reason: state.reason }));
  }

  async discoverAccounts(context: ProviderAdapterContext): Promise<ProviderDiscoveredAccount[]> {
    const site = await this.site(context);
    if (!site) return [];
    const state = this.state(site);
    return [{
      externalAccountId: site.externalSiteId ?? `workspace-site:${site.id}`,
      name: site.name,
      accountType: 'managed_website',
      status: state.status === 'CONNECTED' ? 'CONNECTED' : state.status === 'ERROR' ? 'ERROR' : state.status === 'DISCONNECTED' ? 'DISCONNECTED' : 'UNKNOWN',
      metadata: { siteId: site.id, siteStatus: site.status, domainCount: site.domains.length, publicUrl: site.externalSiteUrl },
    }];
  }

  async discoverAssets(context: ProviderAdapterContext, account: ProviderDiscoveredAccount): Promise<ProviderDiscoveredAsset[]> {
    const site = await this.site(context);
    if (!site || account.externalAccountId !== (site.externalSiteId ?? `workspace-site:${site.id}`)) return [];
    const state = this.state(site);
    const assets: ProviderDiscoveredAsset[] = [{
      externalAssetId: site.id,
      assetType: 'managed_website',
      displayName: site.name,
      status: state.status === 'CONNECTED' ? 'CONNECTED' : state.status === 'ERROR' ? 'ERROR' : 'UNKNOWN',
      capabilities: { status: site.status, publicUrl: site.externalSiteUrl },
      metadata: { siteId: site.id },
    }];
    for (const domain of site.domains) assets.push({
      externalAssetId: domain.id,
      assetType: 'website_domain',
      displayName: domain.hostname,
      status: domain.status === 'verified' ? 'CONNECTED' : domain.status === 'failed' || domain.status === 'expired' ? 'ERROR' : 'UNKNOWN',
      capabilities: { verificationStatus: domain.status, verificationMethod: domain.verificationMethod },
      metadata: { siteId: site.id, hostname: domain.hostname },
    });
    return assets;
  }

  async sync(context: ProviderAdapterContext, syncType: string) {
    const site = await this.site(context);
    if (!site) return { status: 'FAILED' as const, details: { code: 'MANAGED_WEBSITE_NOT_FOUND', syncType } };
    const state = this.state(site);
    if (state.status !== 'CONNECTED') return { status: 'FAILED' as const, details: { code: 'MANAGED_WEBSITE_UNAVAILABLE', syncType, reason: state.reason } };
    const latestJob = await websiteRepo.findLatestJob(site.id);
    return { status: 'SUCCESS' as const, details: { syncType, siteId: site.id, siteStatus: site.status, domainCount: site.domains.length, latestJobStatus: latestJob?.status ?? null } };
  }
}
