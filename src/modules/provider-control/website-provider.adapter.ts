import { AppError } from '../../utils/app-error.js';
import { webflowCollections, webflowCustomDomains, webflowSites, wordpressMedia, wordpressPages, wordpressSites } from '../websites/website.provider.service.js';
import type {
  ProviderAdapter,
  ProviderAdapterContext,
  ProviderCapabilityStatus,
  ProviderDiscoveredAccount,
  ProviderDiscoveredAsset,
  ProviderHealthStatus,
  ProviderVerificationResult,
} from './provider.types.js';

type WebsiteProviderKey = 'wordpress' | 'webflow';

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function sitesFrom(value: unknown): Record<string, unknown>[] {
  const root = objectValue(value);
  const sites = Array.isArray(value) ? value : root.sites;
  return arrayValue(sites).map(objectValue).filter((site) => Object.keys(site).length > 0);
}

function recordsFrom(value: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(objectValue).filter((record) => Object.keys(record).length > 0);
  const root = objectValue(value);
  for (const key of keys) {
    if (Array.isArray(root[key])) return (root[key] as unknown[]).map(objectValue).filter((record) => Object.keys(record).length > 0);
  }
  return [];
}

function providerSiteId(provider: WebsiteProviderKey, site: Record<string, unknown>) {
  return provider === 'wordpress'
    ? stringValue(site.ID ?? site.id)
    : stringValue(site.id ?? site._id);
}

function providerSiteName(provider: WebsiteProviderKey, site: Record<string, unknown>) {
  return provider === 'wordpress'
    ? stringValue(site.name ?? site.URL ?? site.url) || 'WordPress site'
    : stringValue(site.displayName ?? site.name ?? site.previewUrl) || 'Webflow site';
}

function providerSiteUrl(provider: WebsiteProviderKey, site: Record<string, unknown>) {
  return provider === 'wordpress'
    ? stringValue(site.URL ?? site.url) || null
    : stringValue(site.previewUrl ?? site.publishedUrl) || null;
}

function failureState(error: unknown) {
  const isAuth = error instanceof AppError && (
    error.status === 401
    || error.code === 'WEBSITE_PROVIDER_NOT_CONNECTED'
    || error.code === 'WEBSITE_PROVIDER_REAUTH_REQUIRED'
  );
  if (isAuth) return {
    status: 'AUTHORIZATION_REQUIRED' as const,
    authorizationState: error instanceof AppError && error.code === 'WEBSITE_PROVIDER_REAUTH_REQUIRED' ? 'REAUTH_REQUIRED' as const : 'NOT_AUTHORIZED' as const,
    healthStatus: 'AUTHORIZATION_REQUIRED' as const,
  };
  if (error instanceof AppError && error.status === 403) return {
    status: 'PROVIDER_REVIEW' as const,
    authorizationState: 'AUTHORIZED' as const,
    healthStatus: 'PROVIDER_REVIEW' as const,
  };
  return { status: 'ERROR' as const, authorizationState: 'UNKNOWN' as const, healthStatus: 'ERROR' as const };
}

/**
 * Read-only control-plane adapter for the existing WordPress.com and Webflow
 * integrations. It intentionally reuses the canonical website provider
 * service, so a successful check proves a real tenant-scoped API read rather
 * than merely proving that OAuth metadata exists.
 */
export class WebsiteProviderAdapter implements ProviderAdapter {
  readonly runtimeFeatures = ['verification', 'health', 'capabilities', 'discovery', 'sync'] as const;

  constructor(public readonly providerKey: WebsiteProviderKey) {}

  private async listSites(context: ProviderAdapterContext) {
    if (!context.workspaceId) throw new AppError(400, 'WEBSITE_PROVIDER_WORKSPACE_REQUIRED', 'Website provider verification requires a workspace context.');
    return this.providerKey === 'wordpress'
      ? wordpressSites(context.workspaceId)
      : webflowSites(context.workspaceId);
  }

  private account(context: ProviderAdapterContext, sites: Record<string, unknown>[]) {
    const requested = stringValue(context.externalAccountId);
    return (requested ? sites.find((site) => providerSiteId(this.providerKey, site) === requested) : sites[0]) ?? null;
  }

  async verifyConnection(context: ProviderAdapterContext): Promise<ProviderVerificationResult> {
    try {
      const sites = sitesFrom(await this.listSites(context));
      const site = this.account(context, sites);
      if (!site) return {
        verified: false,
        status: 'UNAVAILABLE',
        authorizationState: 'AUTHORIZED',
        healthStatus: 'DEGRADED',
        reason: `The ${this.providerKey} account is reachable, but no matching site was returned.`,
      };
      return {
        verified: true,
        status: 'CONNECTED',
        authorizationState: 'AUTHORIZED',
        healthStatus: 'HEALTHY',
        reason: `${this.providerKey} returned the connected site ${providerSiteName(this.providerKey, site)} through the canonical API path.`,
        lastSuccessAt: new Date().toISOString(),
      };
    } catch (error) {
      const state = failureState(error);
      return {
        verified: false,
        ...state,
        reason: error instanceof Error ? error.message : `${this.providerKey} verification failed.`,
      };
    }
  }

  async getHealth(context: ProviderAdapterContext): Promise<{ status: ProviderHealthStatus; reason: string }> {
    const result = await this.verifyConnection(context);
    return { status: result.healthStatus, reason: result.reason };
  }

  async getCapabilities(context: ProviderAdapterContext) {
    const result = await this.verifyConnection(context);
    const readStatus: ProviderCapabilityStatus = result.status === 'CONNECTED'
      ? 'AVAILABLE'
      : result.status === 'AUTHORIZATION_REQUIRED'
        ? 'AUTHORIZATION_REQUIRED'
        : result.status === 'PROVIDER_REVIEW'
          ? 'PROVIDER_REVIEW'
          : 'ERROR';
    const capabilities = this.providerKey === 'wordpress'
      ? ['wordpress.site.read', 'wordpress.site.publish', 'wordpress.media.upload']
      : ['webflow.site.read', 'webflow.cms.write'];
    return capabilities.map((capabilityKey) => ({
      capabilityKey,
      status: capabilityKey.endsWith('.read') || capabilityKey === 'wordpress.site.read' ? readStatus : readStatus === 'AVAILABLE' ? 'PROVIDER_REVIEW' as const : readStatus,
      reason: result.reason,
    }));
  }

  async discoverAccounts(context: ProviderAdapterContext): Promise<ProviderDiscoveredAccount[]> {
    const sites = sitesFrom(await this.listSites(context));
    return sites.map((site) => ({
      externalAccountId: providerSiteId(this.providerKey, site),
      name: providerSiteName(this.providerKey, site),
      accountType: 'website',
      status: 'CONNECTED' as const,
      metadata: { provider: this.providerKey, url: providerSiteUrl(this.providerKey, site) },
    })).filter((account) => Boolean(account.externalAccountId));
  }

  async discoverAssets(context: ProviderAdapterContext, account: ProviderDiscoveredAccount): Promise<ProviderDiscoveredAsset[]> {
    if (!context.workspaceId) return [];
    const siteId = stringValue(account.externalAccountId);
    if (!siteId) return [];
    const assets: ProviderDiscoveredAsset[] = [{
      externalAssetId: siteId,
      assetType: 'website',
      displayName: account.name ?? `${this.providerKey} website`,
      status: 'CONNECTED',
      capabilities: { provider: this.providerKey, url: account.metadata?.url ?? null },
    }];
    if (this.providerKey === 'wordpress') {
      const [pages, media] = await Promise.all([
        wordpressPages(context.workspaceId, siteId),
        wordpressMedia(context.workspaceId, siteId),
      ]);
      assets.push({ externalAssetId: `${siteId}:pages`, assetType: 'website_pages', displayName: 'WordPress pages', status: 'CONNECTED', metadata: { count: pages.length } });
      assets.push({ externalAssetId: `${siteId}:media`, assetType: 'website_media', displayName: 'WordPress media', status: 'CONNECTED', metadata: { count: media.length } });
    } else {
      const [collections, domains] = await Promise.all([
        webflowCollections(context.workspaceId, siteId),
        webflowCustomDomains(context.workspaceId, siteId),
      ]);
      assets.push({ externalAssetId: `${siteId}:collections`, assetType: 'cms_collections', displayName: 'Webflow CMS collections', status: 'CONNECTED', metadata: { count: recordsFrom(collections, ['collections']).length } });
      assets.push({ externalAssetId: `${siteId}:domains`, assetType: 'website_domains', displayName: 'Webflow custom domains', status: 'CONNECTED', metadata: { count: recordsFrom(domains, ['customDomains', 'domains']).length } });
    }
    return assets;
  }

  async sync(context: ProviderAdapterContext, syncType: string) {
    const result = await this.verifyConnection(context);
    if (!result.verified) return { status: 'FAILED' as const, details: { syncType, provider: this.providerKey, reason: result.reason } };
    const accounts = await this.discoverAccounts(context);
    return { status: 'SUCCESS' as const, details: { syncType, provider: this.providerKey, accountCount: accounts.length, accountIds: accounts.map((account) => account.externalAccountId) } };
  }
}
