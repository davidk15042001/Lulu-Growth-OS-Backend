import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/app-error.js';
import type { PaygDirectPaymentMethod } from './payg-payment-methods.js';

const nextBerlinMondaySql = `(date_trunc('week', NOW() AT TIME ZONE 'Europe/Berlin') + INTERVAL '7 days') AT TIME ZONE 'Europe/Berlin'`;
const currentBerlinMondaySql = `date_trunc('week', NOW() AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin'`;
import { hasAdminCapability } from '../admin/admin.authorization.js';

export const AWS_USAGE_CUSTOMER_MULTIPLIER = 2;

export async function isBillingAdminUser(userId?: string | null) {
  return hasAdminCapability(userId,'billing.bypass');
}

async function isAdminOwnedWorkspace(workspaceId: string) {
  const { rows } = await query<{ id: string }>(
    `SELECT u.id
     FROM workspace_members wm
     JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = $1 AND wm.role = 'owner'
     ORDER BY wm.joined_at
     LIMIT 1`,
    [workspaceId],
  );
  const owner = rows[0];
  return hasAdminCapability(owner?.id,'billing.bypass');
}

export type PaygPeriod = {
  id: string;
  workspaceId: string;
  periodStart: string;
  periodEnd: string;
  currency: 'USD';
  apiCostUsd: string;
  serverCostUsd: string;
  totalCostUsd: string;
  providerCustomerId: string;
  paymentSourceId: string | null;
  preferredPaymentMethod: PaygDirectPaymentMethod | null;
  providerInvoiceId: string | null;
  lineItemsAddedAt: string | null;
  finalizedAt: string | null;
};

export type PaygPaymentMethodSetup = {
  id: string;
  workspaceId: string;
  paymentMethod: PaygDirectPaymentMethod;
  providerCheckoutId: string;
  providerCustomerId: string;
  providerPaymentSourceId: string | null;
  status: 'PENDING' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';
  checkoutUrl: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PaygApiCheckoutReservation = PaygPeriod & {
  status: 'processing' | 'payment_due' | 'payment_failed' | 'failed';
  billingMode: 'api_pay_now';
  hostedInvoiceUrl: string | null;
  reused: boolean;
};

export async function ensurePaygProfile(workspaceId: string, paymentSourceId?: string | null, client?: PoolClient) {
  await query(
    `INSERT INTO workspace_payg_profiles (
       workspace_id, interval_days, current_period_start, current_period_end,
       provider_payment_source_id, collection_method
     ) VALUES ($1, 7, ${currentBerlinMondaySql}, ${nextBerlinMondaySql}, $2,
       CASE WHEN $2::text IS NULL THEN 'CHARGE_ON_CHECKOUT' ELSE 'AUTO_CHARGE' END)
     ON CONFLICT (workspace_id) DO UPDATE SET
       enabled=TRUE,
       interval_days=7,
       provider_payment_source_id=COALESCE(EXCLUDED.provider_payment_source_id, workspace_payg_profiles.provider_payment_source_id),
       collection_method=CASE
         WHEN COALESCE(EXCLUDED.provider_payment_source_id, workspace_payg_profiles.provider_payment_source_id) IS NULL
           THEN 'CHARGE_ON_CHECKOUT'
         ELSE 'AUTO_CHARGE'
       END,
       ai_access_blocked=CASE
         WHEN $2::text IS NOT NULL AND workspace_payg_profiles.block_reason='PAYMENT_SOURCE_SETUP_REQUIRED' THEN FALSE
         ELSE workspace_payg_profiles.ai_access_blocked
       END,
       blocked_at=CASE
         WHEN $2::text IS NOT NULL AND workspace_payg_profiles.block_reason='PAYMENT_SOURCE_SETUP_REQUIRED' THEN NULL
         ELSE workspace_payg_profiles.blocked_at
       END,
       block_reason=CASE
         WHEN $2::text IS NOT NULL AND workspace_payg_profiles.block_reason='PAYMENT_SOURCE_SETUP_REQUIRED' THEN NULL
         ELSE workspace_payg_profiles.block_reason
       END,
       blocked_period_id=CASE
         WHEN $2::text IS NOT NULL AND workspace_payg_profiles.block_reason='PAYMENT_SOURCE_SETUP_REQUIRED' THEN NULL
         ELSE workspace_payg_profiles.blocked_period_id
       END`,
    [workspaceId, paymentSourceId ?? null],
    client,
  );
}

export async function configurePaygDirectPaymentMethod(
  workspaceId: string,
  userId: string,
  paymentMethod: Exclude<PaygDirectPaymentMethod, 'card'>,
) {
  return withTransaction(async (client) => {
    const before = await query<{ preferredPaymentMethod: PaygDirectPaymentMethod | null; hasPaymentSource: boolean }>(
      `SELECT preferred_payment_method AS "preferredPaymentMethod",
              provider_payment_source_id IS NOT NULL AS "hasPaymentSource"
       FROM workspace_payg_profiles
       WHERE workspace_id=$1
       FOR UPDATE`,
      [workspaceId],
      client,
    );
    await query(
      `INSERT INTO workspace_payg_profiles (
         workspace_id, interval_days, current_period_start, current_period_end,
         collection_method, provider_payment_source_id, preferred_payment_method,
         payment_method_configured_at
       ) VALUES ($1, 7, ${currentBerlinMondaySql}, ${nextBerlinMondaySql},
         'CHARGE_ON_CHECKOUT', NULL, $2, NOW())
       ON CONFLICT (workspace_id) DO UPDATE SET
         enabled=TRUE,
         interval_days=7,
         collection_method='CHARGE_ON_CHECKOUT',
         provider_payment_source_id=NULL,
         preferred_payment_method=EXCLUDED.preferred_payment_method,
         payment_method_configured_at=NOW()`,
      [workspaceId, paymentMethod],
      client,
    );
    await query(
      `INSERT INTO audit_log (
         workspace_id, actor_id, action, entity_type, entity_id, before_data, after_data
       ) VALUES ($1, $2, 'payg_payment_method.configured', 'workspace_payg_profile', $1,
         $3::jsonb, $4::jsonb)`,
      [
        workspaceId,
        userId,
        JSON.stringify(before.rows[0] ?? { preferredPaymentMethod: null, hasPaymentSource: false }),
        JSON.stringify({ paymentMethod, collectionMethod: 'CHARGE_ON_CHECKOUT', automaticCollection: false }),
      ],
      client,
    );
  });
}

export async function createPaygPaymentMethodSetup(input: {
  workspaceId: string;
  paymentMethod: 'card';
  providerCheckoutId: string;
  providerCustomerId: string;
  checkoutUrl: string | null;
}) {
  const { rows } = await query<PaygPaymentMethodSetup>(
    `INSERT INTO workspace_payg_payment_setups (
       workspace_id, payment_method, provider_checkout_id, provider_customer_id,
       checkout_url
     ) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, workspace_id AS "workspaceId", payment_method AS "paymentMethod",
               provider_checkout_id AS "providerCheckoutId",
               provider_customer_id AS "providerCustomerId",
               provider_payment_source_id AS "providerPaymentSourceId", status,
               checkout_url AS "checkoutUrl", last_error_code AS "lastErrorCode",
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [input.workspaceId, input.paymentMethod, input.providerCheckoutId, input.providerCustomerId, input.checkoutUrl],
  );
  const setup = rows[0];
  if (!setup) throw new Error('PAYG payment method setup insert did not return a row');
  return setup;
}

export async function getPaygPaymentMethodSetup(workspaceId: string, setupId: string) {
  const { rows } = await query<PaygPaymentMethodSetup>(
    `SELECT id, workspace_id AS "workspaceId", payment_method AS "paymentMethod",
            provider_checkout_id AS "providerCheckoutId",
            provider_customer_id AS "providerCustomerId",
            provider_payment_source_id AS "providerPaymentSourceId", status,
            checkout_url AS "checkoutUrl", last_error_code AS "lastErrorCode",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM workspace_payg_payment_setups
     WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, setupId],
  );
  return rows[0] ?? null;
}

export async function getLatestPaygPaymentMethodSetup(workspaceId: string) {
  const { rows } = await query<PaygPaymentMethodSetup>(
    `SELECT id, workspace_id AS "workspaceId", payment_method AS "paymentMethod",
            provider_checkout_id AS "providerCheckoutId",
            provider_customer_id AS "providerCustomerId",
            provider_payment_source_id AS "providerPaymentSourceId", status,
            checkout_url AS "checkoutUrl", last_error_code AS "lastErrorCode",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM workspace_payg_payment_setups
     WHERE workspace_id=$1
     ORDER BY created_at DESC
     LIMIT 1`,
    [workspaceId],
  );
  return rows[0] ?? null;
}

export async function completePaygCardPaymentMethodSetup(input: {
  workspaceId: string;
  setupId: string;
  paymentSourceId: string;
  userId: string;
}) {
  return withTransaction(async (client) => {
    const setup = await query<PaygPaymentMethodSetup>(
      `UPDATE workspace_payg_payment_setups
       SET status='COMPLETED', provider_payment_source_id=$3, last_error_code=NULL
       WHERE workspace_id=$1 AND id=$2 AND payment_method='card'
       RETURNING id, workspace_id AS "workspaceId", payment_method AS "paymentMethod",
                 provider_checkout_id AS "providerCheckoutId",
                 provider_customer_id AS "providerCustomerId",
                 provider_payment_source_id AS "providerPaymentSourceId", status,
                 checkout_url AS "checkoutUrl", last_error_code AS "lastErrorCode",
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [input.workspaceId, input.setupId, input.paymentSourceId],
      client,
    );
    const result = setup.rows[0];
    if (!result) throw new AppError(404, 'PAYG_PAYMENT_SETUP_NOT_FOUND', 'The payment-method setup does not belong to this workspace.');

    await ensurePaygProfile(input.workspaceId, input.paymentSourceId, client);
    await query(
      `UPDATE workspace_payg_profiles
       SET preferred_payment_method='card', payment_method_configured_at=NOW()
       WHERE workspace_id=$1`,
      [input.workspaceId],
      client,
    );
    await query(
      `INSERT INTO audit_log (
         workspace_id, actor_id, action, entity_type, entity_id, after_data
       ) VALUES ($1, $2, 'payg_payment_method.configured', 'workspace_payg_profile', $1,
         $3::jsonb)`,
      [input.workspaceId, input.userId, JSON.stringify({ paymentMethod: 'card', collectionMethod: 'AUTO_CHARGE', automaticCollection: true })],
      client,
    );
    return result;
  });
}

export async function updatePaygPaymentMethodSetupStatus(
  workspaceId: string,
  setupId: string,
  status: PaygPaymentMethodSetup['status'],
  errorCode?: string | null,
) {
  await query(
    `UPDATE workspace_payg_payment_setups
     SET status=$3, last_error_code=$4
     WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, setupId, status, errorCode ?? null],
  );
}

export async function allocateDailyServerUsage(providerCostUsd: number, customerCostUsd: number) {
  if (customerCostUsd <= 0) return 0;
  const result = await query(
    `INSERT INTO workspace_server_usage_ledger (
       workspace_id, usage_date, provider_cost_usd, customer_cost_usd,
       metadata
     )
     SELECT p.workspace_id, CURRENT_DATE, $1, $2,
            jsonb_build_object('source', 'daily-server-allocation')
     FROM workspace_payg_profiles p
     JOIN workspace_subscriptions s ON s.workspace_id=p.workspace_id
     WHERE p.enabled=TRUE
       AND s.provider='airwallex'
       AND s.status='active'
       AND s.plan_key IN ('starter', 'ai')
     ON CONFLICT (workspace_id, usage_date) DO NOTHING`,
    [providerCostUsd, customerCostUsd],
  );
  return result.rowCount;
}

/**
 * Reserves only the API usage accrued so far for a one-off customer payment.
 * Server/storage entries deliberately remain unassigned, so their weekly
 * charge continues without being reset by an API payment.
 */
export async function reservePaygApiCheckout(workspaceId: string): Promise<PaygApiCheckoutReservation> {
  return withTransaction(async (client) => {
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payg-api-checkout:${workspaceId}`], client);

    const profileResult = await query<{
      workspaceId: string;
      periodStart: string;
      periodEnd: string;
      currency: 'USD';
      providerCustomerId: string | null;
      paymentSourceId: string | null;
      preferredPaymentMethod: PaygDirectPaymentMethod | null;
    }>(
      `SELECT p.workspace_id AS "workspaceId", p.current_period_start AS "periodStart",
              p.current_period_end AS "periodEnd", p.currency,
              s.provider_customer_id AS "providerCustomerId",
              COALESCE(p.provider_payment_source_id, s.metadata->>'paymentSourceId') AS "paymentSourceId",
              p.preferred_payment_method AS "preferredPaymentMethod"
       FROM workspace_payg_profiles p
       JOIN workspace_subscriptions s ON s.workspace_id=p.workspace_id
       WHERE p.workspace_id=$1 AND p.enabled=TRUE
         AND s.provider='airwallex' AND s.status='active'
         AND s.plan_key IN ('starter', 'ai')
       FOR UPDATE OF p`,
      [workspaceId],
      client,
    );
    const profile = profileResult.rows[0];
    if (!profile?.providerCustomerId) {
      throw new AppError(409, 'PAYG_BILLING_CUSTOMER_REQUIRED', 'A confirmed billing customer is required before API usage can be paid.');
    }

    const existingResult = await query<{
      id: string;
      periodStart: string;
      periodEnd: string;
      currency: 'USD';
      apiCostUsd: string;
      serverCostUsd: string;
      totalCostUsd: string;
      providerInvoiceId: string | null;
      lineItemsAddedAt: string | null;
      finalizedAt: string | null;
      hostedInvoiceUrl: string | null;
      status: 'processing' | 'payment_due' | 'payment_failed' | 'failed';
    }>(
      `SELECT id, period_start AS "periodStart", period_end AS "periodEnd", currency,
              api_cost_usd AS "apiCostUsd", server_cost_usd AS "serverCostUsd",
              total_cost_usd AS "totalCostUsd", provider_invoice_id AS "providerInvoiceId",
              line_items_added_at AS "lineItemsAddedAt", finalized_at AS "finalizedAt",
              hosted_invoice_url AS "hostedInvoiceUrl", status
       FROM workspace_payg_periods
       WHERE workspace_id=$1
         AND billing_mode='api_pay_now'
         AND status IN ('processing', 'payment_due', 'payment_failed', 'failed')
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [workspaceId],
      client,
    );
    const existing = existingResult.rows[0];
    if (existing) {
      return {
        ...existing,
        workspaceId,
        providerCustomerId: profile.providerCustomerId,
        paymentSourceId: profile.paymentSourceId,
        preferredPaymentMethod: profile.preferredPaymentMethod,
        billingMode: 'api_pay_now',
        reused: true,
      };
    }

    const cutoffResult = await query<{ cutoff: string }>('SELECT clock_timestamp() AS cutoff', [], client);
    const cutoff = cutoffResult.rows[0]?.cutoff;
    if (!cutoff) throw new AppError(500, 'PAYG_API_CHECKOUT_CUTOFF_MISSING', 'Could not establish the API usage payment cutoff.');

    const totalsResult = await query<{ apiCostUsd: string }>(
      `SELECT COALESCE(SUM(customer_cost_usd), 0)::numeric AS "apiCostUsd"
       FROM ai_usage_ledger
       WHERE workspace_id=$1
         AND payg_period_id IS NULL
         AND created_at >= $2::timestamptz
         AND created_at < $3::timestamptz`,
      [workspaceId, profile.periodStart, cutoff],
      client,
    );
    const apiCostUsd = totalsResult.rows[0]?.apiCostUsd ?? '0';
    if (Number(apiCostUsd) <= 0) {
      throw new AppError(422, 'PAYG_API_USAGE_EMPTY', 'There is no unbilled API usage to pay right now.');
    }

    const periodResult = await query<{
      id: string;
      periodStart: string;
      periodEnd: string;
      currency: 'USD';
      apiCostUsd: string;
      serverCostUsd: string;
      totalCostUsd: string;
      providerInvoiceId: string | null;
      lineItemsAddedAt: string | null;
      finalizedAt: string | null;
      hostedInvoiceUrl: string | null;
    }>(
      `INSERT INTO workspace_payg_periods (
         workspace_id, period_start, period_end, status, currency,
         api_cost_usd, server_cost_usd, billing_mode, metadata
       ) VALUES ($1, $2::timestamptz, $3::timestamptz, 'processing', $4, $5, 0, 'api_pay_now',
         jsonb_build_object('apiUsageCutoff', $3::timestamptz, 'source', 'customer_api_pay_now'))
       RETURNING id, period_start AS "periodStart", period_end AS "periodEnd", currency,
                 api_cost_usd AS "apiCostUsd", server_cost_usd AS "serverCostUsd",
                 total_cost_usd AS "totalCostUsd", provider_invoice_id AS "providerInvoiceId",
                 line_items_added_at AS "lineItemsAddedAt", finalized_at AS "finalizedAt",
                 hosted_invoice_url AS "hostedInvoiceUrl"`,
      [workspaceId, profile.periodStart, cutoff, profile.currency, apiCostUsd],
      client,
    );
    const period = periodResult.rows[0];
    if (!period) throw new AppError(500, 'PAYG_API_CHECKOUT_RESERVATION_FAILED', 'Could not reserve API usage for payment.');

    await query(
      `UPDATE ai_usage_ledger
       SET payg_period_id=$1
       WHERE workspace_id=$2
         AND payg_period_id IS NULL
         AND created_at >= $3::timestamptz
         AND created_at < $4::timestamptz`,
      [period.id, workspaceId, profile.periodStart, cutoff],
      client,
    );

    return {
      ...period,
      status: 'processing',
      workspaceId,
      providerCustomerId: profile.providerCustomerId,
      paymentSourceId: profile.paymentSourceId,
      preferredPaymentMethod: profile.preferredPaymentMethod,
      billingMode: 'api_pay_now',
      reused: false,
    };
  });
}

async function advanceCompletedProfile(client: PoolClient, workspaceId: string, periodStart: string, periodEnd: string) {
  await query(
    `UPDATE workspace_payg_profiles
     SET current_period_start=$3::timestamptz,
         current_period_end=(
           date_trunc('week', $3::timestamptz AT TIME ZONE 'Europe/Berlin') + INTERVAL '7 days'
         ) AT TIME ZONE 'Europe/Berlin'
     WHERE workspace_id=$1
       AND current_period_start=$2::timestamptz
       AND current_period_end=$3::timestamptz`,
    [workspaceId, periodStart, periodEnd],
    client,
  );
}

export async function repairCompletedProfilePointers() {
  const result = await query(
    `UPDATE workspace_payg_profiles p
     SET current_period_start=finished.period_end,
         current_period_end=(
           date_trunc('week', finished.period_end AT TIME ZONE 'Europe/Berlin') + INTERVAL '7 days'
         ) AT TIME ZONE 'Europe/Berlin'
     FROM workspace_payg_periods finished
     WHERE finished.workspace_id=p.workspace_id
       AND finished.period_start=p.current_period_start
       AND finished.period_end=p.current_period_end
       AND finished.status IN ('payment_due', 'payment_failed', 'paid', 'skipped')
       AND p.current_period_end <= NOW()`,
  );
  return result.rowCount;
}

export async function claimDuePaygPeriod(): Promise<PaygPeriod | null> {
  return withTransaction(async (client) => {
    const profile = await query<{
      workspaceId: string;
      periodStart: string;
      periodEnd: string;
      currency: 'USD';
      providerCustomerId: string;
      paymentSourceId: string | null;
      preferredPaymentMethod: PaygDirectPaymentMethod | null;
    }>(
      `SELECT p.workspace_id AS "workspaceId",
              p.current_period_start AS "periodStart",
              p.current_period_end AS "periodEnd",
              p.currency,
              s.provider_customer_id AS "providerCustomerId",
              COALESCE(p.provider_payment_source_id, s.metadata->>'paymentSourceId') AS "paymentSourceId",
              p.preferred_payment_method AS "preferredPaymentMethod"
       FROM workspace_payg_profiles p
       JOIN workspace_subscriptions s ON s.workspace_id=p.workspace_id
       WHERE p.enabled=TRUE
         AND p.current_period_end <= NOW()
         AND s.provider='airwallex'
         AND s.status='active'
         AND s.plan_key IN ('starter', 'ai')
         AND s.provider_customer_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM workspace_payg_periods active
           WHERE active.workspace_id=p.workspace_id
             AND active.period_start=p.current_period_start
             AND active.period_end=p.current_period_end
             AND active.status='processing'
             AND active.processing_started_at > NOW() - INTERVAL '30 minutes'
         )
       ORDER BY p.current_period_end, p.workspace_id
       FOR UPDATE OF p SKIP LOCKED
       LIMIT 1`,
      [],
      client,
    );
    const selected = profile.rows[0];
    if (!selected) return null;

    const period = await query<{ id: string; providerInvoiceId: string | null; lineItemsAddedAt: string | null; finalizedAt: string | null }>(
      `INSERT INTO workspace_payg_periods (
         workspace_id, period_start, period_end, currency, status
       ) VALUES ($1, $2, $3, $4, 'processing')
       ON CONFLICT (workspace_id, period_start, period_end) DO UPDATE SET
         status='processing',
         processing_started_at=NOW(),
         attempt_count=workspace_payg_periods.attempt_count + 1,
         last_error_code=NULL,
         last_error_message=NULL
       WHERE workspace_payg_periods.status='failed'
          OR (workspace_payg_periods.status='processing'
              AND workspace_payg_periods.processing_started_at <= NOW() - INTERVAL '30 minutes')
       RETURNING id, provider_invoice_id AS "providerInvoiceId",
                 line_items_added_at AS "lineItemsAddedAt",
                 finalized_at AS "finalizedAt"`,
      [selected.workspaceId, selected.periodStart, selected.periodEnd, selected.currency],
      client,
    );
    const claimed = period.rows[0];
    if (!claimed) return null;

    await query(
      `UPDATE ai_usage_ledger
       SET payg_period_id=$1
       WHERE workspace_id=$2
         AND payg_period_id IS NULL
         AND created_at >= $3::timestamptz
         AND created_at < $4::timestamptz`,
      [claimed.id, selected.workspaceId, selected.periodStart, selected.periodEnd],
      client,
    );
    await query(
      `UPDATE workspace_server_usage_ledger
       SET payg_period_id=$1
       WHERE workspace_id=$2
         AND payg_period_id IS NULL
         AND created_at >= $3::timestamptz
         AND created_at < $4::timestamptz`,
      [claimed.id, selected.workspaceId, selected.periodStart, selected.periodEnd],
      client,
    );

    const totals = await query<{ apiCostUsd: string; serverCostUsd: string }>(
      `SELECT
         COALESCE((SELECT SUM(customer_cost_usd) FROM ai_usage_ledger WHERE payg_period_id=$1), 0)::numeric AS "apiCostUsd",
         COALESCE((SELECT SUM(customer_cost_usd) FROM workspace_server_usage_ledger WHERE payg_period_id=$1), 0)::numeric AS "serverCostUsd"`,
      [claimed.id],
      client,
    );
    const costs = totals.rows[0] ?? { apiCostUsd: '0', serverCostUsd: '0' };
    const updated = await query<{ totalCostUsd: string }>(
      `UPDATE workspace_payg_periods
       SET api_cost_usd=$2, server_cost_usd=$3
       WHERE id=$1
       RETURNING total_cost_usd AS "totalCostUsd"`,
      [claimed.id, costs.apiCostUsd, costs.serverCostUsd],
      client,
    );

    return {
      ...selected,
      ...claimed,
      periodStart: new Date(selected.periodStart).toISOString(),
      periodEnd: new Date(selected.periodEnd).toISOString(),
      apiCostUsd: costs.apiCostUsd,
      serverCostUsd: costs.serverCostUsd,
      totalCostUsd: updated.rows[0]?.totalCostUsd ?? '0',
    };
  });
}

export async function markPaygPeriodSkipped(period: PaygPeriod) {
  await withTransaction(async (client) => {
    await query(
      `UPDATE workspace_payg_periods
       SET status='skipped', finalized_at=NOW(), processing_started_at=NOW()
       WHERE id=$1`,
      [period.id],
      client,
    );
    await advanceCompletedProfile(client, period.workspaceId, period.periodStart, period.periodEnd);
  });
}

export async function savePaygProviderInvoice(periodId: string, invoiceId: string, hostedUrl?: string | null) {
  await query(
    `UPDATE workspace_payg_periods
     SET provider_invoice_id=$2, hosted_invoice_url=COALESCE($3, hosted_invoice_url),
         metadata=metadata || jsonb_build_object('providerInvoiceCreatedAt', NOW())
     WHERE id=$1`,
    [periodId, invoiceId, hostedUrl ?? null],
  );
}

export async function markPaygLineItemsAdded(periodId: string) {
  await query(`UPDATE workspace_payg_periods SET line_items_added_at=NOW() WHERE id=$1`, [periodId]);
}

export async function finalizePaygPeriod(
  period: PaygPeriod,
  invoice: { status?: string; payment_status?: string; hosted_url?: string; pdf_url?: string; paid_at?: string },
  paymentAttempted = false,
) {
  const paid = String(invoice.payment_status ?? '').toUpperCase() === 'PAID';
  const blockAccess = !paid && (paymentAttempted || !period.paymentSourceId);
  const status = paid ? 'paid' : paymentAttempted ? 'payment_failed' : 'payment_due';
  await withTransaction(async (client) => {
    await query(
      `UPDATE workspace_payg_periods
       SET status=$2,
           hosted_invoice_url=COALESCE($3, hosted_invoice_url),
           invoice_pdf_url=COALESCE($4, invoice_pdf_url),
           finalized_at=NOW(),
           paid_at=CASE WHEN $2='paid' THEN COALESCE($5::timestamptz, NOW()) ELSE paid_at END,
           processing_started_at=NOW(),
           metadata=metadata || $6::jsonb
       WHERE id=$1`,
      [period.id, status, invoice.hosted_url ?? null, invoice.pdf_url ?? null, invoice.paid_at ?? null, JSON.stringify({ providerStatus: invoice.status ?? null, providerPaymentStatus: invoice.payment_status ?? null, paymentAttempted })],
      client,
    );
    if (paid) {
      await clearWorkspaceAiBlock(client, period.workspaceId);
    } else if (blockAccess) {
      await blockWorkspaceAi(client, period.workspaceId, period.id, period.paymentSourceId ? 'AUTOMATIC_PAYMENT_FAILED' : 'PAYMENT_SOURCE_REQUIRED');
    }
    await advanceCompletedProfile(client, period.workspaceId, period.periodStart, period.periodEnd);
  });
}

export async function finalizePaygApiCheckoutPeriod(
  periodId: string,
  invoice: { payment_status?: string; hosted_url?: string; pdf_url?: string; paid_at?: string },
) {
  const paid = String(invoice.payment_status ?? '').toUpperCase() === 'PAID';
  await query(
    `UPDATE workspace_payg_periods
     SET status=$2,
         hosted_invoice_url=COALESCE($3, hosted_invoice_url),
         invoice_pdf_url=COALESCE($4, invoice_pdf_url),
         finalized_at=NOW(),
         paid_at=CASE WHEN $2='paid' THEN COALESCE($5::timestamptz, NOW()) ELSE paid_at END,
         metadata=metadata || jsonb_build_object('providerPaymentStatus', $6::text)
     WHERE id=$1 AND billing_mode='api_pay_now'`,
    [periodId, paid ? 'paid' : 'payment_due', invoice.hosted_url ?? null, invoice.pdf_url ?? null, invoice.paid_at ?? null, invoice.payment_status ?? null],
  );
}

async function blockWorkspaceAi(client: PoolClient, workspaceId: string, periodId: string, reason: string) {
  await query(
    `UPDATE workspace_payg_profiles
     SET ai_access_blocked=TRUE, blocked_at=COALESCE(blocked_at, NOW()),
         block_reason=$3, blocked_period_id=$2
     WHERE workspace_id=$1`,
    [workspaceId, periodId, reason],
    client,
  );
}

async function clearWorkspaceAiBlock(client: PoolClient, workspaceId: string) {
  await query(
    `UPDATE workspace_payg_profiles p
     SET ai_access_blocked=FALSE, blocked_at=NULL, block_reason=NULL, blocked_period_id=NULL
     WHERE p.workspace_id=$1
       AND NOT EXISTS (
         SELECT 1 FROM workspace_payg_periods pp
         WHERE pp.workspace_id=p.workspace_id
           AND pp.status IN ('payment_due', 'payment_failed')
           AND pp.paid_at IS NULL
       )`,
    [workspaceId],
    client,
  );
}

export async function disableWorkspacePaygBilling(workspaceId: string) {
  await query(
    `UPDATE workspace_payg_profiles
     SET enabled=FALSE,
         ai_access_blocked=FALSE,
         blocked_at=NULL,
         block_reason=NULL,
         blocked_period_id=NULL
     WHERE workspace_id=$1`,
    [workspaceId],
  );
}

export async function failPaygPeriod(periodId: string, code: string, message: string) {
  await query(
    `UPDATE workspace_payg_periods
     SET status='failed', last_error_code=$2, last_error_message=$3,
         processing_started_at=NOW()
     WHERE id=$1`,
    [periodId, code, message.slice(0, 2000)],
  );
}

export async function applyPaygInvoiceWebhook(input: {
  periodId: string;
  providerInvoiceId?: string | null;
  paymentStatus: string;
  hostedUrl?: string | null;
  pdfUrl?: string | null;
  paidAt?: string | null;
  paymentSourceId?: string | null;
  eventType?: string | null;
}) {
  const paid = input.paymentStatus.toUpperCase() === 'PAID';
  const failureSignal = `${input.paymentStatus} ${input.eventType ?? ''}`.toUpperCase();
  const failed = !paid && /(FAILED|DECLINED|PAST_DUE|OVERDUE|PAYMENT_FAILURE)/.test(failureSignal);
  return withTransaction(async (client) => {
    const updated = await query<{ workspaceId: string; billingMode: 'weekly' | 'api_pay_now' }>(
      `UPDATE workspace_payg_periods
       SET status=CASE WHEN $3 THEN 'paid' WHEN $8 THEN 'payment_failed' ELSE status END,
           provider_invoice_id=COALESCE($2, provider_invoice_id),
           hosted_invoice_url=COALESCE($4, hosted_invoice_url),
           invoice_pdf_url=COALESCE($5, invoice_pdf_url),
           paid_at=CASE WHEN $3 THEN COALESCE($6::timestamptz, NOW()) ELSE paid_at END,
           metadata=metadata || jsonb_build_object('lastPaymentStatus', $7::text, 'lastPaymentEventType', $9::text)
       WHERE id=$1
       RETURNING workspace_id AS "workspaceId", billing_mode AS "billingMode"`,
      [input.periodId, input.providerInvoiceId ?? null, paid, input.hostedUrl ?? null, input.pdfUrl ?? null, input.paidAt ?? null, input.paymentStatus, failed, input.eventType ?? null],
      client,
    );
    const updatedPeriod = updated.rows[0];
    if (!updatedPeriod) return false;
    const workspaceId = updatedPeriod.workspaceId;
    // A one-off Alipay/WeChat payment must not silently become the recurring
    // weekly auto-charge source. Only the normal weekly flow may save it.
    if (input.paymentSourceId && updatedPeriod.billingMode === 'weekly') {
      await query(
        `UPDATE workspace_payg_profiles
         SET provider_payment_source_id=$2, collection_method='AUTO_CHARGE'
         WHERE workspace_id=$1`,
        [workspaceId, input.paymentSourceId],
        client,
      );
    }
    if (paid) await clearWorkspaceAiBlock(client, workspaceId);
    else if (failed) await blockWorkspaceAi(client, workspaceId, input.periodId, 'AUTOMATIC_PAYMENT_FAILED');
    return true;
  });
}

export async function assertAiBillingAccess(workspaceId: string, userId?: string | null) {
  if (await isBillingAdminUser(userId)) return;
  if (await isAdminOwnedWorkspace(workspaceId)) return;
  const { rows } = await query<{
    planKey: string | null;
    blocked: boolean;
    reason: string | null;
    hostedInvoiceUrl: string | null;
    invoicePdfUrl: string | null;
  }>(
    `SELECT s.plan_key AS "planKey",
            p.ai_access_blocked AS blocked, p.block_reason AS reason,
            pp.hosted_invoice_url AS "hostedInvoiceUrl",
            pp.invoice_pdf_url AS "invoicePdfUrl"
     FROM workspace_subscriptions s
     LEFT JOIN workspace_payg_profiles p ON p.workspace_id=s.workspace_id
     LEFT JOIN workspace_payg_periods pp ON pp.id=p.blocked_period_id
     WHERE s.workspace_id=$1
     ORDER BY s.updated_at DESC
     LIMIT 1`,
    [workspaceId],
  );
  const state = rows[0];
  if (state?.planKey === 'test') return;
  if (!state?.blocked) return;
  throw new AppError(402, 'AI_USAGE_PAYMENT_REQUIRED', 'AI functions are blocked until the outstanding usage invoice is paid.', {
    reason: state.reason,
    paymentLink: state.hostedInvoiceUrl,
    invoicePdfUrl: state.invoicePdfUrl,
  });
}

export async function listUnprovisionedTestBillingCustomers(limit = 25) {
  const { rows } = await query<{
    workspaceId: string;
    workspaceName: string;
    customerEmail: string | null;
  }>(
    `SELECT s.workspace_id AS "workspaceId", w.name AS "workspaceName",
            owner.email AS "customerEmail"
     FROM workspace_subscriptions s
     JOIN workspaces w ON w.id=s.workspace_id AND w.deleted_at IS NULL
     LEFT JOIN LATERAL (
       SELECT u.email
       FROM workspace_members wm
       JOIN users u ON u.id=wm.user_id
       WHERE wm.workspace_id=s.workspace_id AND wm.role='owner'
       ORDER BY wm.joined_at
       LIMIT 1
     ) owner ON TRUE
     WHERE s.plan_key='test'
       AND s.status='active'
       AND s.provider_customer_id IS NULL
     ORDER BY s.updated_at
     LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function saveTestBillingCustomer(workspaceId: string, providerCustomerId: string) {
  await withTransaction(async (client) => {
    await query(
      `UPDATE workspace_subscriptions
       SET provider='airwallex', provider_customer_id=$2,
           metadata=metadata || jsonb_build_object('paygCustomerProvisionedAt', NOW()), updated_at=NOW()
       WHERE workspace_id=$1 AND plan_key='test' AND status='active'`,
      [workspaceId, providerCustomerId],
      client,
    );
  });
  await ensurePaygProfile(workspaceId);
  await query(
    `UPDATE workspace_payg_profiles
     SET ai_access_blocked=TRUE, blocked_at=COALESCE(blocked_at, NOW()),
         block_reason='PAYMENT_SOURCE_SETUP_REQUIRED'
     WHERE workspace_id=$1 AND provider_payment_source_id IS NULL`,
    [workspaceId],
  );
}
