import { AppError } from '../../utils/app-error.js';
import * as omniRepo from '../omnichannel/omnichannel.repo.js';
import { twilioWebhookUrl, verifyTwilioSignature } from './twilio.client.js';

function text(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function messageType(payload: Record<string, unknown>) {
  const mediaType = text(payload, 'MediaContentType0')?.toLowerCase() ?? '';
  if (mediaType.startsWith('image/')) return 'IMAGE';
  if (mediaType.startsWith('video/')) return 'VIDEO';
  if (mediaType.startsWith('audio/')) return 'AUDIO';
  if (Number(text(payload, 'NumMedia') ?? '0') > 0) return 'FILE';
  return 'TEXT';
}

/** Validates first, then normalizes Twilio's form payload into the canonical
 * tenant-scoped OmniChannel store. Unknown destinations are accepted but not
 * routed, so one customer's message can never leak into another workspace. */
export async function ingestTwilioWebhook(payload: Record<string, unknown>, signature?: string) {
  verifyTwilioSignature(twilioWebhookUrl(), payload, signature);
  const messageSid = text(payload, 'MessageSid') ?? text(payload, 'SmsSid');
  const callbackStatus = text(payload, 'MessageStatus') ?? text(payload, 'SmsStatus');
  const from = text(payload, 'From');
  const to = text(payload, 'To');

  if (messageSid && callbackStatus && callbackStatus.toLowerCase() !== 'received') {
    const message = await omniRepo.updateTwilioMessageStatus(messageSid, callbackStatus.toLowerCase(), text(payload, 'ErrorCode'));
    return { kind: 'status', messageSid, status: callbackStatus, matched: Boolean(message) } as const;
  }
  if (!messageSid || !from || !to) throw new AppError(400, 'TWILIO_WEBHOOK_PAYLOAD_INVALID', 'Twilio message webhook is missing MessageSid, From, or To.');
  const body = text(payload, 'Body') ?? (Number(text(payload, 'NumMedia') ?? '0') > 0 ? '[Media attachment]' : '');
  const result = await omniRepo.ingestTwilioInbound({ messageSid, from, to, body, messageType: messageType(payload), metadata: payload });
  return { kind: 'inbound', messageSid, ...result } as const;
}
