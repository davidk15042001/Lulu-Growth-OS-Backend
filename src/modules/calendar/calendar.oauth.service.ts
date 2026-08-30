import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import { encryptSecret } from '../../utils/secret-box.js';
import * as repo from './calendar.repo.js';
import type { CalendarProvider } from './calendar.types.js';

export type CalendarOAuthProvider = Extract<CalendarProvider, 'google' | 'microsoft'>;

type OAuthState = {
  provider: CalendarOAuthProvider;
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
  if (!payload || !signature) throw new AppError(400, 'CALENDAR_OAUTH_STATE_INVALID', 'Calendar connection state is invalid');
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new AppError(400, 'CALENDAR_OAUTH_STATE_INVALID', 'Calendar connection state could not be verified');
  }
  const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthState;
  if (!state.workspaceId || !state.userId || !['google', 'microsoft'].includes(state.provider)) throw new AppError(400, 'CALENDAR_OAUTH_STATE_INVALID', 'Calendar connection state is incomplete');
  if (!state.exp || state.exp < Math.floor(Date.now() / 1000)) throw new AppError(400, 'CALENDAR_OAUTH_STATE_EXPIRED', 'Calendar connection state expired');
  return state;
}

function safeReturnTo(value?: string) {
  return value?.startsWith('/app/calendar') && !value.startsWith('//') ? value : '/app/calendar?section=settings';
}

export function getSafeCalendarReturnTo(stateValue?: string) {
  try { return safeReturnTo(stateValue ? parseState(stateValue).returnTo : undefined); } catch { return '/app/calendar?section=settings'; }
}

function callbackUrl(provider: CalendarOAuthProvider) {
  if (!env.OAUTH_CALLBACK_BASE_URL) throw new AppError(503, 'CALENDAR_OAUTH_CALLBACK_NOT_CONFIGURED', 'Calendar OAuth callback is not configured', { requiredEnv: 'OAUTH_CALLBACK_BASE_URL' });
  return `${env.OAUTH_CALLBACK_BASE_URL.replace(/\/$/, '')}/calendar/oauth/${provider}/callback`;
}

function credentials(provider: CalendarOAuthProvider) {
  if (provider === 'google') {
    const clientId = env.CALENDAR_GOOGLE_CLIENT_ID ?? env.GOOGLE_CLIENT_ID;
    const clientSecret = env.CALENDAR_GOOGLE_CLIENT_SECRET ?? env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new AppError(503, 'CALENDAR_PROVIDER_NOT_CONFIGURED', 'Google Calendar OAuth is not configured', { requiredEnv: ['CALENDAR_GOOGLE_CLIENT_ID', 'CALENDAR_GOOGLE_CLIENT_SECRET'] });
    return { clientId, clientSecret, tenant: 'common' };
  }
  const clientId = env.CALENDAR_MICROSOFT_CLIENT_ID ?? env.EMAIL_MICROSOFT_CLIENT_ID;
  const clientSecret = env.CALENDAR_MICROSOFT_CLIENT_SECRET ?? env.EMAIL_MICROSOFT_CLIENT_SECRET;
  const tenant = env.CALENDAR_MICROSOFT_TENANT ?? env.EMAIL_MICROSOFT_TENANT;
  if (!clientId || !clientSecret) throw new AppError(503, 'CALENDAR_PROVIDER_NOT_CONFIGURED', 'Microsoft Calendar OAuth is not configured', { requiredEnv: ['CALENDAR_MICROSOFT_CLIENT_ID', 'CALENDAR_MICROSOFT_CLIENT_SECRET'] });
  return { clientId, clientSecret, tenant };
}

export function buildCalendarAuthorizationUrl(provider: CalendarOAuthProvider, workspaceId: string, userId: string, returnTo?: string) {
  const { clientId, tenant } = credentials(provider);
  const state = createState({ provider, workspaceId, userId, nonce: crypto.randomBytes(16).toString('hex'), exp: Math.floor(Date.now() / 1000) + 10 * 60, returnTo: safeReturnTo(returnTo) });
  if (provider === 'google') {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackUrl(provider));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('scope', ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.readonly'].join(' '));
    url.searchParams.set('state', state);
    return url.toString();
  }
  const url = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', callbackUrl(provider));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', ['openid', 'email', 'profile', 'offline_access', 'User.Read', 'Calendars.Read'].join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

async function tokenRequest(provider: CalendarOAuthProvider, body: URLSearchParams) {
  const endpoint = provider === 'google'
    ? 'https://oauth2.googleapis.com/token'
    : `https://login.microsoftonline.com/${credentials(provider).tenant}/oauth2/v2.0/token`;
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20_000) });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new AppError(502, 'CALENDAR_OAUTH_TOKEN_EXCHANGE_FAILED', 'Calendar provider rejected the authorization exchange', { providerHttpStatus: response.status, providerCode: payload.error, providerMessage: payload.error_description });
  return payload;
}

async function loadIdentity(provider: CalendarOAuthProvider, accessToken: string) {
  const endpoint = provider === 'google'
    ? 'https://openidconnect.googleapis.com/v1/userinfo'
    : 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName';
  const response = await fetch(endpoint, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
  const identity = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new AppError(502, 'CALENDAR_ACCOUNT_LOOKUP_FAILED', 'Connected calendar identity could not be loaded', { providerHttpStatus: response.status });
  const emailAddress = provider === 'google'
    ? String(identity.email ?? '')
    : String(identity.mail ?? identity.userPrincipalName ?? '');
  return {
    externalAccountId: String(identity.sub ?? identity.id ?? '') || null,
    emailAddress: emailAddress.includes('@') ? emailAddress : null,
    displayName: String(identity.name ?? identity.displayName ?? '') || null,
  };
}

export async function completeCalendarOAuth(provider: CalendarOAuthProvider, code: string, stateValue: string) {
  const state = parseState(stateValue);
  if (state.provider !== provider) throw new AppError(400, 'CALENDAR_OAUTH_STATE_INVALID', 'Calendar provider did not match the connection state');
  const { clientId, clientSecret } = credentials(provider);
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: callbackUrl(provider),
    grant_type: 'authorization_code',
  });
  const token = await tokenRequest(provider, body);
  const accessToken = typeof token.access_token === 'string' ? token.access_token : '';
  if (!accessToken) throw new AppError(502, 'CALENDAR_OAUTH_ACCESS_TOKEN_MISSING', 'Calendar provider did not return an access token');
  const identity = await loadIdentity(provider, accessToken);
  const expiresIn = Number(token.expires_in ?? 3600);
  const account = await repo.upsertOAuthAccount({
    workspaceId: state.workspaceId,
    userId: state.userId,
    provider,
    externalAccountId: identity.externalAccountId,
    emailAddress: identity.emailAddress,
    displayName: identity.displayName,
    encryptedAccessToken: encryptSecret(accessToken),
    encryptedRefreshToken: typeof token.refresh_token === 'string' ? encryptSecret(token.refresh_token) : null,
    tokenExpiresAt: new Date(Date.now() + Math.max(60, expiresIn) * 1000).toISOString(),
    settings: { identity },
  });
  return { account, returnTo: safeReturnTo(state.returnTo) };
}

export function isCalendarOAuthProvider(value: string): value is CalendarOAuthProvider {
  return value === 'google' || value === 'microsoft';
}

export async function refreshCalendarOAuthToken(provider: CalendarOAuthProvider, refreshToken: string) {
  const { clientId, clientSecret } = credentials(provider);
  const scope = provider === 'microsoft'
    ? ['openid', 'email', 'profile', 'offline_access', 'User.Read', 'Calendars.Read'].join(' ')
    : undefined;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    ...(scope ? { scope } : {}),
  });
  return tokenRequest(provider, body);
}
