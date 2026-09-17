import { AppError } from '../../utils/app-error.js';
import { isGoogleAdsPrepaidConfigured, verifyGoogleAdsAccount } from '../adspend/google-ads-spend.service.js';
import type { ProviderAdapter, ProviderAdapterContext, ProviderCapabilityStatus, ProviderDiscoveredAccount, ProviderDiscoveredAsset, ProviderHealthStatus, ProviderVerificationResult } from './provider.types.js';

function stateFor(error: unknown): Pick<ProviderVerificationResult, 'status' | 'authorizationState' | 'healthStatus'> {
  if (error instanceof AppError && ['GOOGLE_ADS_NOT_CONNECTED', 'GOOGLE_ADS_CONFIGURATION_MISSING'].includes(error.code)) {
    return { status: 'AUTHORIZATION_REQUIRED', authorizationState: 'NOT_AUTHORIZED', healthStatus: 'AUTHORIZATION_REQUIRED' };
  }
  if (error instanceof AppError && error.status === 401) return { status: 'AUTHORIZATION_REQUIRED', authorizationState: 'REAUTH_REQUIRED', healthStatus: 'AUTHORIZATION_REQUIRED' };
  return { status: 'ERROR', authorizationState: 'UNKNOWN', healthStatus: 'ERROR' };
}

function customerId(context: ProviderAdapterContext) {
  const value = context.externalAccountId?.trim();
  return value && /^[0-9-]+$/.test(value) ? value : null;
}

export class GoogleAdsAdapter implements ProviderAdapter {
  readonly providerKey = 'google_ads';
  readonly runtimeFeatures = ['verification', 'health', 'capabilities', 'discovery', 'sync'] as const;

  async verifyConnection(context: ProviderAdapterContext): Promise<ProviderVerificationResult> {
    if (!context.workspaceId) return { verified: false, status: 'AUTHORIZATION_REQUIRED', authorizationState: 'NOT_AUTHORIZED', healthStatus: 'AUTHORIZATION_REQUIRED', reason: 'Google Ads verification requires a workspace context.' };
    const account = customerId(context);
    if (!account) return { verified: false, status: 'AUTHORIZATION_REQUIRED', authorizationState: 'NOT_AUTHORIZED', healthStatus: 'AUTHORIZATION_REQUIRED', reason: 'A Google Ads customer account ID is required before verification.' };
    try {
      await verifyGoogleAdsAccount(context.workspaceId, account);
      return { verified: true, status: 'CONNECTED', authorizationState: 'AUTHORIZED', healthStatus: 'HEALTHY', reason: `Google Ads customer ${account.replaceAll('-', '')} is reachable through the verified OAuth/API path.`, lastSuccessAt: new Date().toISOString() };
    } catch (error) {
      const state = stateFor(error);
      return { verified: false, ...state, reason: error instanceof Error ? error.message : 'Google Ads verification failed.' };
    }
  }

  async getHealth(context: ProviderAdapterContext) {
    const result = await this.verifyConnection(context);
    return { status: result.healthStatus, reason: result.reason } as { status: ProviderHealthStatus; reason: string };
  }

  async getCapabilities(context: ProviderAdapterContext): Promise<Array<{ capabilityKey: string; status: ProviderCapabilityStatus; reason?: string }>> {
    const verification = await this.verifyConnection(context);
    const readStatus: ProviderCapabilityStatus = verification.status === 'CONNECTED' ? 'AVAILABLE' : verification.status === 'AUTHORIZATION_REQUIRED' ? 'AUTHORIZATION_REQUIRED' : 'ERROR';
    const writeStatus: ProviderCapabilityStatus = readStatus !== 'AVAILABLE' ? readStatus : isGoogleAdsPrepaidConfigured() ? 'AVAILABLE' : 'PROVIDER_REVIEW';
    const writeReason = isGoogleAdsPrepaidConfigured() ? verification.reason : 'Managed prepaid payer mapping must be verified before campaign mutations are enabled.';
    return [
      { capabilityKey: 'google_ads.campaign.read', status: readStatus, reason: verification.reason },
      { capabilityKey: 'google_ads.spend.read', status: readStatus, reason: verification.reason },
      { capabilityKey: 'google_ads.campaign.create', status: writeStatus, reason: writeReason },
      { capabilityKey: 'google_ads.campaign.update', status: writeStatus, reason: writeReason },
      { capabilityKey: 'google_ads.campaign.pause', status: writeStatus, reason: writeReason },
    ];
  }

  async discoverAccounts(context: ProviderAdapterContext): Promise<ProviderDiscoveredAccount[]> {
    const account = customerId(context);
    if (!account || !context.workspaceId) return [];
    try {
      const probe = await verifyGoogleAdsAccount(context.workspaceId, account);
      return [{ externalAccountId: probe.customerId, name: `Google Ads ${probe.customerId}`, accountType: 'customer', status: 'CONNECTED', currency: probe.currency, metadata: { requestId: probe.requestId, prepaidPayerConfigured: isGoogleAdsPrepaidConfigured() } }];
    } catch { return []; }
  }

  async discoverAssets(context: ProviderAdapterContext, account: ProviderDiscoveredAccount): Promise<ProviderDiscoveredAsset[]> {
    const discovered = await this.discoverAccounts(context);
    if (!discovered.some((candidate) => candidate.externalAccountId === account.externalAccountId)) return [];
    return [{ externalAssetId: `${account.externalAccountId}:campaigns`, assetType: 'google_ads_campaigns', displayName: 'Google Ads campaigns', status: 'CONNECTED', capabilities: { read: true, mutate: isGoogleAdsPrepaidConfigured() }, metadata: { customerId: account.externalAccountId } }];
  }

  async sync(context: ProviderAdapterContext, syncType: string) {
    const verification = await this.verifyConnection(context);
    if (!verification.verified) return { status: 'FAILED' as const, details: { syncType, code: 'GOOGLE_ADS_UNAVAILABLE', reason: verification.reason } };
    return { status: 'SUCCESS' as const, details: { syncType, customerId: customerId(context), prepaidPayerConfigured: isGoogleAdsPrepaidConfigured() } };
  }
}
