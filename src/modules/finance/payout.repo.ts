import { query, withTransaction } from '../../db/pool.js';
import { AppError, conflictError, notFoundError } from '../../utils/app-error.js';

export type PayoutAccount = {
  id: string;
  workspaceId: string;
  provider: string;
  providerBeneficiaryId: string;
  label: string;
  currency: string;
  status: string;
  createdAt: string;
};

export type Payout = {
  id: string;
  workspaceId: string;
  payoutAccountId: string;
  provider: string;
  providerTransferId: string | null;
  amount: string;
  currency: string;
  reference: string;
  status: string;
  providerStatus: string | null;
  failureCode: string | null;
  requestedAt: string;
  submittedAt: string | null;
  completedAt: string | null;
  payoutAccountLabel: string;
  createdAt: string;
};

const accountSelect = `id,workspace_id AS "workspaceId",provider,
  provider_beneficiary_id AS "providerBeneficiaryId",label,currency,status,
  created_at AS "createdAt"`;
const payoutSelect = `p.id,p.workspace_id AS "workspaceId",p.payout_account_id AS "payoutAccountId",
  p.provider,p.provider_transfer_id AS "providerTransferId",p.amount::text,p.currency,p.reference,
  p.status,p.provider_status AS "providerStatus",p.failure_code AS "failureCode",
  p.requested_at AS "requestedAt",p.submitted_at AS "submittedAt",p.completed_at AS "completedAt",
  a.label AS "payoutAccountLabel",p.created_at AS "createdAt"`;

export async function listPayoutAccounts(workspaceId: string) {
  const result = await query<PayoutAccount>(
    `SELECT ${accountSelect} FROM workspace_payout_accounts
      WHERE workspace_id=$1 ORDER BY status='ACTIVE' DESC,created_at DESC LIMIT 100`,
    [workspaceId],
  );
  return result.rows;
}

export async function createPayoutAccount(input: {
  workspaceId: string;
  providerBeneficiaryId: string;
  label: string;
  currency: string;
  actorId: string;
}) {
  const result = await query<PayoutAccount>(
    `INSERT INTO workspace_payout_accounts(
       workspace_id,provider,provider_beneficiary_id,label,currency,created_by
     ) VALUES($1,'airwallex',$2,$3,$4,$5)
     ON CONFLICT (workspace_id,provider,provider_beneficiary_id)
     DO UPDATE SET label=EXCLUDED.label,currency=EXCLUDED.currency,status='ACTIVE',updated_at=NOW()
     RETURNING ${accountSelect}`,
    [input.workspaceId, input.providerBeneficiaryId, input.label, input.currency.toUpperCase(), input.actorId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Payout account was not saved');
  return row;
}

async function availableBalance(workspaceId: string, currency: string, client?: Parameters<typeof query>[2]) {
  const result = await query<{ available: string }>(
    `WITH collected AS (
       SELECT COALESCE(SUM(s.amount-LEAST(s.amount,COALESCE(adjustments.reversed,0))),0)::numeric AS total
       FROM storefront_checkout_sessions s
       LEFT JOIN (
         SELECT checkout_id,COALESCE(SUM(amount) FILTER (WHERE status='ACTIVE'),0)::numeric AS reversed
         FROM storefront_payment_adjustments
         WHERE workspace_id=$1
         GROUP BY checkout_id
       ) adjustments ON adjustments.checkout_id=s.id
       WHERE s.workspace_id=$1 AND s.currency=$2 AND s.status='PAID'
     ), reserved AS (
       SELECT COALESCE(SUM(amount),0)::numeric AS total
       FROM workspace_payouts
       WHERE workspace_id=$1 AND currency=$2
         AND status IN ('REQUESTED','SUBMITTING','SUBMISSION_UNKNOWN','SUBMITTED','PROCESSING','PAID')
     )
     SELECT (collected.total-reserved.total)::text AS available
       FROM collected,reserved`,
    [workspaceId, currency.toUpperCase()],
    client,
  );
  return result.rows[0]?.available ?? '0';
}

export async function getPayoutSummary(workspaceId: string) {
  const result = await query<{ currency: string; grossCollected: string; reversed: string; netCollected: string; reserved: string; paidOut: string; available: string }>(
    `WITH currencies AS (
       SELECT currency FROM storefront_checkout_sessions WHERE workspace_id=$1
       UNION
       SELECT currency FROM workspace_payouts WHERE workspace_id=$1
     ), collected AS (
       SELECT s.currency,
         COALESCE(SUM(s.amount) FILTER (WHERE s.status='PAID'),0)::numeric AS gross,
         COALESCE(SUM(LEAST(s.amount,COALESCE(adjustments.reversed,0))),0)::numeric AS reversed
       FROM storefront_checkout_sessions s
       LEFT JOIN (
         SELECT checkout_id,COALESCE(SUM(amount) FILTER (WHERE status='ACTIVE'),0)::numeric AS reversed
         FROM storefront_payment_adjustments
         WHERE workspace_id=$1
         GROUP BY checkout_id
       ) adjustments ON adjustments.checkout_id=s.id
       WHERE s.workspace_id=$1 GROUP BY s.currency
     ), payouts AS (
       SELECT currency,
         COALESCE(SUM(amount) FILTER (WHERE status IN ('REQUESTED','SUBMITTING','SUBMISSION_UNKNOWN','SUBMITTED','PROCESSING','PAID')),0)::text AS reserved,
         COALESCE(SUM(amount) FILTER (WHERE status='PAID'),0)::text AS paid
       FROM workspace_payouts WHERE workspace_id=$1 GROUP BY currency
     )
     SELECT currencies.currency,
       COALESCE(collected.gross,'0')::text AS "grossCollected",
       COALESCE(collected.reversed,'0')::text AS reversed,
       GREATEST(COALESCE(collected.gross,'0')::numeric-COALESCE(collected.reversed,'0')::numeric,0)::text AS "netCollected",
       COALESCE(payouts.reserved,'0') AS reserved,
       COALESCE(payouts.paid,'0') AS "paidOut",
       GREATEST(COALESCE(collected.gross,'0')::numeric-COALESCE(collected.reversed,'0')::numeric-COALESCE(payouts.reserved,'0')::numeric,0)::text AS available
       FROM currencies
       LEFT JOIN collected USING(currency)
       LEFT JOIN payouts USING(currency)
       ORDER BY currencies.currency`,
    [workspaceId],
  );
  return result.rows;
}

export async function listPayouts(workspaceId: string, limit = 50) {
  const [items, summary] = await Promise.all([
    query<Payout>(`SELECT ${payoutSelect} FROM workspace_payouts p
      JOIN workspace_payout_accounts a ON a.workspace_id=p.workspace_id AND a.id=p.payout_account_id
      WHERE p.workspace_id=$1 ORDER BY p.created_at DESC,p.id DESC LIMIT $2`, [workspaceId, Math.min(limit, 100)]),
    getPayoutSummary(workspaceId),
  ]);
  return { items: items.rows, summary };
}

export async function requestPayout(input: {
  workspaceId: string;
  payoutAccountId: string;
  amount: string;
  currency: string;
  reference: string;
  idempotencyKey: string;
  actorId: string;
}) {
  return withTransaction(async (client) => {
    await query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [input.workspaceId], client);
    const existing = await query<{ id: string; payoutAccountId: string; amount: string; currency: string }>(
      `SELECT id,payout_account_id AS "payoutAccountId",amount::text,currency
         FROM workspace_payouts WHERE workspace_id=$1 AND idempotency_key=$2`,
      [input.workspaceId, input.idempotencyKey],
      client,
    );
    if (existing.rows[0]) {
      const replay = existing.rows[0];
      if (replay.payoutAccountId !== input.payoutAccountId || replay.amount !== input.amount || replay.currency !== input.currency.toUpperCase()) {
        throw conflictError('This payout idempotency key belongs to a different payout');
      }
      const payout = await getPayout(input.workspaceId, replay.id, client);
      if (!payout) throw new Error('Payout request was not saved');
      return payout;
    }
    const account = await query<{ id: string }>(
      `SELECT id FROM workspace_payout_accounts
        WHERE workspace_id=$1 AND id=$2 AND status='ACTIVE' AND currency=$3`,
      [input.workspaceId, input.payoutAccountId, input.currency.toUpperCase()],
      client,
    );
    if (!account.rows[0]) throw notFoundError('Active payout account not found for this currency');
    const available = await availableBalance(input.workspaceId, input.currency, client);
    const availableCheck = await query<{ allowed: boolean }>(`SELECT $1::numeric <= $2::numeric AS allowed`, [input.amount, available], client);
    if (!availableCheck.rows[0]?.allowed) {
      throw new AppError(422, 'PAYOUT_BALANCE_INSUFFICIENT', 'The payout amount is higher than the available paid storefront balance.', { available, currency: input.currency.toUpperCase() });
    }
    const inserted = await query<{ id: string }>(
      `INSERT INTO workspace_payouts(
         workspace_id,payout_account_id,provider,idempotency_key,amount,currency,reference,requested_by
       ) VALUES($1,$2,'airwallex',$3,$4,$5,$6,$7)
       ON CONFLICT (workspace_id,idempotency_key) DO NOTHING RETURNING id`,
      [input.workspaceId, input.payoutAccountId, input.idempotencyKey, input.amount, input.currency.toUpperCase(), input.reference, input.actorId],
      client,
    );
    let payoutId = inserted.rows[0]?.id;
    if (!payoutId) {
      const replay = await query<{ id: string; payoutAccountId: string; amount: string; currency: string }>(
        `SELECT id,payout_account_id AS "payoutAccountId",amount::text,currency FROM workspace_payouts WHERE workspace_id=$1 AND idempotency_key=$2`,
        [input.workspaceId, input.idempotencyKey],
        client,
      );
      if (!replay.rows[0]) throw new Error('Payout request could not be loaded after idempotency replay');
      if (replay.rows[0].payoutAccountId !== input.payoutAccountId || replay.rows[0].amount !== input.amount || replay.rows[0].currency !== input.currency.toUpperCase()) throw conflictError('This payout idempotency key belongs to a different payout');
      payoutId = replay.rows[0].id;
    }
    const payout = await getPayout(input.workspaceId, payoutId, client);
    if (!payout) throw new Error('Payout request was not saved');
    return payout;
  });
}

export async function getPayout(workspaceId: string, payoutId: string, client?: Parameters<typeof query>[2]) {
  const result = await query<Payout>(
    `SELECT ${payoutSelect} FROM workspace_payouts p
      JOIN workspace_payout_accounts a ON a.workspace_id=p.workspace_id AND a.id=p.payout_account_id
      WHERE p.workspace_id=$1 AND p.id=$2`,
    [workspaceId, payoutId],
    client,
  );
  return result.rows[0] ?? null;
}

export async function claimPayoutForSubmission(workspaceId: string, payoutId: string, actorId: string) {
  return withTransaction(async (client) => {
    const locked = await query<{ status: string }>(`SELECT status FROM workspace_payouts WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, payoutId], client);
    if (!locked.rows[0]) throw notFoundError('Payout not found');
    if (locked.rows[0].status !== 'REQUESTED') return { payout: await getPayout(workspaceId, payoutId, client), shouldSubmit: false };
    await query(`UPDATE workspace_payouts SET status='SUBMITTING',approved_by=$3,updated_at=NOW() WHERE workspace_id=$1 AND id=$2`, [workspaceId, payoutId, actorId], client);
    return { payout: await getPayout(workspaceId, payoutId, client), shouldSubmit: true };
  });
}

export async function markPayoutSubmitted(input: { workspaceId: string; payoutId: string; providerTransferId: string; providerStatus: string; providerPayload: Record<string, unknown> }) {
  await query(
    `UPDATE workspace_payouts p SET status='SUBMITTED',provider_transfer_id=$3,provider_status=$4,
        provider_payload=$5::jsonb,submitted_at=NOW(),updated_at=NOW()
      WHERE p.workspace_id=$1 AND p.id=$2 AND p.status='SUBMITTING'
      RETURNING p.id`,
    [input.workspaceId, input.payoutId, input.providerTransferId, input.providerStatus.slice(0, 80), JSON.stringify(input.providerPayload)],
  );
  return getPayout(input.workspaceId, input.payoutId);
}

export async function markPayoutSubmissionFailed(workspaceId: string, payoutId: string, failureCode: string, unknownOutcome: boolean) {
  await query(`UPDATE workspace_payouts SET status=$3,failure_code=$4,updated_at=NOW() WHERE workspace_id=$1 AND id=$2 AND status='SUBMITTING'`, [workspaceId, payoutId, unknownOutcome ? 'SUBMISSION_UNKNOWN' : 'FAILED', failureCode.slice(0, 120)]);
}

export async function applyPayoutProviderStatus(input: { payoutId?: string | null; providerTransferId: string; providerStatus: string; providerPayload: Record<string, unknown> }) {
  const normalized = input.providerStatus.toUpperCase();
  const status = normalized === 'PAID' ? 'PAID'
    : ['FAILED', 'REJECTED'].includes(normalized) ? 'FAILED'
      : ['CANCELLED', 'CANCELED'].includes(normalized) ? 'CANCELLED'
        : ['SUBMITTED', 'SCHEDULED', 'IN_APPROVAL', 'PROCESSING', 'SENT', 'NEW'].includes(normalized) ? 'PROCESSING'
          : null;
  if (!status) return null;
  const result = await query<{ id: string }>(
    `UPDATE workspace_payouts p SET status=$1,provider_status=$2,provider_payload=$3::jsonb,
        completed_at=CASE WHEN $1 IN ('PAID','FAILED','CANCELLED') THEN NOW() ELSE completed_at END,updated_at=NOW()
      WHERE (${input.payoutId ? 'p.id=$4' : 'FALSE'} OR p.provider_transfer_id=$5)
        AND p.provider_transfer_id IS NOT NULL RETURNING p.id`,
    [status, normalized, JSON.stringify(input.providerPayload), input.payoutId ?? null, input.providerTransferId],
  );
  if (!result.rows[0]) return null;
  const workspace = await query<{ workspaceId: string }>(`SELECT workspace_id AS "workspaceId" FROM workspace_payouts WHERE id=$1`, [result.rows[0].id]);
  return workspace.rows[0] ? getPayout(workspace.rows[0].workspaceId, result.rows[0].id) : null;
}
