import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import { encryptSecret } from '../../utils/secret-box.js';
import * as repo from './email.repo.js';
import type { EmailProvider } from './email.types.js';

export type EmailOAuthProvider = Extract<EmailProvider, 'google' | 'microsoft'>;

type OAuthState = {
  provider: EmailOAuthProvider;
  workspaceId: string;
  userId: string;
  nonce: string;
  exp: number;
  returnTo?: string;
};

function encode(value: unknown) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function sign(value: string) { return crypto.createHmac('sha256', env.JWT_SECRET).update(value).digest('base64url'); }

function createState(value: OAuthState) {
  const payload = encode(value);
  return `${payload}.${sign(payload)}`;
}

function parseState(value: string) {
  const [payload, signature] = value.split('.');
  if (!payload || !signature) throw new AppError(400, 'EMAIL_OAUTH_STATE_INVALID', 'Email connection state is invalid');
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new AppError(400, 'EMAIL_OAUTH_STATE_INVALID', 'Email connection state could not be verified');
  }
  const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthState;
  if (!state.workspaceId || !state.userId || !['google', 'microsoft'].includes(state.provider)) throw new AppError(400, 'EMAIL_OAUTH_STATE_INVALID', 'Email connection state is incomplete');
  if (!state.exp || state.exp < Math.floor(Date.now() / 1000)) throw new AppError(400, 'EMAIL_OAUTH_STATE_EXPIRED', 'Email connection state expired');
  return state;
}

function credentials(provider: EmailOAuthProvider) {
  if (provider === 'google') {
    const clientId = env.EMAIL_GOOGLE_CLIENT_ID ?? env.GOOGLE_CLIENT_ID;
    const clientSecret = env.EMAIL_GOOGLE_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new AppError(503, 'EMAIL_PROVIDER_NOT_CONFIGURED', 'Google email OAuth is not configured', { requiredEnv: ['EMAIL_GOOGLE_CLIENT_ID', 'EMAIL_GOOGLE_CLIENT_SECRET'] });
    return { clientId, clientSecret };
  }
  if (!env.EMAIL_MICROSOFT_CLIENT_ID || !env.EMAIL_MICROSOFT_CLIENT_SECRET) {
    throw new AppError(503, 'EMAIL_PROVIDER_NOT_CONFIGURED', 'Microsoft email OAuth is not configured', { requiredEnv: ['EMAIL_MICROSOFT_CLIENT_ID', 'EMAIL_MICROSOFT_CLIENT_SECRET'] });
  }
  return { clientId: env.EMAIL_MICROSOFT_CLIENT_ID, clientSecret: env.EMAIL_MICROSOFT_CLIENT_SECRET };
}

function callbackUrl(provider: EmailOAuthProvider) {
  if (!env.OAUTH_CALLBACK_BASE_URL) throw new AppError(503, 'EMAIL_OAUTH_CALLBACK_NOT_CONFIGURED', 'Email OAuth callback is not configured', { requiredEnv: 'OAUTH_CALLBACK_BASE_URL' });
  return `${env.OAUTH_CALLBACK_BASE_URL.replace(/\/$/, '')}/email/oauth/${provider}/callback`;
}

function safeReturnTo(value?: string) {
  return value?.startsWith('/app/email') && !value.startsWith('//') ? value : '/app/email';
}

export function getSafeEmailReturnTo(stateValue?: string) {
  try { return safeReturnTo(stateValue ? parseState(stateValue).returnTo : undefined); } catch { return '/app/email'; }
}

export function buildEmailAuthorizationUrl(provider: EmailOAuthProvider, workspaceId: string, userId: string, returnTo?: string) {
  const { clientId } = credentials(provider);
  const state = createState({ provider, workspaceId, userId, nonce: crypto.randomBytes(16).toString('hex'), exp: Math.floor(Date.now() / 1000) + 10 * 60, returnTo: safeReturnTo(returnTo) });
  if (provider === 'google') {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackUrl(provider));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('scope', ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/gmail.modify'].join(' '));
    url.searchParams.set('state', state);
    return url.toString();
  }
  const url = new URL(`https://login.microsoftonline.com/${env.EMAIL_MICROSOFT_TENANT}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', callbackUrl(provider));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', ['openid', 'email', 'profile', 'offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send'].join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

async function tokenRequest(provider: EmailOAuthProvider, body: URLSearchParams) {
  const endpoint = provider === 'google'
    ? 'https://oauth2.googleapis.com/token'
    : `https://login.microsoftonline.com/${env.EMAIL_MICROSOFT_TENANT}/oauth2/v2.0/token`;
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20_000) });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new AppError(502, 'EMAIL_OAUTH_TOKEN_EXCHANGE_FAILED', 'Email provider rejected the authorization exchange', { providerHttpStatus: response.status, providerCode: payload.error, providerMessage: payload.error_description });
  return payload;
}

export async function completeEmailOAuth(provider: EmailOAuthProvider, code: string, stateValue: string) {
  const state = parseState(stateValue);
  if (state.provider !== provider) throw new AppError(400, 'EMAIL_OAUTH_STATE_INVALID', 'Email provider did not match the connection state');
  const { clientId, clientSecret } = credentials(provider);
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: callbackUrl(provider), grant_type: 'authorization_code' });
  const token = await tokenRequest(provider, body);
  const accessToken = typeof token.access_token === 'string' ? token.access_token : '';
  if (!accessToken) throw new AppError(502, 'EMAIL_OAUTH_ACCESS_TOKEN_MISSING', 'Email provider did not return an access token');
  const identityResponse = await fetch(provider === 'google' ? 'https://gmail.googleapis.com/gmail/v1/users/me/profile' : 'https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
  const identity = await identityResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!identityResponse.ok) throw new AppError(502, 'EMAIL_ACCOUNT_LOOKUP_FAILED', 'Connected email identity could not be loaded', { providerHttpStatus: identityResponse.status });
  const emailAddress = provider === 'google' ? String(identity.emailAddress ?? '') : String(identity.mail ?? identity.userPrincipalName ?? '');
  if (!emailAddress.includes('@')) throw new AppError(502, 'EMAIL_ACCOUNT_LOOKUP_FAILED', 'Connected provider did not return an email address');
  const expiresIn = Number(token.expires_in ?? 3600);
  const account = await repo.upsertOAuthAccount({
    workspaceId: state.workspaceId,
    userId: state.userId,
    provider,
    emailAddress,
    displayName: provider === 'microsoft' ? String(identity.displayName ?? '') || null : null,
    encryptedAccessToken: encryptSecret(accessToken),
    encryptedRefreshToken: typeof token.refresh_token === 'string' ? encryptSecret(token.refresh_token) : null,
    tokenExpiresAt: new Date(Date.now() + Math.max(60, expiresIn) * 1000).toISOString(),
  });
  return { account, returnTo: safeReturnTo(state.returnTo) };
}

export function isEmailOAuthProvider(value: string): value is EmailOAuthProvider { return value === 'google' || value === 'microsoft'; }

export async function refreshEmailOAuthToken(provider: EmailOAuthProvider, refreshToken: string) {
  const { clientId, clientSecret } = credentials(provider);
  const scope = provider === 'microsoft' ? ['openid', 'email', 'profile', 'offline_access', 'User.Read', 'Mail.ReadWrite', 'Mail.Send'].join(' ') : undefined;
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token', ...(scope ? { scope } : {}) });
  return tokenRequest(provider, body);
}
