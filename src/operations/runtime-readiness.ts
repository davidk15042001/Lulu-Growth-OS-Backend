import { env, hasAiProvider, isProd } from '../config/env.js';
import { checkDatabase } from '../db/pool.js';
import { getAiProviderHealth } from '../modules/ai/openai.service.js';

function configured(...values: Array<string | undefined>) {
  return values.every((value) => Boolean(value?.trim()));
}

export async function getRuntimeReadiness() {
  const database = await checkDatabase();
  const aiProviders = getAiProviderHealth().map(({ lastError: _lastError, ...provider }) => provider);
  const components = {
    database: { required: true, ready: database.configured && database.connected },
    ai: { required: true, ready: hasAiProvider && aiProviders.some((provider) => provider.operational) },
    workers: { required: isProd, ready: !isProd || env.BACKGROUND_WORKERS_ENABLED },
    proxyTrust: { required: isProd, ready: !isProd || env.TRUST_PROXY },
    storage: {
      required: isProd,
      ready: configured(env.AWS_S3_BUCKET, env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY),
    },
    billing: {
      required: isProd,
      ready: configured(env.AIRWALLEX_CLIENT_ID, env.AIRWALLEX_API_KEY, env.AIRWALLEX_LEGAL_ENTITY_ID, env.AIRWALLEX_LINKED_PAYMENT_ACCOUNT_ID, env.AIRWALLEX_WEBHOOK_SECRET),
    },
    providerCredentialEncryption: {
      required: isProd,
      ready: !isProd || Boolean(env.PROVIDER_CREDENTIAL_KEY),
    },
    email: {
      required: isProd,
      ready: configured(env.MAILCOW_SMTP_HOST, env.MAILCOW_SMTP_USER, env.MAILCOW_SMTP_PASS, env.EMAIL_FROM),
    },
    twilio: {
      required: false,
      ready: configured(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_WEBHOOK_URL)
        && Boolean((env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) || env.TWILIO_AUTH_TOKEN),
    },
    premiumMedia: {
      required: false,
      ready: Boolean(env.KIE_API_KEY) && configured(env.AWS_S3_BUCKET, env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY),
    },
  };
  const blockers = Object.entries(components)
    .filter(([, state]) => state.required && !state.ready)
    .map(([name]) => name);
  const ready = blockers.length === 0;
  return {
    ready,
    status: ready ? 'ready' : 'not_ready',
    database,
    aiProviders,
    components,
    blockers,
    checkedAt: new Date().toISOString(),
  };
}
