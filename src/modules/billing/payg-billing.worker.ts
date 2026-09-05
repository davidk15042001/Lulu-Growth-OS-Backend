import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { AppError } from '../../utils/app-error.js';
import {
  addPaygInvoiceLineItems,
  createPaygInvoiceDraft,
  fetchAirwallexInvoice,
  finalizePaygInvoice,
  payPaygInvoice,
} from './airwallex.service.js';
import {
  AWS_USAGE_CUSTOMER_MULTIPLIER,
  allocateDailyServerUsage,
  claimDuePaygPeriod,
  failPaygPeriod,
  finalizePaygPeriod,
  markPaygLineItemsAdded,
  markPaygPeriodSkipped,
  repairCompletedProfilePointers,
  savePaygProviderInvoice,
  type PaygPeriod,
} from './payg-billing.repo.js';

const MAX_PERIODS_PER_CYCLE = 50;
let running = false;
let interval: NodeJS.Timeout | null = null;

function invoiceAmount(value: string) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

async function settleFinalizedInvoice(period: PaygPeriod, invoiceId: string, invoice: Record<string, any>) {
  if (String(invoice.payment_status ?? '').toUpperCase() === 'PAID') {
    await finalizePaygPeriod(period, invoice);
    return;
  }
  if (!period.paymentSourceId) {
    await finalizePaygPeriod(period, invoice);
    logger.warn({ periodId: period.id, workspaceId: period.workspaceId, invoiceId }, 'PAYG invoice needs a payment source; AI access was blocked and the hosted payment link remains available');
    return;
  }
  try {
    const paid = await payPaygInvoice(invoiceId, period.paymentSourceId);
    await finalizePaygPeriod(period, paid, true);
  } catch (error) {
    const latest = await fetchAirwallexInvoice(invoiceId, `payg-payment-failure:${period.id}`).catch(() => null);
    await finalizePaygPeriod(period, latest ?? invoice, true);
    logger.warn({ error, periodId: period.id, workspaceId: period.workspaceId, invoiceId }, 'Automatic PAYG payment failed; AI access was blocked and the hosted payment link remains available');
  }
}

async function issuePeriodInvoice(period: PaygPeriod) {
  const apiCostUsd = invoiceAmount(period.apiCostUsd);
  const serverCostUsd = invoiceAmount(period.serverCostUsd);
  if (apiCostUsd + serverCostUsd <= 0) {
    await markPaygPeriodSkipped(period);
    logger.info({ periodId: period.id, workspaceId: period.workspaceId }, 'PAYG period closed without billable usage');
    return;
  }

  let invoiceId = period.providerInvoiceId;
  let currentInvoice: Record<string, any> | null = null;
  if (invoiceId) {
    currentInvoice = await fetchAirwallexInvoice(invoiceId, period.id);
    const status = String(currentInvoice?.status ?? '').toUpperCase();
    if (status === 'FINALIZED') {
      await settleFinalizedInvoice(period, invoiceId, currentInvoice ?? {});
      return;
    }
  }

  if (!invoiceId) {
    const draft = await createPaygInvoiceDraft({
      periodId: period.id,
      workspaceId: period.workspaceId,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      billingCustomerId: period.providerCustomerId,
      paymentSourceId: period.paymentSourceId,
      preferredPaymentMethod: period.preferredPaymentMethod,
    });
    invoiceId = String(draft.id ?? '');
    if (!invoiceId) throw new AppError(502, 'AIRWALLEX_PAYG_INVOICE_ID_MISSING', 'Airwallex did not return an invoice ID for the PAYG period.');
    await savePaygProviderInvoice(period.id, invoiceId, typeof draft.hosted_url === 'string' ? draft.hosted_url : null);
    period.providerInvoiceId = invoiceId;
  }

  if (!period.lineItemsAddedAt) {
    await addPaygInvoiceLineItems({
      periodId: period.id,
      invoiceId,
      apiCostUsd,
      serverCostUsd,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
    });
    await markPaygLineItemsAdded(period.id);
    period.lineItemsAddedAt = new Date().toISOString();
  }

  const finalized = await finalizePaygInvoice(invoiceId);
  await settleFinalizedInvoice(period, invoiceId, finalized);
  logger.info({ periodId: period.id, workspaceId: period.workspaceId, invoiceId, apiCostUsd, serverCostUsd }, 'PAYG invoice finalized');
}

export async function runPaygBillingCycle() {
  if (running) return;
  running = true;
  try {
    await repairCompletedProfilePointers();
    const providerCost = env.PAYG_SERVER_COST_USD_PER_DAY;
    await allocateDailyServerUsage(providerCost, providerCost * AWS_USAGE_CUSTOMER_MULTIPLIER);

    for (let processed = 0; processed < MAX_PERIODS_PER_CYCLE; processed += 1) {
      const period = await claimDuePaygPeriod();
      if (!period) break;
      try {
        await issuePeriodInvoice(period);
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'PAYG_INVOICE_PROCESSING_FAILED';
        const message = error instanceof Error ? error.message : 'Unknown PAYG invoice error';
        await failPaygPeriod(period.id, code, message).catch((writeError) => logger.error({ writeError, periodId: period.id }, 'PAYG failure state could not be saved'));
        logger.error({ error, code, periodId: period.id, workspaceId: period.workspaceId }, 'PAYG period invoicing failed');
      }
    }
  } catch (error) {
    logger.error({ error }, 'PAYG billing worker cycle failed');
  } finally {
    running = false;
  }
}

export function startPaygBillingWorker() {
  if (interval) return;
  const intervalMs = env.PAYG_BILLING_WORKER_INTERVAL_MINUTES * 60_000;
  const requestCycle = () => appendDomainEvent({
    type: DOMAIN_EVENT_TYPES.BILLING_CYCLE_REQUESTED,
    aggregateType: 'billing_scheduler',
    aggregateId: 'payg',
    payload: { scheduledAt: new Date().toISOString() },
    metadata: { source: 'billing.scheduler' },
    idempotencyKey: `schedule:payg-billing:${Math.floor(Date.now() / intervalMs)}`,
  }).catch((error: unknown) => logger.error({ error }, 'PAYG billing schedule event could not be published'));
  registerDomainEventHandler({
    name: 'billing.payg-cycle.v1',
    eventTypes: [DOMAIN_EVENT_TYPES.BILLING_CYCLE_REQUESTED],
    async handle() {
      await runPaygBillingCycle();
      return { completed: true };
    },
  });
  void requestCycle();
  interval = setInterval(() => void requestCycle(), intervalMs);
  interval.unref();
  logger.info({ intervalMinutes: env.PAYG_BILLING_WORKER_INTERVAL_MINUTES, awsProviderCostUsdPerDay: env.PAYG_SERVER_COST_USD_PER_DAY, awsCustomerMultiplier: AWS_USAGE_CUSTOMER_MULTIPLIER }, 'Weekly Monday PAYG billing worker started');
}

export function stopPaygBillingWorker() {
  if (interval) clearInterval(interval);
  interval = null;
}
