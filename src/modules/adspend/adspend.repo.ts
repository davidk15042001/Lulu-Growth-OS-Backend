import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { AppError } from '../../utils/app-error.js';
import { applyPendingAirwallexWalletReversals } from '../billing/airwallex-wallet-reversal.repo.js';
import { assertWorkspaceAutomationActive } from '../workspaces/workspace-automation.service.js';

export const AD_SPEND_FEE_BASIS_POINTS = 400;
export type AdSpendPaymentMethod = 'card' | 'alipaycn' | 'wechatpay';
export type AdSpendTopupStatus = 'CREATED' | 'PENDING_PAYMENT' | 'REQUIRES_CUSTOMER_ACTION' | 'SUCCEEDED' | 'CANCELLED' | 'FAILED' | 'EXPIRED' | 'REFUNDED' | 'CHARGEBACK';
export type AdBudgetAuthorizationStatus = 'ACTIVE' | 'REVOKED' | 'EXHAUSTED' | 'EXPIRED';

type WalletRow = {
  workspaceId: string;
  currency: 'CNY';
  availableAmount: string;
  reservedAmount: string;
  paymentReservedAmount: string;
  spentAmount: string;
  refundedAmount: string;
  reversalDebtAmount: string;
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
  providerStatus: string | null;
  paymentStatus: 'PENDING'|'SUCCEEDED'|'FAILED'|'CANCELLED'|'EXPIRED'|'REFUNDED'|'CHARGEBACK'|'UNKNOWN';
  creditStatus: 'NOT_CREDITED'|'AVAILABLE'|'REVERSED';
  settlementStatus: 'PENDING'|'COMPLETED'|'NOT_APPLICABLE';
  confirmedAt: string | null;
  cancelledAt: string | null;
  settledAt: string | null;
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

type AdBudgetAuthorizationRow = {
  id: string;
  workspaceId: string;
  createdBy: string;
  provider: string;
  accountId: string;
  campaignId: string;
  currency: string;
  authorizedAmount: string;
  reservedAmount: string;
  consumedAmount: string;
  startsAt: string | Date;
  endsAt: string | Date;
  status: AdBudgetAuthorizationStatus;
  idempotencyKey: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  revokedBy: string | null;
  revokedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

const walletSelect = `workspace_id AS "workspaceId",currency,available_amount AS "availableAmount",
  reserved_amount AS "reservedAmount",payment_reserved_amount AS "paymentReservedAmount",spent_amount AS "spentAmount",refunded_amount AS "refundedAmount",
  reversal_debt_amount AS "reversalDebtAmount",
  total_funded_amount AS "totalFundedAmount",total_fee_amount AS "totalFeeAmount",
  fee_basis_points AS "feeBasisPoints",version,created_at AS "createdAt",updated_at AS "updatedAt"`;

const topupSelect = `id,workspace_id AS "workspaceId",created_by AS "createdBy",net_amount AS "netAmount",
  fee_basis_points AS "feeBasisPoints",fee_amount AS "feeAmount",total_amount AS "totalAmount",currency,
  payment_method AS "paymentMethod",provider,status,merchant_order_id AS "merchantOrderId",
  provider_status AS "providerStatus",payment_status AS "paymentStatus",credit_status AS "creditStatus",settlement_status AS "settlementStatus",
  confirmed_at AS "confirmedAt",cancelled_at AS "cancelledAt",settled_at AS "settledAt",
  provider_invoice_id AS "providerInvoiceId",provider_payment_intent_id AS "providerPaymentIntentId",
  checkout_url AS "checkoutUrl",qr_payload AS "qrPayload",expires_at AS "expiresAt",paid_at AS "paidAt",
  credited_at AS "creditedAt",provider_response AS "providerResponse",error_code AS "errorCode",
  error_message AS "errorMessage",created_at AS "createdAt",updated_at AS "updatedAt"`;

const authorizationSelect = `id,workspace_id AS "workspaceId",created_by AS "createdBy",provider,
  account_id AS "accountId",campaign_id AS "campaignId",currency,authorized_amount AS "authorizedAmount",
  reserved_amount AS "reservedAmount",consumed_amount AS "consumedAmount",starts_at AS "startsAt",
  ends_at AS "endsAt",status,idempotency_key AS "idempotencyKey",reason,metadata,
  revoked_by AS "revokedBy",revoked_at AS "revokedAt",version,created_at AS "createdAt",updated_at AS "updatedAt"`;

function publicWallet(row: WalletRow) {
  return {
    ...row,
    availableAmount: Number(row.availableAmount),
    reservedAmount: Number(row.reservedAmount),
    paymentReservedAmount: Number(row.paymentReservedAmount),
    spentAmount: Number(row.spentAmount),
    refundedAmount: Number(row.refundedAmount),
    reversalDebtAmount: Number(row.reversalDebtAmount),
    totalFundedAmount: Number(row.totalFundedAmount),
    totalFeeAmount: Number(row.totalFeeAmount),
    adsEnabled: Number(row.availableAmount) > 0 && Number(row.reversalDebtAmount) === 0,
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

function publicAuthorization(row: AdBudgetAuthorizationRow) {
  const authorizedAmount = Number(row.authorizedAmount);
  const reservedAmount = Number(row.reservedAmount);
  const consumedAmount = Number(row.consumedAmount);
  const startsAt = timestampIso(row.startsAt);
  const endsAt = timestampIso(row.endsAt);
  const effectivelyExpired = row.status === 'ACTIVE' && timestampMs(row.endsAt) <= Date.now();
  return {
    ...row,
    startsAt,
    endsAt,
    status: effectivelyExpired ? 'EXPIRED' as const : row.status,
    authorizedAmount,
    reservedAmount,
    consumedAmount,
    remainingAmount: Math.max(0, Math.round((authorizedAmount - reservedAmount - consumedAmount) * 100) / 100),
  };
}

function timestampMs(value: string | Date) {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function timestampIso(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function money(value: number, code: string, message: string) {
  if (!Number.isFinite(value) || value <= 0) throw new AppError(422, code, message);
  const rounded = Math.round(value * 100) / 100;
  if (!Number.isSafeInteger(Math.round(rounded * 100))) throw new AppError(422, code, message);
  return rounded;
}

function normalizeScopeId(provider: string, value: string) {
  const normalized = value.trim();
  // Google accepts customer IDs in both 123-456-7890 and 1234567890 form.
  // Store and compare one canonical representation so formatting cannot make a
  // valid customer authorization unusable (or create a duplicate scope).
  return provider === 'google-ads' ? normalized.replaceAll('-', '') : normalized;
}

function assertUuid(value: string, code: string, message: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError(409, code, message);
  }
}

async function auditBudgetAuthorization(
  client: PoolClient,
  workspaceId: string,
  actorId: string | null,
  action: string,
  authorizationId: string,
  afterData: Record<string, unknown>,
) {
  await query(
    `INSERT INTO audit_log(workspace_id,actor_id,action,entity_type,entity_id,after_data)
     VALUES($1,$2,$3,'ad_budget_authorization',$4,$5::jsonb)`,
    [workspaceId, actorId, action, authorizationId, JSON.stringify(afterData)],
    client,
  );
}

async function ensureWallet(workspaceId: string, client?: PoolClient) {
  // Materialize lazily and seed any still-pending payment reserve. This keeps
  // a customer with only an unconfirmed payment from looking funded while
  // still exposing the reserve once the wallet is requested.
  await query(`INSERT INTO workspace_ad_spend_wallets(workspace_id,payment_reserved_amount)
    SELECT $1,COALESCE((SELECT SUM(net_amount) FROM workspace_ad_spend_topups
      WHERE workspace_id=$1 AND credited_at IS NULL
        AND status NOT IN ('FAILED','CANCELLED','EXPIRED','REFUNDED','CHARGEBACK')),0)
    ON CONFLICT DO NOTHING`, [workspaceId], client);
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
  if (Number(wallet.reversalDebtAmount) > 0) {
    throw new AppError(409, 'AD_SPEND_REVERSAL_DEBT', 'Paid advertising is paused until the outstanding refund or chargeback balance is covered.');
  }
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
  return withTransaction(async (client) => {
    const id = crypto.randomUUID();
    const merchantOrderId = `lulu-adspend-${id}`;
    const row = (await query<AdSpendTopupRow>(
      `INSERT INTO workspace_ad_spend_topups(
         id,workspace_id,created_by,net_amount,fee_basis_points,fee_amount,total_amount,currency,
         payment_method,merchant_order_id,payment_status,credit_status,settlement_status
       ) VALUES($1,$2,$3,$4,$5,$6,$7,'CNY',$8,$9,'PENDING','NOT_CREDITED','PENDING')
       RETURNING ${topupSelect}`,
      [id, input.workspaceId, input.userId, input.netAmount.toFixed(2), AD_SPEND_FEE_BASIS_POINTS,
        input.feeAmount.toFixed(2), input.totalAmount.toFixed(2), input.paymentMethod, merchantOrderId],
      client,
    )).rows[0];
    if (!row) throw new Error('Ad spend top-up was not created');
    const existing = (await query<WalletRow>(`SELECT ${walletSelect} FROM workspace_ad_spend_wallets WHERE workspace_id=$1 FOR UPDATE`, [input.workspaceId], client)).rows[0];
    const wallet = existing ? (await query<WalletRow>(
      `UPDATE workspace_ad_spend_wallets
       SET payment_reserved_amount=payment_reserved_amount+$2,version=version+1
       WHERE workspace_id=$1 RETURNING ${walletSelect}`,
      [input.workspaceId, input.netAmount.toFixed(2)], client,
    )).rows[0] : null;
    await query(
      `INSERT INTO workspace_ad_spend_ledger(workspace_id,topup_id,entry_type,amount_delta,balance_after,reserved_after,currency,idempotency_key,metadata)
       VALUES($1,NULL,'DEPOSIT_RESERVED',0,$2,$3,'CNY',$4,$5::jsonb) ON CONFLICT DO NOTHING`,
      [input.workspaceId, existing?.availableAmount ?? '0', wallet?.paymentReservedAmount ?? input.netAmount.toFixed(2),
        `adspend-topup:${id}:deposit-reserved`, JSON.stringify({ provider: 'airwallex', netAmount: input.netAmount, totalCharged: input.totalAmount })],
      client,
    );
    return row;
  });
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
    `UPDATE workspace_ad_spend_topups SET status=$2,provider_status=$2,
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
  if (normalized.includes('CHARGEBACK')) return 'CHARGEBACK';
  if (normalized.includes('REFUND')) return 'REFUNDED';
  if (['SUCCEEDED','PAID','COMPLETED'].includes(normalized)) return 'SUCCEEDED';
  if (normalized === 'CANCELLED' || normalized === 'CANCELED') return 'CANCELLED';
  if (normalized === 'EXPIRED') return 'EXPIRED';
  if (['FAILED','REQUIRES_PAYMENT_METHOD'].includes(normalized)) return 'FAILED';
  if (['REQUIRES_CUSTOMER_ACTION','REQUIRES_ACTION'].includes(normalized)) return 'REQUIRES_CUSTOMER_ACTION';
  return 'PENDING_PAYMENT';
}

export async function applyAdSpendProviderStatus(input: {
  topupId?: string | null;
  workspaceId?: string | null;
  providerPaymentIntentId?: string | null;
  providerInvoiceId?: string | null;
  providerStatus: string;
  paidAt?: string | null;
  providerResponse?: Record<string, unknown>;
  /**
   * A successful PaymentIntent only confirms the provider payment. Wallet
   * funds are minted only after Airwallex independently confirms settlement.
   * Billing invoices set this after their Billing Transaction proof; QR
   * PaymentIntents set it after a Settlement Record is found.
   */
  settlementVerified?: boolean;
}) {
  return withTransaction(async (client) => {
    const matches = await query<AdSpendTopupRow>(
      `SELECT ${topupSelect} FROM workspace_ad_spend_topups
       WHERE ($1::text IS NOT NULL AND provider_payment_intent_id=$1)
          OR ($2::text IS NOT NULL AND provider_invoice_id=$2)
          OR ($3::text IS NOT NULL AND id::text=$3)
       FOR UPDATE`,
      [input.providerPaymentIntentId ?? null, input.providerInvoiceId ?? null, input.topupId ?? null], client,
    );
    if (matches.rows.length > 1) {
      throw new AppError(409, 'AIRWALLEX_WALLET_CORRELATION_AMBIGUOUS', 'Airwallex advertising wallet references resolve to multiple top-ups.');
    }
    const topup = matches.rows[0];
    if (!topup) return null;
    if (input.topupId && input.topupId !== topup.id) {
      throw new AppError(409, 'AIRWALLEX_WALLET_TOPUP_MISMATCH', 'Airwallex wallet metadata does not match the correlated advertising top-up.');
    }
    if (input.workspaceId && input.workspaceId !== topup.workspaceId) {
      throw new AppError(409, 'AIRWALLEX_WALLET_WORKSPACE_MISMATCH', 'Airwallex wallet metadata does not match the correlated advertising top-up.');
    }
    if (input.providerPaymentIntentId && topup.providerPaymentIntentId
      && input.providerPaymentIntentId !== topup.providerPaymentIntentId) {
      throw new AppError(409, 'AIRWALLEX_WALLET_PAYMENT_INTENT_MISMATCH', 'Airwallex PaymentIntent does not match the correlated advertising top-up.');
    }
    if (input.providerInvoiceId && topup.providerInvoiceId && input.providerInvoiceId !== topup.providerInvoiceId) {
      throw new AppError(409, 'AIRWALLEX_WALLET_INVOICE_MISMATCH', 'Airwallex invoice does not match the correlated advertising top-up.');
    }
    const mappedStatus = mapProviderStatus(input.providerStatus);
    const reversal = mappedStatus === 'REFUNDED' || mappedStatus === 'CHARGEBACK';
    const wasReversed = topup.creditStatus === 'REVERSED' || topup.status === 'REFUNDED' || topup.status === 'CHARGEBACK';
    // Provider events can arrive out of order. Once funds were credited, a
    // delayed pending/failed event must never downgrade the successful top-up.
    // Reversal is terminal even if it is observed before the corresponding
    // success webhook. Airwallex does not guarantee delivery ordering.
    const status: AdSpendTopupStatus = wasReversed && topup.creditedAt
      ? topup.status
      : reversal
        ? mappedStatus
        : topup.creditedAt
          ? 'SUCCEEDED'
          : mappedStatus;
    const successful = status === 'SUCCEEDED';
    const settlementVerified = input.settlementVerified === true;
    const newlyCredited = successful && settlementVerified && topup.creditStatus !== 'AVAILABLE';
    const newlyReleased = !topup.creditedAt && ['FAILED','CANCELLED','EXPIRED','REFUNDED','CHARGEBACK'].includes(status);
    const newlyReversed = reversal && topup.creditStatus === 'AVAILABLE' && !wasReversed;
    const paymentStatus = status === 'SUCCEEDED' ? 'SUCCEEDED' : ['CREATED','PENDING_PAYMENT','REQUIRES_CUSTOMER_ACTION'].includes(status) ? 'PENDING' : status;
    await query(
      `UPDATE workspace_ad_spend_topups SET status=$2::varchar,provider_status=$3,payment_status=$4,
       credit_status=CASE WHEN $9::boolean AND $2::varchar='SUCCEEDED' THEN 'AVAILABLE' WHEN $2::varchar IN ('REFUNDED','CHARGEBACK') AND credited_at IS NOT NULL THEN 'REVERSED' ELSE credit_status END,
       settlement_status=CASE WHEN $9::boolean AND $2::varchar='SUCCEEDED' THEN 'COMPLETED' WHEN $2::varchar IN ('REFUNDED','CHARGEBACK') AND credited_at IS NOT NULL THEN 'COMPLETED' WHEN $2::varchar IN ('FAILED','CANCELLED','EXPIRED','REFUNDED','CHARGEBACK') THEN 'NOT_APPLICABLE' ELSE settlement_status END,
       paid_at=CASE WHEN $2::varchar='SUCCEEDED' THEN COALESCE(paid_at,$5::timestamptz,NOW()) ELSE paid_at END,
       confirmed_at=CASE WHEN $2::varchar='SUCCEEDED' THEN COALESCE(confirmed_at,$5::timestamptz,NOW()) ELSE confirmed_at END,
       settled_at=CASE WHEN ($9::boolean AND $2::varchar='SUCCEEDED') OR ($2::varchar IN ('REFUNDED','CHARGEBACK') AND credited_at IS NOT NULL) THEN COALESCE(settled_at,$5::timestamptz,NOW()) ELSE settled_at END,
       credited_at=CASE WHEN $9::boolean AND $2::varchar='SUCCEEDED' THEN COALESCE(credited_at,NOW()) ELSE credited_at END,
       cancelled_at=CASE WHEN $4::varchar IN ('FAILED','CANCELLED','EXPIRED','REFUNDED','CHARGEBACK') THEN COALESCE(cancelled_at,NOW()) ELSE cancelled_at END,
       provider_response=provider_response || $6::jsonb,
       provider_payment_intent_id=COALESCE(provider_payment_intent_id,$7),
       provider_invoice_id=COALESCE(provider_invoice_id,$8)
      WHERE id=$1`,
      [topup.id, status, input.providerStatus, paymentStatus, input.paidAt ?? null, JSON.stringify(input.providerResponse ?? {}),
        input.providerPaymentIntentId ?? null, input.providerInvoiceId ?? null, settlementVerified], client,
    );
    if (newlyCredited) {
      await ensureWallet(topup.workspaceId, client);
      const wallet = (await query<WalletRow>(
        `UPDATE workspace_ad_spend_wallets SET
           payment_reserved_amount=GREATEST(0,payment_reserved_amount-$2),
           available_amount=available_amount+GREATEST(0,$2-reversal_debt_amount),
           reversal_debt_amount=GREATEST(0,reversal_debt_amount-$2),
           total_funded_amount=total_funded_amount+$2,
            total_fee_amount=total_fee_amount+$3,
            version=version+1
         WHERE workspace_id=$1 RETURNING ${walletSelect}`,
        [topup.workspaceId, topup.netAmount, topup.feeAmount], client,
      )).rows[0];
      if (!wallet) throw new Error('Ad spend wallet credit failed');
      await query(
        `INSERT INTO workspace_ad_spend_ledger(
          workspace_id,topup_id,entry_type,amount_delta,balance_after,reserved_after,currency,idempotency_key,metadata
        ) VALUES($1,$2,'TOPUP_CREDIT',$3,$4,$5,'CNY',$6,$7::jsonb) ON CONFLICT DO NOTHING`,
        [topup.workspaceId, topup.id, topup.netAmount, wallet.availableAmount, wallet.paymentReservedAmount, `adspend-topup:${topup.id}:credit`,
          JSON.stringify({
            feeAmount: Number(topup.feeAmount),
            totalCharged: Number(topup.totalAmount),
            provider: 'airwallex',
            reversalDebtAmount: Number(wallet.reversalDebtAmount),
          })], client,
      );
      const reconciled = await applyPendingAirwallexWalletReversals({ walletType: 'AD_SPEND', topupId: topup.id, client });
      const effectiveWallet = reconciled.wallet ?? wallet;
      if (Number(effectiveWallet.availableAmount) > 0 && Number(effectiveWallet.reversalDebtAmount) === 0) {
        await appendDomainEvent({
          workspaceId: topup.workspaceId,
          type: DOMAIN_EVENT_TYPES.AD_SPEND_FUNDED,
          aggregateType: 'ad_spend_wallet',
          aggregateId: topup.workspaceId,
          payload: { topupId: topup.id, amount: Number(topup.netAmount), currency: 'CNY', availableAmount: Number(effectiveWallet.availableAmount) },
          metadata: { actorId: topup.createdBy, source: 'airwallex' },
          idempotencyKey: `adspend-topup:${topup.id}:funded`,
        }, client);
      }
    }
    if (newlyReleased) {
      await ensureWallet(topup.workspaceId, client);
      const wallet = (await query<WalletRow>(
        `UPDATE workspace_ad_spend_wallets SET payment_reserved_amount=GREATEST(0,payment_reserved_amount-$2),version=version+1
         WHERE workspace_id=$1 RETURNING ${walletSelect}`,
        [topup.workspaceId, topup.netAmount], client,
      )).rows[0];
      if (!wallet) throw new Error('Ad spend payment reserve release failed');
      await query(
        `INSERT INTO workspace_ad_spend_ledger(workspace_id,topup_id,entry_type,amount_delta,balance_after,reserved_after,currency,idempotency_key,metadata)
         VALUES($1,$2,'RESERVATION_RELEASED',0,$3,$4,'CNY',$5,$6::jsonb) ON CONFLICT DO NOTHING`,
        [topup.workspaceId, topup.id, wallet.availableAmount, wallet.paymentReservedAmount, `adspend-topup:${topup.id}:deposit-release`, JSON.stringify({ provider: 'airwallex', status, reason: 'payment_not_succeeded' })], client,
      );
    }
    if (newlyReversed) {
      await ensureWallet(topup.workspaceId, client);
      const wallet = (await query<WalletRow>(
        `UPDATE workspace_ad_spend_wallets SET
           available_amount=GREATEST(0,available_amount-$2),
           reversal_debt_amount=reversal_debt_amount+GREATEST(0,$2-available_amount),
           refunded_amount=refunded_amount+$2,
           total_funded_amount=GREATEST(0,total_funded_amount-$2),
           total_fee_amount=GREATEST(0,total_fee_amount-$3),
           version=version+1
         WHERE workspace_id=$1 RETURNING ${walletSelect}`,
        [topup.workspaceId, topup.netAmount, topup.feeAmount], client,
      )).rows[0];
      if (!wallet) throw new Error('Ad spend wallet reversal failed');
      await query(
        `INSERT INTO workspace_ad_spend_ledger(
           workspace_id,topup_id,entry_type,amount_delta,balance_after,reserved_after,currency,idempotency_key,metadata
         ) VALUES($1,$2,'REFUND',$3,$4,$5,'CNY',$6,$7::jsonb) ON CONFLICT DO NOTHING`,
        [topup.workspaceId, topup.id, (-Number(topup.netAmount)).toFixed(2), wallet.availableAmount, wallet.paymentReservedAmount,
          `adspend-topup:${topup.id}:reversal`, JSON.stringify({
            provider: 'airwallex', status, originalAmount: Number(topup.netAmount),
            reversalDebtAmount: Number(wallet.reversalDebtAmount),
          })], client,
      );
    }
    return (await query<AdSpendTopupRow>(
      `SELECT ${topupSelect} FROM workspace_ad_spend_topups WHERE workspace_id=$1 AND id=$2`,
      [topup.workspaceId, topup.id], client,
    )).rows[0] ?? null;
  });
}

/**
 * Repairs a legacy QR top-up that was credited before settlement verification
 * existed. This is deliberately fail-closed: when the wallet has already been
 * consumed or reserved we leave the funds untouched and let an operator
 * reconcile the exact allocation instead of inventing a negative balance.
 */
export async function holdAdSpendTopupForSettlement(input: {
  topupId: string;
  providerResponse?: Record<string, unknown>;
}) {
  return withTransaction(async (client) => {
    const topup = (await query<AdSpendTopupRow>(
      `SELECT ${topupSelect} FROM workspace_ad_spend_topups WHERE id=$1 FOR UPDATE`,
      [input.topupId], client,
    )).rows[0];
    if (!topup || topup.creditStatus !== 'AVAILABLE' || !topup.creditedAt) return topup ?? null;
    await ensureWallet(topup.workspaceId, client);
    const wallet = (await query<WalletRow>(
      `UPDATE workspace_ad_spend_wallets SET
         available_amount=available_amount-$2,
         payment_reserved_amount=payment_reserved_amount+$2,
         total_funded_amount=GREATEST(0,total_funded_amount-$2),
         total_fee_amount=GREATEST(0,total_fee_amount-$3),
         version=version+1
       WHERE workspace_id=$1 AND available_amount >= $2
         AND reserved_amount=0 AND spent_amount=0
       RETURNING ${walletSelect}`,
      [topup.workspaceId, topup.netAmount, topup.feeAmount], client,
    )).rows[0];
    if (!wallet) return topup;
    await query(
      `INSERT INTO workspace_ad_spend_ledger(
         workspace_id,topup_id,entry_type,amount_delta,balance_after,reserved_after,currency,idempotency_key,metadata
       ) VALUES($1,$2,'ADJUSTMENT',$3,$4,$5,'CNY',$6,$7::jsonb) ON CONFLICT DO NOTHING`,
      [topup.workspaceId, topup.id, (-Number(topup.netAmount)).toFixed(2), wallet.availableAmount, wallet.paymentReservedAmount,
        `adspend-topup:${topup.id}:settlement-hold`, JSON.stringify({
          provider: 'airwallex', reason: 'settlement_pending',
          totalAmount: Number(topup.totalAmount), feeAmount: Number(topup.feeAmount),
        })], client,
    );
    await query(
      `UPDATE workspace_ad_spend_topups
          SET credit_status='NOT_CREDITED',settlement_status='PENDING',settled_at=NULL,credited_at=NULL,
              provider_response=provider_response || $2::jsonb
        WHERE id=$1`,
      [topup.id, JSON.stringify({ ...(input.providerResponse ?? {}), settlementReconciled: 'pending' })], client,
    );
    return (await query<AdSpendTopupRow>(
      `SELECT ${topupSelect} FROM workspace_ad_spend_topups WHERE id=$1`, [topup.id], client,
    )).rows[0] ?? null;
  });
}

export async function failAdSpendTopup(topupId: string, code: string, message: string) {
  return withTransaction(async (client) => {
    const row = (await query<AdSpendTopupRow>(`SELECT ${topupSelect} FROM workspace_ad_spend_topups WHERE id=$1 FOR UPDATE`, [topupId], client)).rows[0];
    if (!row || row.creditedAt || ['FAILED','CANCELLED','EXPIRED','REFUNDED','CHARGEBACK'].includes(row.status)) return row ?? null;
    await query(
      `UPDATE workspace_ad_spend_topups SET status='FAILED',provider_status=$2,payment_status='FAILED',settlement_status='NOT_APPLICABLE',cancelled_at=COALESCE(cancelled_at,NOW()),error_code=$3,error_message=$4 WHERE id=$1`,
      [topupId, code, code.slice(0, 120), message.slice(0, 2000)], client,
    );
    await ensureWallet(row.workspaceId, client);
    const wallet = (await query<WalletRow>(
      `UPDATE workspace_ad_spend_wallets SET payment_reserved_amount=GREATEST(0,payment_reserved_amount-$2),version=version+1
       WHERE workspace_id=$1 RETURNING ${walletSelect}`,
      [row.workspaceId, row.netAmount], client,
    )).rows[0];
    if (!wallet) throw new Error('Ad spend payment reserve release failed');
    await query(
      `INSERT INTO workspace_ad_spend_ledger(workspace_id,topup_id,entry_type,amount_delta,balance_after,reserved_after,currency,idempotency_key,metadata)
       VALUES($1,$2,'RESERVATION_RELEASED',0,$3,$4,'CNY',$5,$6::jsonb) ON CONFLICT DO NOTHING`,
      [row.workspaceId, row.id, wallet.availableAmount, wallet.paymentReservedAmount, `adspend-topup:${row.id}:deposit-release`, JSON.stringify({ source: 'payment_creation_failure', code })], client,
    );
    return (await query<AdSpendTopupRow>(`SELECT ${topupSelect} FROM workspace_ad_spend_topups WHERE id=$1`, [row.id], client)).rows[0] ?? null;
  });
}

export async function createAdBudgetAuthorization(input: {
  workspaceId: string;
  userId: string;
  provider: string;
  accountId: string;
  campaignId: string;
  currency: string;
  amount: number;
  startsAt?: string;
  endsAt: string;
  idempotencyKey: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const amount = money(input.amount, 'AD_BUDGET_AUTHORIZATION_AMOUNT_INVALID', 'A campaign budget authorization requires a positive amount.');
  const provider = input.provider.trim().toLowerCase();
  const accountId = normalizeScopeId(provider, input.accountId);
  const campaignId = normalizeScopeId(provider, input.campaignId);
  const currency = input.currency.trim().toUpperCase();
  const startsAt = input.startsAt ? new Date(input.startsAt) : new Date();
  const endsAt = new Date(input.endsAt);
  if (!provider || !accountId || !campaignId || !/^[A-Z]{3}$/.test(currency)
    || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || startsAt >= endsAt) {
    throw new AppError(422, 'AD_BUDGET_AUTHORIZATION_INVALID', 'Provider, account, campaign, currency and a valid authorization period are required.');
  }
  if (endsAt.getTime() <= Date.now()) {
    throw new AppError(422, 'AD_BUDGET_AUTHORIZATION_PERIOD_INVALID', 'A campaign budget authorization must end in the future.');
  }
  return withTransaction(async (client) => {
    await query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ad-budget-idempotency:${input.workspaceId}:${input.idempotencyKey}`], client);
    await query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ad-budget:${input.workspaceId}:${provider}:${accountId}:${campaignId}`], client);
    const prior = (await query<AdBudgetAuthorizationRow>(
      `SELECT ${authorizationSelect} FROM workspace_ad_budget_authorizations
       WHERE workspace_id=$1 AND idempotency_key=$2`,
      [input.workspaceId, input.idempotencyKey], client,
    )).rows[0];
    if (prior) {
      const same = prior.createdBy === input.userId && prior.provider === provider
        && prior.accountId === accountId && prior.campaignId === campaignId
        && prior.currency === currency && Number(prior.authorizedAmount) === amount
        && (!input.startsAt || timestampMs(prior.startsAt) === startsAt.getTime()) && timestampMs(prior.endsAt) === endsAt.getTime();
      if (!same) throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different campaign authorization.');
      return { ...publicAuthorization(prior), idempotent: true };
    }
    await query(
      `UPDATE workspace_ad_budget_authorizations SET status='EXPIRED',version=version+1
       WHERE workspace_id=$1 AND provider=$2 AND account_id=$3 AND campaign_id=$4
         AND status='ACTIVE' AND ends_at<=NOW()`,
      [input.workspaceId, provider, accountId, campaignId], client,
    );
    const active = (await query<{ id: string }>(
      `SELECT id FROM workspace_ad_budget_authorizations
       WHERE workspace_id=$1 AND provider=$2 AND account_id=$3 AND campaign_id=$4 AND status='ACTIVE'
       LIMIT 1 FOR UPDATE`,
      [input.workspaceId, provider, accountId, campaignId], client,
    )).rows[0];
    if (active) {
      throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_ACTIVE', 'Revoke or exhaust the existing campaign authorization before creating another one.');
    }
    const row = (await query<AdBudgetAuthorizationRow>(
      `INSERT INTO workspace_ad_budget_authorizations(
         workspace_id,created_by,provider,account_id,campaign_id,currency,authorized_amount,
         starts_at,ends_at,idempotency_key,reason,metadata
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       RETURNING ${authorizationSelect}`,
      [input.workspaceId, input.userId, provider, accountId, campaignId, currency, amount.toFixed(2),
        startsAt, endsAt, input.idempotencyKey, input.reason?.trim().slice(0, 2000) || null,
        JSON.stringify(input.metadata ?? {})], client,
    )).rows[0];
    if (!row) throw new Error('Campaign budget authorization could not be created');
    const result = publicAuthorization(row);
    await auditBudgetAuthorization(client, input.workspaceId, input.userId, 'advertising.budget_authorized', row.id, result);
    await appendDomainEvent({
      workspaceId: input.workspaceId,
      type: DOMAIN_EVENT_TYPES.AD_BUDGET_AUTHORIZED,
      aggregateType: 'ad_budget_authorization',
      aggregateId: row.id,
      payload: { authorizationId: row.id, provider, accountId, campaignId, currency, amount, startsAt: row.startsAt, endsAt: row.endsAt },
      metadata: { actorId: input.userId, source: 'adspend' },
      idempotencyKey: `ad-budget:${row.id}:authorized`,
    }, client);
    return { ...result, idempotent: false };
  });
}

export async function listAdBudgetAuthorizations(workspaceId: string) {
  const { rows } = await query<AdBudgetAuthorizationRow>(
    `SELECT ${authorizationSelect} FROM workspace_ad_budget_authorizations
     WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 250`,
    [workspaceId],
  );
  return rows.map(publicAuthorization);
}

export async function revokeAdBudgetAuthorization(input: { workspaceId: string; authorizationId: string; userId: string; reason?: string | null }) {
  assertUuid(input.authorizationId, 'AD_BUDGET_AUTHORIZATION_NOT_FOUND', 'Campaign budget authorization not found.');
  return withTransaction(async (client) => {
    const row = (await query<AdBudgetAuthorizationRow>(
      `SELECT ${authorizationSelect} FROM workspace_ad_budget_authorizations
       WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [input.workspaceId, input.authorizationId], client,
    )).rows[0];
    if (!row) throw new AppError(404, 'AD_BUDGET_AUTHORIZATION_NOT_FOUND', 'Campaign budget authorization not found.');
    if (row.status !== 'ACTIVE') return { ...publicAuthorization(row), idempotent: true };
    if (Number(row.reservedAmount) > 0) {
      throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_IN_USE', 'This authorization has an in-flight provider operation and cannot be revoked yet.');
    }
    const updated = (await query<AdBudgetAuthorizationRow>(
      `UPDATE workspace_ad_budget_authorizations
       SET status='REVOKED',revoked_by=$3,revoked_at=NOW(),reason=COALESCE($4,reason),version=version+1
       WHERE workspace_id=$1 AND id=$2 RETURNING ${authorizationSelect}`,
      [input.workspaceId, input.authorizationId, input.userId, input.reason?.trim().slice(0, 2000) || null], client,
    )).rows[0]!;
    const result = publicAuthorization(updated);
    await auditBudgetAuthorization(client, input.workspaceId, input.userId, 'advertising.budget_authorization_revoked', updated.id, result);
    await appendDomainEvent({
      workspaceId: input.workspaceId,
      type: DOMAIN_EVENT_TYPES.AD_BUDGET_REVOKED,
      aggregateType: 'ad_budget_authorization',
      aggregateId: updated.id,
      payload: { authorizationId: updated.id, provider: updated.provider, accountId: updated.accountId, campaignId: updated.campaignId, reason: updated.reason },
      metadata: { actorId: input.userId, source: 'adspend' },
      idempotencyKey: `ad-budget:${updated.id}:revoked`,
    }, client);
    return { ...result, idempotent: false };
  });
}

/** Read-only preflight for action-packet creation. Execution must still call
 * reserveAdSpend, which repeats this policy atomically with wallet reservation. */
export async function assertAdBudgetAuthorization(input: {
  workspaceId: string;
  authorizationId: string;
  provider: string;
  accountId: string;
  campaignId: string;
  currency: string;
  amount: number;
}, client?: PoolClient) {
  const amount = money(input.amount, 'AD_BUDGET_AUTHORIZATION_AMOUNT_INVALID', 'A campaign operation requires a positive authorized amount.');
  assertUuid(input.authorizationId, 'AD_BUDGET_AUTHORIZATION_REQUIRED', 'A customer-authorized campaign budget is required before paid advertising can run.');
  const provider = input.provider.trim().toLowerCase();
  const accountId = normalizeScopeId(provider, input.accountId);
  const campaignId = normalizeScopeId(provider, input.campaignId);
  const row = (await query<AdBudgetAuthorizationRow>(
    `SELECT ${authorizationSelect} FROM workspace_ad_budget_authorizations WHERE workspace_id=$1 AND id=$2`,
    [input.workspaceId, input.authorizationId], client,
  )).rows[0];
  if (!row) throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_REQUIRED', 'A customer-authorized campaign budget is required before paid advertising can run.');
  if (row.provider !== provider || row.accountId !== accountId
    || row.campaignId !== campaignId || row.currency !== input.currency.trim().toUpperCase()) {
    throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_SCOPE_MISMATCH', 'The campaign operation does not match the authorized provider, account, campaign and currency.');
  }
  if (row.status !== 'ACTIVE' || timestampMs(row.startsAt) > Date.now() || timestampMs(row.endsAt) <= Date.now()) {
    throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_INACTIVE', 'The campaign budget authorization is not currently active.');
  }
  const remaining = Number(row.authorizedAmount) - Number(row.reservedAmount) - Number(row.consumedAmount);
  if (remaining < amount) throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_EXCEEDED', 'The campaign operation exceeds the customer-authorized remaining amount.');
  return publicAuthorization(row);
}

/** Atomically reserves both campaign authority and prepaid funds. A funded
 * wallet by itself is never permission to launch or increase a campaign. */
export async function reserveAdSpend(input: {
  workspaceId: string;
  authorizationId: string;
  amount: number;
  idempotencyKey: string;
  provider: string;
  accountId: string;
  campaignId: string;
  currency: string;
  metadata?: Record<string, unknown>;
}) {
  await assertWorkspaceAutomationActive(input.workspaceId);
  if (!input.authorizationId || !input.provider?.trim() || !input.accountId?.trim() || !input.campaignId?.trim() || !input.currency?.trim()) {
    throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_REQUIRED', 'A campaign-specific customer budget authorization is required in addition to prepaid funds.');
  }
  assertUuid(input.authorizationId, 'AD_BUDGET_AUTHORIZATION_REQUIRED', 'A customer-authorized campaign budget is required before paid advertising can run.');
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new AppError(400, 'AD_SPEND_AMOUNT_INVALID', 'Ad spend reservations require a positive CNY amount.');
  }
  const amount = Math.round(input.amount * 100) / 100;
  return withTransaction(async (client) => {
    const provider = input.provider.trim().toLowerCase();
    const accountId = normalizeScopeId(provider, input.accountId);
    const campaignId = normalizeScopeId(provider, input.campaignId);
    const currency = input.currency.trim().toUpperCase();
    await query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ad-reservation-idempotency:${input.workspaceId}:${input.idempotencyKey}`], client);
    const prior = (await query<{ id: string; workspaceId: string; authorizationId: string | null; amount: string; status: string; platform: string | null; accountId: string | null; campaignId: string | null; currency: string; metadata: Record<string, unknown> }>(
      `SELECT id,workspace_id AS "workspaceId",authorization_id AS "authorizationId",amount,status,platform,
       account_id AS "accountId",campaign_id AS "campaignId",currency,metadata
       FROM workspace_ad_spend_reservations WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`, [input.workspaceId,input.idempotencyKey], client,
    )).rows[0];
    if (prior) {
      if (prior.authorizationId !== input.authorizationId
        || Number(prior.amount) !== amount || prior.platform !== provider || prior.accountId !== accountId
        || prior.campaignId !== campaignId || prior.currency !== currency) {
        throw new AppError(409, 'AD_SPEND_IDEMPOTENCY_CONFLICT', 'This ad spend operation key was already used for a different reservation.');
      }
      return { ...prior, amount: Number(prior.amount), idempotent: true };
    }
    await query(
      `UPDATE workspace_ad_budget_authorizations SET status='EXPIRED',version=version+1
       WHERE workspace_id=$1 AND id=$2 AND status='ACTIVE' AND ends_at<=NOW()`,
      [input.workspaceId, input.authorizationId], client,
    );
    const authorization = (await query<AdBudgetAuthorizationRow>(
      `UPDATE workspace_ad_budget_authorizations
       SET reserved_amount=reserved_amount+$7,version=version+1
       WHERE workspace_id=$1 AND id=$2 AND provider=$3 AND account_id=$4 AND campaign_id=$5 AND currency=$6
         AND status='ACTIVE' AND starts_at<=NOW() AND ends_at>NOW()
         AND authorized_amount-reserved_amount-consumed_amount >= $7
       RETURNING ${authorizationSelect}`,
      [input.workspaceId, input.authorizationId, provider, accountId, campaignId, currency, amount.toFixed(2)], client,
    )).rows[0];
    if (!authorization) {
      const candidate = (await query<AdBudgetAuthorizationRow>(
        `SELECT ${authorizationSelect} FROM workspace_ad_budget_authorizations WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [input.workspaceId, input.authorizationId], client,
      )).rows[0];
      if (!candidate) throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_REQUIRED', 'A customer-authorized campaign budget is required before paid advertising can run.');
      if (candidate.provider !== provider || candidate.accountId !== accountId || candidate.campaignId !== campaignId || candidate.currency !== currency) {
        throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_SCOPE_MISMATCH', 'The campaign operation does not match the authorized provider, account, campaign and currency.');
      }
      if (candidate.status !== 'ACTIVE' || timestampMs(candidate.startsAt) > Date.now() || timestampMs(candidate.endsAt) <= Date.now()) {
        throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_INACTIVE', 'The campaign budget authorization is not currently active.');
      }
      throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_EXCEEDED', 'The campaign operation exceeds the customer-authorized remaining amount.');
    }
    await ensureWallet(input.workspaceId, client);
    const wallet = (await query<WalletRow>(
      `UPDATE workspace_ad_spend_wallets SET available_amount=available_amount-$2,
       reserved_amount=reserved_amount+$2,version=version+1
       WHERE workspace_id=$1 AND available_amount >= $2 AND reversal_debt_amount=0 RETURNING ${walletSelect}`,
      [input.workspaceId, amount.toFixed(2)], client,
    )).rows[0];
    if (!wallet) {
      const currentWallet = await ensureWallet(input.workspaceId, client);
      if (Number(currentWallet.reversalDebtAmount) > 0) {
        throw new AppError(409, 'AD_SPEND_REVERSAL_DEBT', 'Paid advertising is paused until the outstanding refund or chargeback balance is covered.');
      }
      throw new AppError(409, 'AD_SPEND_FUNDS_REQUIRED', 'Paid ads are paused until the ad spend wallet is funded.');
    }
    const reservation = (await query<{ id: string }>(
      `INSERT INTO workspace_ad_spend_reservations(workspace_id,authorization_id,amount,currency,platform,account_id,campaign_id,idempotency_key,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id`,
      [input.workspaceId, input.authorizationId, amount.toFixed(2), currency, provider, accountId, campaignId,
        input.idempotencyKey, JSON.stringify(input.metadata ?? {})], client,
    )).rows[0];
    if (!reservation) throw new Error('Ad spend reservation failed');
    await query(
      `INSERT INTO workspace_ad_spend_ledger(workspace_id,entry_type,amount_delta,balance_after,idempotency_key,metadata)
       VALUES($1,'RESERVE',$2,$3,$4,$5::jsonb)`,
      [input.workspaceId, (-amount).toFixed(2), wallet.availableAmount, `adspend-reserve:${reservation.id}`, JSON.stringify(input.metadata ?? {})], client,
    );
    await appendDomainEvent({
      workspaceId: input.workspaceId,
      type: DOMAIN_EVENT_TYPES.AD_BUDGET_RESERVED,
      aggregateType: 'ad_budget_authorization',
      aggregateId: authorization.id,
      payload: { authorizationId: authorization.id, reservationId: reservation.id, provider, accountId, campaignId, currency, amount },
      metadata: { actorId: null, source: 'adspend' },
      idempotencyKey: `ad-budget:${authorization.id}:reservation:${reservation.id}:reserved`,
    }, client);
    return { ...reservation, authorizationId: authorization.id, amount, status: 'RESERVED' as const, metadata: input.metadata ?? {}, idempotent: false };
  });
}

/** Converts a reservation into irreversible provider spend after the provider
 * accepted the operation. Replays are safe and never double-charge the wallet. */
export async function consumeAdSpendReservation(input: {
  workspaceId: string;
  reservationId: string;
  providerOperationId?: string | null;
  metadata?: Record<string, unknown>;
}) {
  return withTransaction(async (client) => {
    const reservation = (await query<{id:string;authorizationId:string|null;amount:string;settledAmount:string;status:string;metadata:Record<string,unknown>}>(
      `SELECT id,authorization_id AS "authorizationId",amount,settled_amount AS "settledAmount",status,metadata
       FROM workspace_ad_spend_reservations WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
      [input.reservationId, input.workspaceId], client,
    )).rows[0];
    if (!reservation) throw new AppError(404, 'AD_SPEND_RESERVATION_NOT_FOUND', 'Ad spend reservation not found.');
    if (reservation.status === 'CONSUMED') return { ...reservation, amount: Number(reservation.amount), settledAmount: Number(reservation.settledAmount), idempotent: true };
    if (reservation.status !== 'RESERVED') throw new AppError(409, 'AD_SPEND_RESERVATION_CLOSED', `Ad spend reservation is already ${reservation.status.toLowerCase()}.`);
    if (!reservation.authorizationId) throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_REQUIRED', 'This legacy reservation has no customer campaign authorization and cannot be consumed.');
    const metadata = { ...reservation.metadata, ...input.metadata, providerOperationId: input.providerOperationId ?? null };
    const remainingAmount = Math.round((Number(reservation.amount) - Number(reservation.settledAmount)) * 100) / 100;
    if (remainingAmount <= 0) {
      await query(
        `UPDATE workspace_ad_spend_reservations SET status='CONSUMED',settled_amount=amount,metadata=$3::jsonb WHERE id=$1 AND workspace_id=$2`,
        [input.reservationId, input.workspaceId, JSON.stringify(metadata)], client,
      );
      return { id: reservation.id, authorizationId: reservation.authorizationId, amount: Number(reservation.amount),
        settledAmount: Number(reservation.amount), consumedAmount: 0, status: 'CONSUMED' as const, idempotent: false };
    }
    const wallet = (await query<WalletRow>(
      `UPDATE workspace_ad_spend_wallets SET reserved_amount=reserved_amount-$2,spent_amount=spent_amount+$2,version=version+1
       WHERE workspace_id=$1 AND reserved_amount >= $2 RETURNING ${walletSelect}`,
      [input.workspaceId, remainingAmount.toFixed(2)], client,
    )).rows[0];
    if (!wallet) throw new AppError(409, 'AD_SPEND_RESERVATION_BALANCE_MISMATCH', 'Reserved ad spend no longer matches the wallet balance.');
    const authorization = (await query<AdBudgetAuthorizationRow>(
      `UPDATE workspace_ad_budget_authorizations
       SET reserved_amount=reserved_amount-$3,consumed_amount=consumed_amount+$3,
           status=CASE WHEN consumed_amount+$3>=authorized_amount THEN 'EXHAUSTED' ELSE status END,
           version=version+1
       WHERE workspace_id=$1 AND id=$2 AND reserved_amount >= $3
       RETURNING ${authorizationSelect}`,
       [input.workspaceId, reservation.authorizationId, remainingAmount.toFixed(2)], client,
    )).rows[0];
    if (!authorization) throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_BALANCE_MISMATCH', 'Reserved campaign authority no longer matches the provider operation.');
    await query(
      `UPDATE workspace_ad_spend_reservations SET status='CONSUMED',settled_amount=amount,metadata=$3::jsonb WHERE id=$1 AND workspace_id=$2`,
      [input.reservationId, input.workspaceId, JSON.stringify(metadata)], client,
    );
    await query(
      `INSERT INTO workspace_ad_spend_ledger(workspace_id,entry_type,amount_delta,balance_after,idempotency_key,metadata)
       VALUES($1,'SPEND',$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
      [input.workspaceId, (-remainingAmount).toFixed(2), wallet.availableAmount,
        `adspend-consume:${reservation.id}`, JSON.stringify(metadata)], client,
    );
    await appendDomainEvent({
      workspaceId: input.workspaceId,
      type: DOMAIN_EVENT_TYPES.AD_BUDGET_CONSUMED,
      aggregateType: 'ad_budget_authorization',
      aggregateId: authorization.id,
      payload: { authorizationId: authorization.id, reservationId: reservation.id, amount: remainingAmount, providerOperationId: input.providerOperationId ?? null },
      metadata: { actorId: null, source: 'adspend' },
      idempotencyKey: `ad-budget:${authorization.id}:reservation:${reservation.id}:consumed`,
    }, client);
    return { id: reservation.id, authorizationId: authorization.id, amount: Number(reservation.amount),
      settledAmount: Number(reservation.amount), consumedAmount: remainingAmount, status: 'CONSUMED' as const, idempotent: false };
  });
}

/** Releases unspent funds when a provider rejects or cannot apply an action. */
export async function releaseAdSpendReservation(input: {
  workspaceId: string;
  reservationId: string;
  reason: string;
  metadata?: Record<string, unknown>;
}) {
  return withTransaction(async (client) => {
    const reservation = (await query<{id:string;authorizationId:string|null;amount:string;settledAmount:string;status:string;metadata:Record<string,unknown>}>(
      `SELECT id,authorization_id AS "authorizationId",amount,settled_amount AS "settledAmount",status,metadata
       FROM workspace_ad_spend_reservations WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
      [input.reservationId, input.workspaceId], client,
    )).rows[0];
    if (!reservation) throw new AppError(404, 'AD_SPEND_RESERVATION_NOT_FOUND', 'Ad spend reservation not found.');
    if (reservation.status === 'RELEASED' || reservation.status === 'EXPIRED' || reservation.status === 'CONSUMED') {
      return { ...reservation, amount: Number(reservation.amount), settledAmount: Number(reservation.settledAmount),
        releasedAmount: Math.max(0, Number(reservation.amount) - Number(reservation.settledAmount)), idempotent: true };
    }
    if (reservation.status !== 'RESERVED') throw new AppError(409, 'AD_SPEND_RESERVATION_CLOSED', `Ad spend reservation is already ${reservation.status.toLowerCase()}.`);
    const metadata = { ...reservation.metadata, ...input.metadata, releaseReason: input.reason.slice(0, 500) };
    const remainingAmount = Math.round((Number(reservation.amount) - Number(reservation.settledAmount)) * 100) / 100;
    if (remainingAmount <= 0) {
      await query(
        `UPDATE workspace_ad_spend_reservations SET status='CONSUMED',settled_amount=amount,metadata=$3::jsonb WHERE id=$1 AND workspace_id=$2`,
        [input.reservationId, input.workspaceId, JSON.stringify(metadata)], client,
      );
      return { id: reservation.id, authorizationId: reservation.authorizationId, amount: Number(reservation.amount),
        settledAmount: Number(reservation.settledAmount), releasedAmount: 0, status: 'CONSUMED' as const, idempotent: false };
    }
    const wallet = (await query<WalletRow>(
      `UPDATE workspace_ad_spend_wallets SET reserved_amount=reserved_amount-$2,
       available_amount=available_amount+GREATEST(0,$2-reversal_debt_amount),
       reversal_debt_amount=GREATEST(0,reversal_debt_amount-$2),version=version+1
       WHERE workspace_id=$1 AND reserved_amount >= $2 RETURNING ${walletSelect}`,
      [input.workspaceId, remainingAmount.toFixed(2)], client,
    )).rows[0];
    if (!wallet) throw new AppError(409, 'AD_SPEND_RESERVATION_BALANCE_MISMATCH', 'Reserved ad spend no longer matches the wallet balance.');
    let authorization: AdBudgetAuthorizationRow | null = null;
    if (reservation.authorizationId) {
      authorization = (await query<AdBudgetAuthorizationRow>(
        `UPDATE workspace_ad_budget_authorizations
         SET reserved_amount=reserved_amount-$3,version=version+1
         WHERE workspace_id=$1 AND id=$2 AND reserved_amount >= $3
         RETURNING ${authorizationSelect}`,
        [input.workspaceId, reservation.authorizationId, remainingAmount.toFixed(2)], client,
      )).rows[0] ?? null;
      if (!authorization) throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_BALANCE_MISMATCH', 'Reserved campaign authority no longer matches the provider operation.');
    }
    await query(
      `UPDATE workspace_ad_spend_reservations SET status='RELEASED',metadata=$3::jsonb WHERE id=$1 AND workspace_id=$2`,
      [input.reservationId, input.workspaceId, JSON.stringify(metadata)], client,
    );
    await query(
      `INSERT INTO workspace_ad_spend_ledger(workspace_id,entry_type,amount_delta,balance_after,idempotency_key,metadata)
       VALUES($1,'RELEASE',$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
      [input.workspaceId, remainingAmount.toFixed(2), wallet.availableAmount,
        `adspend-release:${reservation.id}`, JSON.stringify({ ...metadata, reversalDebtAmount: Number(wallet.reversalDebtAmount) })], client,
    );
    if (authorization) {
      await appendDomainEvent({
        workspaceId: input.workspaceId,
        type: DOMAIN_EVENT_TYPES.AD_BUDGET_RELEASED,
        aggregateType: 'ad_budget_authorization',
        aggregateId: authorization.id,
        payload: { authorizationId: authorization.id, reservationId: reservation.id, amount: remainingAmount, reason: input.reason.slice(0, 500) },
        metadata: { actorId: null, source: 'adspend' },
        idempotencyKey: `ad-budget:${authorization.id}:reservation:${reservation.id}:released`,
      }, client);
    }
    if (Number(wallet.availableAmount) > 0 && Number(wallet.reversalDebtAmount) === 0) {
      await appendDomainEvent({
        workspaceId: input.workspaceId,
        type: DOMAIN_EVENT_TYPES.AD_SPEND_FUNDED,
        aggregateType: 'ad_spend_wallet',
        aggregateId: input.workspaceId,
        payload: {
          reservationId: reservation.id,
          releasedAmount: remainingAmount,
          currency: 'CNY',
          availableAmount: Number(wallet.availableAmount),
        },
        metadata: { actorId: null, source: 'adspend.release' },
        idempotencyKey: `adspend-release:${reservation.id}:funded`,
      }, client);
    }
    return { id: reservation.id, authorizationId: authorization?.id ?? null, amount: Number(reservation.amount),
      settledAmount: Number(reservation.settledAmount), releasedAmount: remainingAmount, status: 'RELEASED' as const, idempotent: false };
  });
}
