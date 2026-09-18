import 'dotenv/config';
import crypto from 'node:crypto';

/**
 * Explicit UnifyPort transport acceptance test.
 *
 * This is intentionally separate from provider-live-readiness.ts. Readiness
 * is safe to run against a production account; this command performs one real
 * WhatsApp send and therefore requires three independent opt-in guards plus a
 * dedicated recipient and a clearly labelled test message.
 */

const CONFIRMATION = 'I_UNDERSTAND_THIS_SENDS_A_REAL_WHATSAPP_MESSAGE';

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the UnifyPort E2E acceptance test.`);
  return value;
}

function whatsappRecipient(value: string) {
  if (value.endsWith('@s.whatsapp.net') || value.endsWith('@g.us')) return value;
  const digits = value.replace(/[^0-9]/g, '');
  if (!/^\d{8,15}$/.test(digits)) {
    throw new Error('PROVIDER_LIVE_E2E_RECIPIENT must be an E.164 number or a WhatsApp JID.');
  }
  return `${digits}@s.whatsapp.net`;
}

function assertExplicitlyEnabled() {
  if (process.env.PROVIDER_LIVE_E2E !== '1') {
    throw new Error('Refusing live provider calls. Set PROVIDER_LIVE_E2E=1 explicitly.');
  }
  if (process.env.PROVIDER_LIVE_E2E_SIDE_EFFECTS !== '1') {
    throw new Error('Refusing provider side effects. Set PROVIDER_LIVE_E2E_SIDE_EFFECTS=1 explicitly.');
  }
  if (process.env.PROVIDER_LIVE_E2E_CONFIRM !== CONFIRMATION) {
    throw new Error(`Refusing provider side effects. Set PROVIDER_LIVE_E2E_CONFIRM=${CONFIRMATION}.`);
  }
}

async function main() {
  assertExplicitlyEnabled();

  // Parse application configuration only after the explicit side-effect
  // guards. An accidental invocation must never emit a raw startup stack trace.
  const { getProviderAdapter } = await import('../src/modules/provider-control/provider-registry.js');
  const { sendMessage } = await import('../src/modules/provider-control/unifyport.client.js');

  const workspaceId = required('PROVIDER_LIVE_E2E_WORKSPACE_ID');
  const externalAccountId = required('PROVIDER_LIVE_E2E_EXTERNAL_ACCOUNT_ID');
  const recipient = whatsappRecipient(required('PROVIDER_LIVE_E2E_RECIPIENT'));
  const message = required('PROVIDER_LIVE_E2E_MESSAGE');
  if (!message.startsWith('[Lulu E2E]')) {
    throw new Error('PROVIDER_LIVE_E2E_MESSAGE must start with "[Lulu E2E]".');
  }
  if (message.length > 500) throw new Error('PROVIDER_LIVE_E2E_MESSAGE must be 500 characters or fewer.');

  const adapter = getProviderAdapter('unifyport');
  const context = {
    connectionId: `live-e2e:${workspaceId}`,
    providerKey: 'unifyport',
    workspaceId,
    externalAccountId,
    grantedScopes: [],
    metadata: {},
  };
  const verification = await adapter.verifyConnection(context);
  if (!verification.verified) {
    throw new Error(`UnifyPort account is not ready: ${verification.status}`);
  }

  const requestId = crypto.randomUUID();
  const result = await sendMessage({
    account_id: externalAccountId,
    to: { id: recipient, type: 'user' },
    message: { type: 'text', text: message },
  });
  const providerMessageId = typeof result.message_id === 'string'
    ? result.message_id
    : typeof result.id === 'string' ? result.id : null;
  if (!providerMessageId) throw new Error('UnifyPort accepted the request without returning a message ID.');

  console.log(JSON.stringify({
    status: 'SENT',
    provider: 'unifyport',
    workspaceId,
    externalAccountId,
    recipient,
    requestId,
    providerMessageId,
  }, null, 2));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'UnifyPort E2E acceptance failed.';
  console.error(JSON.stringify({ status: 'BLOCKED', provider: 'unifyport', error: message }, null, 2));
  process.exitCode = 1;
}
