import { AppError } from '../../utils/app-error.js';
import type {
  ProviderAdapter,
  ProviderAdapterContext,
  ProviderCapabilityStatus,
  ProviderCatalogEntry,
  ProviderDiscoveredAccount,
  ProviderDiscoveredAsset,
  ProviderAdapterFeature,
  ProviderHealthStatus,
  ProviderRuntimeReadiness,
  ProviderVerificationResult,
} from './provider.types.js';
import { UnifyPortAdapter } from './unifyport.adapter.js';
import { TwilioAdapter } from './twilio.adapter.js';
import { GoogleBusinessAdapter } from './google-business.adapter.js';
import { ManagedWebsiteAdapter } from './managed-website.adapter.js';

const providerAliases: Record<string, string> = {
  'google-ads': 'google_ads',
  google_ads: 'google_ads',
  'google-analytics': 'google_analytics',
  google_analytics: 'google_analytics',
  'google-business': 'google_business',
  google_business: 'google_business',
  'tiktok-ads': 'tiktok_ads',
  tiktok_ads: 'tiktok_ads',
  microsoft: 'microsoft_email',
  microsoft_email: 'microsoft_email',
  calcom: 'cal_com',
  'cal-com': 'cal_com',
  'imap/smtp': 'imap_smtp',
  'imap-smtp': 'imap_smtp',
  'unify-port': 'unifyport',
  unify_port: 'unifyport',
  'twilio-messaging': 'twilio',
};

export function canonicalProviderKey(value: string) {
  const normalized = value.trim().toLowerCase();
  return (providerAliases[normalized] ?? normalized.replaceAll('-', '_').replaceAll(' ', '_')) || 'custom';
}

export function providerError(code: string, message: string, details?: Record<string, unknown>, status = 400) {
  return new AppError(status, code, message, details);
}

/**
 * The registry is a catalog, not proof that an external operation is usable.
 * Runtime capability state is always resolved from the connection and adapter.
 */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  { providerKey: 'google_ads', displayName: 'Google Ads', category: 'ADVERTISING', implementationStatus: 'PARTIAL', defaultMode: 'LULU_MANAGED', capabilities: ['google_ads.campaign.read', 'google_ads.campaign.create', 'google_ads.campaign.update', 'google_ads.campaign.pause', 'google_ads.spend.read'].map((capabilityKey) => ({ capabilityKey, displayName: capabilityKey, requiredScopes: [], defaultStatus: 'UNCONFIRMED' as ProviderCapabilityStatus })) },
  { providerKey: 'google_analytics', displayName: 'Google Analytics', category: 'ANALYTICS', implementationStatus: 'PARTIAL', defaultMode: 'LULU_MANAGED', capabilities: [{ capabilityKey: 'google_analytics.reporting.read', displayName: 'Read analytics reporting', requiredScopes: [], defaultStatus: 'UNCONFIRMED' }] },
  { providerKey: 'google_business', displayName: 'Google Business Profile', category: 'LOCAL', implementationStatus: 'IMPLEMENTED', defaultMode: 'CUSTOMER_OWNED', capabilities: [{ capabilityKey: 'google_business.locations.read', displayName: 'Read Business Profile locations', requiredScopes: [], defaultStatus: 'AVAILABLE' }, { capabilityKey: 'google_business.reviews.read', displayName: 'Read Business Profile reviews', requiredScopes: [], defaultStatus: 'AVAILABLE' }, { capabilityKey: 'google_business.reviews.reply', displayName: 'Reply to reviews', requiredScopes: [], defaultStatus: 'AVAILABLE' }] },
  { providerKey: 'google_calendar', displayName: 'Google Calendar', category: 'CALENDAR', implementationStatus: 'IMPLEMENTED', defaultMode: 'CUSTOMER_OWNED', capabilities: [{ capabilityKey: 'calendar.read', displayName: 'Read calendar', requiredScopes: [], defaultStatus: 'AVAILABLE' }, { capabilityKey: 'calendar.write', displayName: 'Write calendar', requiredScopes: [], defaultStatus: 'UNCONFIRMED' }] },
  { providerKey: 'meta', displayName: 'Meta', category: 'ADVERTISING', implementationStatus: 'PARTIAL', defaultMode: 'LULU_MANAGED', capabilities: [{ capabilityKey: 'meta.ads.manage', displayName: 'Manage Meta ads', requiredScopes: [], defaultStatus: 'PROVIDER_REVIEW' }, { capabilityKey: 'meta.ads.read_spend', displayName: 'Read Meta spend', requiredScopes: [], defaultStatus: 'UNCONFIRMED' }] },
  { providerKey: 'facebook', displayName: 'Facebook', category: 'SOCIAL', implementationStatus: 'PARTIAL', defaultMode: 'LULU_MANAGED', capabilities: [{ capabilityKey: 'facebook.pages.publish', displayName: 'Publish Facebook Page posts', requiredScopes: ['pages_manage_posts','pages_read_engagement'], defaultStatus: 'AUTHORIZATION_REQUIRED' }] },
  { providerKey: 'facebook_messenger', displayName: 'Facebook Messenger', category: 'MESSAGING', implementationStatus: 'IMPLEMENTED', defaultMode: 'LULU_MANAGED', capabilities: [] },
  { providerKey: 'instagram', displayName: 'Instagram', category: 'SOCIAL', implementationStatus: 'PARTIAL', defaultMode: 'LULU_MANAGED', capabilities: [{ capabilityKey: 'instagram.content.publish', displayName: 'Publish Instagram content', requiredScopes: ['instagram_basic','instagram_content_publish','pages_show_list','pages_read_engagement'], defaultStatus: 'AUTHORIZATION_REQUIRED' }] },
  { providerKey: 'whatsapp', displayName: 'WhatsApp', category: 'MESSAGING', implementationStatus: 'IMPLEMENTED', defaultMode: 'LULU_MANAGED', capabilities: [{ capabilityKey: 'whatsapp.messages.send', displayName: 'Send WhatsApp messages', requiredScopes: [], defaultStatus: 'AVAILABLE' as ProviderCapabilityStatus }] },
  { providerKey: 'twilio', displayName: 'Twilio', category: 'MESSAGING', implementationStatus: 'IMPLEMENTED', defaultMode: 'LULU_MANAGED', capabilities: [
    { capabilityKey: 'twilio.messages.send', displayName: 'Send messages', requiredScopes: [], defaultStatus: 'AVAILABLE' },
    { capabilityKey: 'twilio.messages.receive', displayName: 'Receive messages', requiredScopes: [], defaultStatus: 'AVAILABLE' },
    { capabilityKey: 'twilio.messages.status', displayName: 'Receive delivery status', requiredScopes: [], defaultStatus: 'AVAILABLE' },
  ] },
  { providerKey: 'unifyport', displayName: 'UnifyPort (WhatsApp beta)', category: 'MESSAGING', implementationStatus: 'PARTIAL', defaultMode: 'LULU_MANAGED', capabilities: [
    { capabilityKey: 'unifyport.workspace.read', displayName: 'Read UnifyPort workspace', requiredScopes: [], defaultStatus: 'AUTHORIZATION_REQUIRED' },
    { capabilityKey: 'unifyport.accounts.read', displayName: 'Read channel accounts', requiredScopes: [], defaultStatus: 'AUTHORIZATION_REQUIRED' },
    { capabilityKey: 'unifyport.accounts.manage', displayName: 'Manage channel accounts', requiredScopes: [], defaultStatus: 'AUTHORIZATION_REQUIRED' },
    { capabilityKey: 'unifyport.messages.send', displayName: 'Send channel messages', requiredScopes: [], defaultStatus: 'UNCONFIRMED' },
    { capabilityKey: 'unifyport.messages.read', displayName: 'Receive channel messages', requiredScopes: [], defaultStatus: 'UNCONFIRMED' },
  ] },
  { providerKey: 'lulu_managed_website', displayName: 'Lulu Managed Website', category: 'WEBSITE', implementationStatus: 'IMPLEMENTED', defaultMode: 'LULU_MANAGED', capabilities: [
    { capabilityKey: 'website.site.read', displayName: 'Read managed website', requiredScopes: [], defaultStatus: 'AVAILABLE' },
    { capabilityKey: 'website.site.preview', displayName: 'Read managed website preview', requiredScopes: [], defaultStatus: 'AVAILABLE' },
    { capabilityKey: 'website.site.publish', displayName: 'Publish verified managed website plan', requiredScopes: [], defaultStatus: 'AVAILABLE' },
    { capabilityKey: 'website.domain.verify', displayName: 'Verify managed website domain ownership', requiredScopes: [], defaultStatus: 'AVAILABLE' },
  ] },
  { providerKey: 'wordpress', displayName: 'WordPress', category: 'WEBSITE', implementationStatus: 'PARTIAL', defaultMode: 'HYBRID', capabilities: [{ capabilityKey: 'wordpress.site.read', displayName: 'Read website', requiredScopes: [], defaultStatus: 'AVAILABLE' }, { capabilityKey: 'wordpress.site.publish', displayName: 'Publish website content', requiredScopes: [], defaultStatus: 'UNCONFIRMED' }, { capabilityKey: 'wordpress.media.upload', displayName: 'Upload media', requiredScopes: [], defaultStatus: 'UNCONFIRMED' }] },
  { providerKey: 'webflow', displayName: 'Webflow', category: 'WEBSITE', implementationStatus: 'PARTIAL', defaultMode: 'CUSTOMER_OWNED', capabilities: [{ capabilityKey: 'webflow.site.read', displayName: 'Read Webflow sites', requiredScopes: [], defaultStatus: 'AVAILABLE' }, { capabilityKey: 'webflow.cms.write', displayName: 'Write CMS content', requiredScopes: [], defaultStatus: 'UNCONFIRMED' }] },
  { providerKey: 'shopify', displayName: 'Shopify', category: 'COMMERCE', implementationStatus: 'PARTIAL', defaultMode: 'CUSTOMER_OWNED', capabilities: [{ capabilityKey: 'shopify.products.read', displayName: 'Read products', requiredScopes: [], defaultStatus: 'AVAILABLE' }, { capabilityKey: 'shopify.products.write', displayName: 'Write products', requiredScopes: [], defaultStatus: 'UNCONFIRMED' }, { capabilityKey: 'shopify.orders.read', displayName: 'Read orders', requiredScopes: [], defaultStatus: 'UNCONFIRMED' }] },
  { providerKey: 'airwallex', displayName: 'Airwallex', category: 'PAYMENTS', implementationStatus: 'IMPLEMENTED', defaultMode: 'LULU_MANAGED', capabilities: [{ capabilityKey: 'airwallex.subscription.billing', displayName: 'Manage Lulu subscription billing', requiredScopes: [], defaultStatus: 'AVAILABLE' }, { capabilityKey: 'airwallex.payment.checkout', displayName: 'Create buyer payment checkout', requiredScopes: [], defaultStatus: 'UNCONFIRMED' }, { capabilityKey: 'airwallex.connected_accounts', displayName: 'Manage connected accounts', requiredScopes: [], defaultStatus: 'UNCONFIRMED' }, { capabilityKey: 'airwallex.funds_split', displayName: 'Split funds', requiredScopes: [], defaultStatus: 'UNCONFIRMED' }, { capabilityKey: 'airwallex.payouts', displayName: 'Create payouts', requiredScopes: [], defaultStatus: 'UNCONFIRMED' }] },
  { providerKey: 'gmail', displayName: 'Gmail', category: 'EMAIL', implementationStatus: 'IMPLEMENTED', defaultMode: 'CUSTOMER_OWNED', capabilities: [{ capabilityKey: 'email.read', displayName: 'Read email', requiredScopes: [], defaultStatus: 'AVAILABLE' }, { capabilityKey: 'email.send', displayName: 'Send email', requiredScopes: [], defaultStatus: 'AVAILABLE' }] },
  { providerKey: 'microsoft_email', displayName: 'Microsoft Email', category: 'EMAIL', implementationStatus: 'IMPLEMENTED', defaultMode: 'CUSTOMER_OWNED', capabilities: [{ capabilityKey: 'email.read', displayName: 'Read email', requiredScopes: [], defaultStatus: 'AVAILABLE' }, { capabilityKey: 'email.send', displayName: 'Send email', requiredScopes: [], defaultStatus: 'AVAILABLE' }] },
  { providerKey: 'imap_smtp', displayName: 'IMAP/SMTP', category: 'EMAIL', implementationStatus: 'IMPLEMENTED', defaultMode: 'CUSTOMER_OWNED', capabilities: [{ capabilityKey: 'email.read', displayName: 'Read email', requiredScopes: [], defaultStatus: 'AVAILABLE' }, { capabilityKey: 'email.send', displayName: 'Send email', requiredScopes: [], defaultStatus: 'AVAILABLE' }] },
  { providerKey: 'microsoft_calendar', displayName: 'Microsoft Calendar', category: 'CALENDAR', implementationStatus: 'IMPLEMENTED', defaultMode: 'CUSTOMER_OWNED', capabilities: [{ capabilityKey: 'calendar.read', displayName: 'Read calendar', requiredScopes: [], defaultStatus: 'AVAILABLE' }] },
  { providerKey: 'calendly', displayName: 'Calendly', category: 'CALENDAR', implementationStatus: 'PARTIAL', defaultMode: 'CUSTOMER_OWNED', capabilities: [] },
  { providerKey: 'cal_com', displayName: 'Cal.com', category: 'CALENDAR', implementationStatus: 'PARTIAL', defaultMode: 'CUSTOMER_OWNED', capabilities: [] },
  { providerKey: 'salesforce', displayName: 'Salesforce', category: 'CRM', implementationStatus: 'PARTIAL', defaultMode: 'CUSTOMER_OWNED', capabilities: [] },
  { providerKey: 'hubspot', displayName: 'HubSpot', category: 'CRM', implementationStatus: 'PARTIAL', defaultMode: 'CUSTOMER_OWNED', capabilities: [] },
  { providerKey: 'pipedrive', displayName: 'Pipedrive', category: 'CRM', implementationStatus: 'PARTIAL', defaultMode: 'CUSTOMER_OWNED', capabilities: [] },
  { providerKey: 'linkedin', displayName: 'LinkedIn', category: 'ADVERTISING', implementationStatus: 'PARTIAL', defaultMode: 'LULU_MANAGED', capabilities: [] },
  { providerKey: 'tiktok_ads', displayName: 'TikTok Ads', category: 'ADVERTISING', implementationStatus: 'PARTIAL', defaultMode: 'LULU_MANAGED', capabilities: [] },
  { providerKey: 'custom', displayName: 'Custom Provider', category: 'OTHER', implementationStatus: 'NOT_IMPLEMENTED', defaultMode: 'CUSTOMER_OWNED', capabilities: [] },
];

class ConservativeLegacyAdapter implements ProviderAdapter {
  constructor(public readonly providerKey: string) {}

  readonly runtimeFeatures: ProviderAdapterFeature[] = ['verification'];

  async verifyConnection(context: ProviderAdapterContext): Promise<ProviderVerificationResult> {
    if (!context.externalAccountId) return { verified: false, status: 'AUTHORIZATION_REQUIRED', authorizationState: 'NOT_AUTHORIZED', healthStatus: 'AUTHORIZATION_REQUIRED', reason: 'No external provider account has been discovered.' };
    if (context.grantedScopes.length === 0) return { verified: false, status: 'AUTHORIZATION_REQUIRED', authorizationState: 'UNKNOWN', healthStatus: 'UNKNOWN', reason: 'The connection has no recorded provider scopes.' };
    return { verified: false, status: 'PROVIDER_REVIEW', authorizationState: 'AUTHORIZED', healthStatus: 'PROVIDER_REVIEW', reason: 'OAuth metadata is present; a provider API verification call is required before this connection is considered usable.' };
  }

  async getHealth(_context: ProviderAdapterContext): Promise<{ status: ProviderHealthStatus; reason: string }> {
    return { status: 'UNKNOWN', reason: 'No provider-specific health probe is registered.' };
  }

  async getCapabilities(_context: ProviderAdapterContext) {
    return [] as Array<{ capabilityKey: string; status: ProviderCapabilityStatus; reason?: string }>;
  }

  async discoverAccounts(_context: ProviderAdapterContext): Promise<ProviderDiscoveredAccount[]> { return []; }
  async discoverAssets(_context: ProviderAdapterContext, _account: ProviderDiscoveredAccount): Promise<ProviderDiscoveredAsset[]> { return []; }
}

const adapters = new Map<string, ProviderAdapter>(PROVIDER_CATALOG.map((entry) => [entry.providerKey, new ConservativeLegacyAdapter(entry.providerKey)]));
adapters.set('unifyport', new UnifyPortAdapter());
adapters.set('twilio', new TwilioAdapter());
adapters.set('google_business', new GoogleBusinessAdapter());
adapters.set('lulu_managed_website', new ManagedWebsiteAdapter());

export function getProviderAdapter(providerKey: string) {
  const adapter = adapters.get(canonicalProviderKey(providerKey));
  if (!adapter) throw providerError('PROVIDER_NOT_REGISTERED', 'This provider is not registered in the Provider Control Plane', { provider: providerKey }, 404);
  return adapter;
}

/** Describe the operations that are really wired to the adapter at runtime.
 * The catalog is deliberately broader than the adapter registry because it
 * also documents planned/legacy providers. Callers must use this projection
 * before scheduling work or presenting a provider as executable. */
export function getProviderRuntimeReadiness(providerKey: string): ProviderRuntimeReadiness {
  const adapter = adapters.get(canonicalProviderKey(providerKey));
  if (!adapter) return { adapterRegistered: false, supportedFeatures: [] };
  if (adapter.runtimeFeatures) return { adapterRegistered: true, supportedFeatures: [...adapter.runtimeFeatures] };
  const supportedFeatures: ProviderAdapterFeature[] = ['verification'];
  if (typeof adapter.getHealth === 'function') supportedFeatures.push('health');
  if (typeof adapter.getCapabilities === 'function') supportedFeatures.push('capabilities');
  if (typeof adapter.discoverAccounts === 'function' || typeof adapter.discoverAssets === 'function') supportedFeatures.push('discovery');
  if (typeof adapter.sync === 'function') supportedFeatures.push('sync');
  if (typeof adapter.handleWebhook === 'function') supportedFeatures.push('webhook');
  return { adapterRegistered: true, supportedFeatures };
}

export function getProviderCatalogEntry(providerKey: string) {
  return PROVIDER_CATALOG.find((entry) => entry.providerKey === canonicalProviderKey(providerKey));
}

export function isProviderRegistered(providerKey: string) {
  return Boolean(getProviderCatalogEntry(providerKey));
}
