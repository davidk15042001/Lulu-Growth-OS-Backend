import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { AppError } from '../../utils/app-error.js';

export const AD_SPEND_FEE_BASIS_POINTS = 400;
export type AdSpendPaymentMethod = 'card' | 'alipaycn' | 'wechatpay';
export type AdSpendTopupStatus = 'CREATED' | 'PENDING_PAYMENT' | 'REQUIRES_CUSTOMER_ACTION' | 'SUCCEEDED' | 'CANCELLED' | 'FAILED' | 'EXPIRED' | 'REFUNDED' | 'CHARGEBACK';

type WalletRow = {
  workspaceId: string;
  currency: 'CNY';
  availableAmount: string;
  reservedAmount: string;
  spentAmount: string;
  refundedAmount: string;
  totalFundedAmount: string;
  totalFeeAmount: string;
  feeBasisPoints: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type AdSpendTopupRow = {
  id: string;
  workspaceId: string;
  createdBy: string;
  netAmount: string;
  feeBasisPoints: number;
  feeAmount: string;
  totalAmount: string;
  currency: 'CNY';
  paymentMethod: AdSpendPaymentMethod;
  provider: 'airwallex';
  status: AdSpendTopupStatus;
  merchantOrderId: string;
  providerInvoiceId: string | null;
  providerPaymentIntentId: string | null;
  checkoutUrl: string | null;
  qrPayload: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  creditedAt: string | null;
  providerResponse: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

const walletSelect = `workspace_id AS "workspaceId",currency,available_amount AS "availableAmount",
  reserved_amount AS "reservedAmount",spent_amount AS "spentAmount",refunded_amount AS "refundedAmount",
  total_funded_amount AS "totalFundedAmount",total_fee_amount AS "totalFeeAmount",
  fee_basis_points AS "feeBasisPoints",version,created_at AS "createdAt",updated_at AS "updatedAt"`;

const topupSelect = `id,workspace_id AS "workspaceId",created_by AS "createdBy",net_amount AS "netAmount",
  fee_basis_points AS "feeBasisPoints",fee_amount AS "feeAmount",total_amount AS "totalAmount",currency,
  payment_method AS "paymentMethod",provider,status,merchant_order_id AS "merchantOrderId",
  provider_invoice_id AS "providerInvoiceId",provider_payment_intent_id AS "providerPaymentIntentId",
  checkout_url AS "checkoutUrl",qr_payload AS "qrPayload",expires_at AS "expiresAt",paid_at AS "paidAt",
  credited_at AS "creditedAt",provider_response AS "providerResponse",error_code AS "errorCode",
  error_message AS "errorMessage",created_at AS "createdAt",updated_at AS "updatedAt"`;

function publicWallet(row: WalletRow) {
  return {
    ...row,
    availableAmount: Number(row.availableAmount),
    reservedAmount: Number(row.reservedAmount),
    spentAmount: Number(row.spentAmount),
    refundedAmount: Number(row.refundedAmount),
    totalFundedAmount: Number(row.totalFundedAmount),
    totalFeeAmount: Number(row.totalFeeAmount),
    adsEnabled: Number(row.availableAmount) > 0,
  };
}

export function publicTopup(row: AdSpendTopupRow) {
  return {
    ...row,
    netAmount: Number(row.netAmount),
    feeAmount: Number(row.feeAmount),
    totalAmount: Number(row.totalAmount),
  };
}

async function ensureWallet(workspaceId: string, client?: PoolClient) {
  await query(`INSERT INTO workspace_ad_spend_wallets(workspace_id) VALUES($1) ON CONFLICT DO NOTHING`, [workspaceId], client);
  const row = (await query<WalletRow>(`SELECT ${walletSelect} FROM workspace_ad_spend_wallets WHERE workspace_id=$1`, [workspaceId], client)).rows[0];
  if (!row) throw new Error('Ad spend wallet could not be created');
  return row;
}

export async function getAdSpendOverview(workspaceId: string) {
  const wallet = await ensureWallet(workspaceId);
  const topups = await query<AdSpendTopupRow>(
    `SELECT ${topupSelect} FROM workspace_ad_spend_topups WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 25`,
    [workspaceId],
  );
  return { wallet: publicWallet(wallet), topups: topups.rows.map(publicTopup) };
}

export async function assertAdSpendFunded(workspaceId: string) {
  const wallet = await ensureWallet(workspaceId);
  if (Number(wallet.availableAmount) <= 0) {
    throw new AppError(409, 'AD_SPEND_FUNDS_REQUIRED', 'Paid advertising is paused until the customer funds the ad spend wallet.');
  }
  return publicWallet(wallet);
}

export async function createAdSpendTopup(input: {
  workspaceId: string;
  userId: string;
  netAmount: number;
  feeAmount: number;
  totalAmount: number;
  paymentMethod: AdSpendPaymentMethod;
}) {
  const id = crypto.randomUUID();
  const merchantOrderId = `lulu-adspend-${id}`;
  const row = (await query<AdSpendTopupRow>(
    `INSERT INTO workspace_ad_spend_topups(
       id,workspace_id,created_by,net_amount,fee_basis_points,fee_amount,total_amount,currency,
       payment_method,merchant_order_id
     ) VALUES($1,$2,$3,$4,$5,$6,$7,'CNY',$8,$9)
     RETURNING ${topupSelect}`,
    [id, input.workspaceId, input.userId, input.netAmount.toFixed(2), AD_SPEND_FEE_BASIS_POINTS,
      input.feeAmount.toFixed(2), input.totalAmount.toFixed(2), input.paymentMethod, merchantOrderId],
  )).rows[0];
  if (!row) throw new Error('Ad spend top-up was not created');
  return row;
}

export async function getAdSpendTopup(workspaceId: string, topupId: string) {
  return (await query<AdSpendTopupRow>(
    `SELECT ${topupSelect} FROM workspace_ad_spend_topups WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, topupId],
  )).rows[0] ?? null;
}

export async function attachAdSpendProviderPayment(input: {
  topupId: string;
  status: AdSpendTopupStatus;
  providerInvoiceId?: string | null;
  providerPaymentIntentId?: string | null;
  checkoutUrl?: string | null;
  qrPayload?: string | null;
  expiresAt?: string | null;
  providerResponse?: Record<string, unknown>;
}) {
  const row = (await query<AdSpendTopupRow>(
    `UPDATE workspace_ad_spend_topups SET status=$2,
       provider_invoice_id=COALESCE($3,provider_invoice_id),
       provider_payment_intent_id=COALESCE($4,provider_payment_intent_id),
       checkout_url=COALESCE($5,checkout_url),qr_payload=COALESCE($6,qr_payload),
       expires_at=COALESCE($7::timestamptz,expires_at),provider_response=$8::jsonb
     WHERE id=$1 RETURNING ${topupSelect}`,
    [input.topupId, input.status, input.providerInvoiceId ?? null, input.providerPaymentIntentId ?? null,
      input.checkoutUrl ?? null, input.qrPayload ?? null, input.expiresAt ?? null,
      JSON.stringify(input.providerResponse ?? {})],
  )).rows[0];
  if (!row) throw new Error('Ad spend top-up provider payment could not be attached');
  return row;
}

function mapProviderStatus(status: string): AdSpendTopupStatus {
  const normalized = status.trim().toUpperCase();
  if (['SUCCEEDED','PAID','COMPLETED'].includes(normalized)) return 'SUCCEEDED';
  if (normalized === 'CANCELLED' || normalized === 'CANCELED') return 'CANCELLED';
  if (normalized === 'EXPIRED') return 'EXPIRED';
  if (['FAILED','REQUIRES_PAYMENT_METHOD'].includes(normalized)) return 'FAILED';
  if (['REQUIRES_CUSTOMER_ACTION','REQUIRES_ACTION'].includes(normalized)) return 'REQUIRES_CUSTOMER_ACTION';
  return 'PENDING_PAYMENT';
}

export async function applyAdSpendProviderStatus(input: {
  providerPaymentIntentId?: string | null;
  providerInvoiceId?: string | null;
  providerStatus: string;
  paidAt?: string | null;
  providerResponse?: Record<string, unknown>;
}) {
  return withTransaction(async (client) => {
    const topup = (await query<AdSpendTopupRow>(
      `SELECT ${topupSelect} FROM workspace_ad_spend_topups
       WHERE ($1::text IS NOT NULL AND provider_payment_intent_id=$1)
          OR ($2::text IS NOT NULL AND provider_invoice_id=$2)
       FOR UPDATE`,
      [input.providerPaymentIntentId ?? null, input.providerInvoiceId ?? null], client,
    )).rows[0];
    if (!topup) return null;
    const mappedStatus = mapProviderStatus(input.providerStatus);
    // Provider events can arrive out of order. Once funds were credited, a
    // delayed pending/failed event must never downgrade the successful top-up.
    const status = topup.creditedAt ? 'SUCCEEDED' : mappedStatus;
    const successful = status === 'SUCCEEDED';
    const newlyCredited = successful && !topup.creditedAt;
    await query(
      `UPDATE workspace_ad_spend_topups SET status=$2::varchar,
       paid_at=CASE WHEN $2::varchar='SUCCEEDED' THEN COALESCE(paid_at,$3::timestamptz,NOW()) ELSE paid_at END,
       credited_at=CASE WHEN $2::varchar='SUCCEEDED' THEN COALESCE(credited_at,NOW()) ELSE credited_at END,
       provider_response=provider_response || $4::jsonb
       WHERE id=$1`,
      [topup.id, status, input.paidAt ?? null, JSON.stringify(input.providerResponse ?? {})], client,
    );
    if (newlyCredited) {
      await ensureWallet(topup.workspaceId, client);
      const wallet = (await query<WalletRow>(
        `UPDATE workspace_ad_spend_wallets SET
           available_amount=available_amount+$2,
           total_funded_amount=total_funded_amount+$2,
           total_fee_amount=total_fee_amount+$3,
           version=version+1
         WHERE workspace_id=$1 RETURNING ${walletSelect}`,
        [topup.workspaceId, topup.netAmount, topup.feeAmount], client,
      )).rows[0];
      if (!wallet) throw new Error('Ad spend wallet credit failed');
      await query(
        `INSERT INTO workspace_ad_spend_ledger(
          workspace_id,topup_id,entry_type,amount_delta,balance_after,currency,idempotency_key,metadata
        ) VALUES($1,$2,'TOPUP_CREDIT',$3,$4,'CNY',$5,$6::jsonb) ON CONFLICT DO NOTHING`,
        [topup.workspaceId, topup.id, topup.netAmount, wallet.availableAmount, `adspend-topup:${topup.id}:credit`,
          JSON.stringify({ feeAmount: Number(topup.feeAmount), totalCharged: Number(topup.totalAmount), provider: 'airwallex' })], client,
      );
      await appendDomainEvent({
        workspaceId: topup.workspaceId,
        type: DOMAIN_EVENT_TYPES.AD_SPEND_FUNDED,
        aggregateType: 'ad_spend_wallet',
        aggregateId: topup.workspaceId,
        payload: { topupId: topup.id, amount: Number(topup.netAmount), currency: 'CNY', availableAmount: Number(wallet.availableAmount) },
        metadata: { actorId: topup.createdBy, source: 'airwallex' },
        idempotencyKey: `adspend-topup:${topup.id}:funded`,
      }, client);
    }
    return (await query<AdSpendTopupRow>(
      `SELECT ${topupSelect} FROM workspace_ad_spend_topups WHERE workspace_id=$1 AND id=$2`,
      [topup.workspaceId, topup.id], client,
    )).rows[0] ?? null;
  });
}

export async function failAdSpendTopup(topupId: string, code: string, message: string) {
  await query(
    `UPDATE workspace_ad_spend_topups SET status='FAILED',error_code=$2,error_message=$3
     WHERE id=$1 AND status IN ('CREATED','PENDING_PAYMENT','REQUIRES_CUSTOMER_ACTION')`,
    [topupId, code.slice(0, 120), message.slice(0, 2000)],
  );
}

/** Atomically reserves prepaid funds. Ad providers must call this before spend. */
export async function reserveAdSpend(input: {
  workspaceId: string;
  amount: number;
  idempotencyKey: string;
  platform?: string | null;
  campaignId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  return withTransaction(async (client) => {
    const prior = (await query<{ id: string }>(
      `SELECT id FROM workspace_ad_spend_reservations WHERE idempotency_key=$1`, [input.idempotencyKey], client,
    )).rows[0];
    if (prior) return prior;
    await ensureWallet(input.workspaceId, client);
    const wallet = (await query<WalletRow>(
      `UPDATE workspace_ad_spend_wallets SET available_amount=available_amount-$2,
       reserved_amount=reserved_amount+$2,version=version+1
       WHERE workspace_id=$1 AND available_amount >= $2 RETURNING ${walletSelect}`,
      [input.workspaceId, input.amount.toFixed(2)], client,
    )).rows[0];
    if (!wallet) throw new AppError(409, 'AD_SPEND_FUNDS_REQUIRED', 'Paid ads are paused until the ad spend wallet is funded.');
    const reservation = (await query<{ id: string }>(
      `INSERT INTO workspace_ad_spend_reservations(workspace_id,amount,platform,campaign_id,idempotency_key,metadata)
       VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
      [input.workspaceId, input.amount.toFixed(2), input.platform ?? null, input.campaignId ?? null,
        input.idempotencyKey, JSON.stringify(input.metadata ?? {})], client,
    )).rows[0];
    if (!reservation) throw new Error('Ad spend reservation failed');
    await query(
      `INSERT INTO workspace_ad_spend_ledger(workspace_id,entry_type,amount_delta,balance_after,idempotency_key,metadata)
       VALUES($1,'RESERVE',$2,$3,$4,$5::jsonb)`,
      [input.workspaceId, (-input.amount).toFixed(2), wallet.availableAmount, `adspend-reserve:${reservation.id}`, JSON.stringify(input.metadata ?? {})], client,
    );
    return reservation;
  });
}
