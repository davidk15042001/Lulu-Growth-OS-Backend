import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/google_ads_reconciliation_only';
process.env.JWT_SECRET = 'google-ads-reconciliation-test-secret';
process.env.PROVIDER_CREDENTIAL_KEY = '11'.repeat(32);
process.env.GOOGLE_ADS_DEVELOPER_TOKEN = 'developer-token-test';
process.env.GOOGLE_ADS_PREPAID_BILLING_ENABLED = 'true';
process.env.GOOGLE_ADS_PREPAID_PAYING_MANAGER_CUSTOMER_ID = '111-222-3333';
process.env.GOOGLE_ADS_PREPAID_PAYMENTS_ACCOUNT_ID = '1234-5678-9012-3456';
process.env.GOOGLE_ADS_PREPAID_PAYMENTS_PROFILE_ID = '1234-5678-9012';
process.env.GOOGLE_ADS_FINALIZATION_LAG_DAYS = '1';

const { pool } = await import('../src/db/pool.js');
const { encryptSecret } = await import('../src/utils/secret-box.js');
const adSpend = await import('../src/modules/adspend/adspend.repo.js');
const googleRepo = await import('../src/modules/adspend/google-ads-spend.repo.js');
const googleService = await import('../src/modules/adspend/google-ads-spend.service.js');
const db = new PGlite();

let observedCostMicros = 5_000_000n;
let campaignStatus = 'PAUSED';
let invoiceAvailable = false;
let mutationMode: 'success' | 'network-error' | 'rejected' = 'success';
let requestSequence = 0;

const billingSetup = {
  resourceName: 'customers/1234567890/billingSetups/4445556666',
  status: 'APPROVED',
  startDateTime: '2020-01-01 00:00:00',
  paymentsAccountInfo: {
    paymentsAccountId: '1234-5678-9012-3456',
    paymentsProfileId: '1234-5678-9012',
  },
};

before(async () => {
  for (const file of (await readdir('src/database/migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`src/database/migrations/${file}`, 'utf8'));
  }
  const execute = async (sql: string, values: unknown[] = []) => {
    const result = await db.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  mock.method(pool, 'query', execute as never);
  mock.method(pool, 'connect', (async () => ({ query: execute, release() {} })) as never);
  mock.method(globalThis, 'fetch', (async (input: string | URL | Request, init?: RequestInit) => {
    requestSequence += 1;
    const url = String(input);
    let body: Record<string, unknown>;
    if (url.includes('/invoices?')) {
      body = invoiceAvailable ? {
        invoices: [{
          id: 'INV-FINAL-1',
          type: 'INVOICE',
          billingSetup: billingSetup.resourceName,
          paymentsAccountId: billingSetup.paymentsAccountInfo.paymentsAccountId,
          paymentsProfileId: billingSetup.paymentsAccountInfo.paymentsProfileId,
          currencyCode: 'CNY',
          issueDate: '2099-01-01',
          serviceDateRange: { startDate: '2000-01-01', endDate: '2099-12-31' },
          subtotalAmountMicros: '10000000',
          totalAmountMicros: '10000000',
          accountBudgetSummaries: [{ customer: 'customers/1234567890' }],
        }],
      } : { invoices: [] };
    } else if (url.endsWith('/googleAds:mutate')) {
      if (mutationMode === 'network-error') throw new TypeError('socket closed after dispatch');
      if (mutationMode === 'rejected') return new Response(JSON.stringify({ error: { message: 'rejected' } }), {
        status: 400, headers: { 'content-type': 'application/json', 'request-id': `google-request-${requestSequence}` },
      });
      const request = JSON.parse(String(init?.body ?? '{}')) as { mutateOperations?: Array<Record<string, unknown>> };
      const serialized = JSON.stringify(request);
      campaignStatus = serialized.includes('PAUSED') ? 'PAUSED' : 'ENABLED';
      body = { mutateOperationResponses: [{}] };
    } else {
      const request = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
      if (request.query?.includes('metrics.cost_micros')) {
        body = { results: [{ campaign: { id: '987654321' }, segments: { date: '2026-09-13' }, metrics: { costMicros: observedCostMicros.toString() } }] };
      } else if (request.query?.includes('FROM billing_setup')) {
        body = { results: [{ billingSetup }] };
      } else {
        body = { results: [{
          customer: { currencyCode: 'CNY' },
          campaign: { id: '987654321', status: campaignStatus, campaignBudget: 'customers/1234567890/campaignBudgets/777888999' },
          campaignBudget: {
            resourceName: 'customers/1234567890/campaignBudgets/777888999',
            period: 'CUSTOM_PERIOD',
            totalAmountMicros: '105000000',
            explicitlyShared: false,
            referenceCount: '1',
          },
        }] };
      }
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', 'request-id': `google-request-${requestSequence}` },
    });
  }) as never);
});

after(async () => {
  mock.restoreAll();
  await pool.end();
  await db.close();
});

async function fixture() {
  const user = (await db.query<{ id: string }>(
    `INSERT INTO users(email,password_hash) VALUES($1,'hash') RETURNING id`,
    [`${crypto.randomUUID()}@test.local`],
  )).rows[0]!;
  const workspace = (await db.query<{ id: string }>(
    `INSERT INTO workspaces(name,created_by) VALUES('Google Ads allocation',$1) RETURNING id`, [user.id],
  )).rows[0]!;
  const platform = (await db.query<{ id: string }>(
    `INSERT INTO workspace_platforms(workspace_id,integration_key,name,category,connection_status,external_account_id)
     VALUES($1,'google-ads','Google Ads','advertising','connected','1234567890') RETURNING id`, [workspace.id],
  )).rows[0]!;
  await db.query(
    `INSERT INTO workspace_platform_oauth_credentials(platform_id,provider,encrypted_access_token)
     VALUES($1,'google-ads',$2)`, [platform.id, encryptSecret('access-token')],
  );
  const topup = await adSpend.createAdSpendTopup({ workspaceId: workspace.id, userId: user.id,
    netAmount: 100, feeAmount: 4, totalAmount: 104, paymentMethod: 'card' });
  await adSpend.attachAdSpendProviderPayment({ topupId: topup.id, status: 'PENDING_PAYMENT', providerPaymentIntentId: `pi_${workspace.id}` });
  await adSpend.applyAdSpendProviderStatus({ providerPaymentIntentId: `pi_${workspace.id}`, providerStatus: 'SUCCEEDED', settlementVerified: true });
  const authorization = await adSpend.createAdBudgetAuthorization({
    workspaceId: workspace.id,
    userId: user.id,
    provider: 'google-ads',
    accountId: '1234567890',
    campaignId: '987654321',
    currency: 'CNY',
    amount: 100,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    idempotencyKey: `authorize-${workspace.id}`,
  });
  return { user, workspace, authorization };
}

describe('Google Ads prepaid spend reconciliation', () => {
  it('keeps a successful launch cap reserved and settles only tenant-scoped observed cost deltas', async () => {
    observedCostMicros = 5_000_000n;
    campaignStatus = 'PAUSED';
    invoiceAvailable = false;
    mutationMode = 'success';
    const { workspace, authorization } = await fixture();
    const launched = await googleService.launchGoogleAdsAllocation(workspace.id, {
      provider: 'google-ads', action: 'launch', customerId: '123-456-7890', campaignId: '987654321',
      campaignBudgetId: '777888999', accountCurrency: 'CNY', budgetAmountCny: 100,
      authorizationId: authorization.id, operationKey: 'launch-one', loginCustomerId: '1112223333',
    });
    assert.equal(launched.allocationState, 'APPLIED');
    const replay = await googleService.launchGoogleAdsAllocation(workspace.id, {
      provider: 'google-ads', action: 'launch', customerId: '1234567890', campaignId: '987654321',
      campaignBudgetId: '777888999', accountCurrency: 'CNY', budgetAmountCny: 100,
      authorizationId: authorization.id, operationKey: 'launch-one', loginCustomerId: '1112223333',
    });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.reservationId, launched.reservationId);
    const afterLaunch = (await db.query<{ available: string; reserved: string; spent: string; status: string; settled: string }>(
      `SELECT w.available_amount AS available,w.reserved_amount AS reserved,w.spent_amount AS spent,
              r.status,r.settled_amount AS settled
       FROM workspace_ad_spend_wallets w JOIN workspace_ad_spend_reservations r ON r.workspace_id=w.workspace_id
       WHERE w.workspace_id=$1 AND r.id=$2`, [workspace.id, launched.reservationId],
    )).rows[0]!;
    assert.deepEqual({ available: Number(afterLaunch.available), reserved: Number(afterLaunch.reserved), spent: Number(afterLaunch.spent), status: afterLaunch.status, settled: Number(afterLaunch.settled) },
      { available: 0, reserved: 100, spent: 0, status: 'RESERVED', settled: 0 });

    const first = await googleRepo.recordGoogleAdsCostObservation({
      workspaceId: workspace.id, reservationId: launched.reservationId, idempotencyKey: 'provider-observation-shared-key',
      providerCostMicros: 17_345_678n, providerCampaignStatus: 'ENABLED', providerBudgetTotalMicros: 105_000_000n,
    });
    assert.equal(first.amountDelta, 12.34);
    assert.equal((await googleRepo.recordGoogleAdsCostObservation({
      workspaceId: workspace.id, reservationId: launched.reservationId, idempotencyKey: 'provider-observation-shared-key',
      providerCostMicros: 17_345_678n, providerCampaignStatus: 'ENABLED', providerBudgetTotalMicros: 105_000_000n,
    })).idempotent, true);
    const afterSpend = (await db.query<{ reserved: string; spent: string; settled: string }>(
      `SELECT w.reserved_amount AS reserved,w.spent_amount AS spent,r.settled_amount AS settled
       FROM workspace_ad_spend_wallets w JOIN workspace_ad_spend_reservations r ON r.workspace_id=w.workspace_id
       WHERE w.workspace_id=$1 AND r.id=$2`, [workspace.id, launched.reservationId],
    )).rows[0]!;
    assert.deepEqual({ reserved: Number(afterSpend.reserved), spent: Number(afterSpend.spent), settled: Number(afterSpend.settled) },
      { reserved: 87.66, spent: 12.34, settled: 12.34 });

    const corrected = await googleRepo.recordGoogleAdsCostObservation({
      workspaceId: workspace.id, reservationId: launched.reservationId, idempotencyKey: 'provider-observation-correction',
      providerCostMicros: 15_000_000n, providerCampaignStatus: 'ENABLED', providerBudgetTotalMicros: 105_000_000n,
    });
    assert.equal(corrected.amountDelta, -2.34);
    const afterCorrection = await adSpend.getAdSpendOverview(workspace.id);
    assert.equal(afterCorrection.wallet.reservedAmount, 90);
    assert.equal(afterCorrection.wallet.spentAmount, 10);

    const other = await fixture();
    const otherReservation = await adSpend.reserveAdSpend({ workspaceId: other.workspace.id, authorizationId: other.authorization.id,
      provider: 'google-ads', accountId: '1234567890', campaignId: '987654321', currency: 'CNY', amount: 100, idempotencyKey: 'other-launch' });
    await googleRepo.createGoogleAdsSpendAllocation({ workspaceId: other.workspace.id, reservationId: otherReservation.id,
      authorizationId: other.authorization.id, customerId: '1234567890', campaignId: '987654321',
      campaignBudgetResourceName: 'customers/1234567890/campaignBudgets/777888999', loginCustomerId: '1112223333',
      currency: 'CNY', capMicros: 100_000_000n, baselineCostMicros: 5_000_000n,
      billingSetupResourceName: billingSetup.resourceName, paymentsAccountId: billingSetup.paymentsAccountInfo.paymentsAccountId,
      paymentsProfileId: billingSetup.paymentsAccountInfo.paymentsProfileId, providerCampaignStatus: 'PAUSED' });
    const tenantScoped = await googleRepo.recordGoogleAdsCostObservation({
      workspaceId: other.workspace.id, reservationId: otherReservation.id, idempotencyKey: 'provider-observation-shared-key',
      providerCostMicros: 6_000_000n, providerCampaignStatus: 'ENABLED', providerBudgetTotalMicros: 105_000_000n,
    });
    assert.equal(tenantScoped.idempotent, false);
  });

  it('holds ambiguous/finalizing funds until matching invoice coverage exists, then releases only the unused remainder', async () => {
    observedCostMicros = 5_000_000n;
    campaignStatus = 'PAUSED';
    invoiceAvailable = false;
    mutationMode = 'success';
    const { workspace, authorization } = await fixture();
    const launched = await googleService.launchGoogleAdsAllocation(workspace.id, {
      provider: 'google-ads', action: 'launch', customerId: '1234567890', campaignId: '987654321',
      budgetAmountCny: 100, authorizationId: authorization.id, operationKey: 'launch-finalize',
    });
    observedCostMicros = 15_000_000n;
    await googleRepo.recordGoogleAdsCostObservation({ workspaceId: workspace.id, reservationId: launched.reservationId,
      idempotencyKey: 'initial-final-cost', providerCostMicros: observedCostMicros,
      providerCampaignStatus: 'PAUSED', providerBudgetTotalMicros: 105_000_000n });
    await googleRepo.requestGoogleAdsAllocationClosure({ workspaceId: workspace.id, reservationId: launched.reservationId, reason: 'test close' });
    await googleRepo.markGoogleAdsPauseOutcome({ workspaceId: workspace.id, reservationId: launched.reservationId, definitive: true });
    await db.query(
      `UPDATE workspace_google_ads_spend_allocations SET launched_at=NOW()-INTERVAL '2 days',
       provider_paused_at=NOW()-INTERVAL '2 days',last_cost_changed_at=NOW()-INTERVAL '2 days',
       stable_observation_count=2,closure_state='AWAITING_BILLING',next_reconcile_at=NOW(),
       lease_owner='test-worker',lease_expires_at=NOW()+INTERVAL '5 minutes'
       WHERE workspace_id=$1 AND reservation_id=$2`, [workspace.id, launched.reservationId],
    );
    const allocation = (await googleRepo.getGoogleAdsSpendAllocation(workspace.id, launched.reservationId))!;
    const pending = await googleService.reconcileGoogleAdsSpendAllocation(allocation, 'test-worker');
    assert.equal(pending.status, 'AWAITING_FINAL_BILLING');
    const stillHeld = await adSpend.getAdSpendOverview(workspace.id);
    assert.equal(stillHeld.wallet.reservedAmount, 90);
    assert.equal(stillHeld.wallet.availableAmount, 0);
    assert.equal(stillHeld.wallet.spentAmount, 10);

    invoiceAvailable = true;
    await db.query(`UPDATE workspace_google_ads_spend_allocations SET next_reconcile_at=NOW(),lease_owner='test-worker',
      lease_expires_at=NOW()+INTERVAL '5 minutes' WHERE workspace_id=$1 AND reservation_id=$2`,
      [workspace.id, launched.reservationId]);
    const refreshed = (await googleRepo.getGoogleAdsSpendAllocation(workspace.id, launched.reservationId))!;
    const finalized = await googleService.reconcileGoogleAdsSpendAllocation(refreshed, 'test-worker');
    assert.equal(finalized.status, 'FINALIZED');
    const released = (await db.query<{ available: string; reserved: string; spent: string; reservationStatus: string; closureState: string }>(
      `SELECT w.available_amount AS available,w.reserved_amount AS reserved,w.spent_amount AS spent,
              r.status AS "reservationStatus",a.closure_state AS "closureState"
       FROM workspace_ad_spend_wallets w
       JOIN workspace_ad_spend_reservations r ON r.workspace_id=w.workspace_id
       JOIN workspace_google_ads_spend_allocations a ON a.workspace_id=r.workspace_id AND a.reservation_id=r.id
       WHERE w.workspace_id=$1 AND r.id=$2`, [workspace.id, launched.reservationId],
    )).rows[0]!;
    assert.deepEqual({ available: Number(released.available), reserved: Number(released.reserved), spent: Number(released.spent),
      reservationStatus: released.reservationStatus, closureState: released.closureState },
    { available: 90, reserved: 0, spent: 10, reservationStatus: 'RELEASED', closureState: 'FINALIZED' });
  });

  it('keeps the full reservation when a provider launch outcome is ambiguous', async () => {
    observedCostMicros = 5_000_000n;
    campaignStatus = 'PAUSED';
    mutationMode = 'network-error';
    const { workspace, authorization } = await fixture();
    await assert.rejects(
      googleService.launchGoogleAdsAllocation(workspace.id, {
        provider: 'google-ads', action: 'launch', customerId: '1234567890', campaignId: '987654321',
        budgetAmountCny: 100, authorizationId: authorization.id, operationKey: 'launch-uncertain',
      }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
        && (error as { code: string }).code === 'GOOGLE_ADS_MUTATION_FAILED_OUTCOME_UNCERTAIN'),
    );
    const row = (await db.query<{ launchState: string; reservationStatus: string; available: string; reserved: string; spent: string }>(
      `SELECT a.launch_state AS "launchState",r.status AS "reservationStatus",w.available_amount AS available,
              w.reserved_amount AS reserved,w.spent_amount AS spent
       FROM workspace_google_ads_spend_allocations a
       JOIN workspace_ad_spend_reservations r ON r.workspace_id=a.workspace_id AND r.id=a.reservation_id
       JOIN workspace_ad_spend_wallets w ON w.workspace_id=a.workspace_id
       WHERE a.workspace_id=$1`, [workspace.id],
    )).rows[0]!;
    assert.deepEqual({ launchState: row.launchState, reservationStatus: row.reservationStatus,
      available: Number(row.available), reserved: Number(row.reserved), spent: Number(row.spent) },
    { launchState: 'UNCERTAIN', reservationStatus: 'RESERVED', available: 0, reserved: 100, spent: 0 });
    mutationMode = 'success';
  });

  it('releases the untouched cap only after a definitive provider rejection', async () => {
    observedCostMicros = 5_000_000n;
    campaignStatus = 'PAUSED';
    mutationMode = 'rejected';
    const { workspace, authorization } = await fixture();
    await assert.rejects(
      googleService.launchGoogleAdsAllocation(workspace.id, {
        provider: 'google-ads', action: 'launch', customerId: '1234567890', campaignId: '987654321',
        budgetAmountCny: 100, authorizationId: authorization.id, operationKey: 'launch-rejected',
      }),
      (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error
        && (error as { code: string }).code === 'GOOGLE_ADS_MUTATION_FAILED'),
    );
    const state = (await db.query<{ launchState: string; closureState: string; reservationStatus: string; available: string; reserved: string; spent: string }>(
      `SELECT a.launch_state AS "launchState",a.closure_state AS "closureState",r.status AS "reservationStatus",
              w.available_amount AS available,w.reserved_amount AS reserved,w.spent_amount AS spent
       FROM workspace_google_ads_spend_allocations a
       JOIN workspace_ad_spend_reservations r ON r.workspace_id=a.workspace_id AND r.id=a.reservation_id
       JOIN workspace_ad_spend_wallets w ON w.workspace_id=a.workspace_id WHERE a.workspace_id=$1`, [workspace.id],
    )).rows[0]!;
    assert.deepEqual({ launchState: state.launchState, closureState: state.closureState, reservationStatus: state.reservationStatus,
      available: Number(state.available), reserved: Number(state.reserved), spent: Number(state.spent) },
    { launchState: 'REJECTED', closureState: 'FINALIZED', reservationStatus: 'RELEASED', available: 100, reserved: 0, spent: 0 });
    mutationMode = 'success';
  });

  it('turns an expired customer authorization into a durable campaign-closure request', async () => {
    observedCostMicros = 5_000_000n;
    campaignStatus = 'PAUSED';
    mutationMode = 'success';
    const { workspace, authorization } = await fixture();
    const launched = await googleService.launchGoogleAdsAllocation(workspace.id, {
      provider: 'google-ads', action: 'launch', customerId: '1234567890', campaignId: '987654321',
      budgetAmountCny: 100, authorizationId: authorization.id, operationKey: 'launch-expiring',
    });
    await db.query(`UPDATE workspace_ad_budget_authorizations SET ends_at=NOW()-INTERVAL '1 second' WHERE workspace_id=$1 AND id=$2`,
      [workspace.id, authorization.id]);
    await googleRepo.claimGoogleAdsSpendAllocation('expiry-test-worker', 300);
    const allocation = await googleRepo.getGoogleAdsSpendAllocation(workspace.id, launched.reservationId);
    assert.equal(allocation?.closureState, 'REQUESTED');
    assert.match(allocation?.closeReason ?? '', /expired/i);
    const wallet = await adSpend.getAdSpendOverview(workspace.id);
    assert.equal(wallet.wallet.reservedAmount, 100);
    assert.equal(wallet.wallet.spentAmount, 0);
  });
});
