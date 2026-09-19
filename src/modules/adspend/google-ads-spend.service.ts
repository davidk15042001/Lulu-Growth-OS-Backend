import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../utils/app-error.js';
import { decryptSecret } from '../../utils/secret-box.js';
import { getPlatformOAuthCredential } from '../onboarding/onboarding.repo.js';
import { refreshStoredOAuthCredential } from '../onboarding/oauth.service.js';
import { releaseAdSpendReservation, reserveAdSpend } from './adspend.repo.js';
import {
  createGoogleAdsSpendAllocation,
  getGoogleAdsSpendAllocation,
  getGoogleAdsSpendAllocationByOperationKey,
  getOpenGoogleAdsSpendAllocation,
  googleAdsBillingEvidenceId,
  finalizeGoogleAdsSpendAllocation,
  markGoogleAdsLaunchApplied,
  markGoogleAdsLaunchRejected,
  markGoogleAdsLaunchUncertain,
  markGoogleAdsPauseOutcome,
  markGoogleAdsAllocationResumed,
  recordGoogleAdsBillingEvidence,
  recordGoogleAdsCostObservation,
  renewGoogleAdsSpendAllocationLease,
  requestGoogleAdsAllocationClosure,
  scheduleGoogleAdsSpendAllocation,
  listWorkspacePausedGoogleAdsAllocations,
  type GoogleAdsSpendAllocation,
} from './google-ads-spend.repo.js';
import { assertWorkspaceAutomationActive } from '../workspaces/workspace-automation.service.js';
import type { AdsComplianceContext } from '../advertising-compliance/advertising-compliance.service.js';
import { assertAdsCompliancePassed, runAdsComplianceGate } from '../advertising-compliance/advertising-compliance.service.js';

export type GoogleAdsOperation = {
  provider: 'google-ads';
  action: 'launch' | 'pause';
  customerId: string;
  campaignId: string;
  campaignBudgetId?: string;
  accountCurrency?: string;
  budgetAmountCny?: number;
  loginCustomerId?: string;
  authorizationId?: string;
  operationKey?: string;
  /** Evidence supplied to the mandatory Ads Compliance Agent before launch. */
  compliance?: AdsComplianceContext | null;
};

async function assertGoogleAdsCompliance(workspaceId: string, operationKey: string, context: AdsComplianceContext | null | undefined) {
  const result = await runAdsComplianceGate({ workspaceId, provider: 'google-ads', action: 'launch', context: { ...(context ?? {}), idempotencyKey: operationKey } });
  assertAdsCompliancePassed(result);
}

type GoogleAdsPayer = {
  loginCustomerId: string;
  paymentsAccountId: string;
  paymentsProfileId: string;
};

type ProviderReply = { body: Record<string, unknown>; requestId: string | null };

type GoogleCampaignSnapshot = {
  customerId: string;
  campaignId: string;
  campaignStatus: string;
  campaignBudgetResourceName: string;
  budgetPeriod: string;
  budgetTotalMicros: bigint;
  budgetExplicitlyShared: boolean;
  budgetReferenceCount: number;
  currency: string;
  costMicros: bigint;
  billingSetupResourceName: string;
  paymentsAccountId: string;
  paymentsProfileId: string;
  contextRequestId: string | null;
  costRequestId: string | null;
  billingRequestId: string | null;
};

export type GoogleAdsAccountProbe = {
  customerId: string;
  currency: string | null;
  requestId: string | null;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function digits(value: string, label = 'Google Ads identifier') {
  const normalized = value.replaceAll('-', '').trim();
  if (!/^\d+$/.test(normalized)) throw new AppError(400, 'AD_PROVIDER_IDENTIFIER_INVALID', `${label} must contain digits only.`);
  return normalized;
}

function providerInt(value: unknown, label: string) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : stringValue(value);
  if (!/^\d+$/.test(text)) throw new AppError(409, 'GOOGLE_ADS_PROVIDER_RESPONSE_INVALID', `Google Ads returned an invalid ${label}.`);
  const parsed = BigInt(text);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError(409, 'GOOGLE_ADS_PROVIDER_RESPONSE_INVALID', `Google Ads returned an unsupported ${label}.`);
  return parsed;
}

function requiredPayer(): GoogleAdsPayer {
  if (!env.GOOGLE_ADS_PREPAID_BILLING_ENABLED) {
    throw new AppError(503, 'GOOGLE_ADS_PREPAID_BILLING_UNCONFIRMED', 'Autonomous launch is disabled until managed Google Ads prepaid billing is confirmed.');
  }
  const loginCustomerId = env.GOOGLE_ADS_PREPAID_PAYING_MANAGER_CUSTOMER_ID;
  const paymentsAccountId = env.GOOGLE_ADS_PREPAID_PAYMENTS_ACCOUNT_ID;
  const paymentsProfileId = env.GOOGLE_ADS_PREPAID_PAYMENTS_PROFILE_ID;
  if (!loginCustomerId || !paymentsAccountId || !paymentsProfileId) {
    throw new AppError(503, 'GOOGLE_ADS_PAYER_MAPPING_MISSING', 'Managed Google Ads payer identifiers are not configured; campaign funds remain unavailable.');
  }
  return {
    loginCustomerId: digits(loginCustomerId, 'Google Ads paying manager customer ID'),
    paymentsAccountId: digits(paymentsAccountId, 'Google Ads payments account ID'),
    paymentsProfileId: digits(paymentsProfileId, 'Google Ads payments profile ID'),
  };
}

async function googleAccessToken(workspaceId: string) {
  const credential = await getPlatformOAuthCredential(workspaceId, 'google-ads');
  if (!credential) throw new AppError(409, 'GOOGLE_ADS_NOT_CONNECTED', 'Connect a Google Ads account before launching paid campaigns.');
  const expiresAt = credential.tokenExpiresAt ? Date.parse(credential.tokenExpiresAt) : null;
  if (expiresAt !== null && expiresAt <= Date.now() + 300_000) {
    return refreshStoredOAuthCredential({ workspaceId, provider: 'google-ads', encryptedRefreshToken: credential.encryptedRefreshToken });
  }
  return decryptSecret(credential.encryptedAccessToken);
}

async function googleHeaders(workspaceId: string, payer: GoogleAdsPayer) {
  if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) throw new AppError(503, 'GOOGLE_ADS_CONFIGURATION_MISSING', 'GOOGLE_ADS_DEVELOPER_TOKEN is not configured.');
  const token = await googleAccessToken(workspaceId);
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN,
    ...(payer.loginCustomerId ? { 'login-customer-id': payer.loginCustomerId } : {}),
  };
}

/** Configuration state used by the Provider Control Plane. */
export function isGoogleAdsPrepaidConfigured() {
  return Boolean(
    env.GOOGLE_ADS_PREPAID_BILLING_ENABLED
    && env.GOOGLE_ADS_PREPAID_PAYING_MANAGER_CUSTOMER_ID
    && env.GOOGLE_ADS_PREPAID_PAYMENTS_ACCOUNT_ID
    && env.GOOGLE_ADS_PREPAID_PAYMENTS_PROFILE_ID,
  );
}

/**
 * Read-only Google Ads account probe. It only reads the customer resource and
 * never creates, updates, pauses, launches, or reserves a campaign budget.
 */
export async function verifyGoogleAdsAccount(workspaceId: string, customerIdInput: string): Promise<GoogleAdsAccountProbe> {
  if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) throw new AppError(503, 'GOOGLE_ADS_CONFIGURATION_MISSING', 'GOOGLE_ADS_DEVELOPER_TOKEN is not configured.');
  const customerId = digits(customerIdInput, 'Google Ads customer ID');
  const loginCustomerId = env.GOOGLE_ADS_PREPAID_PAYING_MANAGER_CUSTOMER_ID
    ? digits(env.GOOGLE_ADS_PREPAID_PAYING_MANAGER_CUSTOMER_ID, 'Google Ads login customer ID')
    : customerId;
  const headers = await googleHeaders(workspaceId, { loginCustomerId, paymentsAccountId: '0', paymentsProfileId: '0' });
  const result = await googleSearch(customerId, headers, 'SELECT customer.id, customer.currency_code FROM customer LIMIT 1', 'GOOGLE_ADS_ACCOUNT_READ_FAILED');
  const row = objectValue(arrayValue(result.body.results)[0]);
  const customer = objectValue(row.customer);
  const returnedId = digits(stringValue(customer.id) || customerId, 'Google Ads customer ID');
  return { customerId: returnedId, currency: stringValue(customer.currencyCode).toUpperCase() || null, requestId: result.requestId };
}

async function googleRequest(url: string, init: RequestInit, code: string, message: string): Promise<ProviderReply> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(Math.min(env.AI_REQUEST_TIMEOUT_MS, 60_000)) });
  } catch (error) {
    throw new AppError(502, `${code}_OUTCOME_UNCERTAIN`, `${message} Google Ads did not return a definitive response.`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new AppError(502, code, message, { providerHttpStatus: response.status, providerResponse: body });
  return { body, requestId: response.headers.get('request-id') };
}

async function googleSearch(customerId: string, headers: Record<string, string>, gaql: string, code: string) {
  return googleRequest(
    `https://googleads.googleapis.com/v25/customers/${customerId}/googleAds:search`,
    { method: 'POST', headers, body: JSON.stringify({ query: gaql }) },
    code,
    'Google Ads campaign reconciliation data could not be verified.',
  );
}

function activeBillingSetup(rows: unknown[], payer: GoogleAdsPayer) {
  const now = Date.now();
  return rows.map((item) => objectValue(objectValue(item).billingSetup)).find((setup) => {
    const info = objectValue(setup.paymentsAccountInfo);
    const startText = stringValue(setup.startDateTime);
    const endText = stringValue(setup.endDateTime);
    const start = startText ? Date.parse(startText.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(startText) ? '' : 'Z')) : Number.NaN;
    const end = endText ? Date.parse(endText.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(endText) ? '' : 'Z')) : Number.POSITIVE_INFINITY;
    return stringValue(setup.status).toUpperCase() === 'APPROVED'
      && Number.isFinite(start) && start <= now && end > now
      && digits(stringValue(info.paymentsAccountId) || '0') === payer.paymentsAccountId
      && digits(stringValue(info.paymentsProfileId) || '0') === payer.paymentsProfileId;
  });
}

async function readGoogleCampaignSnapshot(
  workspaceId: string,
  customerIdInput: string,
  campaignIdInput: string,
  payer: GoogleAdsPayer,
): Promise<GoogleCampaignSnapshot> {
  const customerId = digits(customerIdInput, 'Google Ads customer ID');
  const campaignId = digits(campaignIdInput, 'Google Ads campaign ID');
  const headers = await googleHeaders(workspaceId, payer);
  const context = await googleSearch(customerId, headers,
    `SELECT customer.currency_code, campaign.id, campaign.status, campaign.campaign_budget, campaign_budget.resource_name, campaign_budget.period, campaign_budget.total_amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count FROM campaign WHERE campaign.id = ${campaignId} LIMIT 1`,
    'GOOGLE_ADS_CONTEXT_READ_FAILED');
  const contextRow = objectValue(arrayValue(context.body.results)[0]);
  const campaign = objectValue(contextRow.campaign);
  const budget = objectValue(contextRow.campaignBudget);
  const customer = objectValue(contextRow.customer);
  const campaignBudgetResourceName = stringValue(campaign.campaignBudget) || stringValue(budget.resourceName);
  const campaignStatus = stringValue(campaign.status).toUpperCase();
  const budgetPeriod = stringValue(budget.period).toUpperCase();
  const currency = stringValue(customer.currencyCode).toUpperCase();
  if (!campaignBudgetResourceName || !campaignStatus || !budgetPeriod || !currency
    || typeof budget.explicitlyShared !== 'boolean' || !Number.isSafeInteger(Number(budget.referenceCount))) {
    throw new AppError(409, 'GOOGLE_ADS_CAMPAIGN_CONTEXT_INCOMPLETE', 'Google Ads did not return a complete campaign and budget context.');
  }
  const budgetTotalMicros = providerInt(budget.totalAmountMicros ?? '0', 'campaign budget total');

  const costs = await googleSearch(customerId, headers,
    `SELECT campaign.id, segments.date, metrics.cost_micros FROM campaign WHERE campaign.id = ${campaignId} AND segments.date DURING ALL_TIME`,
    'GOOGLE_ADS_COST_READ_FAILED');
  let costMicros = 0n;
  for (const item of arrayValue(costs.body.results)) {
    const metrics = objectValue(objectValue(item).metrics);
    costMicros += providerInt(metrics.costMicros ?? '0', 'campaign cost');
  }
  if (costMicros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AppError(409, 'GOOGLE_ADS_PROVIDER_RESPONSE_INVALID', 'Google Ads returned an unsupported aggregate campaign cost.');
  }

  const billing = await googleSearch(customerId, headers,
    'SELECT billing_setup.resource_name, billing_setup.status, billing_setup.start_date_time, billing_setup.end_date_time, billing_setup.payments_account_info.payments_account_id, billing_setup.payments_account_info.payments_profile_id FROM billing_setup',
    'GOOGLE_ADS_BILLING_SETUP_READ_FAILED');
  const setup = activeBillingSetup(arrayValue(billing.body.results), payer);
  if (!setup) throw new AppError(409, 'GOOGLE_ADS_PAYER_MAPPING_UNVERIFIED', 'The live Google Ads BillingSetup does not match Lulu’s configured prepaid payer.');
  const info = objectValue(setup.paymentsAccountInfo);
  const billingSetupResourceName = stringValue(setup.resourceName);
  if (!billingSetupResourceName) throw new AppError(409, 'GOOGLE_ADS_PAYER_MAPPING_UNVERIFIED', 'Google Ads returned no billing setup resource for the configured payer.');
  return {
    customerId,
    campaignId,
    campaignStatus,
    campaignBudgetResourceName,
    budgetPeriod,
    budgetTotalMicros,
    budgetExplicitlyShared: budget.explicitlyShared,
    budgetReferenceCount: Number(budget.referenceCount),
    currency,
    costMicros,
    billingSetupResourceName,
    paymentsAccountId: digits(stringValue(info.paymentsAccountId)),
    paymentsProfileId: digits(stringValue(info.paymentsProfileId)),
    contextRequestId: context.requestId,
    costRequestId: costs.requestId,
    billingRequestId: billing.requestId,
  };
}

function launchBudget(input: GoogleAdsOperation) {
  const authorizationId = input.authorizationId?.trim();
  const operationKey = input.operationKey?.trim();
  const amount = input.budgetAmountCny;
  if (!authorizationId || !operationKey || !Number.isFinite(amount) || Number(amount) <= 0) {
    throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_REQUIRED', 'A concrete customer campaign budget authorization, positive amount and operation key are required.');
  }
  const rounded = Math.round(Number(amount) * 100) / 100;
  if (rounded !== Number(amount)) throw new AppError(422, 'AD_SPEND_AMOUNT_INVALID', 'Google Ads budgets must use at most two CNY decimal places.');
  return { authorizationId, operationKey, amount: rounded, capMicros: BigInt(Math.round(rounded * 1_000_000)) };
}

function launchMutationBody(snapshot: GoogleCampaignSnapshot, desiredTotalBudgetMicros: bigint) {
  return {
    mutateOperations: [
      { campaignBudgetOperation: { update: { resourceName: snapshot.campaignBudgetResourceName, totalAmountMicros: desiredTotalBudgetMicros.toString() }, updateMask: 'total_amount_micros' } },
      { campaignOperation: { update: { resourceName: `customers/${snapshot.customerId}/campaigns/${snapshot.campaignId}`, status: 'ENABLED' }, updateMask: 'status' } },
    ],
    partialFailure: false,
  };
}

function pauseMutationBody(customerId: string, campaignId: string) {
  return {
    mutateOperations: [{ campaignOperation: { update: { resourceName: `customers/${customerId}/campaigns/${campaignId}`, status: 'PAUSED' }, updateMask: 'status' } }],
    partialFailure: false,
  };
}

async function mutateGoogleCampaign(workspaceId: string, payer: GoogleAdsPayer, customerId: string, body: Record<string, unknown>) {
  return googleRequest(
    `https://googleads.googleapis.com/v25/customers/${customerId}/googleAds:mutate`,
    { method: 'POST', headers: await googleHeaders(workspaceId, payer), body: JSON.stringify(body) },
    'GOOGLE_ADS_MUTATION_FAILED',
    'Google Ads rejected the autonomous campaign operation.',
  );
}

export async function launchGoogleAdsAllocation(workspaceId: string, input: GoogleAdsOperation) {
  await assertWorkspaceAutomationActive(workspaceId);
  const requested = launchBudget(input);
  const payer = requiredPayer();
  if (input.loginCustomerId && digits(input.loginCustomerId) !== payer.loginCustomerId) {
    throw new AppError(409, 'GOOGLE_ADS_PAYING_MANAGER_MISMATCH', 'The requested Google Ads manager is not the configured prepaid paying manager.');
  }
  const requestedCustomerId = digits(input.customerId, 'Google Ads customer ID');
  const requestedCampaignId = digits(input.campaignId, 'Google Ads campaign ID');
  const priorAllocation = await getGoogleAdsSpendAllocationByOperationKey(workspaceId, requested.operationKey);
  if (priorAllocation) {
    if (priorAllocation.authorizationId !== requested.authorizationId
      || priorAllocation.customerId !== requestedCustomerId || priorAllocation.campaignId !== requestedCampaignId
      || BigInt(priorAllocation.capMicros) !== requested.capMicros) {
      throw new AppError(409, 'AD_SPEND_IDEMPOTENCY_CONFLICT', 'This ad spend operation key was already used for a different Google Ads allocation.');
    }
    if (priorAllocation.launchState === 'APPLIED') {
      return { provider: 'google-ads' as const, action: 'launch' as const,
        providerOperationId: priorAllocation.providerRequestId,
        response: objectValue(priorAllocation.metadata.providerResult), reservationId: priorAllocation.reservationId,
        authorizationId: requested.authorizationId, budgetAmountCny: requested.amount,
        allocationState: priorAllocation.launchState, idempotent: true };
    }
    throw new AppError(409, 'AD_SPEND_OPERATION_UNCERTAIN', 'This campaign operation already has a pending, uncertain, or closed allocation and will not be replayed.', {
      reservationId: priorAllocation.reservationId, launchState: priorAllocation.launchState, closureState: priorAllocation.closureState,
    });
  }
  const snapshot = await readGoogleCampaignSnapshot(workspaceId, input.customerId, input.campaignId, payer);
  if (snapshot.currency !== 'CNY') throw new AppError(409, 'AD_SPEND_CURRENCY_UNSUPPORTED', 'Autonomous launch requires the Google Ads account currency to be CNY.');
  if (snapshot.budgetPeriod !== 'CUSTOM_PERIOD') throw new AppError(409, 'AD_SPEND_BUDGET_PERIOD_UNSUPPORTED', 'Autonomous launch requires a Google Ads CUSTOM_PERIOD lifetime budget.');
  if (snapshot.budgetExplicitlyShared || snapshot.budgetReferenceCount !== 1) {
    throw new AppError(409, 'GOOGLE_ADS_SHARED_BUDGET_UNSUPPORTED', 'A prepaid campaign requires a non-shared budget used by exactly one campaign.');
  }
  if (snapshot.campaignStatus !== 'PAUSED') {
    throw new AppError(409, 'GOOGLE_ADS_CAMPAIGN_NOT_PAUSED', 'A campaign must be paused while Lulu records its cost baseline and applies the prepaid cap.');
  }
  if (input.campaignBudgetId && !snapshot.campaignBudgetResourceName.endsWith(`/campaignBudgets/${digits(input.campaignBudgetId, 'Google Ads campaign budget ID')}`)) {
    throw new AppError(409, 'GOOGLE_ADS_CAMPAIGN_BUDGET_MISMATCH', 'The requested budget does not belong to the target Google Ads campaign.');
  }
  if (input.accountCurrency && input.accountCurrency.toUpperCase() !== snapshot.currency) {
    throw new AppError(409, 'GOOGLE_ADS_ACCOUNT_CURRENCY_MISMATCH', 'The requested currency does not match the live Google Ads account currency.');
  }

  const reservation = await reserveAdSpend({
    workspaceId,
    authorizationId: requested.authorizationId,
    amount: requested.amount,
    idempotencyKey: requested.operationKey,
    provider: 'google-ads',
    accountId: snapshot.customerId,
    campaignId: snapshot.campaignId,
    currency: 'CNY',
    metadata: { provider: 'google-ads', action: 'launch', baselineCostMicros: snapshot.costMicros.toString() },
  });

  let allocation: GoogleAdsSpendAllocation;
  try {
    allocation = await createGoogleAdsSpendAllocation({
      workspaceId,
      reservationId: reservation.id,
      authorizationId: requested.authorizationId,
      customerId: snapshot.customerId,
      campaignId: snapshot.campaignId,
      campaignBudgetResourceName: snapshot.campaignBudgetResourceName,
      loginCustomerId: payer.loginCustomerId,
      currency: 'CNY',
      capMicros: requested.capMicros,
      baselineCostMicros: snapshot.costMicros,
      billingSetupResourceName: snapshot.billingSetupResourceName,
      paymentsAccountId: snapshot.paymentsAccountId,
      paymentsProfileId: snapshot.paymentsProfileId,
      providerCampaignStatus: snapshot.campaignStatus,
      metadata: {
        contextRequestId: snapshot.contextRequestId,
        costRequestId: snapshot.costRequestId,
        billingRequestId: snapshot.billingRequestId,
        // Keep the evidence that cleared the publication gate with the
        // allocation.  Workspace-wide pause/resume must re-use the same
        // canonical compliance context instead of silently bypassing it.
        compliance: input.compliance ?? null,
      },
    });
  } catch (error) {
    if (!reservation.idempotent) {
      await releaseAdSpendReservation({ workspaceId, reservationId: reservation.id, reason: 'Google Ads allocation setup failed before provider dispatch' }).catch(() => undefined);
    }
    throw error;
  }

  if (reservation.idempotent || (allocation as GoogleAdsSpendAllocation & { idempotent?: boolean }).idempotent) {
    if (allocation.launchState === 'APPLIED') {
      return { provider: 'google-ads' as const, action: 'launch' as const, providerOperationId: allocation.providerRequestId,
        response: objectValue(allocation.metadata.providerResult), reservationId: reservation.id,
        authorizationId: requested.authorizationId, budgetAmountCny: requested.amount, allocationState: allocation.launchState, idempotent: true };
    }
    throw new AppError(409, 'AD_SPEND_OPERATION_UNCERTAIN', 'This campaign operation already has a pending, uncertain, or closed allocation and will not be replayed.', {
      reservationId: reservation.id, launchState: allocation.launchState, closureState: allocation.closureState,
    });
  }

  const desiredTotalBudgetMicros = snapshot.costMicros + requested.capMicros;
  let provider: ProviderReply;
  try {
    provider = await mutateGoogleCampaign(workspaceId, payer, snapshot.customerId, launchMutationBody(snapshot, desiredTotalBudgetMicros));
  } catch (error) {
    const definitiveRejection = error instanceof AppError && error.code === 'GOOGLE_ADS_MUTATION_FAILED';
    if (definitiveRejection) {
      try {
        await releaseAdSpendReservation({ workspaceId, reservationId: reservation.id, reason: 'Google Ads definitively rejected campaign launch', metadata: { providerError: error.message } });
        await markGoogleAdsLaunchRejected({ workspaceId, reservationId: reservation.id, metadata: { providerError: error.message } });
      } catch (settlementError) {
        await markGoogleAdsLaunchUncertain({ workspaceId, reservationId: reservation.id, error: settlementError }).catch(() => undefined);
        throw new AppError(503, 'AD_SPEND_SETTLEMENT_UNCERTAIN', 'Google Ads rejected the launch, but Lulu could not release its local reservation. Funds remain held.', {
          reservationId: reservation.id, cause: settlementError instanceof Error ? settlementError.message : String(settlementError),
        });
      }
    } else {
      await markGoogleAdsLaunchUncertain({ workspaceId, reservationId: reservation.id, error }).catch(() => undefined);
    }
    throw error;
  }

  try {
    allocation = await markGoogleAdsLaunchApplied({
      workspaceId,
      reservationId: reservation.id,
      providerRequestId: provider.requestId,
      providerCampaignStatus: 'ENABLED',
      metadata: { providerResult: provider.body },
    });
  } catch (error) {
    await markGoogleAdsLaunchUncertain({ workspaceId, reservationId: reservation.id, error }).catch(() => undefined);
    throw new AppError(503, 'AD_SPEND_SETTLEMENT_UNCERTAIN', 'Google Ads accepted the launch, but Lulu could not persist the provider outcome. The full cap remains held for reconciliation.', {
      reservationId: reservation.id, providerOperationId: provider.requestId, cause: error instanceof Error ? error.message : String(error),
    });
  }
  return { provider: 'google-ads' as const, action: 'launch' as const, providerOperationId: provider.requestId,
    response: provider.body, reservationId: reservation.id, authorizationId: requested.authorizationId,
    budgetAmountCny: requested.amount, allocationState: allocation.launchState, idempotent: false };
}

export async function pauseGoogleAdsCampaign(workspaceId: string, input: GoogleAdsOperation) {
  const customerId = digits(input.customerId, 'Google Ads customer ID');
  const campaignId = digits(input.campaignId, 'Google Ads campaign ID');
  const allocation = await getOpenGoogleAdsSpendAllocation({ workspaceId, customerId, campaignId });
  const unmanagedLogin = input.loginCustomerId ?? env.GOOGLE_ADS_PREPAID_PAYING_MANAGER_CUSTOMER_ID;
  const payer: GoogleAdsPayer = allocation
    ? { loginCustomerId: allocation.loginCustomerId, paymentsAccountId: allocation.paymentsAccountId, paymentsProfileId: allocation.paymentsProfileId }
    : { loginCustomerId: unmanagedLogin ? digits(unmanagedLogin, 'Google Ads manager customer ID') : '', paymentsAccountId: '0', paymentsProfileId: '0' };
  if (allocation) await requestGoogleAdsAllocationClosure({ workspaceId, reservationId: allocation.reservationId, reason: 'Campaign pause requested' });
  try {
    const provider = await mutateGoogleCampaign(workspaceId, payer, customerId, pauseMutationBody(customerId, campaignId));
    if (allocation) await markGoogleAdsPauseOutcome({ workspaceId, reservationId: allocation.reservationId, definitive: true, providerRequestId: provider.requestId });
    return { provider: 'google-ads' as const, action: 'pause' as const, providerOperationId: provider.requestId,
      response: provider.body, ...(allocation ? { reservationId: allocation.reservationId, closureState: 'PROVIDER_PAUSED' as const } : {}) };
  } catch (error) {
    if (allocation) await markGoogleAdsPauseOutcome({ workspaceId, reservationId: allocation.reservationId, definitive: false, error }).catch(() => undefined);
    throw error;
  }
}

/**
 * Resume campaigns that were paused by the workspace-wide Agents switch.
 *
 * An allocation whose prepaid reservation is still held is resumed in place;
 * no additional ad budget is created.  Once the old allocation has already
 * completed provider billing, the normal launch path is used instead.  That
 * path re-checks the customer authorization and the available ad wallet, so
 * a campaign never restarts without an explicit, funded budget.
 *
 * Provider failures are intentionally isolated per campaign.  The workspace
 * switch remains enabled and the affected campaign stays paused until a
 * later reconciliation or an explicit retry can safely resume it.
 */
export async function resumeWorkspaceGoogleAdsCampaigns(workspaceId: string) {
  await assertWorkspaceAutomationActive(workspaceId);
  const allocations = await listWorkspacePausedGoogleAdsAllocations(workspaceId);
  const results: Array<{ reservationId: string; status: 'RESUMED' | 'SKIPPED' | 'FAILED'; reason?: string }> = [];

  for (const allocation of allocations) {
    try {
      await assertWorkspaceAutomationActive(workspaceId);

      // A finalized allocation has released its old hold.  Relaunch through
      // the regular launch flow so authorization and wallet funds are checked
      // atomically before Google Ads is enabled again.
      if (allocation.closureState === 'FINALIZED') {
        const budgetAmountCny = Number(BigInt(allocation.capMicros)) / 1_000_000;
        const complianceContext = allocation.metadata?.compliance as AdsComplianceContext | undefined;
        await assertGoogleAdsCompliance(workspaceId, `workspace-resume:${allocation.reservationId}`, complianceContext);
        await launchGoogleAdsAllocation(workspaceId, {
          provider: 'google-ads', action: 'launch',
          customerId: allocation.customerId, campaignId: allocation.campaignId,
          loginCustomerId: allocation.loginCustomerId,
          authorizationId: allocation.authorizationId,
          budgetAmountCny,
          operationKey: `workspace-resume:${allocation.reservationId}`,
          compliance: complianceContext ?? null,
        });
        results.push({ reservationId: allocation.reservationId, status: 'RESUMED' });
        continue;
      }

      // The original prepaid hold is the budget for an in-place resume.  If
      // reconciliation has already released it, leave the campaign paused;
      // the finalized branch above is the only safe relaunch path.
      if (allocation.reservationStatus !== 'RESERVED') {
        results.push({ reservationId: allocation.reservationId, status: 'SKIPPED', reason: 'Ad budget reservation is no longer held.' });
        continue;
      }

      const payer: GoogleAdsPayer = {
        loginCustomerId: allocation.loginCustomerId,
        paymentsAccountId: allocation.paymentsAccountId,
        paymentsProfileId: allocation.paymentsProfileId,
      };
      if (!configuredPayerMatches(allocation, requiredPayer())) {
        results.push({ reservationId: allocation.reservationId, status: 'SKIPPED', reason: 'Google Ads payer mapping changed.' });
        continue;
      }
      const snapshot = await readGoogleCampaignSnapshot(workspaceId, allocation.customerId, allocation.campaignId, payer);
      if (snapshot.billingSetupResourceName !== allocation.billingSetupResourceName
        || snapshot.paymentsAccountId !== allocation.paymentsAccountId
        || snapshot.paymentsProfileId !== allocation.paymentsProfileId) {
        results.push({ reservationId: allocation.reservationId, status: 'SKIPPED', reason: 'Google Ads billing mapping changed.' });
        continue;
      }
      const desiredBudget = BigInt(allocation.desiredTotalBudgetMicros);
      // Never use the activation switch to increase an externally changed
      // campaign budget.  The customer must authorize that explicitly.
      if (snapshot.budgetTotalMicros !== desiredBudget) {
        results.push({ reservationId: allocation.reservationId, status: 'SKIPPED', reason: 'Campaign budget no longer matches the authorized cap.' });
        continue;
      }
      if (!['PAUSED', 'ENABLED'].includes(snapshot.campaignStatus)) {
        results.push({ reservationId: allocation.reservationId, status: 'SKIPPED', reason: `Campaign is ${snapshot.campaignStatus}, not safely resumable.` });
        continue;
      }
      const provider = snapshot.campaignStatus === 'ENABLED'
        ? null
        : await (async () => {
          await assertGoogleAdsCompliance(workspaceId, `workspace-resume:${allocation.reservationId}`, allocation.metadata?.compliance as AdsComplianceContext | undefined);
          return mutateGoogleCampaign(workspaceId, payer, allocation.customerId, launchMutationBody(snapshot, desiredBudget));
        })();
      const resumed = await markGoogleAdsAllocationResumed({
        workspaceId, reservationId: allocation.reservationId, providerRequestId: provider?.requestId ?? null,
      });
      if (!resumed || resumed.closureState !== 'OPEN') {
        results.push({ reservationId: allocation.reservationId, status: 'SKIPPED', reason: 'Allocation was already finalized during resume.' });
      } else {
        results.push({ reservationId: allocation.reservationId, status: 'RESUMED' });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn({ error, workspaceId, reservationId: allocation.reservationId }, 'Google Ads campaign could not be resumed after workspace activation');
      results.push({ reservationId: allocation.reservationId, status: 'FAILED', reason: reason.slice(0, 500) });
    }
  }
  return results;
}

function observationKey(allocation: GoogleAdsSpendAllocation, snapshot: GoogleCampaignSnapshot) {
  const seed = snapshot.costRequestId ?? `${snapshot.costMicros}:${snapshot.campaignStatus}:${snapshot.budgetTotalMicros}:${Math.floor(Date.now() / 300_000)}`;
  return `google-ads-cost:${allocation.reservationId}:${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

const monthNames = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

function issueMonths(from: Date, through: Date) {
  const months: Array<{ year: number; month: string }> = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(through.getUTCFullYear(), through.getUTCMonth(), 1));
  while (cursor <= end && months.length < 36) {
    months.push({ year: cursor.getUTCFullYear(), month: monthNames[cursor.getUTCMonth()]! });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function utcDay(value: string | Date) {
  const parsed = value instanceof Date ? value : new Date(value);
  return Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
}

function invoiceCoverage(invoices: Record<string, unknown>[], allocation: GoogleAdsSpendAllocation) {
  const expectedCustomer = `customers/${allocation.customerId}`;
  const accepted = invoices.flatMap((invoice) => {
    const service = objectValue(invoice.serviceDateRange);
    const startDate = stringValue(service.startDate);
    const endDate = stringValue(service.endDate);
    const accountMatches = arrayValue(invoice.accountBudgetSummaries).some((summary) => stringValue(objectValue(summary).customer) === expectedCustomer);
    const mappingMatches = stringValue(invoice.billingSetup) === allocation.billingSetupResourceName
      && digits(stringValue(invoice.paymentsAccountId) || '0') === allocation.paymentsAccountId
      && digits(stringValue(invoice.paymentsProfileId) || '0') === allocation.paymentsProfileId
      && stringValue(invoice.currencyCode).toUpperCase() === allocation.currency
      && stringValue(invoice.type).toUpperCase() === 'INVOICE';
    if (!startDate || !endDate || !accountMatches || !mappingMatches) return [];
    const start = Date.parse(`${startDate}T00:00:00Z`);
    const end = Date.parse(`${endDate}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return [];
    return [{ id: stringValue(invoice.id), issueDate: stringValue(invoice.issueDate), start, end,
      subtotalAmountMicros: stringValue(invoice.subtotalAmountMicros), totalAmountMicros: stringValue(invoice.totalAmountMicros) }];
  }).sort((left, right) => left.start - right.start);
  if (!allocation.launchedAt || !allocation.providerPausedAt) return null;
  const requiredStart = utcDay(allocation.launchedAt);
  const requiredEnd = utcDay(allocation.providerPausedAt);
  let coveredThrough = requiredStart - 86_400_000;
  const used: typeof accepted = [];
  for (const invoice of accepted) {
    if (invoice.end < requiredStart || invoice.start > requiredEnd || invoice.start > coveredThrough + 86_400_000) continue;
    used.push(invoice);
    coveredThrough = Math.max(coveredThrough, invoice.end);
    if (coveredThrough >= requiredEnd) break;
  }
  if (coveredThrough < requiredEnd || used.some((item) => !item.id)) return null;
  return used;
}

async function readGoogleFinalBillingEvidence(allocation: GoogleAdsSpendAllocation, payer: GoogleAdsPayer, workerId: string) {
  if (!allocation.launchedAt || !allocation.providerPausedAt || !allocation.lastCostChangedAt) return null;
  const stableSince = Math.max(Date.parse(allocation.providerPausedAt), Date.parse(allocation.lastCostChangedAt));
  if (!Number.isFinite(stableSince) || Date.now() - stableSince < env.GOOGLE_ADS_FINALIZATION_LAG_DAYS * 86_400_000) return null;
  const headers = await googleHeaders(allocation.workspaceId, payer);
  const replies: ProviderReply[] = [];
  const months = issueMonths(new Date(allocation.launchedAt), new Date());
  for (let offset = 0; offset < months.length; offset += 4) {
    await renewGoogleAdsSpendAllocationLease({ workspaceId: allocation.workspaceId, reservationId: allocation.reservationId,
      workerId, leaseSeconds: env.GOOGLE_ADS_RECONCILIATION_LEASE_SECONDS });
    replies.push(...await Promise.all(months.slice(offset, offset + 4).map((issue) => {
      const params = new URLSearchParams({
        billingSetup: allocation.billingSetupResourceName,
        issueYear: String(issue.year),
        issueMonth: issue.month,
      });
      return googleRequest(
        `https://googleads.googleapis.com/v25/customers/${allocation.customerId}/invoices?${params}`,
        { method: 'GET', headers },
        'GOOGLE_ADS_INVOICE_READ_FAILED',
        'Google Ads final billing evidence could not be read.',
      );
    })));
  }
  const invoices = replies.flatMap((reply) => arrayValue(reply.body.invoices).map(objectValue));
  const coverage = invoiceCoverage(invoices, allocation);
  if (!coverage) return null;
  return {
    requestIds: replies.map((reply) => reply.requestId).filter((value): value is string => Boolean(value)),
    invoiceIds: coverage.map((invoice) => invoice.id),
    serviceCoverage: coverage.map((invoice) => ({ start: new Date(invoice.start).toISOString().slice(0, 10), end: new Date(invoice.end).toISOString().slice(0, 10) })),
    invoices: coverage.map(({ id, issueDate, subtotalAmountMicros, totalAmountMicros }) => ({ id, issueDate, subtotalAmountMicros, totalAmountMicros })),
    verifiedAt: new Date().toISOString(),
  };
}

function configuredPayerMatches(allocation: GoogleAdsSpendAllocation, payer: GoogleAdsPayer) {
  return allocation.loginCustomerId === payer.loginCustomerId
    && allocation.paymentsAccountId === payer.paymentsAccountId
    && allocation.paymentsProfileId === payer.paymentsProfileId;
}

export async function reconcileGoogleAdsSpendAllocation(allocationInput: GoogleAdsSpendAllocation, workerId: string) {
  if (allocationInput.leaseOwner !== workerId || !allocationInput.leaseExpiresAt
    || Date.parse(allocationInput.leaseExpiresAt) <= Date.now()) {
    throw new AppError(409, 'GOOGLE_ADS_RECONCILIATION_LEASE_LOST', 'A current tenant-scoped reconciliation lease is required before provider reads or wallet settlement.');
  }
  const payer = requiredPayer();
  if (!configuredPayerMatches(allocationInput, payer)) {
    throw new AppError(409, 'GOOGLE_ADS_PAYER_MAPPING_CHANGED', 'Configured Google Ads payer mapping differs from the immutable launch mapping. Funds remain held.');
  }
  const snapshot = await readGoogleCampaignSnapshot(allocationInput.workspaceId, allocationInput.customerId, allocationInput.campaignId, payer);
  if (snapshot.billingSetupResourceName !== allocationInput.billingSetupResourceName
    || snapshot.paymentsAccountId !== allocationInput.paymentsAccountId
    || snapshot.paymentsProfileId !== allocationInput.paymentsProfileId) {
    throw new AppError(409, 'GOOGLE_ADS_PAYER_MAPPING_CHANGED', 'Live Google Ads payer mapping differs from the launch mapping. Funds remain held.');
  }
  const observed = await recordGoogleAdsCostObservation({
    workspaceId: allocationInput.workspaceId,
    reservationId: allocationInput.reservationId,
    idempotencyKey: observationKey(allocationInput, snapshot),
    providerRequestId: snapshot.costRequestId,
    providerCostMicros: snapshot.costMicros,
    providerCampaignStatus: snapshot.campaignStatus,
    providerBudgetTotalMicros: snapshot.budgetTotalMicros,
    evidence: { contextRequestId: snapshot.contextRequestId, billingRequestId: snapshot.billingRequestId,
      billingSetupResourceName: snapshot.billingSetupResourceName, paymentsAccountId: snapshot.paymentsAccountId,
      paymentsProfileId: snapshot.paymentsProfileId },
  });
  let allocation = observed.allocation;
  const providerAlreadyStopped = ['PAUSED', 'REMOVED', 'ENDED'].includes(snapshot.campaignStatus);
  if (allocation.closureState === 'OPEN' && providerAlreadyStopped) {
    allocation = (await requestGoogleAdsAllocationClosure({
      workspaceId: allocation.workspaceId,
      reservationId: allocation.reservationId,
      reason: `Google Ads campaign entered ${snapshot.campaignStatus}`,
    })) ?? allocation;
    allocation = await markGoogleAdsPauseOutcome({ workspaceId: allocation.workspaceId,
      reservationId: allocation.reservationId, definitive: true, providerRequestId: snapshot.contextRequestId });
  }
  const budgetMismatch = snapshot.budgetTotalMicros !== BigInt(allocation.desiredTotalBudgetMicros);
  if (observed.overCap || budgetMismatch || allocation.launchState !== 'APPLIED') {
    allocation = (await requestGoogleAdsAllocationClosure({
      workspaceId: allocation.workspaceId,
      reservationId: allocation.reservationId,
      reason: observed.overCap ? 'Provider cost exceeded customer cap' : budgetMismatch ? 'Provider budget cap changed outside Lulu' : 'Launch outcome requires safe closure',
    })) ?? allocation;
  }

  if (['REQUESTED', 'PAUSE_UNCERTAIN'].includes(allocation.closureState) && providerAlreadyStopped) {
    allocation = await markGoogleAdsPauseOutcome({ workspaceId: allocation.workspaceId,
      reservationId: allocation.reservationId, definitive: true, providerRequestId: snapshot.contextRequestId });
  }

  if (['REQUESTED', 'PAUSE_UNCERTAIN'].includes(allocation.closureState) && !providerAlreadyStopped) {
    try {
      const provider = await mutateGoogleCampaign(allocation.workspaceId, payer, allocation.customerId, pauseMutationBody(allocation.customerId, allocation.campaignId));
      allocation = await markGoogleAdsPauseOutcome({ workspaceId: allocation.workspaceId, reservationId: allocation.reservationId,
        definitive: true, providerRequestId: provider.requestId });
    } catch (error) {
      await markGoogleAdsPauseOutcome({ workspaceId: allocation.workspaceId, reservationId: allocation.reservationId, definitive: false, error }).catch(() => undefined);
      throw error;
    }
  } else {
    allocation = (await getGoogleAdsSpendAllocation(allocation.workspaceId, allocation.reservationId)) ?? allocation;
  }

  if (!['PROVIDER_PAUSED', 'AWAITING_BILLING'].includes(allocation.closureState)) {
    await scheduleGoogleAdsSpendAllocation({ workspaceId: allocation.workspaceId, reservationId: allocation.reservationId,
      workerId, delaySeconds: env.GOOGLE_ADS_ACTIVE_RECONCILE_INTERVAL_SECONDS });
    return { status: 'ACTIVE' as const, amountDelta: observed.amountDelta };
  }
  if (BigInt(allocation.overCapMicros) > 0n) {
    await scheduleGoogleAdsSpendAllocation({ workspaceId: allocation.workspaceId, reservationId: allocation.reservationId,
      workerId, delaySeconds: env.GOOGLE_ADS_BILLING_RETRY_INTERVAL_SECONDS,
      errorCode: 'GOOGLE_ADS_CAP_EXCEEDED', errorMessage: 'Provider cost exceeded the authorized cap; automatic release is blocked.' });
    return { status: 'BLOCKED_OVER_CAP' as const, amountDelta: observed.amountDelta };
  }
  if (allocation.stableObservationCount < 2) {
    await scheduleGoogleAdsSpendAllocation({ workspaceId: allocation.workspaceId, reservationId: allocation.reservationId,
      workerId, delaySeconds: env.GOOGLE_ADS_ACTIVE_RECONCILE_INTERVAL_SECONDS });
    return { status: 'AWAITING_STABLE_COST' as const, amountDelta: observed.amountDelta };
  }
  const billingEvidence = await readGoogleFinalBillingEvidence(allocation, payer, workerId);
  if (!billingEvidence) {
    await scheduleGoogleAdsSpendAllocation({ workspaceId: allocation.workspaceId, reservationId: allocation.reservationId,
      workerId, delaySeconds: env.GOOGLE_ADS_BILLING_RETRY_INTERVAL_SECONDS,
      errorCode: 'GOOGLE_ADS_FINAL_BILLING_PENDING', errorMessage: 'Final matching Google Ads invoice coverage is not available yet; funds remain reserved.' });
    return { status: 'AWAITING_FINAL_BILLING' as const, amountDelta: observed.amountDelta };
  }
  const evidenceId = googleAdsBillingEvidenceId({ reservationId: allocation.reservationId, evidence: billingEvidence });
  const recorded = await recordGoogleAdsBillingEvidence({
    workspaceId: allocation.workspaceId,
    reservationId: allocation.reservationId,
    idempotencyKey: evidenceId,
    providerRequestId: billingEvidence.requestIds.join(',').slice(0, 240) || null,
    billingSetupResourceName: allocation.billingSetupResourceName,
    paymentsAccountId: allocation.paymentsAccountId,
    paymentsProfileId: allocation.paymentsProfileId,
    evidence: billingEvidence,
  });
  allocation = recorded.allocation;
  await finalizeGoogleAdsSpendAllocation({ workspaceId: allocation.workspaceId, reservationId: allocation.reservationId, evidenceId });
  return { status: 'FINALIZED' as const, amountDelta: observed.amountDelta };
}
