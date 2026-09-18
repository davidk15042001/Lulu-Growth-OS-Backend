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
const INBOUND_CONFIRMATION = 'I_UNDERSTAND_THIS_WAITS_FOR_A_REAL_INBOUND_REPLY';

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

function boundedSeconds(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum} seconds.`);
  }
  return Math.floor(value);
}

async function waitForInboundReply(input: {
  workspaceId: string;
  externalAccountId: string;
  marker: string;
  startedAt: Date;
}) {
  if (process.env.PROVIDER_LIVE_E2E_INBOUND_CONFIRM !== INBOUND_CONFIRMATION) {
    throw new Error(`Refusing inbound wait. Set PROVIDER_LIVE_E2E_INBOUND_CONFIRM=${INBOUND_CONFIRMATION}.`);
  }
  const databaseUrl = required('DATABASE_URL');
  const pollSeconds = boundedSeconds('PROVIDER_LIVE_E2E_INBOUND_POLL_SECONDS', 3, 60);
  const timeoutSeconds = boundedSeconds('PROVIDER_LIVE_E2E_INBOUND_TIMEOUT_SECONDS', 300, 1_800);
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const deadline = Date.now() + timeoutSeconds * 1_000;
  console.log(JSON.stringify({
    status: 'WAITING_FOR_INBOUND',
    provider: 'unifyport',
    marker: input.marker,
    instructions: 'Send this exact marker from the dedicated WhatsApp test recipient. The signed webhook must reach Lulu.',
    timeoutSeconds,
  }, null, 2));
  try {
    while (Date.now() < deadline) {
      const message = await client.query<{
        id: string;
        providerMessageId: string | null;
        status: string;
        receivedAt: string | null;
      }>(`
        SELECT id, provider_message_id AS "providerMessageId", status, received_at AS "receivedAt"
        FROM omni_messages
        WHERE workspace_id=$1
          AND direction='INBOUND'
          AND text_content=$2
          AND created_at >= $3
        ORDER BY created_at DESC
        LIMIT 1
      `, [input.workspaceId, input.marker, input.startedAt]);
      if (message.rows[0]) {
        const webhook = await client.query<{
          status: string;
          attempts: number;
          externalEventId: string;
        }>(`
          SELECT status, attempts, external_event_id AS "externalEventId"
          FROM provider_webhook_events
          WHERE provider_key='unifyport'
            AND event_type='message.received'
            AND received_at >= $1
            AND normalized_metadata #>> '{eventPayload,account_id}' = $2
            AND normalized_metadata #>> '{eventPayload,data,message,text}' = $3
          ORDER BY received_at DESC
          LIMIT 1
        `, [input.startedAt, input.externalAccountId, input.marker]);
        if (webhook.rows[0]?.status === 'PROCESSED') {
          return {
            status: 'RECEIVE_VERIFIED',
            message: message.rows[0],
            webhook: webhook.rows[0],
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1_000));
    }
  } finally {
    await client.end().catch(() => undefined);
  }
  throw new Error(`Inbound webhook acceptance timed out. Expected one message containing ${input.marker}.`);
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
  const startedAt = new Date();
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

  if (process.env.PROVIDER_LIVE_E2E_VERIFY_INBOUND === '1') {
    const marker = `[Lulu E2E INBOUND] ${crypto.randomUUID()}`;
    const inbound = await waitForInboundReply({ workspaceId, externalAccountId, marker, startedAt });
    console.log(JSON.stringify({
      ...inbound,
      provider: 'unifyport',
      workspaceId,
      externalAccountId,
      marker,
    }, null, 2));
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'UnifyPort E2E acceptance failed.';
  console.error(JSON.stringify({ status: 'BLOCKED', provider: 'unifyport', error: message }, null, 2));
  process.exitCode = 1;
}
