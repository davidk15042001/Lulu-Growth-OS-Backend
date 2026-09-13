import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/ai_spend_reservation_tests_only';
process.env.JWT_SECRET = 'ai-spend-reservation-tests-secret-0123456789';

const { pool } = await import('../src/db/pool.js');
const {
  fingerprintAiRequest,
  getAiReservationHealth,
  markAiSpendAmbiguous,
  markAiSpendSubmitted,
  markAiSpendSubmitting,
  releaseAiSpend,
  reserveAiSpend,
  settleAiSpend,
} = await import('../src/modules/api-wallet/ai-spend-reservation.repo.js');
const { resolveAiFundingMode } = await import('../src/modules/api-wallet/ai-funding-policy.js');
const { getApiWalletOverview } = await import('../src/modules/api-wallet/api-wallet.repo.js');
const { recordUsage } = await import('../src/modules/usage/usage.service.js');
const { getBilling } = await import('../src/modules/workspace-app/workspace-app.repo.js');

const db = new PGlite();

before(async () => {
  for (const file of (await readdir('src/database/migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`src/database/migrations/${file}`, 'utf8'));
  }

  const execute = async (sql: string, values: unknown[] = []) => {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
    const result = await db.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };

  // PGlite has one connection. Serialize mocked transaction clients so the
  // Promise.all test reproduces a real pool's lock ordering without nesting
  // transactions on that one connection.
  let transactionTail = Promise.resolve();
  mock.method(pool, 'query', execute as never);
  mock.method(pool, 'connect', (async () => {
    let unlock: (() => void) | null = null;
    return {
      query: async (sql: string, values: unknown[] = []) => {
        const command = sql.trim().toUpperCase();
        if (command === 'BEGIN') {
          const prior = transactionTail;
          transactionTail = new Promise<void>((resolve) => { unlock = resolve; });
          await prior;
        }
        try {
          return await execute(sql, values);
        } finally {
          if ((command === 'COMMIT' || command === 'ROLLBACK') && unlock) {
            unlock();
            unlock = null;
          }
        }
      },
      release() {
        if (unlock) {
          unlock();
          unlock = null;
        }
      },
    };
  }) as never);
});

after(async () => {
  mock.restoreAll();
  await pool.end();
  await db.close();
});

async function seedWorkspace(input: {
  available?: number;
  provider?: string;
  planKey?: string;
  status?: 'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled' | 'expired';
} = {}) {
  const user = (await db.query<{ id: string }>(
    `INSERT INTO users(email,password_hash) VALUES($1,'hash') RETURNING id`,
    [`${crypto.randomUUID()}@test.local`],
  )).rows[0]!;
  const workspace = (await db.query<{ id: string }>(
    `INSERT INTO workspaces(name,created_by) VALUES($1,$2) RETURNING id`,
    [`Wallet ${crypto.randomUUID()}`, user.id],
  )).rows[0]!;
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspace.id, user.id]);
  await db.query(
    `INSERT INTO workspace_subscriptions(workspace_id,provider,plan_key,status)
     VALUES($1,$2,$3,$4)`,
    [workspace.id, input.provider ?? 'airwallex', input.planKey ?? 'starter', input.status ?? 'active'],
  );
  const available = input.available ?? 100;
  await db.query(
    `INSERT INTO workspace_api_wallets(workspace_id,available_amount,total_funded_amount)
     VALUES($1,$2,$2)`,
    [workspace.id, available],
  );
  return { userId: user.id, workspaceId: workspace.id };
}

async function walletState(workspaceId: string) {
  return (await db.query<{
    available: string;
    reserved: string;
    spent: string;
    debt: string;
    funded: string;
  }>(
    `SELECT available_amount AS available,reserved_amount AS reserved,spent_amount AS spent,
            reversal_debt_amount AS debt,total_funded_amount AS funded
       FROM workspace_api_wallets WHERE workspace_id=$1`,
    [workspaceId],
  )).rows[0]!;
}

function reservationInput(workspaceId: string, userId: string, key: string, maximumUsd = 10, rate = 8) {
  return {
    workspaceId,
    userId,
    requestKey: key,
    requestFingerprint: fingerprintAiRequest({ key, prompt: 'same canonical request' }),
    operation: 'test.chat',
    maximumCustomerCostUsd: maximumUsd,
    usdCnyRate: rate,
    pricingSnapshot: { test: true },
    provider: 'openai',
    model: 'gpt-test',
  };
}

function hasCode(code: string) {
  return (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

describe('durable prepaid AI spend reservations', () => {
  it('reserves exactly once under a concurrent replay and exposes the hold publicly', async () => {
    const { workspaceId, userId } = await seedWorkspace();
    const input = reservationInput(workspaceId, userId, 'concurrent-operation');
    const [first, second] = await Promise.all([reserveAiSpend(input), reserveAiSpend(input)]);

    assert.equal(first.funding.mode, 'CUSTOMER_PREPAID');
    assert.equal(second.funding.mode, 'CUSTOMER_PREPAID');
    assert.deepEqual([first.idempotent, second.idempotent].sort(), [false, true]);
    assert.equal(first.reservation?.id, second.reservation?.id);

    const wallet = await walletState(workspaceId);
    assert.equal(Number(wallet.available), 20);
    assert.equal(Number(wallet.reserved), 80);
    const counts = (await db.query<{ reservations: string; reserveEntries: string }>(
      `SELECT
         (SELECT COUNT(*) FROM ai_spend_reservations WHERE workspace_id=$1)::text AS reservations,
         (SELECT COUNT(*) FROM workspace_api_wallet_ledger WHERE workspace_id=$1 AND entry_type='USAGE_RESERVE')::text AS "reserveEntries"`,
      [workspaceId],
    )).rows[0]!;
    assert.equal(Number(counts.reservations), 1);
    assert.equal(Number(counts.reserveEntries), 1);

    const directOverview = await getApiWalletOverview(workspaceId);
    assert.equal(directOverview.wallet.reservedAmount, 80);
    const billingProjection = await getBilling(workspaceId, userId, {});
    assert.equal(billingProjection.apiWallet.reservedAmount, 80);

    await assert.rejects(
      reserveAiSpend({ ...input, requestFingerprint: fingerprintAiRequest({ prompt: 'different' }) }),
      hasCode('AI_RESERVATION_KEY_REUSED'),
    );
  });

  it('uses exact ceiling arithmetic for the smallest representable CNY hold', async () => {
    const { workspaceId, userId } = await seedWorkspace({ available: 1 });
    const result = await reserveAiSpend(reservationInput(workspaceId, userId, 'minimum-hold', 0.00000001, 1));
    assert.equal(result.reservation?.reservedAmount, 0.000001);
    const wallet = await walletState(workspaceId);
    assert.equal(wallet.reserved, '0.000001');
    assert.equal(wallet.available, '0.999999');
  });

  it('pays refund debt from a released hold and never makes reversed money spendable', async () => {
    const { workspaceId, userId } = await seedWorkspace();
    const reserved = await reserveAiSpend(reservationInput(workspaceId, userId, 'release-after-refund'));
    assert.ok(reserved.reservation);
    await db.query(
      `UPDATE workspace_api_wallets
          SET available_amount=0,total_funded_amount=0,reversal_debt_amount=80
        WHERE workspace_id=$1`,
      [workspaceId],
    );

    const releaseInput = {
      workspaceId,
      reservationId: reserved.reservation.id,
      disposition: 'BEFORE_SUBMISSION' as const,
      reason: 'cancelled_before_provider_submission',
    };
    const releases = await Promise.all([releaseAiSpend(releaseInput), releaseAiSpend(releaseInput)]);
    assert.deepEqual(releases.map((result) => result.idempotent).sort(), [false, true]);

    const wallet = await walletState(workspaceId);
    assert.deepEqual(
      [wallet.available, wallet.reserved, wallet.spent, wallet.debt, wallet.funded],
      ['0.000000', '0.000000', '0.000000', '0.000000', '0.00'],
    );
  });

  it('settles once, applies unused hold to refund debt, and rejects contradictory finalization', async () => {
    const { workspaceId, userId } = await seedWorkspace();
    const reserved = await reserveAiSpend(reservationInput(workspaceId, userId, 'settle-after-refund'));
    assert.ok(reserved.reservation);
    await markAiSpendSubmitting(workspaceId, reserved.reservation.id);
    await markAiSpendSubmitted({
      workspaceId,
      reservationId: reserved.reservation.id,
      provider: 'openai',
      model: 'gpt-test',
      providerRequestId: 'provider-response-refund',
    });
    const usage = (await db.query<{ id: string }>(
      `INSERT INTO ai_usage_ledger(
         workspace_id,user_id,provider,model,provider_cost_usd,customer_cost_usd,metadata,reservation_id
       ) VALUES($1,$2,'openai','gpt-test',1,5,$3::jsonb,$4) RETURNING id`,
      [workspaceId, userId, JSON.stringify({ responseId: 'provider-response-refund', fundingMode: 'CUSTOMER_PREPAID' }), reserved.reservation.id],
    )).rows[0]!;
    await db.query(
      `UPDATE workspace_api_wallets
          SET available_amount=0,total_funded_amount=0,reversal_debt_amount=80
        WHERE workspace_id=$1`,
      [workspaceId],
    );

    const settlement = {
      workspaceId,
      reservationId: reserved.reservation.id,
      usageLedgerId: usage.id,
      provider: 'openai',
      model: 'gpt-test',
      providerRequestId: 'provider-response-refund',
      actualCustomerCostUsd: 5,
    };
    const settlements = await Promise.all([settleAiSpend(settlement), settleAiSpend(settlement)]);
    const first = settlements.find((result) => !result.idempotent);
    assert.ok(first);
    assert.equal(first.charged, 40);
    assert.equal(first.debtPaid, 40);
    assert.equal(first.returned, 0);
    assert.deepEqual(settlements.map((result) => result.idempotent).sort(), [false, true]);

    const wallet = await walletState(workspaceId);
    assert.deepEqual(
      [wallet.available, wallet.reserved, wallet.spent, wallet.debt, wallet.funded],
      ['0.000000', '0.000000', '40.000000', '40.000000', '0.00'],
    );
    assert.equal(Number(wallet.available) + Number(wallet.reserved) + Number(wallet.spent) - Number(wallet.debt), Number(wallet.funded));
    await assert.rejects(
      releaseAiSpend({ workspaceId, reservationId: reserved.reservation.id, disposition: 'BEFORE_SUBMISSION', reason: 'late_release' }),
      hasCode('AI_RESERVATION_ALREADY_SETTLED'),
    );
    await assert.rejects(
      settleAiSpend({ ...settlement, providerRequestId: 'different-response' }),
      hasCode('AI_RESERVATION_SETTLEMENT_MISMATCH'),
    );
  });

  it('honors submission-time funding when plans or admin-skip state change later', async () => {
    const customer = await seedWorkspace({ available: 20 });
    const reserved = await reserveAiSpend(reservationInput(customer.workspaceId, customer.userId, 'funding-snapshot', 10, 1));
    assert.ok(reserved.reservation);
    await markAiSpendSubmitting(customer.workspaceId, reserved.reservation.id);
    await markAiSpendSubmitted({
      workspaceId: customer.workspaceId,
      reservationId: reserved.reservation.id,
      provider: 'openai',
      model: 'gpt-test',
      providerRequestId: 'customer-funded-response',
    });
    await db.query(
      `UPDATE workspace_subscriptions SET provider='internal',plan_key='ai',status='active' WHERE workspace_id=$1`,
      [customer.workspaceId],
    );
    await recordUsage({
      workspaceId: customer.workspaceId,
      userId: customer.userId,
      provider: 'openai',
      model: 'gpt-test',
      inputTokens: 1_000_000,
      outputTokens: 0,
      responseId: 'customer-funded-response',
      reservationId: reserved.reservation.id,
      fundingMode: 'CUSTOMER_PREPAID',
    });
    const customerWallet = await walletState(customer.workspaceId);
    assert.equal(Number(customerWallet.reserved), 0);
    assert.equal(Number(customerWallet.available), 15);
    assert.equal(Number(customerWallet.spent), 5);

    const platform = await seedWorkspace({ available: 20, provider: 'internal', planKey: 'ai' });
    const decision = await resolveAiFundingMode(platform.workspaceId, platform.userId);
    assert.equal(decision.mode, 'PLATFORM_FUNDED');
    await db.query(
      `UPDATE workspace_subscriptions SET provider='airwallex',plan_key='starter',status='active' WHERE workspace_id=$1`,
      [platform.workspaceId],
    );
    await recordUsage({
      workspaceId: platform.workspaceId,
      userId: platform.userId,
      provider: 'openai',
      model: 'gpt-test',
      inputTokens: 1_000_000,
      outputTokens: 0,
      responseId: 'platform-funded-response',
      fundingMode: 'PLATFORM_FUNDED',
    });
    const platformWallet = await walletState(platform.workspaceId);
    assert.equal(Number(platformWallet.available), 20);
    assert.equal(Number(platformWallet.spent), 0);
    assert.equal((await db.query(
      `SELECT id FROM workspace_api_wallet_ledger WHERE workspace_id=$1 AND entry_type='USAGE_DEBIT'`,
      [platform.workspaceId],
    )).rows.length, 0);
    await assert.rejects(
      recordUsage({
        workspaceId: platform.workspaceId,
        userId: platform.userId,
        provider: 'openai',
        model: 'gpt-test',
        inputTokens: 1_000_000,
        outputTokens: 0,
        responseId: 'platform-funded-response',
        fundingMode: 'CUSTOMER_PREPAID',
      }),
      hasCode('AI_USAGE_IDEMPOTENCY_MISMATCH'),
    );
  });

  it('requires active internal/test funding, keeps billing skip prepaid, and reports every unresolved state', async () => {
    const inactive = await seedWorkspace({ provider: 'internal', planKey: 'test', status: 'cancelled' });
    assert.equal((await resolveAiFundingMode(inactive.workspaceId, inactive.userId)).mode, 'CUSTOMER_PREPAID');
    await db.query(`UPDATE workspaces SET billing_skipped_at=NOW(),billing_skipped_by=$2 WHERE id=$1`, [inactive.workspaceId, inactive.userId]);
    const skipped = await resolveAiFundingMode(inactive.workspaceId, inactive.userId);
    assert.deepEqual(skipped, { mode: 'CUSTOMER_PREPAID', bypassReason: null });
    const skippedReservation = await reserveAiSpend(reservationInput(inactive.workspaceId, inactive.userId, 'billing-skip-still-prepaid', 1, 1));
    assert.ok(skippedReservation.reservation);
    await markAiSpendSubmitting(inactive.workspaceId, skippedReservation.reservation.id);
    await markAiSpendSubmitted({
      workspaceId: inactive.workspaceId,
      reservationId: skippedReservation.reservation.id,
      provider: 'openai',
      model: 'gpt-test',
      providerRequestId: 'billing-skip-customer-funded-response',
    });
    await recordUsage({
      workspaceId: inactive.workspaceId,
      userId: inactive.userId,
      provider: 'openai',
      model: 'gpt-test',
      inputTokens: 200_000,
      outputTokens: 0,
      responseId: 'billing-skip-customer-funded-response',
      reservationId: skippedReservation.reservation.id,
      fundingMode: 'CUSTOMER_PREPAID',
    });
    const skippedWallet = await walletState(inactive.workspaceId);
    assert.equal(Number(skippedWallet.reserved), 0);
    assert.equal(Number(skippedWallet.spent), 1);

    const skippedWithoutFunds = await seedWorkspace({ available: 0 });
    await db.query(
      `UPDATE workspaces SET billing_skipped_at=NOW(),billing_skipped_by=$2 WHERE id=$1`,
      [skippedWithoutFunds.workspaceId, skippedWithoutFunds.userId],
    );
    assert.equal((await resolveAiFundingMode(skippedWithoutFunds.workspaceId, skippedWithoutFunds.userId)).mode, 'CUSTOMER_PREPAID');
    await assert.rejects(
      reserveAiSpend(reservationInput(skippedWithoutFunds.workspaceId, skippedWithoutFunds.userId, 'billing-skip-no-funds', 1, 1)),
      hasCode('AI_FUNDS_REQUIRED'),
    );

    const visible = await seedWorkspace();
    const first = await reserveAiSpend(reservationInput(visible.workspaceId, visible.userId, 'health-reserved', 1, 1));
    const second = await reserveAiSpend(reservationInput(visible.workspaceId, visible.userId, 'health-ambiguous', 1, 1));
    assert.ok(first.reservation && second.reservation);
    await markAiSpendSubmitting(visible.workspaceId, second.reservation.id);
    await markAiSpendAmbiguous(visible.workspaceId, second.reservation.id, 'provider_outcome_unknown:timeout');
    const health = await getAiReservationHealth();
    assert.ok(health.reservedCount >= 1);
    assert.ok(health.ambiguousCount >= 1);
    assert.ok(health.unresolvedCount >= health.reservedCount + health.ambiguousCount);
    assert.equal(health.walletHoldMismatchCount, 0);
    assert.equal(health.walletHoldMismatchAmount, 0);
    assert.ok(health.oldestUnresolvedAt);
  });
});
