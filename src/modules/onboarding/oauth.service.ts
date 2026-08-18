import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { encryptSecret } from '../../utils/secret-box.js';
import { AppError } from '../../utils/app-error.js';
import * as repo from './onboarding.repo.js';

export type OAuthProvider = 'salesforce' | 'pipedrive' | 'hubspot' | 'google-ads' | 'google-analytics' | 'google-business' | 'meta' | 'linkedin' | 'webflow' | 'wordpress' | 'shopify';

type ProviderConfig = {
  clientId: string;
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  category: string;
  name: string;
};

type OAuthState = {
  provider: OAuthProvider;
  workspaceId: string;
  userId: string;
  nonce: string;
  exp: number;
  shop?: string;
};

const providerNames: Record<OAuthProvider, string> = {
  salesforce: 'Salesforce',
  pipedrive: 'Pipedrive',
  hubspot: 'HubSpot',
  'google-ads': 'Google Ads',
  'google-analytics': 'Google Analytics',
  'google-business': 'Google Business',
  meta: 'Meta Marketing',
  linkedin: 'LinkedIn Ads',
  webflow: 'Webflow',
  wordpress: 'WordPress',
  shopify: 'Shopify',
};

const providerCategories: Record<OAuthProvider, string> = {
  salesforce: 'crm',
  pipedrive: 'crm',
  hubspot: 'crm',
  'google-ads': 'marketing',
  'google-analytics': 'analytics',
  'google-business': 'digital-appearance',
  meta: 'marketing',
  linkedin: 'marketing',
  webflow: 'digital-appearance',
  wordpress: 'digital-appearance',
  shopify: 'digital-appearance',
};

function oauthError(provider: OAuthProvider, code: string, message: string, details?: Record<string, unknown>, status = 502) {
  return new AppError(status, code, message, { provider, ...(details ?? {}) });
}

const providerScopes: Record<OAuthProvider, string[]> = {
  salesforce: ['api', 'refresh_token', 'offline_access'],
  pipedrive: ['base'],
  hubspot: ['oauth', 'crm.objects.contacts.read'],
  'google-ads': ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/adwords'],
  'google-analytics': ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/analytics.readonly'],
  'google-business': ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/business.manage'],
  meta: ['ads_read', 'ads_management', 'business_management'],
  linkedin: ['openid', 'profile', 'email', 'r_ads_reporting'],
  webflow: ['sites:read', 'sites:write', 'cms:read', 'cms:write'],
  wordpress: ['global'],
  shopify: ['read_products', 'read_content'],
};

function callbackUrl(provider: OAuthProvider) {
  if (!env.OAUTH_CALLBACK_BASE_URL) throw oauthError(provider, 'OAUTH_CALLBACK_NOT_CONFIGURED', 'OAuth callback URL is not configured on the server', { requiredEnv: 'OAUTH_CALLBACK_BASE_URL' }, 500);
  return `${env.OAUTH_CALLBACK_BASE_URL.replace(/\/$/, '')}/onboarding/oauth/${provider}/callback`;
}

function providerConfig(provider: OAuthProvider): ProviderConfig {
  const common = { scopes: providerScopes[provider], category: providerCategories[provider], name: providerNames[provider] };
  switch (provider) {
    case 'salesforce':
      if (!env.SALESFORCE_CLIENT_ID || !env.SALESFORCE_CLIENT_SECRET) throw oauthError(provider, 'OAUTH_PROVIDER_CREDENTIALS_MISSING', 'Salesforce OAuth credentials are missing on the server', { requiredEnv: ['SALESFORCE_CLIENT_ID', 'SALESFORCE_CLIENT_SECRET'] }, 500);
      return { ...common, clientId: env.SALESFORCE_CLIENT_ID, clientSecret: env.SALESFORCE_CLIENT_SECRET, authorizationUrl: env.SALESFORCE_AUTH_URL, tokenUrl: env.SALESFORCE_TOKEN_URL };
    case 'pipedrive':
      if (!env.PIPEDRIVE_CLIENT_ID || !env.PIPEDRIVE_CLIENT_SECRET) throw oauthError(provider, 'OAUTH_PROVIDER_CREDENTIALS_MISSING', 'Pipedrive OAuth credentials are missing on the server', { requiredEnv: ['PIPEDRIVE_CLIENT_ID', 'PIPEDRIVE_CLIENT_SECRET'] }, 500);
      return { ...common, clientId: env.PIPEDRIVE_CLIENT_ID, clientSecret: env.PIPEDRIVE_CLIENT_SECRET, authorizationUrl: 'https://oauth.pipedrive.com/oauth/authorize', tokenUrl: 'https://oauth.pipedrive.com/oauth/token' };
    case 'hubspot':
      if (!env.HUBSPOT_CLIENT_ID || !env.HUBSPOT_CLIENT_SECRET) throw oauthError(provider, 'OAUTH_PROVIDER_CREDENTIALS_MISSING', 'HubSpot OAuth credentials are missing on the server', { requiredEnv: ['HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET'] }, 500);
      return { ...common, clientId: env.HUBSPOT_CLIENT_ID, clientSecret: env.HUBSPOT_CLIENT_SECRET, authorizationUrl: 'https://app.hubspot.com/oauth/authorize', tokenUrl: 'https://api.hubapi.com/oauth/v1/token' };
    case 'google-ads':
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_ADS_DEVELOPER_TOKEN) throw oauthError(provider, 'OAUTH_PROVIDER_CREDENTIALS_MISSING', 'Google Ads OAuth credentials or developer token are missing on the server', { requiredEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_ADS_DEVELOPER_TOKEN'] }, 500);
      return { ...common, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token' };
    case 'google-analytics':
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw oauthError(provider, 'OAUTH_PROVIDER_CREDENTIALS_MISSING', 'Google Analytics OAuth credentials are missing on the server', { requiredEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] }, 500);
      return { ...common, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token' };
    case 'google-business':
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw oauthError(provider, 'OAUTH_PROVIDER_CREDENTIALS_MISSING', 'Google Business OAuth credentials are missing on the server', { requiredEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], requiredScope: 'https://www.googleapis.com/auth/business.manage' }, 500);
      return { ...common, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token' };
    case 'meta':
      if (!env.META_CLIENT_ID || !env.META_CLIENT_SECRET) throw oauthError(provider, 'OAUTH_PROVIDER_CREDENTIALS_MISSING', 'Meta OAuth credentials are missing on the server', { requiredEnv: ['META_CLIENT_ID', 'META_CLIENT_SECRET'] }, 500);
      return { ...common, clientId: env.META_CLIENT_ID, clientSecret: env.META_CLIENT_SECRET, authorizationUrl: `https://www.facebook.com/${env.META_GRAPH_VERSION}/dialog/oauth`, tokenUrl: `https://graph.facebook.com/${env.META_GRAPH_VERSION}/oauth/access_token` };
    case 'linkedin':
      if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET) throw oauthError(provider, 'OAUTH_PROVIDER_CREDENTIALS_MISSING', 'LinkedIn OAuth credentials are missing on the server', { requiredEnv: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'] }, 500);
      return { ...common, clientId: env.LINKEDIN_CLIENT_ID, clientSecret: env.LINKEDIN_CLIENT_SECRET, authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken' };
    case 'webflow':
      if (!env.WEBFLOW_CLIENT_ID || !env.WEBFLOW_CLIENT_SECRET) throw oauthError(provider, 'OAUTH_PROVIDER_CREDENTIALS_MISSING', 'Webflow OAuth credentials are missing on the server', { requiredEnv: ['WEBFLOW_CLIENT_ID', 'WEBFLOW_CLIENT_SECRET'] }, 500);
      return { ...common, clientId: env.WEBFLOW_CLIENT_ID, clientSecret: env.WEBFLOW_CLIENT_SECRET, authorizationUrl: 'https://webflow.com/oauth/authorize', tokenUrl: 'https://api.webflow.com/oauth/access_token' };
    case 'wordpress':
      if (!env.WORDPRESS_CLIENT_ID || !env.WORDPRESS_CLIENT_SECRET) throw oauthError(provider, 'OAUTH_PROVIDER_CREDENTIALS_MISSING', 'WordPress.com OAuth credentials are missing on the server', { requiredEnv: ['WORDPRESS_CLIENT_ID', 'WORDPRESS_CLIENT_SECRET'] }, 500);
      return { ...common, clientId: env.WORDPRESS_CLIENT_ID, clientSecret: env.WORDPRESS_CLIENT_SECRET, authorizationUrl: 'https://public-api.wordpress.com/oauth2/authorize', tokenUrl: 'https://public-api.wordpress.com/oauth2/token' };
    case 'shopify':
      if (!env.SHOPIFY_CLIENT_ID || !env.SHOPIFY_CLIENT_SECRET) throw oauthError(provider, 'OAUTH_PROVIDER_CREDENTIALS_MISSING', 'Shopify OAuth credentials are missing on the server', { requiredEnv: ['SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'] }, 500);
      return { ...common, scopes: env.SHOPIFY_SCOPES.split(',').map((scope) => scope.trim()).filter(Boolean), clientId: env.SHOPIFY_CLIENT_ID, clientSecret: env.SHOPIFY_CLIENT_SECRET, authorizationUrl: '', tokenUrl: '' };
  }
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(value: string) {
  return crypto.createHmac('sha256', env.JWT_SECRET).update(value).digest('base64url');
}

function createState(state: OAuthState) {
  const payload = encode(state);
  return `${payload}.${sign(payload)}`;
}

function parseState(value: string): OAuthState {
  const [payload, signature] = value.split('.');
  if (!payload || !signature) throw oauthError('salesforce', 'OAUTH_STATE_INVALID', 'OAuth state is missing or malformed', undefined, 400);
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw oauthError('salesforce', 'OAUTH_STATE_SIGNATURE_INVALID', 'OAuth state signature is invalid or expired', undefined, 400);
  const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthState;
  if (!state.provider || !state.workspaceId || !state.userId || !state.nonce || state.exp < Date.now()) throw oauthError(state.provider ?? 'salesforce', 'OAUTH_STATE_EXPIRED', 'OAuth state is expired or incomplete', undefined, 400);
  return state;
}

export function buildAuthorizationUrl(provider: OAuthProvider, workspaceId: string, userId: string, shop?: string) {
  const config = providerConfig(provider);
  if (provider === 'shopify' && (!shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop))) throw oauthError(provider, 'SHOPIFY_SHOP_DOMAIN_INVALID', 'Shopify shop domain must use the format example.myshopify.com', { expectedFormat: 'example.myshopify.com' }, 400);
  const state = createState({ provider, workspaceId, userId, nonce: crypto.randomBytes(24).toString('base64url'), exp: Date.now() + 10 * 60 * 1_000, ...(shop ? { shop } : {}) });
  const url = provider === 'shopify' ? new URL(`https://${shop}/admin/oauth/authorize`) : new URL(config.authorizationUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', callbackUrl(provider));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('scope', config.scopes.join(' '));
  if (provider === 'google-ads' || provider === 'google-analytics' || provider === 'google-business') url.searchParams.set('access_type', 'offline');
  if (provider === 'google-ads' || provider === 'google-analytics' || provider === 'google-business') url.searchParams.set('prompt', 'consent');
  return url.toString();
}

async function exchangeCode(provider: OAuthProvider, code: string, state: OAuthState) {
  const config = providerConfig(provider);
  const tokenUrl = provider === 'shopify' && state.shop ? `https://${state.shop}/admin/oauth/access_token` : config.tokenUrl;
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl(provider), client_id: config.clientId, client_secret: config.clientSecret });
  const authorization = provider === 'pipedrive' ? `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}` : undefined;
  const response = await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(authorization ? { Authorization: authorization } : {}) }, body });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw oauthError(provider, 'OAUTH_TOKEN_EXCHANGE_FAILED', 'Provider rejected the authorization code', { providerHttpStatus: response.status }, 502);
  return data;
}

async function accountIdentity(provider: OAuthProvider, accessToken: string, tokenData: Record<string, unknown>, shop?: string) {
  if (provider === 'salesforce') return { id: typeof tokenData.id === 'string' ? tokenData.id : null, settings: { instanceUrl: tokenData.instance_url ?? null } };
  if (provider === 'pipedrive') return { id: tokenData.company_id ? String(tokenData.company_id) : tokenData.user_id ? String(tokenData.user_id) : null, settings: { apiDomain: tokenData.api_domain ?? null } };
  const endpoint = provider === 'hubspot'
    ? `https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`
    : provider === 'google-ads'
      ? 'https://openidconnect.googleapis.com/v1/userinfo'
      : provider === 'google-analytics'
        ? 'https://openidconnect.googleapis.com/v1/userinfo'
        : provider === 'google-business'
          ? 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts'
          : provider === 'meta'
        ? `https://graph.facebook.com/${env.META_GRAPH_VERSION}/me?fields=id,name`
        : provider === 'linkedin'
          ? 'https://api.linkedin.com/v2/userinfo'
          : provider === 'webflow'
            ? 'https://api.webflow.com/v2/sites'
            : provider === 'wordpress'
              ? 'https://public-api.wordpress.com/rest/v1.1/me'
              : shop ? `https://${shop}/admin/api/2024-10/shop.json` : (() => { throw new Error('Shopify shop domain is missing'); })();
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw oauthError(provider, 'OAUTH_ACCOUNT_LOOKUP_FAILED', 'Authorization succeeded but the provider account could not be read', { providerHttpStatus: response.status }, 502);
  const webflowSite = Array.isArray(data.sites) ? (data.sites[0] as Record<string, unknown> | undefined) : undefined;
  const shopData = data.shop as Record<string, unknown> | undefined;
  return { id: String(shopData?.id ?? webflowSite?.id ?? data.hub_id ?? data.sub ?? data.id ?? ''), settings: { accountName: shopData?.name ?? webflowSite?.name ?? data.name ?? data.email ?? null, shop: shop ?? null } };
}

export async function completeOAuthCallback(provider: OAuthProvider, code: string, stateValue: string) {
  const state = parseState(stateValue);
  if (state.provider !== provider) throw new Error('OAuth provider mismatch');
  const config = providerConfig(provider);
  const tokenData = await exchangeCode(provider, code, state);
  const accessToken = String(tokenData.access_token ?? '');
  if (!accessToken) throw oauthError(provider, 'OAUTH_ACCESS_TOKEN_MISSING', 'Provider response did not contain an access token', undefined, 502);
  const identity = await accountIdentity(provider, accessToken, tokenData, state.shop);
  const refreshToken = typeof tokenData.refresh_token === 'string' ? tokenData.refresh_token : null;
  const expiresIn = Number(tokenData.expires_in ?? 0);
  const tokenExpiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1_000).toISOString() : null;
  const scopes = typeof tokenData.scope === 'string' ? tokenData.scope.split(/[ ,]+/).filter(Boolean) : config.scopes;
  const platform = await repo.upsertPlatformOAuthCredential({
    workspaceId: state.workspaceId,
    integrationKey: provider,
    name: config.name,
    category: config.category,
    externalAccountId: identity.id,
    grantedScopes: scopes,
    encryptedAccessToken: encryptSecret(accessToken),
    encryptedRefreshToken: refreshToken ? encryptSecret(refreshToken) : null,
    tokenExpiresAt,
    settings: identity.settings,
  });
  await repo.setOnboardingStep(state.workspaceId, 'ai_preferences');
  return { platform, workspaceId: state.workspaceId };
}

export function isSupportedProvider(value: string): value is OAuthProvider {
  return ['salesforce', 'pipedrive', 'hubspot', 'google-ads', 'google-analytics', 'google-business', 'meta', 'linkedin', 'webflow', 'wordpress', 'shopify'].includes(value);
}
