import { providerError } from './provider-registry.js';
import type {
  ProviderAdapter,
  ProviderAdapterContext,
  ProviderCapabilityStatus,
  ProviderDiscoveredAccount,
  ProviderDiscoveredAsset,
  ProviderHealthStatus,
  ProviderVerificationResult,
} from './provider.types.js';

type GoogleBusinessOverview = {
  connected: boolean;
  apiReachable: boolean;
  reauthRequired: boolean;
  lastError: string | null;
  accounts: Array<Record<string, unknown>>;
  locations: Array<Record<string, unknown>>;
  summary: { accountCount: number; locationCount: number };
};

/**
 * Google Business is implemented in the workspace-app module because it still
 * owns the OAuth refresh and Google API details. This adapter deliberately
 * projects that canonical read/sync path into the Provider Control Plane so
 * verification, discovery and worker execution cannot disagree about the
 * provider's real state.
 */
export class GoogleBusinessAdapter implements ProviderAdapter {
  readonly providerKey = 'google_business';
  readonly runtimeFeatures = ['verification', 'health', 'capabilities', 'discovery', 'sync'] as const;

  private async overview(context: ProviderAdapterContext): Promise<GoogleBusinessOverview> {
    if (!context.workspaceId) {
      throw providerError('PROVIDER_WORKSPACE_CONTEXT_MISSING', 'Google Business requires a workspace context for OAuth and API access.', undefined, 409);
    }
    const { getGoogleBusinessOverview } = await import('../workspace-app/google-business.service.js');
    return getGoogleBusinessOverview(context.workspaceId) as Promise<GoogleBusinessOverview>;
  }

  async verifyConnection(context: ProviderAdapterContext): Promise<ProviderVerificationResult> {
    const overview = await this.overview(context);
    if (!overview.connected) {
      return {
        verified: false,
        status: 'AUTHORIZATION_REQUIRED',
        authorizationState: 'NOT_AUTHORIZED',
        healthStatus: 'AUTHORIZATION_REQUIRED',
        reason: 'Google Business is not connected for this workspace.',
      };
    }
    if (overview.reauthRequired) {
      return {
        verified: false,
        status: 'EXPIRED',
        authorizationState: 'REAUTH_REQUIRED',
        healthStatus: 'AUTHORIZATION_REQUIRED',
        reason: overview.lastError ?? 'Google Business authorization must be renewed.',
      };
    }
    if (!overview.apiReachable) {
      return {
        verified: false,
        status: 'ERROR',
        authorizationState: 'UNKNOWN',
        healthStatus: 'ERROR',
        reason: overview.lastError ?? 'Google Business could not be reached.',
      };
    }
    return {
      verified: true,
      status: 'CONNECTED' as const,
      authorizationState: 'AUTHORIZED',
      healthStatus: 'HEALTHY',
      reason: 'Google Business API is reachable and the workspace connection is authorized.',
      lastSuccessAt: new Date().toISOString(),
    };
  }

  async getHealth(context: ProviderAdapterContext): Promise<{ status: ProviderHealthStatus; reason: string }> {
    const overview = await this.overview(context);
    if (!overview.connected) return { status: 'DISCONNECTED', reason: 'Google Business is not connected for this workspace.' };
    if (overview.reauthRequired) return { status: 'AUTHORIZATION_REQUIRED', reason: overview.lastError ?? 'Google Business authorization must be renewed.' };
    if (!overview.apiReachable) return { status: 'ERROR', reason: overview.lastError ?? 'Google Business could not be reached.' };
    return { status: 'HEALTHY', reason: 'Google Business API is reachable.' };
  }

  async getCapabilities(context: ProviderAdapterContext) {
    const overview = await this.overview(context);
    let status: ProviderCapabilityStatus = 'AVAILABLE';
    let reason = 'Google Business API is reachable.';
    if (!overview.connected) { status = 'AUTHORIZATION_REQUIRED'; reason = 'Connect Google Business before using this capability.'; }
    else if (overview.reauthRequired) { status = 'AUTHORIZATION_REQUIRED'; reason = overview.lastError ?? 'Renew Google Business authorization.'; }
    else if (!overview.apiReachable) { status = 'ERROR'; reason = overview.lastError ?? 'Google Business API could not be reached.'; }
    return [
      'google_business.locations.read',
      'google_business.reviews.read',
      'google_business.reviews.reply',
    ].map((capabilityKey) => ({ capabilityKey, status, reason }));
  }

  async discoverAccounts(context: ProviderAdapterContext): Promise<ProviderDiscoveredAccount[]> {
    const overview = await this.overview(context);
    if (!overview.apiReachable) return [];
    return overview.accounts.map((account) => ({
      externalAccountId: String(account.id ?? account.name ?? ''),
      name: account.name == null ? null : String(account.name),
      accountType: account.type == null ? null : String(account.type),
      status: 'CONNECTED' as const,
      metadata: { locationCount: Number(account.locationCount ?? 0) },
    })).filter((account) => Boolean(account.externalAccountId));
  }

  async discoverAssets(context: ProviderAdapterContext, account: ProviderDiscoveredAccount): Promise<ProviderDiscoveredAsset[]> {
    const overview = await this.overview(context);
    if (!overview.apiReachable) return [];
    return overview.locations
      .filter((location) => String(location.accountId ?? '') === account.externalAccountId)
      .map((location) => ({
        externalAssetId: String(location.id ?? ''),
        assetType: 'location',
        displayName: location.title == null ? null : String(location.title),
        status: 'CONNECTED' as const,
        capabilities: { websiteUrl: location.websiteUrl == null ? null : String(location.websiteUrl), address: location.address == null ? '' : String(location.address) },
        metadata: { accountId: account.externalAccountId, storeCode: location.storeCode == null ? null : String(location.storeCode) },
      })).filter((asset) => Boolean(asset.externalAssetId));
  }

  async sync(context: ProviderAdapterContext, syncType: string) {
    const overview = await this.overview(context);
    if (!overview.connected) return { status: 'FAILED' as const, details: { code: 'GOOGLE_BUSINESS_NOT_CONNECTED', syncType } };
    if (overview.reauthRequired) return { status: 'FAILED' as const, details: { code: 'GOOGLE_BUSINESS_REAUTH_REQUIRED', syncType, reason: overview.lastError } };
    if (!overview.apiReachable) return { status: 'FAILED' as const, details: { code: 'GOOGLE_BUSINESS_API_UNAVAILABLE', syncType, reason: overview.lastError } };
    return {
      status: 'SUCCESS' as const,
      details: { syncType, accountCount: overview.summary.accountCount, locationCount: overview.summary.locationCount },
    };
  }
}
