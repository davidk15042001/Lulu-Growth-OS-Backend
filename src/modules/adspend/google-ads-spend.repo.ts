import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { AppError } from '../../utils/app-error.js';

export type GoogleAdsLaunchState = 'PENDING' | 'APPLIED' | 'UNCERTAIN' | 'REJECTED';
export type GoogleAdsClosureState = 'OPEN' | 'REQUESTED' | 'PAUSE_UNCERTAIN' | 'PROVIDER_PAUSED' | 'AWAITING_BILLING' | 'FINALIZED';

export type GoogleAdsSpendAllocation = {
  reservationId: string;
  workspaceId: string;
  authorizationId: string;
  customerId: string;
  campaignId: string;
  campaignBudgetResourceName: string;
  loginCustomerId: string;
  currency: 'CNY';
  capMicros: string;
  baselineCostMicros: string;
  desiredTotalBudgetMicros: string;
  lastObservedCostMicros: string;
  settledCostMicros: string;
  overCapMicros: string;
  launchState: GoogleAdsLaunchState;
  closureState: GoogleAdsClosureState;
  providerCampaignStatus: string | null;
  providerRequestId: string | null;
  billingSetupResourceName: string;
  paymentsAccountId: string;
  paymentsProfileId: string;
  launchedAt: string | null;
  closeRequestedAt: string | null;
  closeReason: string | null;
  providerPausedAt: string | null;
  lastObservedAt: string | null;
  lastCostChangedAt: string | null;
  stableObservationCount: number;
  billingEvidenceAt: string | null;
  billingEvidence: Record<string, unknown>;
  finalizedAt: string | null;
  nextReconcileAt: string;
  attemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

const allocationSelect = `reservation_id AS "reservationId",workspace_id AS "workspaceId",
  authorization_id AS "authorizationId",customer_id AS "customerId",campaign_id AS "campaignId",
  campaign_budget_resource_name AS "campaignBudgetResourceName",login_customer_id AS "loginCustomerId",
  currency,cap_micros AS "capMicros",baseline_cost_micros AS "baselineCostMicros",
  desired_total_budget_micros AS "desiredTotalBudgetMicros",last_observed_cost_micros AS "lastObservedCostMicros",
  settled_cost_micros AS "settledCostMicros",over_cap_micros AS "overCapMicros",
  launch_state AS "launchState",closure_state AS "closureState",
  provider_campaign_status AS "providerCampaignStatus",provider_request_id AS "providerRequestId",
  billing_setup_resource_name AS "billingSetupResourceName",payments_account_id AS "paymentsAccountId",
  payments_profile_id AS "paymentsProfileId",launched_at AS "launchedAt",
  close_requested_at AS "closeRequestedAt",close_reason AS "closeReason",
  provider_paused_at AS "providerPausedAt",last_observed_at AS "lastObservedAt",
  last_cost_changed_at AS "lastCostChangedAt",stable_observation_count AS "stableObservationCount",
  billing_evidence_at AS "billingEvidenceAt",billing_evidence AS "billingEvidence",finalized_at AS "finalizedAt",
  next_reconcile_at AS "nextReconcileAt",attempt_count AS "attemptCount",lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",last_error_code AS "lastErrorCode",
  last_error_message AS "lastErrorMessage",metadata,created_at AS "createdAt",updated_at AS "updatedAt"`;

function digits(value: string) {
  return value.replaceAll('-', '').trim();
}

function assertMicros(value: bigint, code: string, message: string) {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError(422, code, message);
  }
}

export async function createGoogleAdsSpendAllocation(input: {
  workspaceId: string;
  reservationId: string;
  authorizationId: string;
  customerId: string;
  campaignId: string;
  campaignBudgetResourceName: string;
  loginCustomerId: string;
  currency: 'CNY';
  capMicros: bigint;
  baselineCostMicros: bigint;
  billingSetupResourceName: string;
  paymentsAccountId: string;
  paymentsProfileId: string;
  providerCampaignStatus: string;
  metadata?: Record<string, unknown>;
}) {
  assertMicros(input.capMicros, 'GOOGLE_ADS_CAP_INVALID', 'The Google Ads allocation cap is invalid.');
  if (input.capMicros <= 0n) throw new AppError(422, 'GOOGLE_ADS_CAP_INVALID', 'The Google Ads allocation cap must be positive.');
  assertMicros(input.baselineCostMicros, 'GOOGLE_ADS_BASELINE_INVALID', 'The Google Ads cost baseline is invalid.');
  const customerId = digits(input.customerId);
  const campaignId = digits(input.campaignId);
  const loginCustomerId = digits(input.loginCustomerId);
  const paymentsAccountId = digits(input.paymentsAccountId);
  const paymentsProfileId = digits(input.paymentsProfileId);
  const desiredTotalBudgetMicros = input.baselineCostMicros + input.capMicros;
  return withTransaction(async (client) => {
    await query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`google-ads-allocation:${input.workspaceId}:${customerId}:${campaignId}`], client);
    const prior = (await query<GoogleAdsSpendAllocation>(
      `SELECT ${allocationSelect} FROM workspace_google_ads_spend_allocations
       WHERE workspace_id=$1 AND reservation_id=$2 FOR UPDATE`,
      [input.workspaceId, input.reservationId], client,
    )).rows[0];
    if (prior) {
      const same = prior.authorizationId === input.authorizationId
        && prior.customerId === customerId && prior.campaignId === campaignId
        && BigInt(prior.capMicros) === input.capMicros && BigInt(prior.baselineCostMicros) === input.baselineCostMicros
        && prior.billingSetupResourceName === input.billingSetupResourceName
        && prior.paymentsAccountId === paymentsAccountId && prior.paymentsProfileId === paymentsProfileId;
      if (!same) throw new AppError(409, 'GOOGLE_ADS_ALLOCATION_IDEMPOTENCY_CONFLICT', 'The reservation is already bound to a different Google Ads allocation.');
      return { ...prior, idempotent: true };
    }
    const reservation = (await query<{ amount: string; settledAmount: string; status: string; authorizationId: string | null; platform: string | null; accountId: string | null; campaignId: string | null; currency: string }>(
      `SELECT amount,settled_amount AS "settledAmount",status,authorization_id AS "authorizationId",platform,
              account_id AS "accountId",campaign_id AS "campaignId",currency
         FROM workspace_ad_spend_reservations WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [input.workspaceId, input.reservationId], client,
    )).rows[0];
    if (!reservation || reservation.status !== 'RESERVED' || Number(reservation.settledAmount) !== 0) {
      throw new AppError(409, 'GOOGLE_ADS_RESERVATION_INVALID', 'A new Google Ads allocation requires an untouched active reservation.');
    }
    if (reservation.authorizationId !== input.authorizationId || reservation.platform !== 'google-ads'
      || reservation.accountId !== customerId || reservation.campaignId !== campaignId || reservation.currency !== input.currency
      || BigInt(Math.round(Number(reservation.amount) * 1_000_000)) !== input.capMicros) {
      throw new AppError(409, 'GOOGLE_ADS_RESERVATION_SCOPE_MISMATCH', 'The reservation does not match the verified Google Ads campaign allocation.');
    }
    const conflict = (await query<{ reservationId: string }>(
      `SELECT reservation_id AS "reservationId" FROM workspace_google_ads_spend_allocations
       WHERE workspace_id=$1 AND customer_id=$2 AND campaign_id=$3
         AND launch_state<>'REJECTED' AND closure_state<>'FINALIZED' LIMIT 1 FOR UPDATE`,
      [input.workspaceId, customerId, campaignId], client,
    )).rows[0];
    if (conflict) throw new AppError(409, 'GOOGLE_ADS_CAMPAIGN_ALREADY_ALLOCATED', 'This campaign already has an open prepaid allocation.');
    const row = (await query<GoogleAdsSpendAllocation>(
      `INSERT INTO workspace_google_ads_spend_allocations(
         reservation_id,workspace_id,authorization_id,customer_id,campaign_id,campaign_budget_resource_name,
         login_customer_id,currency,cap_micros,baseline_cost_micros,desired_total_budget_micros,
         last_observed_cost_micros,provider_campaign_status,billing_setup_resource_name,
         payments_account_id,payments_profile_id,metadata,lease_owner,lease_expires_at,next_reconcile_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,$12,$13,$14,$15,$16::jsonb,
         $17,NOW()+INTERVAL '30 minutes',NOW()+INTERVAL '30 minutes')
       RETURNING ${allocationSelect}`,
      [input.reservationId, input.workspaceId, input.authorizationId, customerId, campaignId,
        input.campaignBudgetResourceName, loginCustomerId, input.currency, input.capMicros.toString(),
        input.baselineCostMicros.toString(), desiredTotalBudgetMicros.toString(), input.providerCampaignStatus,
        input.billingSetupResourceName, paymentsAccountId, paymentsProfileId, JSON.stringify(input.metadata ?? {}),
        `launch-dispatch:${input.reservationId}`], client,
    )).rows[0];
    if (!row) throw new Error('Google Ads spend allocation could not be persisted');
    return { ...row, idempotent: false };
  });
}

export async function getGoogleAdsSpendAllocation(workspaceId: string, reservationId: string, client?: PoolClient) {
  return (await query<GoogleAdsSpendAllocation>(
    `SELECT ${allocationSelect} FROM workspace_google_ads_spend_allocations WHERE workspace_id=$1 AND reservation_id=$2`,
    [workspaceId, reservationId], client,
  )).rows[0] ?? null;
}

export async function getGoogleAdsSpendAllocationByOperationKey(workspaceId: string, operationKey: string) {
  return (await query<GoogleAdsSpendAllocation>(
    `SELECT ${allocationSelect} FROM workspace_google_ads_spend_allocations a
     WHERE a.workspace_id=$1 AND EXISTS(
       SELECT 1 FROM workspace_ad_spend_reservations r
       WHERE r.workspace_id=a.workspace_id AND r.id=a.reservation_id AND r.idempotency_key=$2
     ) LIMIT 1`,
    [workspaceId, operationKey],
  )).rows[0] ?? null;
}

export async function getOpenGoogleAdsSpendAllocation(input: { workspaceId: string; customerId: string; campaignId: string }) {
  return (await query<GoogleAdsSpendAllocation>(
    `SELECT ${allocationSelect} FROM workspace_google_ads_spend_allocations
     WHERE workspace_id=$1 AND customer_id=$2 AND campaign_id=$3
       AND launch_state<>'REJECTED' AND closure_state<>'FINALIZED'
     ORDER BY created_at DESC LIMIT 1`,
    [input.workspaceId, digits(input.customerId), digits(input.campaignId)],
  )).rows[0] ?? null;
}

export async function listGoogleAdsSpendAllocations(workspaceId: string) {
  const rows = (await query<GoogleAdsSpendAllocation>(
    `SELECT ${allocationSelect} FROM workspace_google_ads_spend_allocations
     WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 250`, [workspaceId],
  )).rows;
  return rows.map((row) => {
    const capMicros = BigInt(row.capMicros);
    const baselineMicros = BigInt(row.baselineCostMicros);
    const observedMicros = BigInt(row.lastObservedCostMicros);
    const settledMicros = BigInt(row.settledCostMicros);
    return {
      reservationId: row.reservationId,
      authorizationId: row.authorizationId,
      provider: 'google-ads' as const,
      customerId: row.customerId,
      campaignId: row.campaignId,
      currency: row.currency,
      capAmount: Number(capMicros) / 1_000_000,
      observedSpendAmount: Number(observedMicros > baselineMicros ? observedMicros - baselineMicros : 0n) / 1_000_000,
      settledAmount: Number(settledMicros) / 1_000_000,
      remainingReservedAmount: Number(capMicros - settledMicros) / 1_000_000,
      overCapAmount: Number(BigInt(row.overCapMicros)) / 1_000_000,
      launchState: row.launchState,
      closureState: row.closureState,
      providerCampaignStatus: row.providerCampaignStatus,
      launchedAt: row.launchedAt,
      closeRequestedAt: row.closeRequestedAt,
      providerPausedAt: row.providerPausedAt,
      lastObservedAt: row.lastObservedAt,
      billingEvidenceAvailable: Boolean(row.billingEvidenceAt),
      finalizedAt: row.finalizedAt,
      lastErrorCode: row.lastErrorCode,
      lastErrorMessage: row.lastErrorMessage,
    };
  });
}

export async function markGoogleAdsLaunchApplied(input: {
  workspaceId: string;
  reservationId: string;
  providerRequestId?: string | null;
  providerCampaignStatus?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const row = (await query<GoogleAdsSpendAllocation>(
    `UPDATE workspace_google_ads_spend_allocations SET launch_state='APPLIED',launched_at=COALESCE(launched_at,NOW()),
       provider_request_id=COALESCE($3,provider_request_id),provider_campaign_status=COALESCE($4,provider_campaign_status),
       metadata=metadata||$5::jsonb,next_reconcile_at=NOW()+INTERVAL '60 seconds',
       lease_owner=NULL,lease_expires_at=NULL,last_error_code=NULL,last_error_message=NULL
     WHERE workspace_id=$1 AND reservation_id=$2 AND launch_state IN ('PENDING','UNCERTAIN','APPLIED')
     RETURNING ${allocationSelect}`,
    [input.workspaceId, input.reservationId, input.providerRequestId ?? null,
      input.providerCampaignStatus ?? null, JSON.stringify(input.metadata ?? {})],
  )).rows[0];
  if (!row) throw new AppError(409, 'GOOGLE_ADS_ALLOCATION_CLOSED', 'The Google Ads allocation can no longer be marked as launched.');
  return row;
}

export async function markGoogleAdsLaunchUncertain(input: { workspaceId: string; reservationId: string; error: unknown }) {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await query(
    `UPDATE workspace_google_ads_spend_allocations SET launch_state='UNCERTAIN',next_reconcile_at=NOW()+INTERVAL '60 seconds',
       lease_owner=NULL,lease_expires_at=NULL,last_error_code='GOOGLE_ADS_LAUNCH_OUTCOME_UNCERTAIN',last_error_message=$3
     WHERE workspace_id=$1 AND reservation_id=$2 AND launch_state='PENDING'`,
    [input.workspaceId, input.reservationId, message.slice(0, 2000)],
  );
}

export async function markGoogleAdsLaunchRejected(input: { workspaceId: string; reservationId: string; providerRequestId?: string | null; metadata?: Record<string, unknown> }) {
  const row = (await query<GoogleAdsSpendAllocation>(
    `UPDATE workspace_google_ads_spend_allocations SET launch_state='REJECTED',closure_state='FINALIZED',
       provider_request_id=COALESCE($3,provider_request_id),finalized_at=COALESCE(finalized_at,NOW()),
       metadata=metadata||$4::jsonb,next_reconcile_at=NOW(),lease_owner=NULL,lease_expires_at=NULL
     WHERE workspace_id=$1 AND reservation_id=$2 AND closure_state<>'FINALIZED'
     RETURNING ${allocationSelect}`,
    [input.workspaceId, input.reservationId, input.providerRequestId ?? null, JSON.stringify(input.metadata ?? {})],
  )).rows[0];
  return row ?? getGoogleAdsSpendAllocation(input.workspaceId, input.reservationId);
}

export async function requestGoogleAdsAllocationClosure(input: {
  workspaceId: string;
  reservationId: string;
  reason: string;
}) {
  const row = (await query<GoogleAdsSpendAllocation>(
    `UPDATE workspace_google_ads_spend_allocations SET
       closure_state=CASE WHEN closure_state='OPEN' THEN 'REQUESTED' ELSE closure_state END,
       close_requested_at=COALESCE(close_requested_at,NOW()),close_reason=COALESCE(close_reason,$3),next_reconcile_at=NOW()
     WHERE workspace_id=$1 AND reservation_id=$2 AND closure_state<>'FINALIZED'
     RETURNING ${allocationSelect}`,
    [input.workspaceId, input.reservationId, input.reason.slice(0, 2000)],
  )).rows[0];
  return row ?? getGoogleAdsSpendAllocation(input.workspaceId, input.reservationId);
}

export async function markGoogleAdsPauseOutcome(input: {
  workspaceId: string;
  reservationId: string;
  definitive: boolean;
  providerRequestId?: string | null;
  error?: unknown;
}) {
  const message = input.error instanceof Error ? input.error.message : input.error === undefined ? null : String(input.error);
  const row = (await query<GoogleAdsSpendAllocation>(
    `UPDATE workspace_google_ads_spend_allocations SET
       closure_state=CASE WHEN $3 THEN 'PROVIDER_PAUSED' ELSE 'PAUSE_UNCERTAIN' END,
       provider_campaign_status=CASE WHEN $3 THEN 'PAUSED' ELSE provider_campaign_status END,
       provider_paused_at=CASE WHEN $3 THEN COALESCE(provider_paused_at,NOW()) ELSE provider_paused_at END,
       provider_request_id=COALESCE($4,provider_request_id),next_reconcile_at=NOW(),
       last_error_code=CASE WHEN $3 THEN NULL ELSE 'GOOGLE_ADS_PAUSE_OUTCOME_UNCERTAIN' END,
       last_error_message=CASE WHEN $3 THEN NULL ELSE $5 END
     WHERE workspace_id=$1 AND reservation_id=$2 AND closure_state<>'FINALIZED'
     RETURNING ${allocationSelect}`,
    [input.workspaceId, input.reservationId, input.definitive, input.providerRequestId ?? null, message?.slice(0, 2000) ?? null],
  )).rows[0];
  if (!row) throw new AppError(409, 'GOOGLE_ADS_ALLOCATION_CLOSED', 'The Google Ads allocation is already closed.');
  return row;
}

export async function claimGoogleAdsSpendAllocation(workerId: string, leaseSeconds: number) {
  await query(
    `UPDATE workspace_google_ads_spend_allocations a SET closure_state='REQUESTED',
       close_requested_at=COALESCE(a.close_requested_at,NOW()),close_reason=COALESCE(a.close_reason,'Customer budget authorization expired'),
       next_reconcile_at=NOW()
     FROM workspace_ad_budget_authorizations auth
     WHERE a.workspace_id=auth.workspace_id AND a.authorization_id=auth.id
       AND a.closure_state='OPEN' AND (auth.ends_at<=NOW() OR auth.status IN ('REVOKED','EXPIRED'))`,
  );
  return (await query<GoogleAdsSpendAllocation>(
    `WITH candidate AS (
       SELECT workspace_id,reservation_id FROM workspace_google_ads_spend_allocations
       WHERE launch_state<>'REJECTED' AND closure_state<>'FINALIZED' AND next_reconcile_at<=NOW()
         AND (lease_expires_at IS NULL OR lease_expires_at<NOW())
       ORDER BY CASE WHEN closure_state='OPEN' THEN 1 ELSE 0 END, next_reconcile_at, created_at
       LIMIT 1 FOR UPDATE SKIP LOCKED
     ), claimed AS (
     UPDATE workspace_google_ads_spend_allocations a SET lease_owner=$1,
       lease_expires_at=NOW()+($2::text||' seconds')::interval,attempt_count=attempt_count+1
     FROM candidate c WHERE a.workspace_id=c.workspace_id AND a.reservation_id=c.reservation_id
     RETURNING a.*
     ) SELECT ${allocationSelect} FROM claimed`,
    [workerId, leaseSeconds],
  )).rows[0] ?? null;
}

/** New-code reservations are persisted before their allocation row. A crash in
 * that small, pre-provider window leaves a provably undispatched orphan. Legacy
 * ambiguous reservations are explicitly marked by migration 0096 and excluded. */
export async function listRecoverableGoogleAdsReservationOrphans(limit = 20) {
  return (await query<{ workspaceId: string; reservationId: string }>(
    `SELECT r.workspace_id AS "workspaceId",r.id AS "reservationId"
     FROM workspace_ad_spend_reservations r
     WHERE r.platform='google-ads' AND r.status='RESERVED'
       AND r.created_at<NOW()-INTERVAL '15 minutes'
       AND COALESCE(r.metadata->>'legacyPreReconciliation','false')<>'true'
       AND NOT EXISTS(
         SELECT 1 FROM workspace_google_ads_spend_allocations a
         WHERE a.workspace_id=r.workspace_id AND a.reservation_id=r.id
       )
     ORDER BY r.created_at LIMIT $1`, [Math.max(1, Math.min(limit, 100))],
  )).rows;
}

export async function scheduleGoogleAdsSpendAllocation(input: {
  workspaceId: string;
  reservationId: string;
  workerId: string;
  delaySeconds: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  const result = await query(
    `UPDATE workspace_google_ads_spend_allocations SET lease_owner=NULL,lease_expires_at=NULL,
       next_reconcile_at=NOW()+($4::text||' seconds')::interval,last_error_code=$5,last_error_message=$6
     WHERE workspace_id=$1 AND reservation_id=$2 AND lease_owner=$3`,
    [input.workspaceId, input.reservationId, input.workerId, Math.max(1, Math.round(input.delaySeconds)),
      input.errorCode ?? null, input.errorMessage?.slice(0, 2000) ?? null],
  );
  if (result.rowCount !== 1) {
    const current = await getGoogleAdsSpendAllocation(input.workspaceId, input.reservationId);
    if (current?.closureState !== 'FINALIZED') {
      throw new AppError(409, 'GOOGLE_ADS_RECONCILIATION_LEASE_LOST', 'The Google Ads reconciliation lease was lost before its next run could be scheduled.');
    }
  }
}

export async function renewGoogleAdsSpendAllocationLease(input: {
  workspaceId: string;
  reservationId: string;
  workerId: string;
  leaseSeconds: number;
}) {
  const result = await query(
    `UPDATE workspace_google_ads_spend_allocations
     SET lease_expires_at=NOW()+($4::text||' seconds')::interval
     WHERE workspace_id=$1 AND reservation_id=$2 AND lease_owner=$3 AND closure_state<>'FINALIZED'`,
    [input.workspaceId, input.reservationId, input.workerId, Math.max(30, Math.round(input.leaseSeconds))],
  );
  if (result.rowCount !== 1) throw new AppError(409, 'GOOGLE_ADS_RECONCILIATION_LEASE_LOST', 'The Google Ads reconciliation lease was lost; funds remain held.');
}

export async function recordGoogleAdsCostObservation(input: {
  workspaceId: string;
  reservationId: string;
  idempotencyKey: string;
  providerRequestId?: string | null;
  providerCostMicros: bigint;
  providerCampaignStatus: string;
  providerBudgetTotalMicros: bigint;
  evidence?: Record<string, unknown>;
}) {
  assertMicros(input.providerCostMicros, 'GOOGLE_ADS_COST_INVALID', 'The provider cost observation is invalid.');
  assertMicros(input.providerBudgetTotalMicros, 'GOOGLE_ADS_BUDGET_INVALID', 'The provider budget observation is invalid.');
  const providerCampaignStatus = input.providerCampaignStatus.trim().toUpperCase();
  if (!providerCampaignStatus) throw new AppError(422, 'GOOGLE_ADS_CAMPAIGN_STATUS_INVALID', 'A provider campaign status is required.');
  return withTransaction(async (client) => {
    const allocation = (await query<GoogleAdsSpendAllocation>(
      `SELECT ${allocationSelect} FROM workspace_google_ads_spend_allocations
       WHERE workspace_id=$1 AND reservation_id=$2 FOR UPDATE`,
      [input.workspaceId, input.reservationId], client,
    )).rows[0];
    if (!allocation) throw new AppError(404, 'GOOGLE_ADS_ALLOCATION_NOT_FOUND', 'Google Ads allocation not found.');
    const observation = (await query<{ id: string }>(
      `INSERT INTO workspace_google_ads_spend_observations(
         workspace_id,reservation_id,source,idempotency_key,provider_request_id,provider_cost_micros,
         provider_campaign_status,provider_budget_total_micros,evidence
       ) VALUES($1,$2,'CAMPAIGN_METRICS',$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING id`,
      [input.workspaceId, input.reservationId, input.idempotencyKey, input.providerRequestId ?? null,
        input.providerCostMicros.toString(), providerCampaignStatus, input.providerBudgetTotalMicros.toString(),
        JSON.stringify(input.evidence ?? {})], client,
    )).rows[0];
    if (!observation) {
      const prior = (await query<{ reservationId: string; providerCostMicros: string | null; providerCampaignStatus: string | null; providerBudgetTotalMicros: string | null }>(
        `SELECT reservation_id AS "reservationId",provider_cost_micros AS "providerCostMicros",
                provider_campaign_status AS "providerCampaignStatus",provider_budget_total_micros AS "providerBudgetTotalMicros"
         FROM workspace_google_ads_spend_observations WHERE workspace_id=$1 AND idempotency_key=$2`,
        [input.workspaceId, input.idempotencyKey], client,
      )).rows[0];
      if (!prior || prior.reservationId !== input.reservationId
        || prior.providerCostMicros === null || BigInt(prior.providerCostMicros) !== input.providerCostMicros
        || prior.providerCampaignStatus !== providerCampaignStatus
        || prior.providerBudgetTotalMicros === null || BigInt(prior.providerBudgetTotalMicros) !== input.providerBudgetTotalMicros) {
        throw new AppError(409, 'GOOGLE_ADS_OBSERVATION_IDEMPOTENCY_CONFLICT', 'The Google Ads observation key was already used for different provider evidence.');
      }
      return { allocation, idempotent: true, amountDelta: 0, overCap: BigInt(allocation.overCapMicros) > 0n };
    }

    const baseline = BigInt(allocation.baselineCostMicros);
    const cap = BigInt(allocation.capMicros);
    const incremental = input.providerCostMicros > baseline ? input.providerCostMicros - baseline : 0n;
    const overCap = incremental > cap;
    const bounded = incremental > cap ? cap : incremental;
    // Wallets are denominated to cents. Always round provider micros down so
    // a customer is never charged more than the observed campaign cost.
    const targetSettledMicros = (bounded / 10_000n) * 10_000n;
    const previousSettledMicros = BigInt(allocation.settledCostMicros);
    const deltaMicros = targetSettledMicros - previousSettledMicros;
    const amountDelta = Number(deltaMicros) / 1_000_000;
    const paused = ['PAUSED', 'REMOVED', 'ENDED'].includes(providerCampaignStatus);

    if (deltaMicros !== 0n) {
      const absAmount = Math.abs(amountDelta).toFixed(2);
      const positive = deltaMicros > 0n;
      const wallet = (await query<{ availableAmount: string }>(
        positive
          ? `UPDATE workspace_ad_spend_wallets SET reserved_amount=reserved_amount-$2,spent_amount=spent_amount+$2,version=version+1
             WHERE workspace_id=$1 AND reserved_amount >= $2 RETURNING available_amount AS "availableAmount"`
          : `UPDATE workspace_ad_spend_wallets SET reserved_amount=reserved_amount+$2,spent_amount=spent_amount-$2,version=version+1
             WHERE workspace_id=$1 AND spent_amount >= $2 RETURNING available_amount AS "availableAmount"`,
        [input.workspaceId, absAmount], client,
      )).rows[0];
      if (!wallet) throw new AppError(409, 'AD_SPEND_RESERVATION_BALANCE_MISMATCH', 'Observed Google Ads spend no longer matches the reserved wallet balance.');
      const authorization = (await query<{ id: string }>(
        positive
          ? `UPDATE workspace_ad_budget_authorizations SET reserved_amount=reserved_amount-$3,consumed_amount=consumed_amount+$3,version=version+1
             WHERE workspace_id=$1 AND id=$2 AND reserved_amount >= $3 RETURNING id`
          : `UPDATE workspace_ad_budget_authorizations SET reserved_amount=reserved_amount+$3,consumed_amount=consumed_amount-$3,version=version+1
             WHERE workspace_id=$1 AND id=$2 AND consumed_amount >= $3 RETURNING id`,
        [input.workspaceId, allocation.authorizationId, absAmount], client,
      )).rows[0];
      if (!authorization) throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_BALANCE_MISMATCH', 'Observed Google Ads spend no longer matches the reserved campaign authorization.');
      const reservation = (await query<{ id: string }>(
        `UPDATE workspace_ad_spend_reservations SET settled_amount=$3
         WHERE workspace_id=$1 AND id=$2 AND status='RESERVED' AND amount >= $3 RETURNING id`,
        [input.workspaceId, input.reservationId, (Number(targetSettledMicros) / 1_000_000).toFixed(2)], client,
      )).rows[0];
      if (!reservation) throw new AppError(409, 'AD_SPEND_RESERVATION_CLOSED', 'The Google Ads reservation closed before its cost observation could settle.');
      const ledgerKey = `google-ads-settle:${input.workspaceId}:${input.reservationId}:${observation.id}`;
      await query(
        `INSERT INTO workspace_ad_spend_ledger(workspace_id,entry_type,amount_delta,balance_after,idempotency_key,metadata)
         VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
        [input.workspaceId, positive ? 'SPEND' : 'ADJUSTMENT', positive ? -Number(absAmount) : Number(absAmount),
          wallet.availableAmount, ledgerKey, JSON.stringify({ reservationId: input.reservationId, observationId: observation.id,
            provider: 'google-ads', providerCostMicros: input.providerCostMicros.toString(), deltaCostMicros: deltaMicros.toString() })], client,
      );
      await query(
        `INSERT INTO workspace_google_ads_spend_settlements(
           workspace_id,reservation_id,observation_id,idempotency_key,previous_settled_cost_micros,
           settled_cost_micros,delta_cost_micros,amount_delta
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [input.workspaceId, input.reservationId, observation.id, ledgerKey, previousSettledMicros.toString(),
          targetSettledMicros.toString(), deltaMicros.toString(), amountDelta.toFixed(2)], client,
      );
      if (positive) {
        await appendDomainEvent({
          workspaceId: input.workspaceId,
          type: DOMAIN_EVENT_TYPES.AD_BUDGET_CONSUMED,
          aggregateType: 'ad_budget_authorization',
          aggregateId: allocation.authorizationId,
          payload: { authorizationId: allocation.authorizationId, reservationId: input.reservationId,
            amount: amountDelta, provider: 'google-ads', providerCostMicros: input.providerCostMicros.toString(), incremental: true },
          metadata: { actorId: null, source: 'google-ads-reconciliation' },
          idempotencyKey: `google-ads:${input.workspaceId}:${input.reservationId}:${observation.id}:consumed`,
        }, client);
      }
    }

    const updated = (await query<GoogleAdsSpendAllocation>(
      `UPDATE workspace_google_ads_spend_allocations SET
         last_observed_cost_micros=$3,settled_cost_micros=$4,
         over_cap_micros=GREATEST(0,$5::bigint-cap_micros),provider_campaign_status=$6,
         last_observed_at=NOW(),last_cost_changed_at=CASE
           WHEN last_observed_at IS NULL OR last_observed_cost_micros<>$3 THEN NOW()
           ELSE COALESCE(last_cost_changed_at,NOW()) END,
         stable_observation_count=CASE WHEN last_observed_cost_micros=$3 THEN stable_observation_count+1 ELSE 1 END,
         launch_state=CASE WHEN launch_state='UNCERTAIN' AND $7=desired_total_budget_micros THEN 'APPLIED' ELSE launch_state END,
         closure_state=CASE
           WHEN closure_state IN ('REQUESTED','PAUSE_UNCERTAIN') AND $8 THEN 'PROVIDER_PAUSED'
           WHEN closure_state='PROVIDER_PAUSED' THEN 'AWAITING_BILLING'
           ELSE closure_state END,
         provider_paused_at=CASE WHEN $8 THEN COALESCE(provider_paused_at,NOW()) ELSE provider_paused_at END,
         last_error_code=CASE WHEN $5::bigint>cap_micros THEN 'GOOGLE_ADS_CAP_EXCEEDED' ELSE NULL END,
         last_error_message=CASE WHEN $5::bigint>cap_micros THEN 'Provider-observed campaign cost exceeded the customer-authorized cap.' ELSE NULL END
       WHERE workspace_id=$1 AND reservation_id=$2 RETURNING ${allocationSelect}`,
      [input.workspaceId, input.reservationId, input.providerCostMicros.toString(), targetSettledMicros.toString(),
        incremental.toString(), providerCampaignStatus, input.providerBudgetTotalMicros.toString(), paused], client,
    )).rows[0]!;
    return { allocation: updated, idempotent: false, amountDelta, overCap };
  });
}

export async function recordGoogleAdsBillingEvidence(input: {
  workspaceId: string;
  reservationId: string;
  idempotencyKey: string;
  providerRequestId?: string | null;
  billingSetupResourceName: string;
  paymentsAccountId: string;
  paymentsProfileId: string;
  evidence: Record<string, unknown>;
}) {
  return withTransaction(async (client) => {
    const allocation = (await query<GoogleAdsSpendAllocation>(
      `SELECT ${allocationSelect} FROM workspace_google_ads_spend_allocations
       WHERE workspace_id=$1 AND reservation_id=$2 FOR UPDATE`,
      [input.workspaceId, input.reservationId], client,
    )).rows[0];
    if (!allocation) throw new AppError(404, 'GOOGLE_ADS_ALLOCATION_NOT_FOUND', 'Google Ads allocation not found.');
    if (allocation.billingSetupResourceName !== input.billingSetupResourceName
      || allocation.paymentsAccountId !== digits(input.paymentsAccountId)
      || allocation.paymentsProfileId !== digits(input.paymentsProfileId)) {
      throw new AppError(409, 'GOOGLE_ADS_BILLING_MAPPING_CHANGED', 'Google Ads billing evidence does not match the payer mapping verified at launch.');
    }
    const observation = (await query<{ id: string }>(
      `INSERT INTO workspace_google_ads_spend_observations(
         workspace_id,reservation_id,source,idempotency_key,provider_request_id,billing_setup_resource_name,
         payments_account_id,payments_profile_id,evidence
       ) VALUES($1,$2,'BILLING_INVOICE',$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING id`,
      [input.workspaceId, input.reservationId, input.idempotencyKey, input.providerRequestId ?? null,
        input.billingSetupResourceName, digits(input.paymentsAccountId), digits(input.paymentsProfileId),
        JSON.stringify(input.evidence)], client,
    )).rows[0];
    if (!observation) {
      const prior = (await query<{ reservationId: string; billingSetupResourceName: string | null; paymentsAccountId: string | null; paymentsProfileId: string | null }>(
        `SELECT reservation_id AS "reservationId",billing_setup_resource_name AS "billingSetupResourceName",
                payments_account_id AS "paymentsAccountId",payments_profile_id AS "paymentsProfileId"
         FROM workspace_google_ads_spend_observations WHERE workspace_id=$1 AND idempotency_key=$2`,
        [input.workspaceId, input.idempotencyKey], client,
      )).rows[0];
      if (!prior || prior.reservationId !== input.reservationId
        || prior.billingSetupResourceName !== input.billingSetupResourceName
        || prior.paymentsAccountId !== digits(input.paymentsAccountId)
        || prior.paymentsProfileId !== digits(input.paymentsProfileId)) {
        throw new AppError(409, 'GOOGLE_ADS_OBSERVATION_IDEMPOTENCY_CONFLICT', 'The Google Ads billing evidence key was already used for different provider evidence.');
      }
      return { allocation, idempotent: true };
    }
    const updated = (await query<GoogleAdsSpendAllocation>(
      `UPDATE workspace_google_ads_spend_allocations SET billing_evidence_at=NOW(),billing_evidence=$3::jsonb,
       closure_state=CASE WHEN closure_state IN ('PROVIDER_PAUSED','AWAITING_BILLING') THEN 'AWAITING_BILLING' ELSE closure_state END,
       last_error_code=NULL,last_error_message=NULL
       WHERE workspace_id=$1 AND reservation_id=$2 RETURNING ${allocationSelect}`,
      [input.workspaceId, input.reservationId, JSON.stringify(input.evidence)], client,
    )).rows[0]!;
    return { allocation: updated, idempotent: false };
  });
}

export function googleAdsBillingEvidenceId(input: { reservationId: string; evidence: Record<string, unknown> }) {
  const stableEvidence = { ...input.evidence };
  delete stableEvidence.requestIds;
  delete stableEvidence.verifiedAt;
  const digest = crypto.createHash('sha256').update(JSON.stringify(stableEvidence)).digest('hex').slice(0, 32);
  return `google-ads-invoices:${input.reservationId}:${digest}`;
}

/** Atomically closes the provider allocation and releases only its unspent
 * reservation remainder. There is no crash window in which wallet funds can
 * be released while the allocation still appears open. */
export async function finalizeGoogleAdsSpendAllocation(input: { workspaceId: string; reservationId: string; evidenceId: string }) {
  return withTransaction(async (client) => {
    const allocation = (await query<GoogleAdsSpendAllocation>(
      `SELECT ${allocationSelect} FROM workspace_google_ads_spend_allocations
       WHERE workspace_id=$1 AND reservation_id=$2 FOR UPDATE`,
      [input.workspaceId, input.reservationId], client,
    )).rows[0];
    if (!allocation) throw new AppError(404, 'GOOGLE_ADS_ALLOCATION_NOT_FOUND', 'Google Ads allocation not found.');
    if (allocation.closureState === 'FINALIZED') return { allocation, releasedAmount: 0, idempotent: true };
    if (allocation.closureState !== 'AWAITING_BILLING' || !allocation.billingEvidenceAt
      || BigInt(allocation.overCapMicros) > 0n) {
      throw new AppError(409, 'GOOGLE_ADS_FINALIZATION_EVIDENCE_MISSING', 'The Google Ads allocation cannot close without final provider, cap, and billing evidence.');
    }
    const reservation = (await query<{ authorizationId: string | null; amount: string; settledAmount: string; status: string; metadata: Record<string, unknown> }>(
      `SELECT authorization_id AS "authorizationId",amount,settled_amount AS "settledAmount",status,metadata
       FROM workspace_ad_spend_reservations WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [input.workspaceId, input.reservationId], client,
    )).rows[0];
    if (!reservation || !reservation.authorizationId) throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_REQUIRED', 'The Google Ads reservation has no campaign authorization.');
    if (!['RESERVED', 'RELEASED', 'CONSUMED'].includes(reservation.status)) {
      throw new AppError(409, 'AD_SPEND_RESERVATION_CLOSED', 'The Google Ads reservation cannot be finalized from its current state.');
    }
    const remaining = reservation.status === 'RESERVED'
      ? Math.max(0, Math.round((Number(reservation.amount) - Number(reservation.settledAmount)) * 100) / 100)
      : 0;
    let availableAmount: string | null = null;
    let reversalDebtAmount: string | null = null;
    if (reservation.status === 'RESERVED' && remaining > 0) {
      const wallet = (await query<{ availableAmount: string; reversalDebtAmount: string }>(
        `UPDATE workspace_ad_spend_wallets SET reserved_amount=reserved_amount-$2,
           available_amount=available_amount+GREATEST(0,$2-reversal_debt_amount),
           reversal_debt_amount=GREATEST(0,reversal_debt_amount-$2),version=version+1
         WHERE workspace_id=$1 AND reserved_amount >= $2
         RETURNING available_amount AS "availableAmount",reversal_debt_amount AS "reversalDebtAmount"`,
        [input.workspaceId, remaining.toFixed(2)], client,
      )).rows[0];
      if (!wallet) throw new AppError(409, 'AD_SPEND_RESERVATION_BALANCE_MISMATCH', 'Reserved Google Ads funds no longer match the wallet.');
      const authorization = (await query<{ id: string }>(
        `UPDATE workspace_ad_budget_authorizations SET reserved_amount=reserved_amount-$3,
           status=CASE
             WHEN status='ACTIVE' AND ends_at<=NOW() THEN 'EXPIRED'
             WHEN status='ACTIVE' AND consumed_amount>=authorized_amount THEN 'EXHAUSTED'
             ELSE status END,
           version=version+1
         WHERE workspace_id=$1 AND id=$2 AND reserved_amount >= $3 RETURNING id`,
        [input.workspaceId, reservation.authorizationId, remaining.toFixed(2)], client,
      )).rows[0];
      if (!authorization) throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_BALANCE_MISMATCH', 'Reserved Google Ads funds no longer match the campaign authorization.');
      const metadata = { ...reservation.metadata, releaseReason: 'Final Google Ads billing reconciliation', billingEvidenceId: input.evidenceId };
      await query(
        `UPDATE workspace_ad_spend_reservations SET status='RELEASED',metadata=$3::jsonb
         WHERE workspace_id=$1 AND id=$2`,
        [input.workspaceId, input.reservationId, JSON.stringify(metadata)], client,
      );
      await query(
        `INSERT INTO workspace_ad_spend_ledger(workspace_id,entry_type,amount_delta,balance_after,idempotency_key,metadata)
         VALUES($1,'RELEASE',$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
        [input.workspaceId, remaining.toFixed(2), wallet.availableAmount, `adspend-release:${input.reservationId}`,
          JSON.stringify({ ...metadata, reversalDebtAmount: Number(wallet.reversalDebtAmount) })], client,
      );
      await appendDomainEvent({
        workspaceId: input.workspaceId,
        type: DOMAIN_EVENT_TYPES.AD_BUDGET_RELEASED,
        aggregateType: 'ad_budget_authorization',
        aggregateId: reservation.authorizationId,
        payload: { authorizationId: reservation.authorizationId, reservationId: input.reservationId, amount: remaining,
          reason: 'Final Google Ads billing reconciliation' },
        metadata: { actorId: null, source: 'google-ads-reconciliation' },
        idempotencyKey: `ad-budget:${reservation.authorizationId}:reservation:${input.reservationId}:released`,
      }, client);
      availableAmount = wallet.availableAmount;
      reversalDebtAmount = wallet.reversalDebtAmount;
    } else if (reservation.status === 'RESERVED') {
      await query(
        `UPDATE workspace_ad_spend_reservations SET status='CONSUMED',settled_amount=amount,
           metadata=metadata||$3::jsonb WHERE workspace_id=$1 AND id=$2`,
        [input.workspaceId, input.reservationId, JSON.stringify({ billingEvidenceId: input.evidenceId })], client,
      );
      await query(
        `UPDATE workspace_ad_budget_authorizations SET status=CASE
           WHEN consumed_amount>=authorized_amount THEN 'EXHAUSTED'
           WHEN status='ACTIVE' AND ends_at<=NOW() THEN 'EXPIRED'
           ELSE status END,version=version+1
         WHERE workspace_id=$1 AND id=$2`,
        [input.workspaceId, reservation.authorizationId], client,
      );
    }
    const finalized = (await query<GoogleAdsSpendAllocation>(
      `UPDATE workspace_google_ads_spend_allocations SET closure_state='FINALIZED',finalized_at=COALESCE(finalized_at,NOW()),
         lease_owner=NULL,lease_expires_at=NULL,next_reconcile_at=NOW(),last_error_code=NULL,last_error_message=NULL
       WHERE workspace_id=$1 AND reservation_id=$2 RETURNING ${allocationSelect}`,
      [input.workspaceId, input.reservationId], client,
    )).rows[0]!;
    if (availableAmount !== null && reversalDebtAmount !== null
      && Number(availableAmount) > 0 && Number(reversalDebtAmount) === 0) {
      await appendDomainEvent({
        workspaceId: input.workspaceId,
        type: DOMAIN_EVENT_TYPES.AD_SPEND_FUNDED,
        aggregateType: 'ad_spend_wallet',
        aggregateId: input.workspaceId,
        payload: { reservationId: input.reservationId, releasedAmount: remaining, currency: 'CNY', availableAmount: Number(availableAmount) },
        metadata: { actorId: null, source: 'google-ads-reconciliation' },
        idempotencyKey: `adspend-release:${input.reservationId}:funded`,
      }, client);
    }
    return { allocation: finalized, releasedAmount: remaining, idempotent: false };
  });
}
