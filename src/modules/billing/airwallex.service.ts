import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { sendMail } from '../../utils/mailer.js';
import { query, withTransaction } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { AppError } from '../../utils/app-error.js';
import { queueInitialBusinessAnalysis } from '../agents/initial-analysis.service.js';
import { startContentRefresh } from '../content-generation/content-generation.service.js';
import { analyzeChannel } from '../search-intelligence/search-intelligence.service.js';
import { discoverCompetitors } from '../onboarding/onboarding.service.js';
import * as onboardingRepo from '../onboarding/onboarding.repo.js';
import { findWorkspaceById } from '../workspaces/workspace.repo.js';
import { startAutomaticWebsiteGeneration, syncWordpressProviderSites } from '../websites/website.automation.service.js';
import { requestWebsiteGenerationWorkerRun } from '../websites/website.worker.js';
import {
  applyPaygInvoiceWebhook,
  disableWorkspacePaygBilling,
  ensurePaygProfile,
  failPaygPeriod,
  finalizePaygApiCheckoutPeriod,
  markPaygLineItemsAdded,
  reservePaygApiCheckout,
  savePaygProviderInvoice,
} from './payg-billing.repo.js';
import { getPaygDirectPaymentMethods } from './payg-payment-methods.js';

export type BillingPlanKey = 'explorer' | 'viewer' | 'starter' | 'ai' | 'test';

type AirwallexObject = Record<string, any>;

const planConfig: Record<BillingPlanKey, { amountMinor: number; priceEnv?: keyof typeof env; label: string }> = {
  explorer: { amountMinor: 0, label: 'Explorer (legacy)' },
  viewer: { amountMinor: 0, label: 'Viewer' },
  starter: { amountMinor: 420000, priceEnv: 'AIRWALLEX_STARTER_PRICE_ID', label: 'Starter' },
  ai: { amountMinor: 3000000, priceEnv: 'AIRWALLEX_AI_PRICE_ID', label: 'AI' },
  test: { amountMinor: 0, priceEnv: 'AIRWALLEX_TEST_PRICE_ID', label: 'Test' },
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

async function airwallexPostWithoutBody(path: string, operation: string) {
  const token = await login();
  const response = await fetch(`${env.AIRWALLEX_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-client-id': env.AIRWALLEX_CLIENT_ID!,
    },
  });
  const data = await response.json().catch(() => ({})) as AirwallexObject;
  if (!response.ok) {
    const providerCode = data.code ?? data.error_code ?? null;
    const providerMessage = data.message ?? data.error ?? null;
    logger.warn({ path, providerHttpStatus: response.status, providerCode, providerMessage }, 'Airwallex billing request rejected');
    throw providerError(`AIRWALLEX_${operation}_FAILED`, `Airwallex rejected the ${operation.toLowerCase().replaceAll('_', ' ')} request`, { providerHttpStatus: response.status, providerCode, providerMessage, path }, 502);
  }
  return data;
}

async function airwallexPostBody(path: string, body: AirwallexObject, operation: string) {
  const token = await login();
  const response = await fetch(`${env.AIRWALLEX_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-client-id': env.AIRWALLEX_CLIENT_ID!,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as AirwallexObject;
  if (!response.ok) {
    const providerCode = data.code ?? data.error_code ?? null;
    const providerMessage = data.message ?? data.error ?? null;
    logger.warn({ path, providerHttpStatus: response.status, providerCode, providerMessage }, 'Airwallex billing request rejected');
    throw providerError(`AIRWALLEX_${operation}_FAILED`, `Airwallex rejected the ${operation.toLowerCase().replaceAll('_', ' ')} request`, { providerHttpStatus: response.status, providerCode, providerMessage, path }, 502);
  }
  return data;
}

export function deterministicBillingRequestId(seed: string) {
  const bytes = crypto.createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function createPaygInvoiceDraft(input: {
  periodId: string;
  workspaceId: string;
  periodStart: string;
  periodEnd: string;
  billingCustomerId: string;
  paymentSourceId?: string | null;
}) {
  const autoCharge = Boolean(input.paymentSourceId);
  return airwallexRequest('/api/v1/billing/invoices/create', {
    billing_customer_id: input.billingCustomerId,
    collection_method: autoCharge ? 'AUTO_CHARGE' : 'CHARGE_ON_CHECKOUT',
    currency: 'USD',
    days_until_due: env.PAYG_INVOICE_DAYS_UNTIL_DUE,
    default_tax_percent: 0,
    memo: `Lulu AI pay-as-you-go usage ${input.periodStart.slice(0, 10)} - ${input.periodEnd.slice(0, 10)}`,
    footer: 'API and AWS infrastructure usage is collected automatically every Monday. A payment link is available only if automatic collection fails.',
    metadata: {
      workspace_id: input.workspaceId,
      payg_period_id: input.periodId,
      billing_type: 'payg_weekly_monday',
    },
    ...(env.AIRWALLEX_LEGAL_ENTITY_ID ? { legal_entity_id: env.AIRWALLEX_LEGAL_ENTITY_ID } : {}),
    ...(env.AIRWALLEX_LINKED_PAYMENT_ACCOUNT_ID ? { linked_payment_account_id: env.AIRWALLEX_LINKED_PAYMENT_ACCOUNT_ID } : {}),
    ...(autoCharge
      ? { payment_source_id: input.paymentSourceId }
      : {
          payment_options: {
            payment_method_save: { mode: 'ENABLED', next_triggered_by: 'MERCHANT' },
            payment_method_types: ['card', 'googlepay', 'applepay'],
          },
        }),
  }, deterministicBillingRequestId(`payg-invoice:${input.periodId}`), 'PAYG_INVOICE_CREATE');
}

export async function addPaygInvoiceLineItems(input: {
  periodId: string;
  invoiceId: string;
  apiCostUsd: number;
  serverCostUsd: number;
  periodStart: string;
  periodEnd: string;
}) {
  const periodLabel = `${input.periodStart.slice(0, 10)} - ${input.periodEnd.slice(0, 10)}`;
  const lineItems = [
    { key: 'api', name: 'Lulu AI API usage', description: `AI and external API usage for ${periodLabel}`, amount: input.apiCostUsd },
    { key: 'server', name: 'Lulu AI AWS infrastructure usage', description: `AWS infrastructure usage for ${periodLabel}, billed at 2× provider cost`, amount: input.serverCostUsd },
  ].filter((item) => item.amount > 0).map((item) => ({
    description: item.description,
    quantity: 1,
    metadata: { usage_type: item.key, payg_period_id: input.periodId },
    price: {
      pricing_model: 'FLAT',
      flat_amount: Number(item.amount.toFixed(8)),
      tax_included: false,
      product: {
        name: item.name,
        description: item.description,
        unit: 'weekly period',
        metadata: { billing_type: 'payg' },
      },
    },
  }));
  if (lineItems.length === 0) return null;
  return airwallexRequest(
    `/api/v1/billing/invoices/${encodeURIComponent(input.invoiceId)}/add_line_items`,
    { line_items: lineItems },
    deterministicBillingRequestId(`payg-line-items:${input.periodId}`),
    'PAYG_LINE_ITEMS_ADD',
  );
}

export function finalizePaygInvoice(invoiceId: string) {
  return airwallexPostWithoutBody(
    `/api/v1/billing/invoices/${encodeURIComponent(invoiceId)}/finalize`,
    'PAYG_INVOICE_FINALIZE',
  );
}

export function payPaygInvoice(invoiceId: string, paymentSourceId: string) {
  return airwallexPostBody(
    `/api/v1/billing/invoices/${encodeURIComponent(invoiceId)}/pay`,
    { payment_source_id: paymentSourceId },
    'PAYG_INVOICE_PAYMENT',
  );
}

export async function createPaygBillingCustomer(input: {
  workspaceId: string;
  name: string;
  email?: string | null;
}) {
  return airwallexRequest('/api/v1/billing/billing_customers/create', {
    name: input.name,
    type: 'BUSINESS',
    default_billing_currency: 'USD',
    description: 'Lulu AI pay-as-you-go customer',
    metadata: { workspace_id: input.workspaceId, billing_type: 'payg_weekly_monday' },
    ...(input.email ? { email: input.email } : {}),
    ...(env.AIRWALLEX_LEGAL_ENTITY_ID ? { default_legal_entity_id: env.AIRWALLEX_LEGAL_ENTITY_ID } : {}),
  }, deterministicBillingRequestId(`payg-customer:${input.workspaceId}`), 'PAYG_CUSTOMER_CREATE');
}

export async function fetchAirwallexInvoice(invoiceId: string, requestId: string) {
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

async function activateInternalPlan(workspaceId: string, planKey: BillingPlanKey, metadata: Record<string, unknown>, automationTrigger?: string) {
  await withTransaction(async (client) => {
    await query(
      `INSERT INTO workspace_subscriptions (workspace_id, provider, plan_key, status, current_period_starts_at, current_period_ends_at, metadata)
       VALUES ($1, 'internal', $2, 'active', NOW(), NOW() + INTERVAL '1 year', $3::jsonb)
       ON CONFLICT (workspace_id) DO UPDATE SET provider='internal', plan_key=EXCLUDED.plan_key, status='active', cancel_at_period_end=false, current_period_starts_at=NOW(), current_period_ends_at=NOW() + INTERVAL '1 year', metadata=workspace_subscriptions.metadata || EXCLUDED.metadata, updated_at=NOW()` ,
      [workspaceId, planKey, JSON.stringify(metadata)],
      client,
    );
    await query(`UPDATE workspaces SET onboarding_step='setup_complete', onboarding_completed_at=COALESCE(onboarding_completed_at, NOW()) WHERE id=$1 AND deleted_at IS NULL`, [workspaceId], client);
    if (automationTrigger) {
      await appendDomainEvent({
        workspaceId,
        type: DOMAIN_EVENT_TYPES.BILLING_ACTIVATED,
        aggregateType: 'workspace_subscription',
        aggregateId: workspaceId,
        payload: { planKey, trigger: automationTrigger },
        metadata: { source: 'billing' },
        idempotencyKey: `billing-activated:${workspaceId}`,
      }, client);
    }
  });
}

export async function createPaygApiUsageCheckout(workspaceId: string) {
  const period = await reservePaygApiCheckout(workspaceId);
  if (period.providerInvoiceId && period.finalizedAt) {
    return {
      periodId: period.id,
      paymentUrl: period.hostedInvoiceUrl,
      status: period.status,
      reused: true,
    };
  }
  if (period.reused && period.status === 'processing' && !period.providerInvoiceId) {
    throw new AppError(409, 'PAYG_API_CHECKOUT_IN_PROGRESS', 'An API usage payment is already being prepared. Please try again shortly.');
  }

  try {
    let invoiceId = period.providerInvoiceId;
    let paymentUrl = period.hostedInvoiceUrl;
    if (!invoiceId) {
      const draft = await airwallexRequest('/api/v1/billing/invoices/create', {
        billing_customer_id: period.providerCustomerId,
        collection_method: 'CHARGE_ON_CHECKOUT',
        currency: period.currency,
        days_until_due: env.PAYG_INVOICE_DAYS_UNTIL_DUE,
        default_tax_percent: 0,
        memo: 'Lulu AI API usage payment',
        footer: 'This invoice settles API usage accrued to the payment cutoff. Server and storage usage continue in the weekly billing cycle.',
        metadata: {
          workspace_id: workspaceId,
          payg_period_id: period.id,
          billing_type: 'payg_api_pay_now',
        },
        payment_options: {
          payment_method_types: getPaygDirectPaymentMethods(),
        },
        ...(env.AIRWALLEX_LEGAL_ENTITY_ID ? { legal_entity_id: env.AIRWALLEX_LEGAL_ENTITY_ID } : {}),
        ...(env.AIRWALLEX_LINKED_PAYMENT_ACCOUNT_ID ? { linked_payment_account_id: env.AIRWALLEX_LINKED_PAYMENT_ACCOUNT_ID } : {}),
      }, deterministicBillingRequestId(`payg-api-pay-now:${period.id}`), 'PAYG_API_CHECKOUT_CREATE');
      invoiceId = String(draft.id ?? '');
      if (!invoiceId) throw providerError('AIRWALLEX_PAYG_API_INVOICE_ID_MISSING', 'Airwallex did not return an invoice ID for the API usage payment.');
      paymentUrl = typeof draft.hosted_url === 'string' ? draft.hosted_url : null;
      await savePaygProviderInvoice(period.id, invoiceId, paymentUrl);
    }

    if (!period.lineItemsAddedAt) {
      await addPaygInvoiceLineItems({
        periodId: period.id,
        invoiceId,
        apiCostUsd: Number(period.apiCostUsd),
        serverCostUsd: 0,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
      });
      await markPaygLineItemsAdded(period.id);
    }
    const finalized = await finalizePaygInvoice(invoiceId);
    await finalizePaygApiCheckoutPeriod(period.id, finalized);
    return {
      periodId: period.id,
      paymentUrl: typeof finalized.hosted_url === 'string' ? finalized.hosted_url : paymentUrl,
      status: String(finalized.payment_status ?? '').toUpperCase() === 'PAID' ? 'paid' as const : 'payment_due' as const,
      reused: period.reused,
    };
  } catch (error) {
    await failPaygPeriod(period.id, error instanceof AppError ? error.code : 'PAYG_API_CHECKOUT_FAILED', error instanceof Error ? error.message : 'Unknown API usage checkout error');
    throw error;
  }
}

async function assertOnboardingReadyForBilling(workspaceId: string) {
  const [workspace, state] = await Promise.all([
    findWorkspaceById(workspaceId),
    onboardingRepo.getCompletionState(workspaceId),
  ]);
  if (!workspace || !state) throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found.');

  const missing: string[] = [];
  if (!state.hasCompanyInformation) missing.push('companyInformation');
  if (!state.hasBusinessDescription || workspace.onboardingFileReuploadRequired) missing.push('businessDescription');
  if (!workspace.onboardingCompletedAt && !['billing', 'setup_complete'].includes(workspace.onboardingStep)) missing.push('existingPlatforms');
  if (missing.length > 0) {
    throw new AppError(422, 'ONBOARDING_INCOMPLETE', 'Complete the required onboarding steps before choosing a billing plan.', { missing });
  }
}

function testPlanPasswordMatches(password?: string) {
  const configuredPassword = env.BILLING_TEST_PLAN_PASSWORD;
  if (!configuredPassword) {
    throw new AppError(503, 'BILLING_TEST_PLAN_DISABLED', 'The internal Test plan is not enabled on this server.');
  }
  const suppliedHash = crypto.createHash('sha256').update(password ?? '').digest();
  const configuredHash = crypto.createHash('sha256').update(configuredPassword).digest();
  return crypto.timingSafeEqual(suppliedHash, configuredHash);
}

function detectSearchLanguageCode(languages: string[]) {
  const primary = String(languages[0] ?? '').trim().toLowerCase();
  if (!primary) return 'en';
  if (primary.startsWith('de') || primary.includes('german') || primary.includes('deutsch')) return 'de';
  if (primary.startsWith('fr') || primary.includes('french') || primary.includes('francais') || primary.includes('français')) return 'fr';
  if (primary.startsWith('es') || primary.includes('spanish') || primary.includes('espanol') || primary.includes('español')) return 'es';
  if (primary.startsWith('it') || primary.includes('italian') || primary.includes('italiano')) return 'it';
  if (primary.startsWith('pt') || primary.includes('portuguese') || primary.includes('português') || primary.includes('portugues')) return 'pt';
  if (primary.startsWith('nl') || primary.includes('dutch') || primary.includes('nederlands')) return 'nl';
  return primary.slice(0, 2) || 'en';
}

async function startPostPaymentSearchAutomation(workspaceId: string, userId: string, languageCode: string) {
  const input = {
    locationCode: 2840,
    languageCode,
    depth: 20,
    maxKeywords: 10,
    device: 'desktop' as const,
    autoApply: true,
  };

  for (const channel of ['seo', 'geo', 'aeo'] as const) {
    try {
      await analyzeChannel(workspaceId, userId, channel, input);
    } catch (error) {
      logger.error({ error, workspaceId, userId, channel }, 'Post-payment search automation failed');
    }
  }
}

async function startPostPaymentWebsiteAutomation(workspaceId: string, userId: string) {
  let queuedWorker = false;

  try {
    const platforms = await onboardingRepo.listPlatforms(workspaceId);
    const connectedPlatforms = new Set(
      platforms
        .filter((platform) => platform.connectionStatus === 'connected' && platform.integrationKey)
        .map((platform) => platform.integrationKey as string),
    );

    if (connectedPlatforms.has('wordpress')) {
      try {
        const sites = await syncWordpressProviderSites(workspaceId);
        const wordpressSites = sites.filter((site) => site.provider === 'wordpress' && site.externalSiteId && site.status !== 'error');
        if (wordpressSites.length === 1) {
          await startAutomaticWebsiteGeneration({
            workspaceId,
            userId,
            provider: 'wordpress',
            targetMode: 'existing',
            siteId: wordpressSites[0]!.id,
          });
          queuedWorker = true;
        } else if (wordpressSites.length > 1) {
          logger.info({ workspaceId, siteCount: wordpressSites.length }, 'Post-payment WordPress website automation skipped because a site selection is required');
        }
      } catch (error) {
        logger.error({ error, workspaceId, userId, provider: 'wordpress' }, 'Post-payment website automation failed');
      }
    }

    if (connectedPlatforms.has('webflow')) {
      try {
        await startAutomaticWebsiteGeneration({
          workspaceId,
          userId,
          provider: 'webflow',
          targetMode: 'existing',
        });
        queuedWorker = true;
      } catch (error) {
        logger.error({ error, workspaceId, userId, provider: 'webflow' }, 'Post-payment website automation failed');
      }
    }

    if (queuedWorker) requestWebsiteGenerationWorkerRun();
  } catch (error) {
    logger.error({ error, workspaceId, userId }, 'Post-payment website automation orchestration failed');
  }
}

async function startPostPaymentAutomation(workspaceId: string, trigger: string) {
  const workspace = await findWorkspaceById(workspaceId);
  if (!workspace) {
    throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'Post-payment automation workspace could not be loaded.');
  }

  const userId = workspace.createdBy;
  const languageCode = detectSearchLanguageCode(workspace.languages);

  await Promise.all([
    startContentRefresh(workspaceId, 'system'),
    (async () => {
    try {
      const competitors = await onboardingRepo.listCompetitors(workspaceId);
      if (competitors.length === 0) await discoverCompetitors(workspaceId, userId);
    } catch (error) {
      logger.error({ error, workspaceId, userId, trigger }, 'Post-payment competitor discovery failed');
    }
    try {
      await queueInitialBusinessAnalysis(workspaceId);
    } catch (error) {
      logger.error({ error, workspaceId, trigger }, 'Post-payment initial analysis could not be queued');
    }
    })(),
    startPostPaymentSearchAutomation(workspaceId, userId, languageCode),
    startPostPaymentWebsiteAutomation(workspaceId, userId),
  ]);

  return true;
}

export async function createCheckout(input: { workspaceId: string; planKey: BillingPlanKey; successUrl: string; backUrl: string; customerEmail?: string; password?: string; allowInternalPlans?: boolean }) {
  const config = planConfig[input.planKey];
  if (!config) throw providerError('BILLING_PLAN_INVALID', 'The selected billing plan is not supported', { planKey: input.planKey }, 422);

  if (input.planKey === 'explorer') throw new AppError(422, 'BILLING_PLAN_REMOVED', 'The Explorer plan is no longer available.');
  if ((input.planKey === 'viewer' || input.planKey === 'test') && !input.allowInternalPlans) {
    throw new AppError(403, 'BILLING_PLAN_NOT_AVAILABLE', 'The selected billing plan is not available for this account.');
  }
  await assertOnboardingReadyForBilling(input.workspaceId);
  if (input.planKey === 'viewer') {
    await activateInternalPlan(input.workspaceId, 'viewer', { source: 'viewer-plan', activatedAt: new Date().toISOString() });
    return { planKey: 'viewer' as const, free: true as const, status: 'active' as const };
  }
  if (input.planKey === 'test' && !testPlanPasswordMatches(input.password)) {
    throw new AppError(403, 'TEST_PASSWORD_INVALID', 'The Test plan password is invalid.');
  }
  if (input.planKey === 'test') {
    await activateInternalPlan(input.workspaceId, 'test', { source: 'test-plan', activatedAt: new Date().toISOString(), billingExempt: true }, 'test_plan_activation');
    await disableWorkspacePaygBilling(input.workspaceId);
    return { planKey: 'test' as const, free: true as const, status: 'active' as const };
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

  return withTransaction(async (client) => {
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`billing-checkout:${input.workspaceId}`], client);
    const existingResult = await query<{
      planKey: BillingPlanKey;
      checkoutId: string;
      checkoutUrl: string;
      status: string;
    }>(
      `SELECT plan_key AS "planKey", provider_checkout_id AS "checkoutId", checkout_url AS "checkoutUrl", status
       FROM workspace_billing_checkouts
       WHERE workspace_id=$1
         AND checkout_url IS NOT NULL
         AND upper(status) NOT IN ('CANCELLED', 'EXPIRED', 'FAILED')
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.workspaceId],
      client,
    );
    const existing = existingResult.rows[0];
    if (existing) {
      try {
        const providerCheckout = await airwallexGet(`/api/v1/billing/billing_checkouts/${encodeURIComponent(existing.checkoutId)}`);
        const providerStatus = String(providerCheckout.status ?? existing.status).toUpperCase();
        if (['CANCELLED', 'EXPIRED', 'FAILED'].includes(providerStatus)) {
          await query(
            `UPDATE workspace_billing_checkouts SET status=$3, raw_response=$4::jsonb, updated_at=NOW()
             WHERE workspace_id=$1 AND provider_checkout_id=$2`,
            [input.workspaceId, existing.checkoutId, providerStatus, JSON.stringify(providerCheckout)],
            client,
          );
        } else if (existing.planKey === input.planKey) {
          return { planKey: input.planKey, free: false as const, checkoutId: existing.checkoutId, checkoutUrl: existing.checkoutUrl, status: providerStatus, reused: true as const };
        } else {
          throw new AppError(409, 'BILLING_CHECKOUT_ALREADY_ACTIVE', 'Another billing checkout is already active for this workspace.', { planKey: existing.planKey });
        }
      } catch (error) {
        if (error instanceof AppError && error.code === 'BILLING_CHECKOUT_ALREADY_ACTIVE') throw error;
        logger.warn({ error, workspaceId: input.workspaceId, checkoutId: existing.checkoutId }, 'Existing billing checkout could not be refreshed; reusing its stored URL');
        if (existing.planKey === input.planKey) {
          return { planKey: input.planKey, free: false as const, checkoutId: existing.checkoutId, checkoutUrl: existing.checkoutUrl, status: existing.status, reused: true as const };
        }
        throw new AppError(409, 'BILLING_CHECKOUT_ALREADY_ACTIVE', 'Another billing checkout is already active for this workspace.', { planKey: existing.planKey });
      }
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
      payment_options: {
        payment_method_save: { mode: 'ENABLED', next_triggered_by: 'MERCHANT' },
        payment_method_types: ['card'],
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
      [input.workspaceId, input.planKey, checkoutId, checkout.billing_customer_id ?? null, checkout.subscription_id ?? null, checkout.invoice_id ?? null, input.customerEmail ?? null, checkout.status ?? 'ACTIVE', checkoutUrl, config.amountMinor, JSON.stringify(checkout)],
      client,
    );

    await query(
      `INSERT INTO workspace_subscriptions (workspace_id, provider, provider_customer_id, provider_subscription_id, plan_key, status, current_period_starts_at, current_period_ends_at, metadata)
       VALUES ($1, 'airwallex', $2, $3, $4, 'trialing', NOW(), NOW() + INTERVAL '1 year', $5::jsonb)
       ON CONFLICT (workspace_id) DO UPDATE SET provider='airwallex', provider_customer_id=COALESCE(EXCLUDED.provider_customer_id, workspace_subscriptions.provider_customer_id), provider_subscription_id=COALESCE(EXCLUDED.provider_subscription_id, workspace_subscriptions.provider_subscription_id), plan_key=EXCLUDED.plan_key, status='trialing', metadata=workspace_subscriptions.metadata || EXCLUDED.metadata, updated_at=NOW()` ,
      [input.workspaceId, checkout.billing_customer_id ?? null, checkout.subscription_id ?? null, input.planKey, JSON.stringify({ checkoutId, amountMinor: config.amountMinor, checkoutUrl })],
      client,
    );

    return { planKey: input.planKey, free: false as const, checkoutId, checkoutUrl, status: checkout.status ?? 'ACTIVE', reused: false as const };
  });
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
  const localCheckout = local.rows[0];
  if (!localCheckout) throw providerError('BILLING_CHECKOUT_NOT_FOUND', 'The billing checkout does not belong to this workspace', { checkoutId }, 404);

  const checkout = await airwallexGet(`/api/v1/billing/billing_checkouts/${encodeURIComponent(checkoutId)}`);
  const subscription = (checkout.subscription ?? {}) as AirwallexObject;
  const providerStatus = String(checkout.status ?? subscription.status ?? '').toUpperCase();
  const completed = providerStatus === 'COMPLETED' || String(subscription.status ?? '').toUpperCase() === 'ACTIVE';
  const customerId = checkout.billing_customer_id ?? checkout.customer_id ?? subscription.billing_customer_id ?? null;
  const subscriptionId = checkout.subscription_id ?? subscription.id ?? null;
  const paymentSourceId = checkout.payment_source_id ?? subscription.payment_source_id ?? null;
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

  if (!completed) return { checkoutId, planKey: localCheckout.plan_key, status: 'pending' as const, providerStatus };

  await query(
    `UPDATE workspace_subscriptions
     SET provider='airwallex', provider_customer_id=COALESCE($2, provider_customer_id), provider_subscription_id=COALESCE($3, provider_subscription_id), plan_key=$4, status='active', metadata=metadata || $5::jsonb, updated_at=NOW()
     WHERE workspace_id=$1`,
    [workspaceId, customerId, subscriptionId, localCheckout.plan_key, JSON.stringify({ syncedFromCheckout: checkoutId, invoiceId, paymentSourceId })]
  );
  if (localCheckout.plan_key === 'starter' || localCheckout.plan_key === 'ai') {
    await ensurePaygProfile(workspaceId, typeof paymentSourceId === 'string' ? paymentSourceId : null);
  }
  await withTransaction(async (client) => {
    await query(`UPDATE workspaces SET onboarding_step='setup_complete', onboarding_completed_at=COALESCE(onboarding_completed_at, NOW()) WHERE id=$1 AND deleted_at IS NULL`, [workspaceId], client);
    await appendDomainEvent({
      workspaceId,
      type: DOMAIN_EVENT_TYPES.BILLING_ACTIVATED,
      aggregateType: 'workspace_subscription',
      aggregateId: workspaceId,
      payload: { planKey: localCheckout.plan_key, trigger: 'checkout_sync' },
      metadata: { source: 'billing', correlationId: checkoutId },
      idempotencyKey: `billing-activated:${workspaceId}`,
    }, client);
  });
  return { checkoutId, planKey: localCheckout.plan_key, status: 'active' as const, providerStatus, subscriptionId, invoiceId };
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
    const eventData = (event.data ?? event.object ?? {}) as AirwallexObject;
    const data = eventData.object && typeof eventData.object === 'object'
      ? eventData.object as AirwallexObject
      : eventData;
    const metadata = (data.metadata ?? data.invoice?.metadata ?? data.subscription?.metadata ?? data.checkout?.metadata ?? {}) as AirwallexObject;
    const workspaceId = typeof metadata.workspace_id === 'string' ? metadata.workspace_id : null;
    if (!workspaceId) {
      await query(`UPDATE airwallex_webhook_events SET processed_at=NOW(), processing_at=NULL WHERE event_id=$1`, [eventId]);
      logger.warn({ eventId, eventType }, 'Airwallex webhook ignored: workspace metadata missing');
      return { processed: false, eventId, reason: 'workspace_id_missing', code: 'AIRWALLEX_WEBHOOK_WORKSPACE_ID_MISSING' };
    }

    const paygPeriodId = typeof metadata.payg_period_id === 'string' ? metadata.payg_period_id : null;
    if (paygPeriodId) {
      const invoice = (data.invoice ?? data) as AirwallexObject;
      const handled = await applyPaygInvoiceWebhook({
        periodId: paygPeriodId,
        providerInvoiceId: typeof invoice.id === 'string' ? invoice.id : typeof data.invoice_id === 'string' ? data.invoice_id : null,
        paymentStatus: String(invoice.payment_status ?? (eventType.includes('PAID') ? 'PAID' : 'UNPAID')),
        hostedUrl: typeof invoice.hosted_url === 'string' ? invoice.hosted_url : null,
        pdfUrl: typeof invoice.pdf_url === 'string' ? invoice.pdf_url : null,
        paidAt: typeof invoice.paid_at === 'string' ? invoice.paid_at : null,
        paymentSourceId: typeof invoice.payment_source_id === 'string' ? invoice.payment_source_id : null,
        eventType,
      });
      await query(`UPDATE airwallex_webhook_events SET processed_at=NOW(), processing_at=NULL, last_error_code=NULL WHERE event_id=$1`, [eventId]);
      return { processed: handled, eventId, paygPeriodId, status: String(invoice.payment_status ?? 'UNPAID').toLowerCase() };
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

    const webhookPaymentSourceId = subscription.payment_source_id ?? checkout.payment_source_id ?? null;
    const effectiveStatus = mappedStatus;
    await query(
      `UPDATE workspace_subscriptions SET provider='airwallex', provider_customer_id=COALESCE($2, provider_customer_id), provider_subscription_id=COALESCE($3, provider_subscription_id), plan_key=COALESCE($4, plan_key), status=$5, current_period_starts_at=COALESCE($6::timestamptz, current_period_starts_at), current_period_ends_at=COALESCE($7::timestamptz, current_period_ends_at), metadata=metadata || $8::jsonb, updated_at=NOW() WHERE workspace_id=$1`,
      [workspaceId, subscription.billing_customer_id ?? checkout.billing_customer_id ?? null, subscription.id ?? checkout.subscription_id ?? null, metadata.plan_key ?? null, effectiveStatus, subscription.current_period_starts_at ?? null, subscription.current_period_ends_at ?? null, JSON.stringify({ lastWebhookEventId: eventId, lastWebhookType: eventType, invoiceId: data.invoice_id ?? null, paymentSourceId: webhookPaymentSourceId })]
    );
    if (effectiveStatus === 'active') {
      if (metadata.plan_key === 'starter' || metadata.plan_key === 'ai') {
        await ensurePaygProfile(workspaceId, typeof webhookPaymentSourceId === 'string' ? webhookPaymentSourceId : null);
      }
      await withTransaction(async (client) => {
        await query(`UPDATE workspaces SET onboarding_step='setup_complete', onboarding_completed_at=COALESCE(onboarding_completed_at, NOW()) WHERE id=$1 AND deleted_at IS NULL`, [workspaceId], client);
        await appendDomainEvent({
          workspaceId,
          type: DOMAIN_EVENT_TYPES.BILLING_ACTIVATED,
          aggregateType: 'workspace_subscription',
          aggregateId: workspaceId,
          payload: { planKey: metadata.plan_key ?? null, trigger: `webhook:${eventType}` },
          metadata: { source: 'airwallex_webhook', correlationId: eventId },
          idempotencyKey: `billing-activated:${workspaceId}`,
        }, client);
      });
    }
    const invoiceId = String(data.invoice_id ?? data.invoice?.id ?? subscription.invoice_id ?? subscription.latest_invoice_id ?? checkout.invoice_id ?? checkout.latest_invoice_id ?? '');
    const planKey = metadata.plan_key as BillingPlanKey | undefined;
    if (invoiceId && (effectiveStatus === 'active' || eventType.includes('INVOICE') || eventType.includes('PAID'))) {
      try {
        if (planKey === 'starter' || planKey === 'ai') await sendInvoiceEmailForWebhook(workspaceId, planKey, invoiceId, eventId);
      } catch (error) {
        logger.error({ code: 'BILLING_INVOICE_EMAIL_FAILED', error: error instanceof Error ? error.message : 'unknown_error', workspaceId, planKey, invoiceId, eventId }, 'Invoice email delivery failed');
      }
    }
    await query(`UPDATE airwallex_webhook_events SET processed_at=NOW(), processing_at=NULL, last_error_code=NULL WHERE event_id=$1`, [eventId]);
    return { processed: true, eventId, status: effectiveStatus };
  } catch (error) {
    const errorCode = error instanceof AppError ? error.code : 'AIRWALLEX_WEBHOOK_PROCESSING_FAILED';
    await query(`UPDATE airwallex_webhook_events SET processing_at=NULL, last_error_code=$2 WHERE event_id=$1`, [eventId, errorCode]).catch((updateError) => logger.error({ updateError, eventId }, 'Could not release Airwallex webhook claim'));
    throw error;
  }
}

registerDomainEventHandler({
  name: 'billing.post-payment-automation',
  eventTypes: [DOMAIN_EVENT_TYPES.BILLING_ACTIVATED],
  async handle(event) {
    if (!event.workspaceId) throw new Error('Billing activation event is missing a workspace ID');
    const trigger = typeof event.payload.trigger === 'string' ? event.payload.trigger : 'billing_activation';
    await startPostPaymentAutomation(event.workspaceId, trigger);
    return { workspaceId: event.workspaceId, trigger };
  },
});

export const billingPlans = Object.entries(planConfig).map(([key, value]) => ({ key, label: value.label, amountMinor: value.amountMinor, currency: 'CNY', interval: 'year' }));
