import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { AppError } from '../../utils/app-error.js';
import { snapshotAllR2Storage } from '../../storage/r2-metering.repo.js';
import { reconcileStoredObjectInventory } from '../../storage/s3.service.js';
import {
  addPaygInvoiceLineItems,
  createPaygInvoiceDraft,
  fetchAirwallexInvoice,
  finalizePaygInvoice,
  payPaygInvoice,
  reconcilePendingWalletInvoicePayments,
} from './airwallex.service.js';
import {
  claimDuePaygPeriod,
  failPaygPeriod,
  finalizePaygPeriod,
  markPaygLineItemsAdded,
  markPaygPeriodAwaitingQrPayment,
  markPaygPeriodSkipped,
  repairCompletedProfilePointers,
  savePaygProviderInvoice,
  type PaygPeriod,
} from './payg-billing.repo.js';
import { createRuntimeWorkerMonitor } from '../../operations/worker-liveness.js';
import { reconcileUnsettledApiUsage } from '../usage/usage.service.js';
import { createPaidStorageInvoice, reconcilePaidBillingInvoices } from './paid-billing-invoice.service.js';

const MAX_PERIODS_PER_CYCLE = 50;
let interval: NodeJS.Timeout | null = null;
let activeCycle: Promise<void> | null = null;
let activeScheduleRequest: Promise<void> | null = null;
let stopping = false;
let lastStorageInventoryAt = 0;
const STORAGE_INVENTORY_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const runtimeMonitor = createRuntimeWorkerMonitor('payg-billing', {
  staleAfterMs: Math.max(60_000, env.PAYG_BILLING_WORKER_INTERVAL_MINUTES * 60_000 + 60_000),
});

function invoiceAmount(value: string) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

async function settleFinalizedInvoice(period: PaygPeriod, invoiceId: string, invoice: Record<string, any>) {
  if (String(invoice.payment_status ?? '').toUpperCase() === 'PAID') {
    await finalizePaygPeriod(period, invoice);
    await createPaidStorageInvoice({
      periodId: period.id,
      workspaceId: period.workspaceId,
      amount: invoiceAmount(period.serverCostUsd),
      currency: period.currency,
      paidAt: typeof invoice.paid_at === 'string' ? invoice.paid_at : null,
      providerInvoiceId: invoiceId,
    });
    return;
  }
  if (!period.paymentSourceId) {
    await finalizePaygPeriod(period, invoice);
    logger.warn({ periodId: period.id, workspaceId: period.workspaceId, invoiceId }, 'Storage invoice needs a payment source; the hosted payment link remains available');
    return;
  }
  try {
    const paid = await payPaygInvoice(invoiceId, period.paymentSourceId);
    await finalizePaygPeriod(period, paid, true);
    if (String(paid.payment_status ?? '').toUpperCase() === 'PAID') {
      await createPaidStorageInvoice({
        periodId: period.id,
        workspaceId: period.workspaceId,
        amount: invoiceAmount(period.serverCostUsd),
        currency: period.currency,
        paidAt: typeof paid.paid_at === 'string' ? paid.paid_at : null,
        providerInvoiceId: invoiceId,
      });
    }
  } catch (error) {
    const latest = await fetchAirwallexInvoice(invoiceId, `payg-payment-failure:${period.id}`).catch(() => null);
    await finalizePaygPeriod(period, latest ?? invoice, true);
    logger.warn({ error, periodId: period.id, workspaceId: period.workspaceId, invoiceId }, 'Automatic storage payment failed; the hosted payment link remains available');
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

  if (!period.paymentSourceId && (period.preferredPaymentMethod === 'wechatpay' || period.preferredPaymentMethod === 'alipaycn')) {
    await markPaygPeriodAwaitingQrPayment(period);
    logger.info({ periodId: period.id, workspaceId: period.workspaceId, paymentMethod: period.preferredPaymentMethod }, 'PAYG period is awaiting a manual wallet QR payment');
    return;
  }

  if (!period.providerCustomerId) {
    throw new AppError(409, 'PAYG_BILLING_CUSTOMER_REQUIRED', 'A confirmed billing customer is required before creating the weekly usage invoice.');
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

export function runPaygBillingCycle(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (activeCycle) return activeCycle;
  activeCycle = (async () => {
    let processedCount = 0;
    await repairCompletedProfilePointers();
    const apiSettlement = await reconcileUnsettledApiUsage();
    const walletInvoiceReconciliation = await reconcilePendingWalletInvoicePayments();
    const paidInvoiceReconciliation = await reconcilePaidBillingInvoices();
    if (!stopping && Date.now() - lastStorageInventoryAt >= STORAGE_INVENTORY_INTERVAL_MS) {
      const inventory = await reconcileStoredObjectInventory();
      if (inventory.scanned) lastStorageInventoryAt = Date.now();
    }
    if (!stopping) await snapshotAllR2Storage();
    for (let processed = 0; processed < MAX_PERIODS_PER_CYCLE && !stopping; processed += 1) {
      const period = await claimDuePaygPeriod();
      if (!period) break;
      processedCount += 1;
      try {
        await issuePeriodInvoice(period);
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'PAYG_INVOICE_PROCESSING_FAILED';
        const message = error instanceof Error ? error.message : 'Unknown PAYG invoice error';
        await failPaygPeriod(period.id, code, message).catch((writeError) => logger.error({ writeError, periodId: period.id }, 'PAYG failure state could not be saved'));
        logger.error({ error, code, periodId: period.id, workspaceId: period.workspaceId }, 'PAYG period invoicing failed');
      }
    }
    runtimeMonitor.progress({
      phase: processedCount || apiSettlement.settled || walletInvoiceReconciliation.credited ? 'processed' : 'idle',
      processed: processedCount + apiSettlement.settled + walletInvoiceReconciliation.credited,
      metadata: {
        apiUsageSettled: apiSettlement.settled,
        walletInvoicesChecked: walletInvoiceReconciliation.checked,
        walletInvoicesCredited: walletInvoiceReconciliation.credited,
        walletInvoiceFailures: walletInvoiceReconciliation.failed,
        paidInvoicesChecked: paidInvoiceReconciliation.checked,
        paidInvoicesCreated: paidInvoiceReconciliation.created,
      },
    });
  })()
    .catch((error: unknown) => {
      runtimeMonitor.failed(error);
      logger.error({ error }, 'PAYG billing worker cycle failed');
    })
    .finally(() => { activeCycle = null; });
  return activeCycle;
}

function requestPaygBillingCycle(intervalMs: number): Promise<void> {
  if (stopping) return Promise.resolve();
  if (activeScheduleRequest) return activeScheduleRequest;
  activeScheduleRequest = appendDomainEvent({
    type: DOMAIN_EVENT_TYPES.BILLING_CYCLE_REQUESTED,
    aggregateType: 'billing_scheduler',
    aggregateId: 'payg',
    payload: { scheduledAt: new Date().toISOString() },
    metadata: { source: 'billing.scheduler' },
    idempotencyKey: `schedule:payg-billing:${Math.floor(Date.now() / intervalMs)}`,
  })
    .then(() => undefined)
    .catch((error: unknown) => logger.error({ error }, 'PAYG billing schedule event could not be published'))
    .finally(() => { activeScheduleRequest = null; });
  return activeScheduleRequest;
}

export function startPaygBillingWorker() {
  if (interval) return;
  stopping = false;
  runtimeMonitor.start();
  const intervalMs = env.PAYG_BILLING_WORKER_INTERVAL_MINUTES * 60_000;
  registerDomainEventHandler({
    name: 'billing.payg-cycle.v1',
    eventTypes: [DOMAIN_EVENT_TYPES.BILLING_CYCLE_REQUESTED],
    async handle() {
      await runPaygBillingCycle();
      return { completed: true };
    },
  });
  void requestPaygBillingCycle(intervalMs);
  interval = setInterval(() => void requestPaygBillingCycle(intervalMs), intervalMs);
  interval.unref();
  logger.info({ intervalMinutes: env.PAYG_BILLING_WORKER_INTERVAL_MINUTES }, 'Weekly Cloudflare R2 storage billing worker started');
}

export async function stopPaygBillingWorker() {
  stopping = true;
  if (interval) clearInterval(interval);
  interval = null;
  await runtimeMonitor.stopping();
  if (activeScheduleRequest) await activeScheduleRequest;
  if (activeCycle) await activeCycle;
  await runtimeMonitor.stopped();
}
