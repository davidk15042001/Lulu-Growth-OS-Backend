import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';

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
  providerInvoiceId: string | null;
  lineItemsAddedAt: string | null;
  finalizedAt: string | null;
};

export async function ensurePaygProfile(workspaceId: string, paymentSourceId?: string | null) {
  await query(
    `INSERT INTO workspace_payg_profiles (
       workspace_id, current_period_start, current_period_end,
       provider_payment_source_id, collection_method
     ) VALUES ($1, NOW(), NOW() + INTERVAL '14 days', $2,
       CASE WHEN $2::text IS NULL THEN 'CHARGE_ON_CHECKOUT' ELSE 'AUTO_CHARGE' END)
     ON CONFLICT (workspace_id) DO UPDATE SET
       enabled=TRUE,
       provider_payment_source_id=COALESCE(EXCLUDED.provider_payment_source_id, workspace_payg_profiles.provider_payment_source_id),
       collection_method=CASE
         WHEN COALESCE(EXCLUDED.provider_payment_source_id, workspace_payg_profiles.provider_payment_source_id) IS NULL
           THEN 'CHARGE_ON_CHECKOUT'
         ELSE 'AUTO_CHARGE'
       END`,
    [workspaceId, paymentSourceId ?? null],
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

async function advanceCompletedProfile(client: PoolClient, workspaceId: string, periodStart: string, periodEnd: string) {
  await query(
    `UPDATE workspace_payg_profiles
     SET current_period_start=$3::timestamptz,
         current_period_end=$3::timestamptz + INTERVAL '14 days'
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
         current_period_end=finished.period_end + INTERVAL '14 days'
     FROM workspace_payg_periods finished
     WHERE finished.workspace_id=p.workspace_id
       AND finished.period_start=p.current_period_start
       AND finished.period_end=p.current_period_end
       AND finished.status IN ('payment_due', 'paid', 'skipped')
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
    }>(
      `SELECT p.workspace_id AS "workspaceId",
              p.current_period_start AS "periodStart",
              p.current_period_end AS "periodEnd",
              p.currency,
              s.provider_customer_id AS "providerCustomerId",
              COALESCE(p.provider_payment_source_id, s.metadata->>'paymentSourceId') AS "paymentSourceId"
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
) {
  const paid = String(invoice.payment_status ?? '').toUpperCase() === 'PAID';
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
      [period.id, paid ? 'paid' : 'payment_due', invoice.hosted_url ?? null, invoice.pdf_url ?? null, invoice.paid_at ?? null, JSON.stringify({ providerStatus: invoice.status ?? null, providerPaymentStatus: invoice.payment_status ?? null })],
      client,
    );
    await advanceCompletedProfile(client, period.workspaceId, period.periodStart, period.periodEnd);
  });
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
}) {
  const paid = input.paymentStatus.toUpperCase() === 'PAID';
  const { rowCount } = await query(
    `UPDATE workspace_payg_periods
     SET status=CASE WHEN $3 THEN 'paid' ELSE status END,
         provider_invoice_id=COALESCE($2, provider_invoice_id),
         hosted_invoice_url=COALESCE($4, hosted_invoice_url),
         invoice_pdf_url=COALESCE($5, invoice_pdf_url),
         paid_at=CASE WHEN $3 THEN COALESCE($6::timestamptz, NOW()) ELSE paid_at END,
         metadata=metadata || jsonb_build_object('lastPaymentStatus', $7::text)
     WHERE id=$1`,
    [input.periodId, input.providerInvoiceId ?? null, paid, input.hostedUrl ?? null, input.pdfUrl ?? null, input.paidAt ?? null, input.paymentStatus],
  );
  if (input.paymentSourceId) {
    await query(
      `UPDATE workspace_payg_profiles p
       SET provider_payment_source_id=$2, collection_method='AUTO_CHARGE'
       FROM workspace_payg_periods pp
       WHERE pp.id=$1 AND p.workspace_id=pp.workspace_id`,
      [input.periodId, input.paymentSourceId],
    );
  }
  return rowCount > 0;
}
