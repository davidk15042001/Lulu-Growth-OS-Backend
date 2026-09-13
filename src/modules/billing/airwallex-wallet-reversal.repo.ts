import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/app-error.js';

export type AirwallexWalletType = 'API' | 'AD_SPEND';
export type AirwallexReversalKind = 'REFUND' | 'DISPUTE';

export type AirwallexWalletReversalInput = {
  eventId: string;
  eventType: string;
  reversalKind: AirwallexReversalKind;
  reversalId: string;
  providerStatus: string;
  providerStage?: string | null;
  active: boolean;
  amount: number | string;
  currency: string;
  providerPaymentIntentId?: string | null;
  providerInvoiceId?: string | null;
  workspaceId?: string | null;
  apiTopupId?: string | null;
  adSpendTopupId?: string | null;
  providerUpdatedAt?: string | null;
  eventCreatedAt?: string | null;
  providerPayload?: Record<string, unknown>;
};

type Topup = {
  walletType: AirwallexWalletType;
  id: string;
  workspaceId: string;
  status: string;
  currency: string;
  providerPaymentIntentId: string | null;
  providerInvoiceId: string | null;
  creditedAt: string | Date | null;
  providerTotalAmount: string;
  walletAmount: string;
  feeAmount: string;
};

type ReversalRow = {
  id: string;
  workspaceId: string;
  walletType: AirwallexWalletType;
  apiTopupId: string | null;
  adSpendTopupId: string | null;
  reversalKind: AirwallexReversalKind;
  reversalId: string;
  providerPaymentIntentId: string | null;
  providerInvoiceId: string | null;
  providerStatus: string;
  providerStage: string | null;
  currency: string;
  providerAmount: string;
  walletAmount: string;
  feeAmount: string;
  active: boolean;
  appliedWalletAmount: string;
  appliedFeeAmount: string;
  movementSequence: number;
  providerUpdatedAt: string | Date | null;
  lastEventCreatedAt: string | Date | null;
  lastEventId: string;
  metadata: Record<string, unknown>;
};

type WalletState = {
  availableAmount: string;
  reversalDebtAmount: string;
  totalFundedAmount: string;
};

const reversalSelect = `id,workspace_id AS "workspaceId",wallet_type AS "walletType",
  api_topup_id AS "apiTopupId",ad_spend_topup_id AS "adSpendTopupId",
  provider_reversal_kind AS "reversalKind",provider_reversal_id AS "reversalId",
  provider_payment_intent_id AS "providerPaymentIntentId",provider_invoice_id AS "providerInvoiceId",
  provider_status AS "providerStatus",provider_stage AS "providerStage",currency,
  provider_amount AS "providerAmount",wallet_amount AS "walletAmount",fee_amount AS "feeAmount",
  is_active AS active,applied_wallet_amount AS "appliedWalletAmount",
  applied_fee_amount AS "appliedFeeAmount",movement_sequence AS "movementSequence",
  provider_updated_at AS "providerUpdatedAt",last_event_created_at AS "lastEventCreatedAt",
  last_event_id AS "lastEventId",metadata`;

function reversalError(code: string, message: string, details?: Record<string, unknown>) {
  return new AppError(409, code, message, details);
}

function optionalId(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function toMinor(value: number | string, field: string) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw reversalError('AIRWALLEX_REVERSAL_AMOUNT_INVALID', `Airwallex ${field} must be a positive CNY amount.`);
  }
  const minor = Math.round(numeric * 100);
  if (!Number.isSafeInteger(minor) || Math.abs(numeric * 100 - minor) > 0.000001) {
    throw reversalError('AIRWALLEX_REVERSAL_AMOUNT_INVALID', `Airwallex ${field} has unsupported precision.`);
  }
  return minor;
}

function minorText(minor: number) {
  return (minor / 100).toFixed(2);
}

function timestampIso(value: string | null | undefined, field: string) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw reversalError('AIRWALLEX_REVERSAL_TIMESTAMP_INVALID', `Airwallex ${field} is invalid.`);
  }
  return parsed.toISOString();
}

function timestampMs(value: string | Date | null) {
  if (!value) return null;
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(milliseconds) ? null : milliseconds;
}

function topupSelect(walletType: AirwallexWalletType) {
  return walletType === 'API'
    ? `SELECT 'API'::text AS "walletType",id,workspace_id AS "workspaceId",status,currency,
         provider_payment_intent_id AS "providerPaymentIntentId",provider_invoice_id AS "providerInvoiceId",
         credited_at AS "creditedAt",amount AS "providerTotalAmount",amount AS "walletAmount",
         0::numeric AS "feeAmount"
       FROM workspace_api_topups`
    : `SELECT 'AD_SPEND'::text AS "walletType",id,workspace_id AS "workspaceId",status,currency,
         provider_payment_intent_id AS "providerPaymentIntentId",provider_invoice_id AS "providerInvoiceId",
         credited_at AS "creditedAt",total_amount AS "providerTotalAmount",net_amount AS "walletAmount",
         fee_amount AS "feeAmount"
       FROM workspace_ad_spend_topups`;
}

async function findById(walletType: AirwallexWalletType, id: string, client: PoolClient) {
  return (await query<Topup>(`${topupSelect(walletType)} WHERE id::text=$1 FOR UPDATE`, [id], client)).rows[0] ?? null;
}

async function findByProviderReferences(input: {
  providerPaymentIntentId: string | null;
  providerInvoiceId: string | null;
}, client: PoolClient) {
  if (!input.providerPaymentIntentId && !input.providerInvoiceId) return [];
  const params = [input.providerPaymentIntentId, input.providerInvoiceId];
  const predicate = `WHERE ($1::text IS NOT NULL AND provider_payment_intent_id=$1)
    OR ($2::text IS NOT NULL AND provider_invoice_id=$2) FOR UPDATE`;
  const [api, adSpend] = await Promise.all([
    query<Topup>(`${topupSelect('API')} ${predicate}`, params, client),
    query<Topup>(`${topupSelect('AD_SPEND')} ${predicate}`, params, client),
  ]);
  return [...api.rows, ...adSpend.rows];
}

async function correlateTopup(input: AirwallexWalletReversalInput, client: PoolClient) {
  const apiTopupId = optionalId(input.apiTopupId);
  const adSpendTopupId = optionalId(input.adSpendTopupId);
  const providerPaymentIntentId = optionalId(input.providerPaymentIntentId);
  const providerInvoiceId = optionalId(input.providerInvoiceId);
  if (apiTopupId && adSpendTopupId) {
    throw reversalError('AIRWALLEX_REVERSAL_CORRELATION_AMBIGUOUS', 'A reversal cannot reference both an AI and advertising top-up.');
  }

  const referenced = await findByProviderReferences({ providerPaymentIntentId, providerInvoiceId }, client);
  let topup: Topup | null = null;
  if (apiTopupId) topup = await findById('API', apiTopupId, client);
  else if (adSpendTopupId) topup = await findById('AD_SPEND', adSpendTopupId, client);
  else if (referenced.length === 1) topup = referenced[0]!;
  else if (referenced.length > 1) {
    throw reversalError('AIRWALLEX_REVERSAL_CORRELATION_AMBIGUOUS', 'Airwallex reversal references resolve to more than one Lulu top-up.', {
      providerPaymentIntentId, providerInvoiceId,
    });
  }

  if (!topup) {
    throw reversalError('AIRWALLEX_WALLET_TOPUP_NOT_FOUND', 'No Lulu wallet top-up matches this Airwallex reversal.', {
      apiTopupId, adSpendTopupId, providerPaymentIntentId, providerInvoiceId,
    });
  }
  if (referenced.some((candidate) => candidate.walletType !== topup!.walletType || candidate.id !== topup!.id)) {
    throw reversalError('AIRWALLEX_REVERSAL_CORRELATION_CONFLICT', 'Airwallex reversal metadata conflicts with its provider payment references.');
  }
  if (input.workspaceId && input.workspaceId !== topup.workspaceId) {
    throw reversalError('AIRWALLEX_REVERSAL_WORKSPACE_MISMATCH', 'Airwallex reversal workspace metadata does not match the correlated top-up.');
  }
  if (providerPaymentIntentId && topup.providerPaymentIntentId && providerPaymentIntentId !== topup.providerPaymentIntentId) {
    throw reversalError('AIRWALLEX_REVERSAL_PAYMENT_INTENT_MISMATCH', 'Airwallex reversal PaymentIntent does not match the correlated top-up.');
  }
  if (providerInvoiceId && topup.providerInvoiceId && providerInvoiceId !== topup.providerInvoiceId) {
    throw reversalError('AIRWALLEX_REVERSAL_INVOICE_MISMATCH', 'Airwallex reversal invoice does not match the correlated top-up.');
  }

  const table = topup.walletType === 'API' ? 'workspace_api_topups' : 'workspace_ad_spend_topups';
  await query(
    `UPDATE ${table} SET
       provider_payment_intent_id=COALESCE(provider_payment_intent_id,$2),
       provider_invoice_id=COALESCE(provider_invoice_id,$3)
     WHERE id=$1`,
    [topup.id, providerPaymentIntentId, providerInvoiceId], client,
  );
  return { ...topup, providerPaymentIntentId: topup.providerPaymentIntentId ?? providerPaymentIntentId,
    providerInvoiceId: topup.providerInvoiceId ?? providerInvoiceId };
}

function allocation(input: { amountMinor: number; providerTotalMinor: number; walletTotalMinor: number;
  feeTotalMinor: number; otherProviderMinor: number; otherWalletMinor: number; otherFeeMinor: number }) {
  const remainingProvider = input.providerTotalMinor - input.otherProviderMinor;
  const remainingWallet = input.walletTotalMinor - input.otherWalletMinor;
  const remainingFee = input.feeTotalMinor - input.otherFeeMinor;
  if (input.amountMinor > remainingProvider || remainingProvider < 0 || remainingWallet < 0 || remainingFee < 0) {
    throw reversalError('AIRWALLEX_REVERSAL_AMOUNT_EXCEEDS_TOPUP', 'Cumulative Airwallex reversals exceed the original top-up.');
  }
  if (input.amountMinor === remainingProvider) return { walletMinor: remainingWallet, feeMinor: remainingFee };
  let walletMinor = Number((BigInt(input.amountMinor) * BigInt(input.walletTotalMinor)
    + BigInt(Math.floor(input.providerTotalMinor / 2))) / BigInt(input.providerTotalMinor));
  walletMinor = Math.min(remainingWallet, Math.max(0, walletMinor));
  let feeMinor = input.amountMinor - walletMinor;
  if (feeMinor > remainingFee) {
    feeMinor = remainingFee;
    walletMinor = input.amountMinor - feeMinor;
  }
  if (walletMinor > remainingWallet || feeMinor < 0) {
    throw reversalError('AIRWALLEX_REVERSAL_ALLOCATION_INVALID', 'Airwallex reversal cannot be allocated to wallet balance and service fee.');
  }
  return { walletMinor, feeMinor };
}

async function ensureWallet(topup: Topup, client: PoolClient) {
  if (topup.walletType === 'API') {
    await query(`INSERT INTO workspace_api_wallets(workspace_id) VALUES($1) ON CONFLICT DO NOTHING`, [topup.workspaceId], client);
  } else {
    await query(`INSERT INTO workspace_ad_spend_wallets(workspace_id) VALUES($1) ON CONFLICT DO NOTHING`, [topup.workspaceId], client);
  }
}

async function settleReversal(row: ReversalRow, topup: Topup, client: PoolClient) {
  if (!topup.creditedAt) return row;
  const desiredWalletMinor = row.active ? toMinor(row.walletAmount, 'wallet allocation') : 0;
  const desiredFeeMinor = row.active && Number(row.feeAmount) > 0 ? toMinor(row.feeAmount, 'fee allocation') : 0;
  const appliedWalletMinor = Number(row.appliedWalletAmount) > 0 ? toMinor(row.appliedWalletAmount, 'applied wallet allocation') : 0;
  const appliedFeeMinor = Number(row.appliedFeeAmount) > 0 ? toMinor(row.appliedFeeAmount, 'applied fee allocation') : 0;
  const walletDeltaMinor = desiredWalletMinor - appliedWalletMinor;
  const feeDeltaMinor = desiredFeeMinor - appliedFeeMinor;
  if (walletDeltaMinor === 0 && feeDeltaMinor === 0) return row;
  if ((walletDeltaMinor > 0 && feeDeltaMinor < 0) || (walletDeltaMinor < 0 && feeDeltaMinor > 0)) {
    throw reversalError('AIRWALLEX_REVERSAL_MOVEMENT_INVALID', 'Airwallex reversal produced a mixed debit and release movement.');
  }

  await ensureWallet(topup, client);
  const isDebit = walletDeltaMinor > 0 || feeDeltaMinor > 0;
  const walletMovement = Math.abs(walletDeltaMinor);
  const feeMovement = Math.abs(feeDeltaMinor);
  let wallet: WalletState | null = null;
  if (topup.walletType === 'API') {
    wallet = (await query<WalletState>(
      isDebit
        ? `UPDATE workspace_api_wallets SET
             available_amount=GREATEST(0,available_amount-$2),
             reversal_debt_amount=reversal_debt_amount+GREATEST(0,$2-available_amount),
             total_funded_amount=GREATEST(0,total_funded_amount-$2),version=version+1
           WHERE workspace_id=$1 RETURNING available_amount AS "availableAmount",
             reversal_debt_amount AS "reversalDebtAmount",total_funded_amount AS "totalFundedAmount"`
        : `UPDATE workspace_api_wallets SET
             available_amount=available_amount+GREATEST(0,$2-reversal_debt_amount),
             reversal_debt_amount=GREATEST(0,reversal_debt_amount-$2),
             total_funded_amount=total_funded_amount+$2,version=version+1
           WHERE workspace_id=$1 RETURNING available_amount AS "availableAmount",
             reversal_debt_amount AS "reversalDebtAmount",total_funded_amount AS "totalFundedAmount"`,
      [topup.workspaceId, minorText(walletMovement)], client,
    )).rows[0] ?? null;
  } else {
    wallet = (await query<WalletState>(
      isDebit
        ? `UPDATE workspace_ad_spend_wallets SET
             available_amount=GREATEST(0,available_amount-$2),
             reversal_debt_amount=reversal_debt_amount+GREATEST(0,$2-available_amount),
             refunded_amount=refunded_amount+$2,
             total_funded_amount=GREATEST(0,total_funded_amount-$2),
             total_fee_amount=GREATEST(0,total_fee_amount-$3),version=version+1
           WHERE workspace_id=$1 RETURNING available_amount AS "availableAmount",
             reversal_debt_amount AS "reversalDebtAmount",total_funded_amount AS "totalFundedAmount"`
        : `UPDATE workspace_ad_spend_wallets SET
             available_amount=available_amount+GREATEST(0,$2-reversal_debt_amount),
             reversal_debt_amount=GREATEST(0,reversal_debt_amount-$2),
             refunded_amount=GREATEST(0,refunded_amount-$2),
             total_funded_amount=total_funded_amount+$2,
             total_fee_amount=total_fee_amount+$3,version=version+1
           WHERE workspace_id=$1 RETURNING available_amount AS "availableAmount",
             reversal_debt_amount AS "reversalDebtAmount",total_funded_amount AS "totalFundedAmount"`,
      [topup.workspaceId, minorText(walletMovement), minorText(feeMovement)], client,
    )).rows[0] ?? null;
  }
  if (!wallet) throw new Error('Airwallex wallet reversal could not update its wallet.');

  const nextSequence = row.movementSequence + 1;
  if (walletMovement > 0) {
    const ledgerTable = topup.walletType === 'API' ? 'workspace_api_wallet_ledger' : 'workspace_ad_spend_ledger';
    const keyPrefix = topup.walletType === 'API' ? 'api' : 'adspend';
    const amountDelta = `${isDebit ? '-' : ''}${minorText(walletMovement)}`;
    await query(
      `INSERT INTO ${ledgerTable}(workspace_id,topup_id,entry_type,amount_delta,balance_after,idempotency_key,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [topup.workspaceId, topup.id, isDebit ? 'REFUND' : 'ADJUSTMENT', amountDelta, wallet.availableAmount,
        `${keyPrefix}:airwallex-reversal:${row.id}:${nextSequence}`, JSON.stringify({
          provider: 'airwallex', reversalKind: row.reversalKind, providerReversalId: row.reversalId,
          providerStatus: row.providerStatus, providerStage: row.providerStage,
          providerAmount: Number(row.providerAmount), walletAmount: Number(row.walletAmount),
          feeAmount: Number(row.feeAmount), feeMovement: feeMovement / 100,
          eventId: row.lastEventId, reversalDebtAmount: Number(wallet.reversalDebtAmount),
        })], client,
    );
  }
  const updated = (await query<ReversalRow>(
    `UPDATE airwallex_wallet_reversals SET applied_wallet_amount=$2,applied_fee_amount=$3,
       movement_sequence=$4 WHERE id=$1 RETURNING ${reversalSelect}`,
    [row.id, minorText(desiredWalletMinor), minorText(desiredFeeMinor), nextSequence], client,
  )).rows[0];
  if (!updated) throw new Error('Airwallex reversal journal update failed.');
  return updated;
}

async function updateTopupAggregateStatus(topup: Topup, client: PoolClient) {
  const foreignKey = topup.walletType === 'API' ? 'api_topup_id' : 'ad_spend_topup_id';
  const aggregate = (await query<{ activeAmount: string; hasDispute: boolean }>(
    `SELECT COALESCE(SUM(provider_amount) FILTER (WHERE is_active),0) AS "activeAmount",
       COALESCE(BOOL_OR(provider_reversal_kind='DISPUTE') FILTER (WHERE is_active),FALSE) AS "hasDispute"
     FROM airwallex_wallet_reversals WHERE ${foreignKey}=$1`, [topup.id], client,
  )).rows[0]!;
  const activeMinor = Number(aggregate.activeAmount) > 0 ? toMinor(aggregate.activeAmount, 'aggregate reversal') : 0;
  const totalMinor = toMinor(topup.providerTotalAmount, 'top-up total');
  const table = topup.walletType === 'API' ? 'workspace_api_topups' : 'workspace_ad_spend_topups';
  const status = activeMinor >= totalMinor
    ? (aggregate.hasDispute ? 'CHARGEBACK' : 'REFUNDED')
    : topup.creditedAt
      ? 'SUCCEEDED'
      : ['REFUNDED','CHARGEBACK'].includes(topup.status)
        ? 'PENDING_PAYMENT'
        : topup.status;
  await query(`UPDATE ${table} SET status=$2 WHERE id=$1`, [topup.id, status], client);
  return status;
}

async function walletState(topup: Topup, client: PoolClient) {
  const table = topup.walletType === 'API' ? 'workspace_api_wallets' : 'workspace_ad_spend_wallets';
  return (await query<WalletState>(
    `SELECT available_amount AS "availableAmount",reversal_debt_amount AS "reversalDebtAmount",
       total_funded_amount AS "totalFundedAmount" FROM ${table} WHERE workspace_id=$1`,
    [topup.workspaceId], client,
  )).rows[0] ?? null;
}

export async function applyPendingAirwallexWalletReversals(input: {
  walletType: AirwallexWalletType;
  topupId: string;
  client: PoolClient;
}) {
  const topup = await findById(input.walletType, input.topupId, input.client);
  if (!topup) throw new Error('Airwallex reversal top-up no longer exists.');
  const foreignKey = input.walletType === 'API' ? 'api_topup_id' : 'ad_spend_topup_id';
  const pending = await query<ReversalRow>(
    `SELECT ${reversalSelect} FROM airwallex_wallet_reversals
     WHERE ${foreignKey}=$1 AND is_active=TRUE
       AND (applied_wallet_amount<>wallet_amount OR applied_fee_amount<>fee_amount)
     ORDER BY created_at,id FOR UPDATE`, [input.topupId], input.client,
  );
  for (const reversal of pending.rows) await settleReversal(reversal, topup, input.client);
  const status = await updateTopupAggregateStatus(topup, input.client);
  return { status, wallet: await walletState(topup, input.client), applied: pending.rowCount };
}

export async function recordAirwallexWalletReversal(input: AirwallexWalletReversalInput) {
  const reversalId = optionalId(input.reversalId);
  const eventId = optionalId(input.eventId);
  if (!reversalId || !eventId) {
    throw reversalError('AIRWALLEX_REVERSAL_ID_MISSING', 'Airwallex terminal reversal is missing its resource or event ID.');
  }
  const currency = input.currency.trim().toUpperCase();
  if (currency !== 'CNY') {
    throw reversalError('AIRWALLEX_REVERSAL_CURRENCY_MISMATCH', 'Airwallex reversal currency does not match Lulu wallet currency.', { currency });
  }
  const providerStatus = input.providerStatus.trim().toUpperCase();
  const providerStage = optionalId(input.providerStage)?.toUpperCase() ?? null;
  const providerUpdatedAt = timestampIso(input.providerUpdatedAt, 'resource updated_at');
  const eventCreatedAt = timestampIso(input.eventCreatedAt, 'event created_at');
  const amountMinor = toMinor(input.amount, 'amount');

  return withTransaction(async (client) => {
    await query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`airwallex-reversal:${input.reversalKind}:${reversalId}`], client);
    const topup = await correlateTopup(input, client);
    const providerTotalMinor = toMinor(topup.providerTotalAmount, 'top-up total');
    const walletTotalMinor = toMinor(topup.walletAmount, 'top-up wallet amount');
    const feeTotalMinor = Number(topup.feeAmount) > 0 ? toMinor(topup.feeAmount, 'top-up fee') : 0;
    if (amountMinor > providerTotalMinor) {
      throw reversalError('AIRWALLEX_REVERSAL_AMOUNT_EXCEEDS_TOPUP', 'Airwallex reversal amount exceeds the original top-up.', {
        reversalAmount: minorText(amountMinor), topupAmount: minorText(providerTotalMinor),
      });
    }

    let existing = (await query<ReversalRow>(
      `SELECT ${reversalSelect} FROM airwallex_wallet_reversals
       WHERE provider='airwallex' AND provider_reversal_kind=$1 AND provider_reversal_id=$2 FOR UPDATE`,
      [input.reversalKind, reversalId], client,
    )).rows[0] ?? null;
    let adoptedLegacy = false;
    if (!existing) {
      const foreignKey = topup.walletType === 'API' ? 'api_topup_id' : 'ad_spend_topup_id';
      existing = (await query<ReversalRow>(
        `SELECT ${reversalSelect} FROM airwallex_wallet_reversals
         WHERE ${foreignKey}=$1 AND provider_reversal_kind=$2 AND provider_reversal_id LIKE 'legacy:%'
         ORDER BY created_at LIMIT 1 FOR UPDATE`, [topup.id, input.reversalKind], client,
      )).rows[0] ?? null;
      adoptedLegacy = Boolean(existing);
    }
    if (existing && (existing.walletType !== topup.walletType
      || (topup.walletType === 'API' ? existing.apiTopupId : existing.adSpendTopupId) !== topup.id)) {
      throw reversalError('AIRWALLEX_REVERSAL_CORRELATION_CONFLICT', 'This Airwallex reversal ID is already linked to another Lulu top-up.');
    }
    if (existing?.providerPaymentIntentId && topup.providerPaymentIntentId
      && existing.providerPaymentIntentId !== topup.providerPaymentIntentId) {
      throw reversalError('AIRWALLEX_REVERSAL_CORRELATION_CONFLICT', 'Stored Airwallex reversal PaymentIntent no longer matches its top-up.');
    }
    if (existing?.providerInvoiceId && topup.providerInvoiceId && existing.providerInvoiceId !== topup.providerInvoiceId) {
      throw reversalError('AIRWALLEX_REVERSAL_CORRELATION_CONFLICT', 'Stored Airwallex reversal invoice no longer matches its top-up.');
    }
    if (existing && !adoptedLegacy && toMinor(existing.providerAmount, 'stored amount') !== amountMinor) {
      throw reversalError('AIRWALLEX_REVERSAL_AMOUNT_CONFLICT', 'Airwallex reported different amounts for the same reversal resource.');
    }

    if (existing && !adoptedLegacy) {
      const incomingCursor = providerUpdatedAt ? Date.parse(providerUpdatedAt) : eventCreatedAt ? Date.parse(eventCreatedAt) : null;
      const storedCursor = timestampMs(existing.providerUpdatedAt) ?? timestampMs(existing.lastEventCreatedAt);
      if (storedCursor !== null && incomingCursor !== null && incomingCursor < storedCursor) {
        return { processed: true, stale: true, idempotent: true, walletType: topup.walletType,
          topupId: topup.id, reversalId, status: existing.providerStatus };
      }
      if (storedCursor !== null && incomingCursor === null
        && (existing.active !== input.active || existing.providerStatus !== providerStatus)) {
        throw reversalError('AIRWALLEX_REVERSAL_ORDER_AMBIGUOUS', 'Airwallex reversal changed without an ordering timestamp.');
      }
      if (storedCursor !== null && incomingCursor === storedCursor
        && (existing.active !== input.active || existing.providerStatus !== providerStatus)) {
        throw reversalError('AIRWALLEX_REVERSAL_ORDER_AMBIGUOUS', 'Conflicting Airwallex reversal states have the same ordering timestamp.');
      }
    }

    const foreignKey = topup.walletType === 'API' ? 'api_topup_id' : 'ad_spend_topup_id';
    const other = (await query<{ providerAmount: string; walletAmount: string; feeAmount: string }>(
      `SELECT COALESCE(SUM(provider_amount),0) AS "providerAmount",
         COALESCE(SUM(wallet_amount),0) AS "walletAmount",COALESCE(SUM(fee_amount),0) AS "feeAmount"
       FROM airwallex_wallet_reversals WHERE ${foreignKey}=$1 AND is_active=TRUE
         AND ($2::uuid IS NULL OR id<>$2)`, [topup.id, existing?.id ?? null], client,
    )).rows[0]!;
    const otherProviderMinor = Number(other.providerAmount) > 0 ? toMinor(other.providerAmount, 'existing reversal total') : 0;
    const otherWalletMinor = Number(other.walletAmount) > 0 ? toMinor(other.walletAmount, 'existing wallet reversal total') : 0;
    const otherFeeMinor = Number(other.feeAmount) > 0 ? toMinor(other.feeAmount, 'existing fee reversal total') : 0;
    const desiredAllocation = input.active
      ? allocation({ amountMinor, providerTotalMinor, walletTotalMinor, feeTotalMinor,
          otherProviderMinor, otherWalletMinor, otherFeeMinor })
      : allocation({ amountMinor, providerTotalMinor, walletTotalMinor, feeTotalMinor,
          otherProviderMinor: 0, otherWalletMinor: 0, otherFeeMinor: 0 });
    const metadata = { ...(existing?.metadata ?? {}), ...(input.providerPayload ?? {}),
      lastEventType: input.eventType };

    if (!existing) {
      existing = (await query<ReversalRow>(
        `INSERT INTO airwallex_wallet_reversals(
           workspace_id,wallet_type,api_topup_id,ad_spend_topup_id,provider_reversal_kind,
           provider_reversal_id,provider_payment_intent_id,provider_invoice_id,provider_status,
           provider_stage,currency,provider_amount,wallet_amount,fee_amount,is_active,
           provider_updated_at,last_event_created_at,last_event_id,metadata
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CNY',$11,$12,$13,$14,$15,$16,$17,$18::jsonb)
         RETURNING ${reversalSelect}`,
        [topup.workspaceId, topup.walletType, topup.walletType === 'API' ? topup.id : null,
          topup.walletType === 'AD_SPEND' ? topup.id : null, input.reversalKind, reversalId,
          topup.providerPaymentIntentId, topup.providerInvoiceId, providerStatus, providerStage,
          minorText(amountMinor), minorText(desiredAllocation.walletMinor), minorText(desiredAllocation.feeMinor),
          input.active, providerUpdatedAt, eventCreatedAt, eventId, JSON.stringify(metadata)], client,
      )).rows[0] ?? null;
    } else {
      existing = (await query<ReversalRow>(
        `UPDATE airwallex_wallet_reversals SET provider_reversal_id=$2,
           provider_payment_intent_id=COALESCE(provider_payment_intent_id,$3),
           provider_invoice_id=COALESCE(provider_invoice_id,$4),provider_status=$5,
           provider_stage=$6,provider_amount=$7,wallet_amount=$8,fee_amount=$9,is_active=$10,
           provider_updated_at=COALESCE($11::timestamptz,provider_updated_at),
           last_event_created_at=COALESCE($12::timestamptz,last_event_created_at),
           last_event_id=$13,metadata=$14::jsonb WHERE id=$1 RETURNING ${reversalSelect}`,
        [existing.id, reversalId, topup.providerPaymentIntentId, topup.providerInvoiceId,
          providerStatus, providerStage, minorText(amountMinor), minorText(desiredAllocation.walletMinor),
          minorText(desiredAllocation.feeMinor), input.active, providerUpdatedAt, eventCreatedAt,
          eventId, JSON.stringify(metadata)], client,
      )).rows[0] ?? null;
    }
    if (!existing) throw new Error('Airwallex reversal journal insert failed.');
    const settled = await settleReversal(existing, topup, client);
    const status = await updateTopupAggregateStatus(topup, client);
    return { processed: true, stale: false,
      idempotent: settled.movementSequence === existing.movementSequence,
      walletType: topup.walletType, topupId: topup.id, reversalId, status,
      providerAmount: amountMinor / 100, walletAmount: Number(settled.walletAmount),
      feeAmount: Number(settled.feeAmount), active: settled.active };
  });
}
