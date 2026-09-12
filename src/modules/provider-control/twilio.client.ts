import { createHmac } from 'node:crypto';
import twilio from 'twilio';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';

export type TwilioAddress = `whatsapp:${string}` | `messenger:${string}`;

type TwilioMessageResponse = {
  sid?: string;
  status?: string;
  error_code?: number | null;
  error_message?: string | null;
};

function credentials() {
  if (!env.TWILIO_ACCOUNT_SID) {
    throw new AppError(503, 'TWILIO_NOT_CONFIGURED', 'Twilio is not configured on this server.');
  }
  if (env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) {
    return { accountSid: env.TWILIO_ACCOUNT_SID, username: env.TWILIO_API_KEY_SID, password: env.TWILIO_API_KEY_SECRET };
  }
  if (env.TWILIO_AUTH_TOKEN) {
    return { accountSid: env.TWILIO_ACCOUNT_SID, username: env.TWILIO_ACCOUNT_SID, password: env.TWILIO_AUTH_TOKEN };
  }
  throw new AppError(503, 'TWILIO_NOT_CONFIGURED', 'Twilio REST credentials are not configured on this server.');
}

function authorization(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

async function twilioRequest<T>(path: string, init: RequestInit = {}) {
  const auth = credentials();
  let response: Response;
  try {
    response = await fetch(`${env.TWILIO_BASE_URL.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { Authorization: authorization(auth.username, auth.password), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new AppError(502, 'TWILIO_NETWORK_ERROR', 'Twilio could not be reached.', { cause: error instanceof Error ? error.message : String(error) });
  }
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new AppError(response.status === 401 || response.status === 403 ? 502 : 502, 'TWILIO_API_ERROR', typeof payload.message === 'string' ? payload.message : 'Twilio rejected the request.', {
      provider: 'twilio', status: response.status, code: payload.code ?? null, moreInfo: payload.more_info ?? null,
    });
  }
  return payload as T;
}

export function isTwilioConfigured() {
  return Boolean(env.TWILIO_ACCOUNT_SID && ((env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) || env.TWILIO_AUTH_TOKEN));
}

export function isTwilioWebhookConfigured() {
  return Boolean(env.TWILIO_AUTH_TOKEN && env.TWILIO_WEBHOOK_URL);
}

export async function getTwilioAccount() {
  const auth = credentials();
  return twilioRequest<Record<string, unknown>>(`/2010-04-01/Accounts/${encodeURIComponent(auth.accountSid)}.json`);
}

export function twilioMessageForm(input: { from: TwilioAddress; to: TwilioAddress; body?: string; contentSid?: string; contentVariables?: Record<string,string> }) {
  if (input.contentSid) {
    return new URLSearchParams({
      From: input.from,
      To: input.to,
      ContentSid: input.contentSid,
      ContentVariables: JSON.stringify(input.contentVariables ?? {}),
    });
  }
  if (!input.body?.trim()) throw new AppError(422, 'TWILIO_MESSAGE_BODY_REQUIRED', 'A Twilio message body is required.');
  return new URLSearchParams({ From: input.from, To: input.to, Body: input.body });
}

export async function sendTwilioMessage(input: { from: TwilioAddress; to: TwilioAddress; body?: string; contentSid?: string; contentVariables?: Record<string,string> }) {
  const auth = credentials();
  const body = twilioMessageForm(input);
  if (env.TWILIO_STATUS_CALLBACK_URL) body.set('StatusCallback', env.TWILIO_STATUS_CALLBACK_URL);
  const result = await twilioRequest<TwilioMessageResponse>(
    `/2010-04-01/Accounts/${encodeURIComponent(auth.accountSid)}/Messages.json`,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() },
  );
  if (!result.sid) throw new AppError(502, 'TWILIO_MESSAGE_ID_MISSING', 'Twilio accepted the request without returning a message SID.');
  return { sid: result.sid, status: result.status ?? 'queued' };
}

function normalizedParams(params: Record<string, unknown>) {
  return Object.keys(params).sort().flatMap((key) => {
    const value = params[key];
    if (Array.isArray(value)) return [...value].map(String).sort().map((entry) => `${key}${entry}`);
    return value == null ? [] : [`${key}${String(value)}`];
  }).join('');
}

export function computeTwilioSignature(url: string, params: Record<string, unknown>, authToken: string) {
  return createHmac('sha1', authToken).update(`${url}${normalizedParams(params)}`, 'utf8').digest('base64');
}

export function verifyTwilioSignature(url: string, params: Record<string, unknown>, signature?: string) {
  if (!env.TWILIO_AUTH_TOKEN) throw new AppError(503, 'TWILIO_WEBHOOK_VERIFICATION_UNAVAILABLE', 'TWILIO_AUTH_TOKEN is required to verify Twilio webhooks.');
  if (!signature) throw new AppError(403, 'TWILIO_WEBHOOK_SIGNATURE_MISSING', 'Twilio webhook signature is required.');
  // Use Twilio's maintained validator so newly introduced webhook parameters
  // continue to be included exactly as required by their signing contract.
  if (!twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature, url, params)) {
    throw new AppError(403, 'TWILIO_WEBHOOK_SIGNATURE_INVALID', 'Twilio webhook signature could not be verified.');
  }
  return true;
}

export function twilioWebhookUrl() {
  if (!env.TWILIO_WEBHOOK_URL) throw new AppError(503, 'TWILIO_WEBHOOK_URL_MISSING', 'TWILIO_WEBHOOK_URL is required to validate Twilio webhooks.');
  return env.TWILIO_WEBHOOK_URL;
}

export function asTwilioAddress(channelType: string, value: string): TwilioAddress {
  const trimmed = value.trim();
  if (channelType === 'WHATSAPP') return (trimmed.startsWith('whatsapp:') ? trimmed : `whatsapp:${trimmed}`) as TwilioAddress;
  if (channelType === 'FACEBOOK_MESSENGER') return (trimmed.startsWith('messenger:') ? trimmed : `messenger:${trimmed}`) as TwilioAddress;
  throw new AppError(409, 'TWILIO_CHANNEL_UNSUPPORTED', `Twilio transport is not enabled for ${channelType}.`);
}
