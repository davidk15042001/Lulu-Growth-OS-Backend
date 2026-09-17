import { decryptSecret } from '../../utils/secret-box.js';
import { query } from '../../db/pool.js';
import { getPlatformOAuthCredential } from '../onboarding/onboarding.repo.js';
import { refreshStoredOAuthCredential } from '../onboarding/oauth.service.js';
import { AppError } from '../../utils/app-error.js';
import type {
  ProviderAdapter,
  ProviderAdapterContext,
  ProviderCapabilityStatus,
  ProviderDiscoveredAccount,
  ProviderDiscoveredAsset,
  ProviderHealthStatus,
  ProviderVerificationResult,
} from './provider.types.js';

type ShopifySettings = { shop: string | null; scopes: string[] };

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function shopDomain(value: unknown) {
  const shop = stringValue(value).toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : null;
}

function errorState(error: unknown) {
  if (error instanceof AppError && (error.status === 401 || error.code === 'SHOPIFY_NOT_CONNECTED' || error.code === 'SHOPIFY_REAUTH_REQUIRED')) return { status: 'AUTHORIZATION_REQUIRED' as const, authorizationState: 'REAUTH_REQUIRED' as const, healthStatus: 'AUTHORIZATION_REQUIRED' as const };
  if (error instanceof AppError && error.code === 'SHOPIFY_CONFIGURATION_MISSING') return { status: 'PROVIDER_REVIEW' as const, authorizationState: 'AUTHORIZED' as const, healthStatus: 'PROVIDER_REVIEW' as const };
  return { status: 'ERROR' as const, authorizationState: 'UNKNOWN' as const, healthStatus: 'ERROR' as const };
}

/** Read-only Shopify adapter backed by the workspace's canonical OAuth platform record. */
export class ShopifyAdapter implements ProviderAdapter {
  readonly providerKey = 'shopify';
  readonly runtimeFeatures = ['verification', 'health', 'capabilities', 'discovery', 'sync'] as const;

  private async settings(context: ProviderAdapterContext): Promise<ShopifySettings> {
    if (!context.workspaceId) throw new AppError(400, 'SHOPIFY_WORKSPACE_REQUIRED', 'Shopify verification requires a workspace context.');
    const platformId = stringValue(context.metadata.legacyPlatformId);
    if (!platformId) throw new AppError(503, 'SHOPIFY_CONFIGURATION_MISSING', 'The canonical Shopify platform record is missing.');
    const result = await query<{ settings: unknown; grantedScopes: string[] }>(
      `SELECT settings, granted_scopes AS "grantedScopes" FROM workspace_platforms WHERE id=$1 AND workspace_id=$2 AND integration_key='shopify' AND deleted_at IS NULL LIMIT 1`,
      [platformId, context.workspaceId],
    );
    const row = result.rows[0];
    if (!row) throw new AppError(503, 'SHOPIFY_CONFIGURATION_MISSING', 'The canonical Shopify platform record is missing.');
    return { shop: shopDomain(objectValue(row.settings).shop), scopes: Array.isArray(row.grantedScopes) ? row.grantedScopes.map(String) : [] };
  }

  private async token(context: ProviderAdapterContext) {
    if (!context.workspaceId) throw new AppError(400, 'SHOPIFY_WORKSPACE_REQUIRED', 'Shopify verification requires a workspace context.');
    const credential = await getPlatformOAuthCredential(context.workspaceId, 'shopify');
    if (!credential) throw new AppError(409, 'SHOPIFY_NOT_CONNECTED', 'Shopify is not connected for this workspace.');
    const expiresAt = credential.tokenExpiresAt ? Date.parse(credential.tokenExpiresAt) : null;
    if (expiresAt !== null && expiresAt <= Date.now() + 300_000) return refreshStoredOAuthCredential({ workspaceId: context.workspaceId, provider: 'shopify', encryptedRefreshToken: credential.encryptedRefreshToken });
    return decryptSecret(credential.encryptedAccessToken);
  }

  private async request(context: ProviderAdapterContext, shop: string, path: string) {
    const token = await this.token(context);
    let response: Response;
    try {
      response = await fetch(`https://${shop}${path}`, { headers: { accept: 'application/json', 'x-shopify-access-token': token }, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      throw new AppError(502, 'SHOPIFY_NETWORK_ERROR', 'Shopify did not return a definitive response.', { cause: error instanceof Error ? error.message : String(error) });
    }
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new AppError(response.status === 401 ? 401 : 502, response.status === 401 ? 'SHOPIFY_REAUTH_REQUIRED' : 'SHOPIFY_REQUEST_FAILED', 'Shopify rejected the read-only provider check.', { providerHttpStatus: response.status });
    return body;
  }

  async verifyConnection(context: ProviderAdapterContext): Promise<ProviderVerificationResult> {
    try {
      const settings = await this.settings(context);
      if (!settings.shop) return { verified: false, status: 'PROVIDER_REVIEW', authorizationState: 'AUTHORIZED', healthStatus: 'PROVIDER_REVIEW', reason: 'A valid Shopify myshopify.com domain is required before verification.' };
      const body = await this.request(context, settings.shop, '/admin/api/2024-10/shop.json');
      const shop = objectValue(body.shop);
      return { verified: true, status: 'CONNECTED', authorizationState: 'AUTHORIZED', healthStatus: 'HEALTHY', reason: `Shopify shop ${stringValue(shop.name) || settings.shop} is reachable through the canonical API path.`, lastSuccessAt: new Date().toISOString() };
    } catch (error) {
      const state = errorState(error);
      return { verified: false, ...state, reason: error instanceof Error ? error.message : 'Shopify verification failed.' };
    }
  }

  async getHealth(context: ProviderAdapterContext): Promise<{ status: ProviderHealthStatus; reason: string }> {
    const result = await this.verifyConnection(context);
    return { status: result.healthStatus, reason: result.reason };
  }

  async getCapabilities(context: ProviderAdapterContext) {
    const result = await this.verifyConnection(context);
    const settings: ShopifySettings = await this.settings(context).catch(() => ({ shop: null, scopes: [] }));
    const read: ProviderCapabilityStatus = result.status === 'CONNECTED' ? 'AVAILABLE' : result.status === 'AUTHORIZATION_REQUIRED' ? 'AUTHORIZATION_REQUIRED' : result.status === 'PROVIDER_REVIEW' ? 'PROVIDER_REVIEW' : 'ERROR';
    const orders: ProviderCapabilityStatus = read === 'AVAILABLE' && settings.scopes.includes('read_orders') ? 'AVAILABLE' : read === 'AVAILABLE' ? 'PROVIDER_REVIEW' : read;
    return [
      { capabilityKey: 'shopify.products.read', status: read, reason: result.reason },
      { capabilityKey: 'shopify.products.write', status: read === 'AVAILABLE' && settings.scopes.includes('write_products') ? 'PROVIDER_REVIEW' : read, reason: 'Product mutations require an explicit provider scope and remain conservatively gated.' },
      { capabilityKey: 'shopify.orders.read', status: orders, reason: orders === 'AVAILABLE' ? result.reason : 'Shopify read_orders scope is not recorded.' },
    ];
  }

  async discoverAccounts(context: ProviderAdapterContext): Promise<ProviderDiscoveredAccount[]> {
    const settings = await this.settings(context);
    if (!settings.shop) return [];
    const body = await this.request(context, settings.shop, '/admin/api/2024-10/shop.json');
    const shop = objectValue(body.shop);
    return [{ externalAccountId: stringValue(shop.id) || context.externalAccountId || settings.shop, name: stringValue(shop.name) || settings.shop, accountType: 'shopify_shop', status: 'CONNECTED', currency: stringValue(shop.currency) || null, country: stringValue(shop.country) || null, metadata: { shop: settings.shop, scopes: settings.scopes } }];
  }

  async discoverAssets(context: ProviderAdapterContext, account: ProviderDiscoveredAccount): Promise<ProviderDiscoveredAsset[]> {
    const settings = await this.settings(context);
    if (!settings.shop || account.metadata?.shop !== settings.shop) return [];
    const body = await this.request(context, settings.shop, '/admin/api/2024-10/products.json?limit=1&fields=id,title');
    const products = Array.isArray(body.products) ? body.products : [];
    return [{ externalAssetId: `${account.externalAccountId}:products`, assetType: 'shopify_products', displayName: 'Shopify products', status: 'CONNECTED', capabilities: { read: true }, metadata: { sampleCount: products.length, shop: settings.shop } }];
  }

  async sync(context: ProviderAdapterContext, syncType: string) {
    const result = await this.verifyConnection(context);
    return result.verified ? { status: 'SUCCESS' as const, details: { syncType, provider: this.providerKey } } : { status: 'FAILED' as const, details: { syncType, provider: this.providerKey, reason: result.reason } };
  }
}
