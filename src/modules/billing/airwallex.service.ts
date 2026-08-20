import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { sendMail } from '../../utils/mailer.js';
import { query, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/app-error.js';
import { queueInitialBusinessAnalysis } from '../agents/initial-analysis.service.js';

export type BillingPlanKey = 'explorer' | 'starter' | 'ai' | 'test';

type AirwallexObject = Record<string, any>;

const planConfig: Record<BillingPlanKey, { amountMinor: number; priceEnv?: keyof typeof env; label: string }> = {
  explorer: { amountMinor: 0, label: 'Explorer' },
  starter: { amountMinor: 420000, priceEnv: 'AIRWALLEX_STARTER_PRICE_ID', label: 'Starter' },
  ai: { amountMinor: 3000000, priceEnv: 'AIRWALLEX_AI_PRICE_ID', label: 'AI' },
  test: { amountMinor: 100, priceEnv: 'AIRWALLEX_TEST_PRICE_ID', label: 'Test' },
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

async function airwallexRequest(path: string, body: AirwallexObject, requestId: string, operation = 'REQUEST') {
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
    throw providerError(`AIRWALLEX_${operation}_FAILED`, `Airwallex rejected the ${operation.toLowerCase().replaceAll('_', ' ')} request`, { providerHttpStatus: response.status, providerCode, providerMessage, path }, 502);
  }
  return data;
}

async function fetchAirwallexInvoice(invoiceId: string, requestId: string) {
  const token = await login();
  const response = await fetch(`${env.AIRWALLEX_BASE_URL}/api/v1/billing/invoices/${encodeURIComponent(invoiceId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-client-id': env.AIRWALLEX_CLIENT_ID!,
      Accept: 'application/json',
    },
  });
  const data = await response.json().catch(() => ({})) as AirwallexObject;
  if (!response.ok) {
    logger.warn({ code: 'AIRWALLEX_INVOICE_LOOKUP_FAILED', requestId, invoiceId, providerHttpStatus: response.status, providerCode: data.code ?? data.error_code ?? null, providerMessage: data.message ?? data.error ?? null }, 'Airwallex invoice lookup rejected');
    return null;
  }
  return data;
}

async function sendInvoiceEmailForWebhook(workspaceId: string, planKey: BillingPlanKey, invoiceId: string, eventId: string) {
  const checkout = await query<{ customer_email: string | null; invoice_email_sent_at: string | null }>(
    `SELECT customer_email, invoice_email_sent_at FROM workspace_billing_checkouts
     WHERE workspace_id=$1 AND plan_key=$2 ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, planKey]
  );
  const recipient = checkout.rows[0]?.customer_email;
  if (!recipient || checkout.rows[0]?.invoice_email_sent_at) return;

  const invoice = await fetchAirwallexInvoice(invoiceId, eventId);
  if (!invoice) return;
  const pdfUrl = typeof invoice.pdf_url === 'string' ? invoice.pdf_url : typeof invoice.invoice_pdf_url === 'string' ? invoice.invoice_pdf_url : null;
  const hostedUrl = typeof invoice.hosted_invoice_url === 'string' ? invoice.hosted_invoice_url : typeof invoice.url === 'string' ? invoice.url : null;
  if (!pdfUrl) {
    logger.warn({ code: 'AIRWALLEX_INVOICE_PDF_URL_MISSING', workspaceId, planKey, invoiceId }, 'Airwallex invoice has no PDF URL yet');
    return;
  }

  const pdfResponse = await fetch(pdfUrl);
  if (!pdfResponse.ok) {
    logger.warn({ code: 'AIRWALLEX_INVOICE_PDF_DOWNLOAD_FAILED', workspaceId, planKey, invoiceId, providerHttpStatus: pdfResponse.status }, 'Airwallex invoice PDF download failed');
    return;
  }
  const pdf = Buffer.from(await pdfResponse.arrayBuffer());
  const invoiceNumber = String(invoice.number ?? invoiceId);
  const safeHostedUrl = hostedUrl ? `<p>You can also view the invoice online: <a href="${hostedUrl}">${hostedUrl}</a></p>` : '';
  await sendMail(
    recipient,
    `Lulu AI invoice ${invoiceNumber}`,
    `<p>Thank you for your payment. Your Lulu AI invoice is attached as a PDF.</p>${safeHostedUrl}`,
    [{ filename: `lulu-ai-invoice-${invoiceNumber}.pdf`, content: pdf, contentType: 'application/pdf' }]
  );
  await query(
    `UPDATE workspace_billing_checkouts SET provider_invoice_id=$2, invoice_pdf_url=$3, invoice_email_sent_at=NOW(), updated_at=NOW()
     WHERE workspace_id=$1 AND plan_key=$4`,
    [workspaceId, invoiceId, pdfUrl, planKey]
  );
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

export async function createCheckout(input: { workspaceId: string; planKey: BillingPlanKey; successUrl: string; backUrl: string; customerEmail?: string }) {
  const config = planConfig[input.planKey];
  if (!config) throw providerError('BILLING_PLAN_INVALID', 'The selected billing plan is not supported', { planKey: input.planKey }, 422);

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

  if (!env.AIRWALLEX_LINKED_PAYMENT_ACCOUNT_ID) {
    throw providerError(
      'AIRWALLEX_LINKED_PAYMENT_ACCOUNT_ID_MISSING',
      'Airwallex requires a linked payment account because this seller has multiple linked payment accounts',
      {
        requiredEnv: 'AIRWALLEX_LINKED_PAYMENT_ACCOUNT_ID',
        configuration: 'Set the seller linked payment account ID in the backend environment before creating a checkout',
      },
      500,
    );
  }

  const checkout = await airwallexRequest('/api/v1/billing/billing_checkouts/create', {
    mode: 'SUBSCRIPTION',
    ui_mode: 'HOSTED',
    locale: 'AUTO',
    customer_data: { name: 'Lulu AI workspace', type: 'BUSINESS', ...(input.customerEmail ? { email: input.customerEmail } : {}) },
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
  }, crypto.randomUUID(), 'CHECKOUT_CREATE');

  const checkoutId = String(checkout.id ?? '');
  if (!checkoutId) throw providerError('AIRWALLEX_CHECKOUT_ID_MISSING', 'Airwallex did not return a Billing Checkout ID');
  const checkoutUrl = typeof checkout.url === 'string' ? checkout.url : typeof checkout.checkout_url === 'string' ? checkout.checkout_url : typeof checkout.hosted_checkout_url === 'string' ? checkout.hosted_checkout_url : null;
  if (!checkoutUrl) throw providerError('AIRWALLEX_CHECKOUT_URL_MISSING', 'Airwallex did not return a hosted Checkout URL', { checkoutId });

  await query(
    `INSERT INTO workspace_billing_checkouts (workspace_id, plan_key, provider_checkout_id, provider_customer_id, provider_subscription_id, provider_invoice_id, customer_email, status, checkout_url, amount_minor, currency, raw_response)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'CNY', $11::jsonb)`,
    [input.workspaceId, input.planKey, checkoutId, checkout.billing_customer_id ?? null, checkout.subscription_id ?? null, checkout.invoice_id ?? null, input.customerEmail ?? null, checkout.status ?? 'ACTIVE', checkoutUrl, config.amountMinor, JSON.stringify(checkout)]
  );

  await query(
    `INSERT INTO workspace_subscriptions (workspace_id, provider, provider_customer_id, provider_subscription_id, plan_key, status, current_period_starts_at, current_period_ends_at, metadata)
     VALUES ($1, 'airwallex', $2, $3, $4, 'trialing', NOW(), NOW() + INTERVAL '1 year', $5::jsonb)
     ON CONFLICT (workspace_id) DO UPDATE SET provider='airwallex', provider_customer_id=COALESCE(EXCLUDED.provider_customer_id, workspace_subscriptions.provider_customer_id), provider_subscription_id=COALESCE(EXCLUDED.provider_subscription_id, workspace_subscriptions.provider_subscription_id), plan_key=EXCLUDED.plan_key, status='trialing', metadata=workspace_subscriptions.metadata || EXCLUDED.metadata, updated_at=NOW()` ,
    [input.workspaceId, checkout.billing_customer_id ?? null, checkout.subscription_id ?? null, input.planKey, JSON.stringify({ checkoutId, amountMinor: config.amountMinor, checkoutUrl })]
  );

  return { planKey: input.planKey, free: false, checkoutId, checkoutUrl, status: checkout.status ?? 'ACTIVE' };
}

async function airwallexGet(path: string, operation = 'CHECKOUT_STATUS') {
  const token = await login();
  const response = await fetch(`${env.AIRWALLEX_BASE_URL}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-client-id': env.AIRWALLEX_CLIENT_ID!,
      Accept: 'application/json',
    },
  });
  const data = await response.json().catch(() => ({})) as AirwallexObject;
  if (!response.ok) {
    const providerCode = data.code ?? data.error_code ?? null;
    const providerMessage = data.message ?? data.error ?? null;
    logger.warn({ path, providerHttpStatus: response.status, providerCode, providerMessage }, 'Airwallex status request rejected');
    throw providerError(`AIRWALLEX_${operation}_FAILED`, `Airwallex rejected the ${operation.toLowerCase().replaceAll('_', ' ')} request`, { providerHttpStatus: response.status, providerCode, providerMessage, path }, 502);
  }
  return data;
}

export async function syncCheckoutStatus(workspaceId: string, checkoutId: string) {
  const local = await query<{ plan_key: BillingPlanKey; provider_checkout_id: string }>(
    `SELECT plan_key, provider_checkout_id FROM workspace_billing_checkouts WHERE workspace_id=$1 AND provider_checkout_id=$2 LIMIT 1`,
    [workspaceId, checkoutId]
  );
  if (!local.rows[0]) throw providerError('BILLING_CHECKOUT_NOT_FOUND', 'The billing checkout does not belong to this workspace', { checkoutId }, 404);

  const checkout = await airwallexGet(`/api/v1/billing/billing_checkouts/${encodeURIComponent(checkoutId)}`);
  const subscription = (checkout.subscription ?? {}) as AirwallexObject;
  const providerStatus = String(checkout.status ?? subscription.status ?? '').toUpperCase();
  const completed = providerStatus === 'COMPLETED' || String(subscription.status ?? '').toUpperCase() === 'ACTIVE';
  const customerId = checkout.billing_customer_id ?? checkout.customer_id ?? subscription.billing_customer_id ?? null;
  const subscriptionId = checkout.subscription_id ?? subscription.id ?? null;
  const invoiceId = checkout.invoice_id ?? checkout.latest_invoice_id ?? subscription.invoice_id ?? subscription.latest_invoice_id ?? null;

  await query(
    `UPDATE workspace_billing_checkouts
     SET provider_customer_id=COALESCE($3, provider_customer_id),
         provider_subscription_id=COALESCE($4, provider_subscription_id),
         provider_invoice_id=COALESCE($5, provider_invoice_id),
         status=$6,
         raw_response=$7::jsonb,
         updated_at=NOW()
     WHERE workspace_id=$1 AND provider_checkout_id=$2`,
    [workspaceId, checkoutId, customerId, subscriptionId, invoiceId, completed ? 'COMPLETED' : providerStatus === 'CANCELLED' ? 'CANCELLED' : providerStatus === 'EXPIRED' ? 'EXPIRED' : 'ACTIVE', JSON.stringify(checkout)]
  );

  if (!completed) return { checkoutId, planKey: local.rows[0].plan_key, status: 'pending' as const, providerStatus };

  await query(
    `UPDATE workspace_subscriptions
     SET provider='airwallex', provider_customer_id=COALESCE($2, provider_customer_id), provider_subscription_id=COALESCE($3, provider_subscription_id), plan_key=$4, status='active', metadata=metadata || $5::jsonb, updated_at=NOW()
     WHERE workspace_id=$1`,
    [workspaceId, customerId, subscriptionId, local.rows[0].plan_key, JSON.stringify({ syncedFromCheckout: checkoutId, invoiceId })]
  );
  await query(`UPDATE workspaces SET onboarding_step='setup_complete', onboarding_completed_at=COALESCE(onboarding_completed_at, NOW()) WHERE id=$1 AND deleted_at IS NULL`, [workspaceId]);
  void queueInitialBusinessAnalysis(workspaceId).catch((error) => logger.error({ error, workspaceId }, 'Post-payment initial analysis could not be queued'));
  return { checkoutId, planKey: local.rows[0].plan_key, status: 'active' as const, providerStatus, subscriptionId, invoiceId };
}

export function verifyWebhookSignature(rawBody: string, timestamp: string | undefined, signature: string | undefined, nonce: string | undefined) {
  if (!env.AIRWALLEX_WEBHOOK_SECRET) throw providerError('AIRWALLEX_WEBHOOK_SECRET_MISSING', 'Airwallex webhook secret is missing on the server', { requiredEnv: 'AIRWALLEX_WEBHOOK_SECRET' }, 500);
  if (!timestamp || !signature || !nonce) throw providerError('AIRWALLEX_WEBHOOK_HEADERS_MISSING', 'Airwallex webhook signature headers are missing', { requiredHeaders: ['x-timestamp', 'x-signature', 'x-nonce'] }, 403);
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) throw providerError('AIRWALLEX_WEBHOOK_TIMESTAMP_INVALID', 'Airwallex webhook timestamp is invalid', undefined, 403);
  if (Math.abs(Date.now() - timestampNumber * 1000) > env.AIRWALLEX_WEBHOOK_TOLERANCE_SECONDS * 1000) throw providerError('AIRWALLEX_WEBHOOK_TIMESTAMP_EXPIRED', 'Airwallex webhook timestamp is outside the allowed tolerance', { toleranceSeconds: env.AIRWALLEX_WEBHOOK_TOLERANCE_SECONDS }, 403);
  const expected = crypto.createHmac('sha256', env.AIRWALLEX_WEBHOOK_SECRET).update(`${timestamp}${nonce}${rawBody}`).digest('hex');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw providerError('AIRWALLEX_WEBHOOK_SIGNATURE_INVALID', 'Airwallex webhook signature is invalid', { signatureFormat: 'HMAC-SHA256' }, 403);
}

export async function handleWebhook(event: AirwallexObject) {
  const eventId = String(event.id ?? event.event_id ?? '');
  const eventType = String(event.type ?? event.event_type ?? 'unknown');
  if (!eventId) throw providerError('AIRWALLEX_WEBHOOK_EVENT_ID_MISSING', 'Airwallex webhook event ID is missing', undefined, 400);

  const claim = await withTransaction(async (client) => {
    const inserted = await query<{ event_id: string; processed_at: string | null }>(
      `INSERT INTO airwallex_webhook_events (event_id, event_type, payload, processing_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id, processed_at`,
      [eventId, eventType, JSON.stringify(event)],
      client,
    );
    if (inserted.rowCount > 0) return { claimed: true, processed: false };

    const existing = await query<{ processed_at: string | null; processing_at: string | null }>(
      `SELECT processed_at, processing_at
       FROM airwallex_webhook_events
       WHERE event_id=$1
       FOR UPDATE`,
      [eventId],
      client,
    );
    const row = existing.rows[0];
    if (!row) return { claimed: false, processed: false };
    if (row.processed_at) return { claimed: false, processed: true };

    await query(
      `UPDATE airwallex_webhook_events
       SET processing_at=NOW(), last_error_code=NULL, payload=$2::jsonb, event_type=$3
       WHERE event_id=$1`,
      [eventId, JSON.stringify(event), eventType],
      client,
    );
    return { claimed: true, processed: false };
  });

  if (!claim.claimed) return { duplicate: true, eventId, processed: claim.processed };

  try {
    const data = (event.data ?? event.object ?? {}) as AirwallexObject;
    const metadata = (data.metadata ?? data.subscription?.metadata ?? data.checkout?.metadata ?? {}) as AirwallexObject;
    const workspaceId = typeof metadata.workspace_id === 'string' ? metadata.workspace_id : null;
    if (!workspaceId) {
      await query(`UPDATE airwallex_webhook_events SET processed_at=NOW(), processing_at=NULL WHERE event_id=$1`, [eventId]);
      logger.warn({ eventId, eventType }, 'Airwallex webhook ignored: workspace metadata missing');
      return { processed: false, eventId, reason: 'workspace_id_missing', code: 'AIRWALLEX_WEBHOOK_WORKSPACE_ID_MISSING' };
    }

    const subscription = (data.subscription ?? data) as AirwallexObject;
    const checkout = (data.checkout ?? data) as AirwallexObject;
    const providerStatus = String(subscription.status ?? checkout.status ?? '').toUpperCase();
    const mappedStatus = providerStatus === 'ACTIVE' || eventType.includes('PAID') || eventType.includes('COMPLETED') ? 'active' : providerStatus === 'CANCELLED' ? 'cancelled' : providerStatus === 'EXPIRED' ? 'expired' : providerStatus === 'UNPAID' ? 'past_due' : null;
    if (!mappedStatus) {
      await query(`UPDATE airwallex_webhook_events SET processed_at=NOW(), processing_at=NULL WHERE event_id=$1`, [eventId]);
      logger.warn({ eventId, eventType, providerStatus }, 'Airwallex webhook ignored: unsupported subscription status');
      return { processed: false, eventId, reason: 'unsupported_subscription_status', code: 'AIRWALLEX_SUBSCRIPTION_STATUS_UNSUPPORTED' };
    }

    await query(
      `UPDATE workspace_subscriptions SET provider='airwallex', provider_customer_id=COALESCE($2, provider_customer_id), provider_subscription_id=COALESCE($3, provider_subscription_id), plan_key=COALESCE($4, plan_key), status=$5, current_period_starts_at=COALESCE($6::timestamptz, current_period_starts_at), current_period_ends_at=COALESCE($7::timestamptz, current_period_ends_at), metadata=metadata || $8::jsonb, updated_at=NOW() WHERE workspace_id=$1`,
      [workspaceId, subscription.billing_customer_id ?? checkout.billing_customer_id ?? null, subscription.id ?? checkout.subscription_id ?? null, metadata.plan_key ?? null, mappedStatus, subscription.current_period_starts_at ?? null, subscription.current_period_ends_at ?? null, JSON.stringify({ lastWebhookEventId: eventId, lastWebhookType: eventType, invoiceId: data.invoice_id ?? null })]
    );
    if (mappedStatus === 'active') {
      await query(`UPDATE workspaces SET onboarding_step='setup_complete', onboarding_completed_at=COALESCE(onboarding_completed_at, NOW()) WHERE id=$1 AND deleted_at IS NULL`, [workspaceId]);
      void queueInitialBusinessAnalysis(workspaceId).catch((error) => logger.error({ error, workspaceId, eventId }, 'Post-payment initial analysis could not be queued'));
    }
    const invoiceId = String(data.invoice_id ?? data.invoice?.id ?? subscription.invoice_id ?? subscription.latest_invoice_id ?? checkout.invoice_id ?? checkout.latest_invoice_id ?? '');
    const planKey = metadata.plan_key as BillingPlanKey | undefined;
    if (invoiceId && (mappedStatus === 'active' || eventType.includes('INVOICE') || eventType.includes('PAID'))) {
      try {
        if (planKey === 'starter' || planKey === 'ai' || planKey === 'test') await sendInvoiceEmailForWebhook(workspaceId, planKey, invoiceId, eventId);
      } catch (error) {
        logger.error({ code: 'BILLING_INVOICE_EMAIL_FAILED', error: error instanceof Error ? error.message : 'unknown_error', workspaceId, planKey, invoiceId, eventId }, 'Invoice email delivery failed');
      }
    }
    await query(`UPDATE airwallex_webhook_events SET processed_at=NOW(), processing_at=NULL, last_error_code=NULL WHERE event_id=$1`, [eventId]);
    return { processed: true, eventId, status: mappedStatus };
  } catch (error) {
    const errorCode = error instanceof AppError ? error.code : 'AIRWALLEX_WEBHOOK_PROCESSING_FAILED';
    await query(`UPDATE airwallex_webhook_events SET processing_at=NULL, last_error_code=$2 WHERE event_id=$1`, [eventId, errorCode]).catch((updateError) => logger.error({ updateError, eventId }, 'Could not release Airwallex webhook claim'));
    throw error;
  }
}

export const billingPlans = Object.entries(planConfig).map(([key, value]) => ({ key, label: value.label, amountMinor: value.amountMinor, currency: 'CNY', interval: 'year' }));
