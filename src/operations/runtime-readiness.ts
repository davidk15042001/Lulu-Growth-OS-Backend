import { env, hasAiProvider, isProd, trustProxySetting } from '../config/env.js';
import { checkDatabase } from '../db/pool.js';
import { getAiProviderHealth } from '../modules/ai/openai.service.js';
import { getAiReservationHealth } from '../modules/api-wallet/ai-spend-reservation.repo.js';
import { getKieBillingCatalogReadiness } from '../modules/premium-media/premium-media-cost-catalog.js';
import { getPremiumMediaBillingHealth } from '../modules/premium-media/premium-media.repo.js';
import { getWorkerSupervisorHealth } from './worker-liveness.js';

function configured(...values: Array<string | undefined>) {
  return values.every((value) => Boolean(value?.trim()));
}

type AiReservationHealth = Awaited<ReturnType<typeof getAiReservationHealth>>;

export function getAiSpendReservationReadiness(health: AiReservationHealth | null) {
  const healthy = health !== null
    && health.staleUnresolvedCount === 0
    && health.walletHoldMismatchCount === 0;
  return {
    required: true,
    ready: healthy,
    healthy,
    ...(health ?? {}),
  };
}

export function toPublicRuntimeReadiness(readiness: {
  ready: boolean;
  status: string;
  checkedAt: string;
}) {
  return {
    ready: readiness.ready,
    status: readiness.status,
    checkedAt: readiness.checkedAt,
  };
}

export async function getRuntimeReadiness() {
  const database = await checkDatabase();
  const aiProviders = getAiProviderHealth().map(({ lastError: _lastError, ...provider }) => provider);
  // Every provider in this list is wired through the OpenAI-compatible text
  // completion path (Kie supplies the configured quality model as a fallback).
  const textProviders = aiProviders;
  const primaryTextProvider = textProviders.find((provider) => provider.primary) ?? null;
  const textAiReady = hasAiProvider && textProviders.some((provider) => provider.operational);
  const aiSpendReservations = database.connected
    ? await getAiReservationHealth().catch(() => null)
    : null;
  const premiumMediaCatalog = getKieBillingCatalogReadiness();
  const premiumMediaBilling = database.connected
    ? await getPremiumMediaBillingHealth().catch(() => null)
    : null;
  const workerSupervisor = database.connected && env.BACKGROUND_WORKERS_ENABLED
    ? await getWorkerSupervisorHealth().catch(() => ({ live: false, supervisorLive: false, staleAfterMs: 45_000, instanceId: null, heartbeatAt: null, startedAt: null, registeredWorkers: [] as string[], requiredWorkers: [] as string[], unhealthyRequiredWorkers: [] as string[], workers: [] }))
    : { live: false, supervisorLive: false, staleAfterMs: 45_000, instanceId: null, heartbeatAt: null, startedAt: null, registeredWorkers: [] as string[], requiredWorkers: [] as string[], unhealthyRequiredWorkers: [] as string[], workers: [] };
  const components = {
    database: { required: true, ready: database.configured && database.connected },
    // Provider balance is not a process-readiness requirement. Customer-funded
    // AI work is authorized and metered at execution time; an exhausted global
    // provider account must degrade AI work without taking login, billing,
    // onboarding, or the rest of the workspace API out of service.
    ai: { required: false, ready: textAiReady, kind: 'text', operationalProviders: textProviders.filter((provider) => provider.operational).map((provider) => provider.provider) },
    aiSpendReservations: getAiSpendReservationReadiness(aiSpendReservations),
    primaryTextAi: { required: false, ready: Boolean(primaryTextProvider?.operational), provider: primaryTextProvider?.provider ?? env.AI_PROVIDER, configured: Boolean(primaryTextProvider?.configured), fallbackActive: textAiReady && !primaryTextProvider?.operational },
    workers: { required: isProd, ready: !isProd || (env.BACKGROUND_WORKERS_ENABLED && workerSupervisor.live), configured: env.BACKGROUND_WORKERS_ENABLED, supervisor: workerSupervisor },
    proxyTrust: { required: isProd, ready: !isProd || Boolean(trustProxySetting), mode: trustProxySetting || 'disabled' },
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
      // Transactional email is an optional capability, not a platform
      // dependency. Lulu can run onboarding, billing, integrations and
      // autonomous work without Mailcow (or any other global SMTP server).
      // Email actions fail explicitly at the action boundary until an SMTP
      // transport is configured, while connected Gmail/Outlook/SMTP accounts
      // remain independent workspace integrations.
      required: false,
      ready: configured(env.MAILCOW_SMTP_HOST, env.MAILCOW_SMTP_USER, env.MAILCOW_SMTP_PASS, env.EMAIL_FROM),
    },
    twilio: {
      required: false,
      ready: configured(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_WEBHOOK_URL)
        && Boolean((env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET) || env.TWILIO_AUTH_TOKEN),
    },
    premiumMedia: {
      required: false,
      ready: Boolean(env.KIE_API_KEY)
        && configured(env.AWS_S3_BUCKET, env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY)
        && premiumMediaCatalog.ready
        && premiumMediaBilling !== null
        && premiumMediaBilling.ambiguousCount === 0
        && premiumMediaBilling.unreservedCount === 0,
      catalog: premiumMediaCatalog,
      billing: premiumMediaBilling,
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
