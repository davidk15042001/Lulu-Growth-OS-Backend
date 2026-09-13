import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { AppError } from '../../utils/app-error.js';
import { resolveAiFundingMode, type AiFundingDecision } from './ai-funding-policy.js';

export type AiSpendReservationStatus = 'RESERVED' | 'SUBMITTING' | 'SUBMITTED' | 'AMBIGUOUS' | 'SETTLED' | 'RELEASED';
export type AiSpendReleaseDisposition = 'BEFORE_SUBMISSION' | 'DEFINITIVE_REJECTION';

type ReservationRow = {
  id: string;
  workspaceId: string;
  requestKey: string;
  requestFingerprint: string;
  operation: string;
  status: AiSpendReservationStatus;
  reservedAmount: string;
  settledAmount: string | null;
  maximumCustomerCostUsd: string;
  actualCustomerCostUsd: string | null;
  usdCnyRate: string;
  pricingSnapshot: Record<string, unknown>;
  provider: string | null;
  model: string | null;
  providerRequestId: string | null;
  usageLedgerId: string | null;
  ambiguityReason: string | null;
  submittedAt: string | null;
  settledAt: string | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const reservationSelect = `
  id,workspace_id AS "workspaceId",request_key AS "requestKey",
  request_fingerprint AS "requestFingerprint",operation,status,
  reserved_amount AS "reservedAmount",settled_amount AS "settledAmount",
  maximum_customer_cost_usd AS "maximumCustomerCostUsd",
  actual_customer_cost_usd AS "actualCustomerCostUsd",usd_cny_rate AS "usdCnyRate",
  pricing_snapshot AS "pricingSnapshot",provider,model,
  provider_request_id AS "providerRequestId",usage_ledger_id AS "usageLedgerId",
  ambiguity_reason AS "ambiguityReason",submitted_at AS "submittedAt",
  settled_at AS "settledAt",released_at AS "releasedAt",
  created_at AS "createdAt",updated_at AS "updatedAt"`;

function fixed(value: number, scale: number, mode: 'ceil' | 'round' = 'round') {
  if (!Number.isFinite(value) || value < 0) throw new AppError(422, 'AI_RESERVATION_AMOUNT_INVALID', 'AI reservation amounts must be finite and non-negative.');
  if (value >= 1_000_000_000) throw new AppError(422, 'AI_RESERVATION_AMOUNT_INVALID', 'AI reservation amount exceeds the supported range.');
  const [whole, fraction = ''] = value.toFixed(scale + 8).split('.');
  const kept = fraction.slice(0, scale).padEnd(scale, '0');
  const discarded = fraction.slice(scale);
  let units = BigInt(`${whole}${kept}`);
  if (mode === 'ceil' ? /[1-9]/.test(discarded) : Number(discarded[0] ?? '0') >= 5) units += 1n;
  return unitsToFixed(units, scale);
}

function fixedToUnits(value: string, scale: number) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new AppError(500, 'AI_RESERVATION_MONEY_INVALID', 'Stored AI wallet money is invalid.');
  const fraction = match[2] ?? '';
  if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) {
    throw new AppError(500, 'AI_RESERVATION_MONEY_PRECISION', 'Stored AI wallet money exceeds its supported precision.');
  }
  return BigInt(`${match[1]}${fraction.slice(0, scale).padEnd(scale, '0')}`);
}

function unitsToFixed(units: bigint, scale: number) {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const rendered = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative ? `-${rendered}` : rendered;
}

function multiplyFixed(
  left: string,
  leftScale: number,
  right: string,
  rightScale: number,
  outputScale: number,
  mode: 'ceil' | 'round',
) {
  const product = fixedToUnits(left, leftScale) * fixedToUnits(right, rightScale);
  const scaleDifference = leftScale + rightScale - outputScale;
  if (scaleDifference <= 0) return unitsToFixed(product * (10n ** BigInt(-scaleDifference)), outputScale);
  const divisor = 10n ** BigInt(scaleDifference);
  const rounded = mode === 'ceil'
    ? (product + divisor - 1n) / divisor
    : (product + (divisor / 2n)) / divisor;
  return unitsToFixed(rounded, outputScale);
}

function publicReservation(row: ReservationRow) {
  return {
    ...row,
    reservedAmount: Number(row.reservedAmount),
    settledAmount: row.settledAmount === null ? null : Number(row.settledAmount),
    maximumCustomerCostUsd: Number(row.maximumCustomerCostUsd),
    actualCustomerCostUsd: row.actualCustomerCostUsd === null ? null : Number(row.actualCustomerCostUsd),
    usdCnyRate: Number(row.usdCnyRate),
  };
}

async function lockWallet(workspaceId: string, client: PoolClient) {
  await query(`SELECT pg_advisory_xact_lock(hashtext('ai-wallet'),hashtext($1))`, [workspaceId], client);
  await query(`INSERT INTO workspace_api_wallets(workspace_id) VALUES($1) ON CONFLICT DO NOTHING`, [workspaceId], client);
  const wallet = (await query<{
    availableAmount: string;
    reservedAmount: string;
    reversalDebtAmount: string;
  }>(
    `SELECT available_amount AS "availableAmount",reserved_amount AS "reservedAmount",
            reversal_debt_amount AS "reversalDebtAmount"
       FROM workspace_api_wallets WHERE workspace_id=$1 FOR UPDATE`,
    [workspaceId],
    client,
  )).rows[0];
  if (!wallet) throw new Error('AI wallet could not be locked');
  return wallet;
}

export function fingerprintAiRequest(value: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function reserveAiSpend(input: {
  workspaceId: string;
  userId?: string | null;
  requestKey: string;
  requestFingerprint: string;
  operation: string;
  maximumCustomerCostUsd: number;
  usdCnyRate: number;
  pricingSnapshot: Record<string, unknown>;
  provider?: string | null;
  model?: string | null;
}): Promise<
  | { funding: Extract<AiFundingDecision, { mode: 'PLATFORM_FUNDED' }>; reservation: null; idempotent: false }
  | { funding: Extract<AiFundingDecision, { mode: 'CUSTOMER_PREPAID' }>; reservation: ReturnType<typeof publicReservation>; idempotent: boolean }
> {
  const funding = await resolveAiFundingMode(input.workspaceId, input.userId);
  if (funding.mode === 'PLATFORM_FUNDED') return { funding, reservation: null, idempotent: false };
  if (!input.requestKey.trim() || input.requestKey.length > 240) throw new AppError(422, 'AI_RESERVATION_KEY_INVALID', 'AI requests require a valid operation idempotency key.');
  if (!/^[0-9a-f]{64}$/.test(input.requestFingerprint)) throw new AppError(422, 'AI_RESERVATION_FINGERPRINT_INVALID', 'AI request fingerprint is invalid.');

  const maximumUsd = fixed(input.maximumCustomerCostUsd, 8, 'ceil');
  const rate = fixed(input.usdCnyRate, 8, 'round');
  const hold = multiplyFixed(maximumUsd, 8, rate, 8, 6, 'ceil');
  if (fixedToUnits(hold, 6) <= 0n) throw new AppError(422, 'AI_RESERVATION_AMOUNT_INVALID', 'AI request maximum charge must be greater than zero.');

  return withTransaction(async (client) => {
    const lockedWallet = await lockWallet(input.workspaceId, client);
    const prior = (await query<ReservationRow>(
      `SELECT ${reservationSelect} FROM ai_spend_reservations
        WHERE workspace_id=$1 AND request_key=$2 FOR UPDATE`,
      [input.workspaceId, input.requestKey],
      client,
    )).rows[0];
    if (prior) {
      if (prior.requestFingerprint !== input.requestFingerprint) {
        throw new AppError(409, 'AI_RESERVATION_KEY_REUSED', 'The AI operation key was already used for a different request.');
      }
      return { funding, reservation: publicReservation(prior), idempotent: true };
    }

    const wallet = (await query<{ availableAmount: string; reservedAmount: string; reversalDebtAmount: string }>(
      `UPDATE workspace_api_wallets
          SET available_amount=available_amount-$2,
              reserved_amount=reserved_amount+$2,
              version=version+1
        WHERE workspace_id=$1
          AND reversal_debt_amount=0
          AND available_amount >= $2
      RETURNING available_amount AS "availableAmount",reserved_amount AS "reservedAmount",
                reversal_debt_amount AS "reversalDebtAmount"`,
      [input.workspaceId, hold],
      client,
    )).rows[0];
    if (!wallet) {
      const state = lockedWallet;
      if (fixedToUnits(state.reversalDebtAmount, 6) > 0n) {
        throw new AppError(409, 'AI_REVERSAL_DEBT', 'AI execution is paused until the outstanding refund or chargeback balance is covered.');
      }
      throw new AppError(402, 'AI_FUNDS_REQUIRED', 'The AI wallet does not have enough spendable balance for this request.', {
        requiredAmount: Number(hold),
        availableAmount: Number(state.availableAmount),
      });
    }

    const reservation = (await query<ReservationRow>(
      `INSERT INTO ai_spend_reservations(
         workspace_id,request_key,request_fingerprint,operation,reserved_amount,
         maximum_customer_cost_usd,usd_cny_rate,pricing_snapshot,provider,model,actor_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
       RETURNING ${reservationSelect}`,
      [input.workspaceId, input.requestKey, input.requestFingerprint, input.operation, hold,
        maximumUsd, rate, JSON.stringify(input.pricingSnapshot), input.provider ?? null,
        input.model ?? null, input.userId ?? null],
      client,
    )).rows[0]!;
    await query(
      `INSERT INTO workspace_api_wallet_ledger(
         workspace_id,reservation_id,entry_type,amount_delta,balance_after,idempotency_key,metadata
       ) VALUES($1,$2,'USAGE_RESERVE',$3,$4,$5,$6::jsonb)`,
      [input.workspaceId, reservation.id, unitsToFixed(-fixedToUnits(hold, 6), 6), wallet.availableAmount,
        `ai-reservation:${reservation.id}:reserve`, JSON.stringify({ operation: input.operation, maximumCustomerCostUsd: Number(maximumUsd), usdCnyRate: Number(rate) })],
      client,
    );
    return { funding, reservation: publicReservation(reservation), idempotent: false };
  });
}

export async function markAiSpendSubmitting(workspaceId: string, reservationId: string) {
  const row = (await query<ReservationRow>(
    `UPDATE ai_spend_reservations SET status='SUBMITTING'
      WHERE workspace_id=$1 AND id=$2 AND status='RESERVED'
      RETURNING ${reservationSelect}`,
    [workspaceId, reservationId],
  )).rows[0];
  return row ? publicReservation(row) : null;
}

export async function markAiSpendSubmitted(input: {
  workspaceId: string;
  reservationId: string;
  provider: string;
  model: string;
  providerRequestId: string;
}) {
  const row = (await query<ReservationRow>(
      `UPDATE ai_spend_reservations
        SET status='SUBMITTED',provider=$3,model=$4,provider_request_id=$5,
            submitted_at=COALESCE(submitted_at,NOW()),ambiguity_reason=NULL
      WHERE workspace_id=$1 AND id=$2
        AND (provider IS NULL OR provider=$3)
        AND (model IS NULL OR model=$4)
        AND (provider_request_id IS NULL OR provider_request_id=$5)
        AND (status='SUBMITTING' OR (status='SUBMITTED' AND provider_request_id=$5))
      RETURNING ${reservationSelect}`,
    [input.workspaceId, input.reservationId, input.provider, input.model, input.providerRequestId],
  )).rows[0];
  return row ? publicReservation(row) : null;
}

export async function markAiSpendAmbiguous(workspaceId: string, reservationId: string, reason: string) {
  const row = (await query<ReservationRow>(
    `UPDATE ai_spend_reservations
        SET status='AMBIGUOUS',ambiguity_reason=$3,submitted_at=COALESCE(submitted_at,NOW())
      WHERE workspace_id=$1 AND id=$2 AND status IN ('SUBMITTING','SUBMITTED','AMBIGUOUS')
      RETURNING ${reservationSelect}`,
    [workspaceId, reservationId, reason.slice(0, 2_000)],
  )).rows[0];
  return row ? publicReservation(row) : null;
}

export async function releaseAiSpend(input: {
  workspaceId: string;
  reservationId: string;
  disposition: AiSpendReleaseDisposition;
  reason: string;
}) {
  return withTransaction(async (client) => {
    // Every wallet mutation takes the workspace wallet lock before a
    // reservation row lock. A single lock order prevents reserve/settle/release
    // deadlocks while preserving per-wallet serializability.
    const priorWallet = await lockWallet(input.workspaceId, client);
    const reservation = (await query<ReservationRow>(
      `SELECT ${reservationSelect} FROM ai_spend_reservations
        WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [input.workspaceId, input.reservationId],
      client,
    )).rows[0];
    if (!reservation) throw new AppError(404, 'AI_RESERVATION_NOT_FOUND', 'AI spend reservation not found.');
    if (reservation.status === 'RELEASED') return { reservation: publicReservation(reservation), idempotent: true };
    if (reservation.status === 'SETTLED') {
      throw new AppError(409, 'AI_RESERVATION_ALREADY_SETTLED', 'A settled AI reservation cannot be released.');
    }
    const releasable = (reservation.status === 'RESERVED' && input.disposition === 'BEFORE_SUBMISSION')
      || (reservation.status === 'SUBMITTING' && input.disposition === 'DEFINITIVE_REJECTION');
    if (!releasable) {
      throw new AppError(409, 'AI_RESERVATION_OUTCOME_UNRESOLVED', 'A reservation with a possible provider charge cannot be released without reconciliation.');
    }
    const reservedUnits = fixedToUnits(reservation.reservedAmount, 6);
    const debtUnits = fixedToUnits(priorWallet.reversalDebtAmount, 6);
    const debtPaidUnits = debtUnits < reservedUnits ? debtUnits : reservedUnits;
    const returnedUnits = reservedUnits - debtPaidUnits;
    const debtPaid = unitsToFixed(debtPaidUnits, 6);
    const returned = unitsToFixed(returnedUnits, 6);
    const wallet = (await query<{ availableAmount: string; reversalDebtAmount: string }>(
      `UPDATE workspace_api_wallets SET
         reserved_amount=reserved_amount-$2,
         available_amount=available_amount+GREATEST(0,$2-reversal_debt_amount),
         reversal_debt_amount=GREATEST(0,reversal_debt_amount-$2),
         version=version+1
       WHERE workspace_id=$1 AND reserved_amount >= $2
       RETURNING available_amount AS "availableAmount",reversal_debt_amount AS "reversalDebtAmount"`,
      [input.workspaceId, reservation.reservedAmount],
      client,
    )).rows[0];
    if (!wallet) throw new AppError(500, 'AI_RESERVATION_WALLET_INVARIANT', 'AI reservation no longer matches the wallet hold.');
    const updated = (await query<ReservationRow>(
      `UPDATE ai_spend_reservations SET status='RELEASED',released_at=NOW(),ambiguity_reason=$3
        WHERE workspace_id=$1 AND id=$2 RETURNING ${reservationSelect}`,
      [input.workspaceId, input.reservationId, input.reason.slice(0, 2_000)],
      client,
    )).rows[0]!;
    await query(
      `INSERT INTO workspace_api_wallet_ledger(
         workspace_id,reservation_id,entry_type,amount_delta,balance_after,idempotency_key,metadata
       ) VALUES($1,$2,'USAGE_RELEASE',$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
      [input.workspaceId, reservation.id, returned, wallet.availableAmount,
        `ai-reservation:${reservation.id}:release`, JSON.stringify({ disposition: input.disposition, reason: input.reason, debtPaid: Number(debtPaid), reversalDebtAmount: Number(wallet.reversalDebtAmount) })],
      client,
    );
    if (Number(wallet.availableAmount) > 0 && Number(wallet.reversalDebtAmount) === 0) {
      await appendDomainEvent({
        workspaceId: input.workspaceId,
        type: DOMAIN_EVENT_TYPES.API_FUNDS_FUNDED,
        aggregateType: 'api_wallet',
        aggregateId: input.workspaceId,
        payload: { reservationId: reservation.id, availableAmount: Number(wallet.availableAmount), trigger: 'reservation_release' },
        metadata: { source: 'ai-wallet-reservation' },
        idempotencyKey: `ai-reservation:${reservation.id}:funded-after-release`,
      }, client);
    }
    return { reservation: publicReservation(updated), idempotent: false };
  });
}

export async function settleAiSpend(input: {
  workspaceId: string;
  reservationId: string;
  usageLedgerId: string;
  provider: string;
  model: string;
  providerRequestId: string;
  actualCustomerCostUsd: number;
}) {
  return withTransaction(async (client) => {
    const priorWallet = await lockWallet(input.workspaceId, client);
    const reservation = (await query<ReservationRow>(
      `SELECT ${reservationSelect} FROM ai_spend_reservations
        WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [input.workspaceId, input.reservationId],
      client,
    )).rows[0];
    if (!reservation) throw new AppError(404, 'AI_RESERVATION_NOT_FOUND', 'AI spend reservation not found.');
    const actualUsd = fixed(input.actualCustomerCostUsd, 8, 'round');
    if (reservation.status === 'SETTLED') {
      const sameSettlement = reservation.usageLedgerId === input.usageLedgerId
        && reservation.provider === input.provider
        && reservation.model === input.model
        && reservation.providerRequestId === input.providerRequestId
        && reservation.actualCustomerCostUsd !== null
        && fixedToUnits(reservation.actualCustomerCostUsd, 8) === fixedToUnits(actualUsd, 8);
      if (!sameSettlement) {
        throw new AppError(409, 'AI_RESERVATION_SETTLEMENT_MISMATCH', 'The AI reservation was already settled with different provider usage.');
      }
      return { reservation: publicReservation(reservation), idempotent: true };
    }
    if (reservation.status === 'RELEASED') throw new AppError(409, 'AI_RESERVATION_ALREADY_RELEASED', 'A released AI reservation cannot be settled.');
    if (reservation.status === 'RESERVED') {
      throw new AppError(409, 'AI_RESERVATION_NOT_SUBMITTED', 'An AI reservation cannot be settled before provider submission begins.');
    }
    if ((reservation.provider !== null && reservation.provider !== input.provider)
      || (reservation.model !== null && reservation.model !== input.model)
      || (reservation.providerRequestId !== null && reservation.providerRequestId !== input.providerRequestId)) {
      throw new AppError(409, 'AI_RESERVATION_PROVIDER_MISMATCH', 'Provider usage does not match the submitted AI reservation identity.');
    }

    const usage = (await query<{
      provider: string;
      model: string;
      customerCostUsd: string;
      responseId: string | null;
      providerRequestId: string | null;
    }>(
      `UPDATE ai_usage_ledger SET reservation_id=$3
        WHERE workspace_id=$1 AND id=$2 AND (reservation_id IS NULL OR reservation_id=$3)
        RETURNING provider,model,customer_cost_usd AS "customerCostUsd",
                  NULLIF(metadata->>'responseId','') AS "responseId",
                  NULLIF(metadata->>'providerRequestId','') AS "providerRequestId"`,
      [input.workspaceId, input.usageLedgerId, reservation.id],
      client,
    )).rows[0];
    if (!usage || usage.provider !== input.provider || usage.model !== input.model
      || (usage.providerRequestId ?? usage.responseId) !== input.providerRequestId
      || fixedToUnits(usage.customerCostUsd, 8) !== fixedToUnits(actualUsd, 8)) {
      throw new AppError(409, 'AI_USAGE_RESERVATION_MISMATCH', 'Provider usage does not match the AI spend reservation settlement.');
    }

    const actualCny = multiplyFixed(actualUsd, 8, reservation.usdCnyRate, 8, 6, 'round');
    const actualCnyUnits = fixedToUnits(actualCny, 6);
    const reservedUnits = fixedToUnits(reservation.reservedAmount, 6);
    const chargedUnits = actualCnyUnits < reservedUnits ? actualCnyUnits : reservedUnits;
    const unusedUnits = reservedUnits - chargedUnits;
    const debtUnits = fixedToUnits(priorWallet.reversalDebtAmount, 6);
    const debtPaidUnits = debtUnits < unusedUnits ? debtUnits : unusedUnits;
    const returnedUnits = unusedUnits - debtPaidUnits;
    const charged = unitsToFixed(chargedUnits, 6);
    const unused = unitsToFixed(unusedUnits, 6);
    const debtPaid = unitsToFixed(debtPaidUnits, 6);
    const returned = unitsToFixed(returnedUnits, 6);
    const wallet = (await query<{ availableAmount: string; reversalDebtAmount: string }>(
      `UPDATE workspace_api_wallets SET
         reserved_amount=reserved_amount-$2,
         spent_amount=spent_amount+$3,
         reversal_debt_amount=GREATEST(0,reversal_debt_amount-$4),
         available_amount=available_amount+$5,
         version=version+1
       WHERE workspace_id=$1 AND reserved_amount >= $2
       RETURNING available_amount AS "availableAmount",reversal_debt_amount AS "reversalDebtAmount"`,
      [input.workspaceId, reservation.reservedAmount, charged, debtPaid, returned],
      client,
    )).rows[0];
    if (!wallet) throw new AppError(500, 'AI_RESERVATION_WALLET_INVARIANT', 'AI reservation no longer matches the wallet hold.');
    const updated = (await query<ReservationRow>(
      `UPDATE ai_spend_reservations SET status='SETTLED',settled_amount=$3,
         actual_customer_cost_usd=$4,provider=$5,model=$6,provider_request_id=$7,
         usage_ledger_id=$8,submitted_at=COALESCE(submitted_at,NOW()),settled_at=NOW(),ambiguity_reason=NULL
       WHERE workspace_id=$1 AND id=$2 RETURNING ${reservationSelect}`,
      [input.workspaceId, reservation.id, charged, actualUsd, input.provider,
        input.model, input.providerRequestId, input.usageLedgerId],
      client,
    )).rows[0]!;
    await query(
      `INSERT INTO workspace_api_wallet_ledger(
         workspace_id,reservation_id,ai_usage_ledger_id,entry_type,amount_delta,balance_after,
         idempotency_key,usd_cost,usd_cny_rate,metadata
       ) VALUES($1,$2,$3,'USAGE_DEBIT',$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT DO NOTHING`,
      [input.workspaceId, reservation.id, input.usageLedgerId, unitsToFixed(-chargedUnits, 6), wallet.availableAmount,
        `ai-reservation:${reservation.id}:settle`, actualUsd, reservation.usdCnyRate,
        JSON.stringify({ providerRequestId: input.providerRequestId, reservedAmount: Number(reservation.reservedAmount),
          actualCny: Number(actualCny), charged: Number(charged), unused: Number(unused), debtPaid: Number(debtPaid),
          platformAbsorbedCny: Number(unitsToFixed(actualCnyUnits - chargedUnits, 6)) })],
      client,
    );
    if (unusedUnits > 0n) {
      await query(
        `INSERT INTO workspace_api_wallet_ledger(
           workspace_id,reservation_id,ai_usage_ledger_id,entry_type,amount_delta,balance_after,
           idempotency_key,metadata
         ) VALUES($1,$2,$3,'USAGE_RELEASE',$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
        [input.workspaceId, reservation.id, input.usageLedgerId, returned, wallet.availableAmount,
          `ai-reservation:${reservation.id}:unused-release`, JSON.stringify({ unused: Number(unused), debtPaid: Number(debtPaid), returned: Number(returned) })],
        client,
      );
    }
    if (Number(wallet.availableAmount) > 0 && Number(wallet.reversalDebtAmount) === 0 && returnedUnits > 0n) {
      await appendDomainEvent({
        workspaceId: input.workspaceId,
        type: DOMAIN_EVENT_TYPES.API_FUNDS_FUNDED,
        aggregateType: 'api_wallet',
        aggregateId: input.workspaceId,
        payload: { reservationId: reservation.id, availableAmount: Number(wallet.availableAmount), trigger: 'unused_reservation_release' },
        metadata: { source: 'ai-wallet-reservation' },
        idempotencyKey: `ai-reservation:${reservation.id}:funded-after-settlement`,
      }, client);
    }
    return {
      reservation: publicReservation(updated),
      idempotent: false,
      charged: Number(charged),
      unused: Number(unused),
      debtPaid: Number(debtPaid),
      returned: Number(returned),
      underReserved: actualCnyUnits > chargedUnits,
    };
  });
}

export async function getAiReservationHealth() {
  const row = (await query<{
    reservedCount: string;
    ambiguousCount: string;
    submittingCount: string;
    submittedCount: string;
    unresolvedCount: string;
    staleUnresolvedCount: string;
    walletHoldMismatchCount: string;
    walletHoldMismatchAmount: string;
    oldestUnresolvedAt: string | null;
  }>(
    `WITH active_holds AS (
       SELECT workspace_id,SUM(reserved_amount) AS held
         FROM ai_spend_reservations
        WHERE status IN ('RESERVED','SUBMITTING','SUBMITTED','AMBIGUOUS')
        GROUP BY workspace_id
     ), wallet_hold_health AS (
       SELECT COALESCE(w.workspace_id,h.workspace_id) AS workspace_id,
              ABS(COALESCE(w.reserved_amount,0)-COALESCE(h.held,0)) AS difference
         FROM workspace_api_wallets w
         FULL OUTER JOIN active_holds h ON h.workspace_id=w.workspace_id
        WHERE COALESCE(w.reserved_amount,0)<>COALESCE(h.held,0)
     )
     SELECT COUNT(*) FILTER (WHERE status='RESERVED')::text AS "reservedCount",
            COUNT(*) FILTER (WHERE status='AMBIGUOUS')::text AS "ambiguousCount",
            COUNT(*) FILTER (WHERE status IN ('SUBMITTING','SUBMITTED'))::text AS "submittingCount",
            COUNT(*) FILTER (WHERE status='SUBMITTED')::text AS "submittedCount",
            COUNT(*) FILTER (WHERE status IN ('RESERVED','SUBMITTING','SUBMITTED','AMBIGUOUS'))::text AS "unresolvedCount",
            COUNT(*) FILTER (WHERE status='AMBIGUOUS'
              OR (status='RESERVED' AND updated_at<NOW()-INTERVAL '5 minutes')
              OR (status='SUBMITTING' AND updated_at<NOW()-INTERVAL '15 minutes')
              OR (status='SUBMITTED' AND updated_at<NOW()-INTERVAL '24 hours'))::text AS "staleUnresolvedCount",
            (SELECT COUNT(*)::text FROM wallet_hold_health) AS "walletHoldMismatchCount",
            (SELECT COALESCE(SUM(difference),0)::text FROM wallet_hold_health) AS "walletHoldMismatchAmount",
            MIN(updated_at) FILTER (WHERE status IN ('RESERVED','SUBMITTING','SUBMITTED','AMBIGUOUS')) AS "oldestUnresolvedAt"
       FROM ai_spend_reservations`,
  )).rows[0];
  return {
    reservedCount: Number(row?.reservedCount ?? 0),
    ambiguousCount: Number(row?.ambiguousCount ?? 0),
    submittingCount: Number(row?.submittingCount ?? 0),
    submittedCount: Number(row?.submittedCount ?? 0),
    unresolvedCount: Number(row?.unresolvedCount ?? 0),
    staleUnresolvedCount: Number(row?.staleUnresolvedCount ?? 0),
    walletHoldMismatchCount: Number(row?.walletHoldMismatchCount ?? 0),
    walletHoldMismatchAmount: Number(row?.walletHoldMismatchAmount ?? 0),
    oldestUnresolvedAt: row?.oldestUnresolvedAt ?? null,
  };
}
