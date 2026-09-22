import { AppError } from '../../utils/app-error.js';
import { isAirwallexConfigured, isAirwallexWebhookConfigured, verifyAirwallexConnection } from '../billing/airwallex.service.js';
import { env } from '../../config/env.js';
import type { ProviderAdapter, ProviderAdapterContext, ProviderCapabilityStatus, ProviderDiscoveredAccount, ProviderDiscoveredAsset, ProviderHealthStatus, ProviderVerificationResult } from './provider.types.js';

function errorState(error: unknown): Pick<ProviderVerificationResult, 'status' | 'authorizationState' | 'healthStatus'> {
  if (error instanceof AppError && error.status === 401) return { status: 'AUTHORIZATION_REQUIRED', authorizationState: 'REAUTH_REQUIRED', healthStatus: 'AUTHORIZATION_REQUIRED' };
  return { status: 'ERROR', authorizationState: 'UNKNOWN', healthStatus: 'ERROR' };
}

/**
 * Read-only Provider Control Plane adapter for the existing Airwallex billing
 * service. Probes authenticate against Airwallex only; they never create a
 * checkout, invoice, payment intent, payout, or wallet credit.
 */
export class AirwallexAdapter implements ProviderAdapter {
  readonly providerKey = 'airwallex';
  readonly runtimeFeatures = ['verification', 'health', 'capabilities', 'discovery', 'sync'] as const;

  async verifyConnection(_context: ProviderAdapterContext): Promise<ProviderVerificationResult> {
    if (!isAirwallexConfigured()) return { verified: false, status: 'AUTHORIZATION_REQUIRED', authorizationState: 'NOT_AUTHORIZED', healthStatus: 'AUTHORIZATION_REQUIRED', reason: 'Airwallex client credentials are not configured.' };
    try {
      const result = await verifyAirwallexConnection();
      return { verified: result.authenticated, status: 'CONNECTED', authorizationState: 'AUTHORIZED', healthStatus: 'HEALTHY', reason: 'Airwallex authentication and account context are reachable.', lastSuccessAt: new Date().toISOString() };
    } catch (error) {
      const state = errorState(error);
      return { verified: false, ...state, reason: error instanceof Error ? error.message : 'Airwallex verification failed.' };
    }
  }

  async getHealth(context: ProviderAdapterContext) {
    const result = await this.verifyConnection(context);
    return { status: result.healthStatus, reason: result.reason } as { status: ProviderHealthStatus; reason: string };
  }

  async getCapabilities(context: ProviderAdapterContext): Promise<Array<{ capabilityKey: string; status: ProviderCapabilityStatus; reason?: string }>> {
    const verification = await this.verifyConnection(context);
    const status: ProviderCapabilityStatus = verification.status === 'CONNECTED'
      ? 'AVAILABLE'
      : verification.status === 'AUTHORIZATION_REQUIRED'
        ? 'AUTHORIZATION_REQUIRED'
        : 'ERROR';
    const configuredCheckout = Boolean(env.AIRWALLEX_LINKED_PAYMENT_ACCOUNT_ID);
    const checkoutStatus: ProviderCapabilityStatus = status === 'AVAILABLE' && configuredCheckout ? 'AVAILABLE' : status === 'AVAILABLE' ? 'UNCONFIRMED' : status;
    return [
      { capabilityKey: 'airwallex.subscription.billing', status, reason: verification.reason },
      { capabilityKey: 'airwallex.payment.checkout', status: checkoutStatus, reason: configuredCheckout ? verification.reason : 'A linked payment account is required before hosted checkout is available.' },
      { capabilityKey: 'airwallex.connected_accounts', status: 'UNCONFIRMED' as const, reason: 'Connected-account operations are not exposed by the Lulu billing adapter.' },
      { capabilityKey: 'airwallex.funds_split', status: 'UNCONFIRMED' as const, reason: 'Funds-split operations require a separate verified Airwallex contract.' },
      { capabilityKey: 'airwallex.payouts', status, reason: verification.verified ? 'Direct beneficiary transfers are available through the verified Airwallex Transfers API.' : verification.reason },
    ];
  }

  async discoverAccounts(context: ProviderAdapterContext): Promise<ProviderDiscoveredAccount[]> {
    const verification = await this.verifyConnection(context);
    if (!verification.verified) return [];
    const externalAccountId = env.AIRWALLEX_LOGIN_AS ?? 'airwallex:platform';
    return [{ externalAccountId, name: 'Lulu Airwallex billing account', accountType: 'billing_platform', status: 'CONNECTED', metadata: { baseUrl: env.AIRWALLEX_BASE_URL, loginAsConfigured: Boolean(env.AIRWALLEX_LOGIN_AS), webhookConfigured: isAirwallexWebhookConfigured() } }];
  }

  async discoverAssets(context: ProviderAdapterContext, account: ProviderDiscoveredAccount): Promise<ProviderDiscoveredAsset[]> {
    const accounts = await this.discoverAccounts(context);
    if (!accounts.some((candidate) => candidate.externalAccountId === account.externalAccountId)) return [];
    return [{ externalAssetId: `${account.externalAccountId}:billing`, assetType: 'airwallex_billing', displayName: 'Airwallex billing and wallet settlement', status: 'CONNECTED', capabilities: { subscriptionBilling: true, hostedCheckout: Boolean(env.AIRWALLEX_LINKED_PAYMENT_ACCOUNT_ID), webhook: isAirwallexWebhookConfigured() }, metadata: { provider: 'airwallex' } }];
  }

  async sync(context: ProviderAdapterContext, syncType: string) {
    const verification = await this.verifyConnection(context);
    if (!verification.verified) return { status: 'FAILED' as const, details: { syncType, code: 'AIRWALLEX_UNAVAILABLE', reason: verification.reason } };
    return { status: 'SUCCESS' as const, details: { syncType, authenticated: true, webhookConfigured: isAirwallexWebhookConfigured() } };
  }
}
