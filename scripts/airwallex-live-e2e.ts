import 'dotenv/config';

/**
 * Explicit Airwallex payment acceptance test.
 *
 * This command is never part of normal deployment. It creates exactly one
 * CNY 1.00 AI-wallet top-up only when all guards below are present, then waits
 * for the operator to complete that payment in Airwallex. It verifies the
 * complete result: provider success, wallet credit, and one paid Lulu invoice
 * with a ready PDF document. No funds are created by the script itself.
 */

const CONFIRMATION = 'I_UNDERSTAND_THIS_CREATES_A_REAL_AIRWALLEX_PAYMENT';
const PAYMENT_METHODS = new Set(['card', 'alipaycn', 'wechatpay']);

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Airwallex E2E acceptance test.`);
  return value;
}

function assertExplicitlyEnabled() {
  if (process.env.AIRWALLEX_LIVE_E2E !== '1') {
    throw new Error('Refusing live Airwallex calls. Set AIRWALLEX_LIVE_E2E=1 explicitly.');
  }
  if (process.env.AIRWALLEX_LIVE_E2E_SIDE_EFFECTS !== '1') {
    throw new Error('Refusing payment creation. Set AIRWALLEX_LIVE_E2E_SIDE_EFFECTS=1 explicitly.');
  }
  if (process.env.AIRWALLEX_LIVE_E2E_CONFIRM !== CONFIRMATION) {
    throw new Error(`Refusing payment creation. Set AIRWALLEX_LIVE_E2E_CONFIRM=${CONFIRMATION}.`);
  }
}

function positiveSeconds(name: string, fallback: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
  }
  return value;
}

async function main() {
  assertExplicitlyEnabled();
  const workspaceId = required('AIRWALLEX_LIVE_E2E_WORKSPACE_ID');
  const paymentMethod = (process.env.AIRWALLEX_LIVE_E2E_PAYMENT_METHOD ?? 'wechatpay').trim().toLowerCase();
  if (!PAYMENT_METHODS.has(paymentMethod)) {
    throw new Error('AIRWALLEX_LIVE_E2E_PAYMENT_METHOD must be card, alipaycn, or wechatpay.');
  }
  const returnUrl = process.env.AIRWALLEX_LIVE_E2E_RETURN_URL?.trim() ?? 'https://lulu-ai.cn/app/billing';
  try {
    new URL(returnUrl);
  } catch {
    throw new Error('AIRWALLEX_LIVE_E2E_RETURN_URL must be a valid URL.');
  }
  const pollSeconds = positiveSeconds('AIRWALLEX_LIVE_E2E_POLL_SECONDS', 5, 60);
  const timeoutSeconds = positiveSeconds('AIRWALLEX_LIVE_E2E_TIMEOUT_SECONDS', 600, 3600);

  // Import configuration-dependent modules only after the side-effect guards.
  const { query, pool } = await import('../src/db/pool.js');
  const { startApiTopup, syncApiTopup } = await import('../src/modules/api-wallet/api-wallet.service.js');
  const { reconcilePaidBillingInvoices } = await import('../src/modules/billing/paid-billing-invoice.service.js');

  try {
    const owner = await query<{ id: string }>(
      `SELECT COALESCE(
         (SELECT wm.user_id FROM workspace_members wm WHERE wm.workspace_id=$1 AND wm.role='owner' ORDER BY wm.joined_at LIMIT 1),
         (SELECT w.created_by FROM workspaces w WHERE w.id=$1)
       ) AS id`,
      [workspaceId],
    );
    const userId = process.env.AIRWALLEX_LIVE_E2E_USER_ID?.trim() || owner.rows[0]?.id;
    if (!userId) throw new Error('The workspace has no owner. Set AIRWALLEX_LIVE_E2E_USER_ID explicitly.');

    const created = await startApiTopup({
      workspaceId,
      userId,
      amount: 1,
      paymentMethod: paymentMethod as 'card' | 'alipaycn' | 'wechatpay',
      returnUrl,
    });
    const topup = created.topup;
    const topupId = String(topup.id);
    console.log(JSON.stringify({
      status: 'AWAITING_CUSTOMER_PAYMENT',
      amount: 1,
      currency: 'CNY',
      paymentMethod,
      workspaceId,
      topupId,
      checkoutUrl: topup.checkoutUrl ?? null,
      qrPayload: topup.qrPayload ?? null,
      expiresAt: topup.expiresAt ?? null,
      instruction: 'Complete exactly this CNY 1.00 payment, then keep this command running.',
    }, null, 2));

    const deadline = Date.now() + timeoutSeconds * 1_000;
    let latest = topup;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1_000));
      latest = await syncApiTopup(workspaceId, topupId);
      console.log(JSON.stringify({ status: 'POLL', topupStatus: latest.status, paymentStatus: latest.paymentStatus, creditStatus: latest.creditStatus }));
      if (latest.status === 'SUCCEEDED') break;
      if (['FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED', 'CHARGEBACK'].includes(latest.status)) {
        throw new Error(`Airwallex payment ended in terminal state ${latest.status}.`);
      }
    }
    if (latest.status !== 'SUCCEEDED') {
      throw new Error(`Airwallex payment was not completed within ${timeoutSeconds} seconds.`);
    }

    const reconciliation = await reconcilePaidBillingInvoices(20);
    const invoice = await query<{ id: string; invoiceNumber: string; status: string; documentStatus: string; documentReference: string | null; grandTotal: string }>(
      `SELECT i.id, i.invoice_number AS "invoiceNumber", i.status,
              i.document_status AS "documentStatus",
              i.document_storage_reference AS "documentReference",
              i.grand_total AS "grandTotal"
         FROM commercial_document_operations o
         JOIN invoices i ON i.workspace_id=o.workspace_id AND i.id=o.document_id
        WHERE o.workspace_id=$1
          AND o.operation_key=$2
          AND o.operation_type='invoice.create'
          AND o.status='COMPLETED'
        ORDER BY i.created_at DESC LIMIT 1`,
      [workspaceId, `billing-invoice:ai_credits:${topupId}`],
    );
    const row = invoice.rows[0];
    if (!row || row.status !== 'PAID' || row.documentStatus !== 'READY' || !row.documentReference) {
      throw new Error('Airwallex payment succeeded, but the paid Lulu invoice/PDF was not ready. Reconciliation must be investigated.');
    }
    console.log(JSON.stringify({
      status: 'VERIFIED',
      topup: { id: topupId, providerStatus: latest.providerStatus, paymentStatus: latest.paymentStatus, creditStatus: latest.creditStatus },
      invoice: row,
      reconciliation,
    }, null, 2));
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Airwallex E2E acceptance failed.';
  console.error(JSON.stringify({ status: 'BLOCKED', provider: 'airwallex', error: message }, null, 2));
  process.exitCode = 1;
}
