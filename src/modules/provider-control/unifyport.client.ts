import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';

const DEFAULT_TIMEOUT_MS = 20_000;

export type UnifyPortWorkspace = {
  id?: string;
  name?: string;
  status?: string;
  [key: string]: unknown;
};

export type UnifyPortAccount = {
  id?: string;
  name?: string;
  provider?: string;
  region?: string;
  status?: string;
  runtime_status?: string;
  [key: string]: unknown;
};

export type UnifyPortAuthState = {
  status?: string;
  auth_payload?: Record<string, unknown> | null;
  last_error?: string | null;
  [key: string]: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function configuredKey() {
  const key = env.UNIFYPORT_API_KEY;
  if (!key) {
    throw new AppError(503, 'UNIFYPORT_NOT_CONFIGURED', 'UnifyPort is not configured on this server.');
  }
  return key;
}

function apiError(status: number, payload: Record<string, unknown>, requestId: string) {
  const error = asRecord(payload.error);
  const code = optionalString(payload.code) ?? optionalString(payload.error_code) ?? optionalString(error.code) ?? 'UNIFYPORT_API_ERROR';
  const message = optionalString(payload.message) ?? optionalString(payload.error_description) ?? optionalString(error.message) ?? 'UnifyPort rejected the request.';
  return new AppError(status === 401 ? 401 : 502, code, message, {
    provider: 'unifyport',
    providerHttpStatus: status,
    providerCode: code,
    requestId: optionalString(payload.request_id) ?? requestId,
  });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiKey = configuredKey();
  const requestId = randomUUID();
  let response: Response;
  try {
    response = await fetch(`${env.UNIFYPORT_BASE_URL.replace(/\/$/, '')}${path}`, {
      ...init,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'X-Api-Key': apiKey,
        'X-Request-Id': requestId,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'UNIFYPORT_NETWORK_ERROR', 'UnifyPort could not be reached.', { provider: 'unifyport', requestId });
  }

  const text = await response.text().catch(() => '');
  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      payload = asRecord(JSON.parse(text));
    } catch {
      payload = {};
    }
  }
  if (!response.ok) throw apiError(response.status, payload, requestId);
  const data = payload.data;
  return (data === undefined ? payload : data) as T;
}

export function isUnifyPortConfigured() {
  return Boolean(env.UNIFYPORT_API_KEY);
}

export function redactUnifyPortError(error: unknown) {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return { code: 'UNIFYPORT_UNKNOWN_ERROR', message: 'UnifyPort request failed.' };
}

export function getWorkspace() {
  return request<UnifyPortWorkspace>('/v1/workspace');
}

export function listAccounts() {
  return request<UnifyPortAccount[]>('/v1/accounts');
}

export function getAccount(accountId: string) {
  return request<UnifyPortAccount>(`/v1/accounts/${encodeURIComponent(accountId)}`);
}

export function createAccount(input: { name: string; provider: string; region: string; status?: string | undefined; auth_mode?: string | undefined; provider_data?: Record<string, unknown> | undefined }) {
  return request<UnifyPortAccount>('/v1/accounts', { method: 'POST', body: JSON.stringify(input) });
}

export function getAccountAuth(accountId: string) {
  return request<UnifyPortAuthState>(`/v1/accounts/${encodeURIComponent(accountId)}/auth`);
}

export function startQrAuth(accountId: string) {
  return request<UnifyPortAuthState>(`/v1/accounts/${encodeURIComponent(accountId)}/auth/qr/start`, { method: 'POST', body: '{}' });
}

export function startCodeAuth(accountId: string) {
  return request<UnifyPortAuthState>(`/v1/accounts/${encodeURIComponent(accountId)}/auth/start`, { method: 'POST', body: '{}' });
}

export function refreshRuntime(accountId: string) {
  return request<UnifyPortAccount>(`/v1/accounts/${encodeURIComponent(accountId)}/runtime/refresh`, { method: 'POST', body: '{}' });
}

export function sendMessage(input: { account_id: string; to: { id: string; type: 'user' | 'group' | 'channel' }; message: { type: string; text?: string; url?: string; caption?: string }; reply_to?: { reply_token: string } }) {
  return request<Record<string, unknown>>('/v1/messages', { method: 'POST', body: JSON.stringify(input) });
}

export function listProviderRegions(provider: string) {
  return request<unknown[]>(`/v1/providers/${encodeURIComponent(provider)}/regions`);
}

export function createWebhookEndpoint(input: { url: string; subscribed_events: string[]; signing_secret?: string }) {
  return request<Record<string, unknown>>('/v1/webhook-endpoints', { method: 'POST', body: JSON.stringify(input) });
}

/** Verify the signature format used by UnifyPort's X-Device-* webhook
 * deliveries: HMAC-SHA256(timestamp + '.' + raw body). */
export function verifyWebhookSignature(rawBody: string, headers: { signature?: string; timestamp?: string }) {
  const secret = env.UNIFYPORT_WEBHOOK_SIGNING_SECRET;
  if (!secret) throw new AppError(503, 'UNIFYPORT_WEBHOOK_VERIFICATION_UNAVAILABLE', 'No UnifyPort webhook signing secret is configured.');
  const signature = headers.signature?.trim();
  const timestamp = headers.timestamp?.trim() ?? '';
  if (!signature) throw new AppError(403, 'UNIFYPORT_WEBHOOK_SIGNATURE_MISSING', 'UnifyPort webhook signature is required.');
  if (!timestamp) throw new AppError(403, 'UNIFYPORT_WEBHOOK_TIMESTAMP_INVALID', 'UnifyPort webhook timestamp is required.');
  const parsedTimestamp = Date.parse(timestamp);
  if (!Number.isFinite(parsedTimestamp) || Math.abs(Date.now() - parsedTimestamp) > 300_000) throw new AppError(403, 'UNIFYPORT_WEBHOOK_TIMESTAMP_INVALID', 'UnifyPort webhook timestamp is invalid or expired.');
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new AppError(403, 'UNIFYPORT_WEBHOOK_SIGNATURE_INVALID', 'UnifyPort webhook signature could not be verified.');
  return { providerKey: 'unifyport', verified: true } as const;
}
