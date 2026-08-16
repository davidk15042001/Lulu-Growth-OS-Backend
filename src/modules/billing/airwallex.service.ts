import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { query } from '../../db/pool.js';
import { AppError, badRequest, forbiddenError } from '../../utils/app-error.js';

export type BillingPlanKey = 'explorer' | 'starter' | 'ai';

type AirwallexObject = Record<string, any>;

const planConfig: Record<BillingPlanKey, { amountMinor: number; priceEnv?: keyof typeof env; label: string }> = {
  explorer: { amountMinor: 0, label: 'Explorer' },
  starter: { amountMinor: 420000, priceEnv: 'AIRWALLEX_STARTER_PRICE_ID', label: 'Starter' },
  ai: { amountMinor: 3000000, priceEnv: 'AIRWALLEX_AI_PRICE_ID', label: 'AI' },
};

function providerError(code: string, message: string, details?: Record<string, unknown>, status = 502) {
  return new AppError(status, code, message, details);
}

function requireAirwallex() {
  if (!env.AIRWALLEX_CLIENT_ID || !env.AIRWALLEX_API_KEY) {
    throw providerError('AIRWALLEX_CREDENTIALS_MISSING', 'Airwallex Sandbox credentials are missing on the server', { requiredEnv: ['AIRWALLEX_CLIENT_ID', 'AIRWALLEX_API_KEY'] }, 500);
  }
}

async function login(): Promise<string> {
  requireAirwallex();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-client-id': env.AIRWALLEX_CLIENT_ID!,
    'x-api-key': env.AIRWALLEX_API_KEY!,
    ...(env.AIRWALLEX_LOGIN_AS ? { 'x-login-as': env.AIRWALLEX_LOGIN_AS } : {}),
  };
  const response = await fetch(`${env.AIRWALLEX_BASE_URL}/api/v1/authentication/login`, {
    method: 'POST',
    headers,
  });
  const data = await response.json().catch(() => ({})) as AirwallexObject;
  const token = typeof data.token === 'string' ? data.token : typeof data.access_token === 'string' ? data.access_token : null;
  if (!response.ok || !token) {
    throw providerError('AIRWALLEX_AUTH_FAILED', 'Airwallex rejected the Sandbox credentials', { providerHttpStatus: response.status, providerCode: data.code ?? data.error_code ?? null, providerMessage: data.message ?? data.error ?? null }, 502);
  }
  return token;
}

async function airwallexRequest(path: string, body: AirwallexObject, requestId: string) {
  const token = await login();
  const response = await fetch(`${env.AIRWALLEX_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-client-id': env.AIRWALLEX_CLIENT_ID!,
    },
    body: JSON.stringify({ ...body, request_id: requestId }),
  });
  const data = await response.json().catch(() => ({})) as AirwallexObject;
  if (!response.ok) {
    const providerCode = data.code ?? data.error_code ?? null;
    const providerMessage = data.message ?? data.error ?? null;
    logger.warn({ requestId, path, providerHttpStatus: response.status, providerCode, providerMessage }, 'Airwallex billing request rejected');
    throw providerError('AIRWALLEX_REQUEST_FAILED', 'Airwallex rejected the billing request', { providerHttpStatus: response.status, providerCode, providerMessage, path }, 502);
  }
  return data;
}

function planPriceId(planKey: BillingPlanKey) {
  const config = planConfig[planKey];
  if (!config.priceEnv) return null;
  const priceId = env[config.priceEnv];
  if (!priceId || typeof priceId !== 'string') {
    throw providerError('AIRWALLEX_PRICE_NOT_CONFIGURED', `${config.label} Airwallex recurring Price ID is missing on the server`, { requiredEnv: config.priceEnv }, 500);
  }
  return priceId;
}

export async function createCheckout(input: { workspaceId: string; planKey: BillingPlanKey; successUrl: string; backUrl: string }) {
  const config = planConfig[input.planKey];
  if (!config) throw badRequest('Unknown billing plan', { planKey: input.planKey });

  if (input.planKey === 'explorer') {
    await query(
      `INSERT INTO workspace_subscriptions (workspace_id, provider, plan_key, status, current_period_starts_at, current_period_ends_at, metadata)
       VALUES ($1, 'internal', 'explorer', 'active', NOW(), NOW() + INTERVAL '1 year', $2::jsonb)
       ON CONFLICT (workspace_id) DO UPDATE SET provider='internal', plan_key='explorer', status='active', cancel_at_period_end=false, current_period_starts_at=NOW(), current_period_ends_at=NOW() + INTERVAL '1 year', metadata=workspace_subscriptions.metadata || EXCLUDED.metadata, updated_at=NOW()` ,
      [input.workspaceId, JSON.stringify({ source: 'onboarding', confirmedAt: new Date().toISOString() })]
    );
    await query(`UPDATE workspaces SET onboarding_step='setup_complete', onboarding_completed_at=COALESCE(onboarding_completed_at, NOW()) WHERE id=$1 AND deleted_at IS NULL`, [input.workspaceId]);
    return { planKey: 'explorer' as const, free: true, status: 'active' as const };
  }

  const checkout = await airwallexRequest('/api/v1/billing/billing_checkouts/create', {
    mode: 'SUBSCRIPTION',
    ui_mode: 'HOSTED',
    locale: 'AUTO',
    customer_data: { name: 'Lulu AI workspace', type: 'BUSINESS' },
    line_items: [{ price_id: planPriceId(input.planKey), quantity: 1 }],
    subscription_data: {
      duration: { period: 1, period_unit: 'YEAR' },
      default_invoice_template: { invoice_memo: `Lulu AI ${config.label} annual subscription` },
      metadata: { workspace_id: input.workspaceId, plan_key: input.planKey },
    },
    ...(env.AIRWALLEX_LEGAL_ENTITY_ID ? { legal_entity_id: env.AIRWALLEX_LEGAL_ENTITY_ID } : {}),
    ...(env.AIRWALLEX_LINKED_PAYMENT_ACCOUNT_ID ? { linked_payment_account_id: env.AIRWALLEX_LINKED_PAYMENT_ACCOUNT_ID } : {}),
    metadata: { workspace_id: input.workspaceId, plan_key: input.planKey },
    success_url: input.successUrl,
    back_url: input.backUrl,
    hosted_completion_page: { display: true },
  }, crypto.randomUUID());

  const checkoutId = String(checkout.id ?? '');
  if (!checkoutId) throw providerError('AIRWALLEX_CHECKOUT_ID_MISSING', 'Airwallex did not return a Billing Checkout ID');
  const checkoutUrl = typeof checkout.url === 'string' ? checkout.url : typeof checkout.checkout_url === 'string' ? checkout.checkout_url : typeof checkout.hosted_checkout_url === 'string' ? checkout.hosted_checkout_url : null;
  if (!checkoutUrl) throw providerError('AIRWALLEX_CHECKOUT_URL_MISSING', 'Airwallex did not return a hosted Checkout URL', { checkoutId });

  await query(
    `INSERT INTO workspace_billing_checkouts (workspace_id, plan_key, provider_checkout_id, provider_customer_id, provider_subscription_id, provider_invoice_id, status, checkout_url, amount_minor, currency, raw_response)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CNY', $10::jsonb)`,
    [input.workspaceId, input.planKey, checkoutId, checkout.billing_customer_id ?? null, checkout.subscription_id ?? null, checkout.invoice_id ?? null, checkout.status ?? 'ACTIVE', checkoutUrl, config.amountMinor, JSON.stringify(checkout)]
  );

  await query(
    `INSERT INTO workspace_subscriptions (workspace_id, provider, provider_customer_id, provider_subscription_id, plan_key, status, current_period_starts_at, current_period_ends_at, metadata)
     VALUES ($1, 'airwallex', $2, $3, $4, 'trialing', NOW(), NOW() + INTERVAL '1 year', $5::jsonb)
     ON CONFLICT (workspace_id) DO UPDATE SET provider='airwallex', provider_customer_id=COALESCE(EXCLUDED.provider_customer_id, workspace_subscriptions.provider_customer_id), provider_subscription_id=COALESCE(EXCLUDED.provider_subscription_id, workspace_subscriptions.provider_subscription_id), plan_key=EXCLUDED.plan_key, status='trialing', metadata=workspace_subscriptions.metadata || EXCLUDED.metadata, updated_at=NOW()` ,
    [input.workspaceId, checkout.billing_customer_id ?? null, checkout.subscription_id ?? null, input.planKey, JSON.stringify({ checkoutId, amountMinor: config.amountMinor, checkoutUrl })]
  );

  return { planKey: input.planKey, free: false, checkoutId, checkoutUrl, status: checkout.status ?? 'ACTIVE' };
}

export function verifyWebhookSignature(rawBody: string, timestamp: string | undefined, signature: string | undefined, nonce: string | undefined) {
  if (!env.AIRWALLEX_WEBHOOK_SECRET) throw providerError('AIRWALLEX_WEBHOOK_SECRET_MISSING', 'Airwallex webhook secret is missing on the server', { requiredEnv: 'AIRWALLEX_WEBHOOK_SECRET' }, 500);
  if (!timestamp || !signature || !nonce) throw forbiddenError('Airwallex webhook signature headers are missing');
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || Math.abs(Date.now() - timestampNumber * 1000) > env.AIRWALLEX_WEBHOOK_TOLERANCE_SECONDS * 1000) throw forbiddenError('Airwallex webhook timestamp is outside the allowed tolerance');
  const expected = crypto.createHmac('sha256', env.AIRWALLEX_WEBHOOK_SECRET).update(`${timestamp}${nonce}${rawBody}`).digest('hex');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw forbiddenError('Airwallex webhook signature is invalid');
}

export async function handleWebhook(event: AirwallexObject) {
  const eventId = String(event.id ?? event.event_id ?? '');
  const eventType = String(event.type ?? event.event_type ?? 'unknown');
  if (!eventId) throw badRequest('Airwallex webhook event ID is missing');
  const inserted = await query(`INSERT INTO airwallex_webhook_events (event_id, event_type, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`, [eventId, eventType, JSON.stringify(event)]);
  if (inserted.rowCount === 0) return { duplicate: true, eventId };

  const data = (event.data ?? event.object ?? {}) as AirwallexObject;
  const metadata = (data.metadata ?? data.subscription?.metadata ?? data.checkout?.metadata ?? {}) as AirwallexObject;
  const workspaceId = typeof metadata.workspace_id === 'string' ? metadata.workspace_id : null;
  if (!workspaceId) {
    await query(`UPDATE airwallex_webhook_events SET processed_at=NOW() WHERE event_id=$1`, [eventId]);
    return { processed: false, eventId, reason: 'workspace_id_missing' };
  }

  const subscription = (data.subscription ?? data) as AirwallexObject;
  const checkout = (data.checkout ?? data) as AirwallexObject;
  const providerStatus = String(subscription.status ?? checkout.status ?? '').toUpperCase();
  const mappedStatus = providerStatus === 'ACTIVE' || eventType.includes('PAID') || eventType.includes('COMPLETED') ? 'active' : providerStatus === 'CANCELLED' ? 'cancelled' : providerStatus === 'EXPIRED' ? 'expired' : providerStatus === 'UNPAID' ? 'past_due' : null;
  if (mappedStatus) {
    await query(
      `UPDATE workspace_subscriptions SET provider='airwallex', provider_customer_id=COALESCE($2, provider_customer_id), provider_subscription_id=COALESCE($3, provider_subscription_id), plan_key=COALESCE($4, plan_key), status=$5, current_period_starts_at=COALESCE($6::timestamptz, current_period_starts_at), current_period_ends_at=COALESCE($7::timestamptz, current_period_ends_at), metadata=metadata || $8::jsonb, updated_at=NOW() WHERE workspace_id=$1`,
      [workspaceId, subscription.billing_customer_id ?? checkout.billing_customer_id ?? null, subscription.id ?? checkout.subscription_id ?? null, metadata.plan_key ?? null, mappedStatus, subscription.current_period_starts_at ?? null, subscription.current_period_ends_at ?? null, JSON.stringify({ lastWebhookEventId: eventId, lastWebhookType: eventType, invoiceId: data.invoice_id ?? null })]
    );
    if (mappedStatus === 'active') {
      await query(`UPDATE workspaces SET onboarding_step='setup_complete', onboarding_completed_at=COALESCE(onboarding_completed_at, NOW()) WHERE id=$1 AND deleted_at IS NULL`, [workspaceId]);
    }
  }
  await query(`UPDATE airwallex_webhook_events SET processed_at=NOW() WHERE event_id=$1`, [eventId]);
  return { processed: true, eventId, status: mappedStatus };
}

export const billingPlans = Object.entries(planConfig).map(([key, value]) => ({ key, label: value.label, amountMinor: value.amountMinor, currency: 'CNY', interval: 'year' }));
