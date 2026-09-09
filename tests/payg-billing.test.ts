import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/payg_billing_tests_only';
process.env.JWT_SECRET = 'payg-billing-tests-secret-0123456789';

const { pool } = await import('../src/db/pool.js');
const { reservePaygApiCheckout } = await import('../src/modules/billing/payg-billing.repo.js');
const db = new PGlite();

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
});

after(async () => {
  mock.restoreAll();
  await pool.end();
  await db.close();
});

describe('PAYG API payment reservation', () => {
  it('allows wallet payment for an internally activated AI workspace', async () => {
    const user = (await db.query<{ id: string }>(
      `INSERT INTO users(email, password_hash) VALUES($1, 'hash') RETURNING id`,
      [`${crypto.randomUUID()}@test.local`],
    )).rows[0]!;
    const workspace = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name, created_by) VALUES('Internal AI Workspace', $1) RETURNING id`,
      [user.id],
    )).rows[0]!;
    await db.query(
      `INSERT INTO workspace_subscriptions(workspace_id, provider, plan_key, status)
       VALUES($1, 'internal', 'ai', 'trialing')`,
      [workspace.id],
    );
    await db.query(
      `INSERT INTO workspace_payg_profiles(
         workspace_id, interval_days, current_period_start, current_period_end,
         preferred_payment_method, payment_method_configured_at
       ) VALUES($1, 7, NOW() - INTERVAL '1 day', NOW() + INTERVAL '6 days', 'wechatpay', NOW())`,
      [workspace.id],
    );
    await db.query(
      `INSERT INTO ai_usage_ledger(
         workspace_id, user_id, provider, model, input_tokens, output_tokens, customer_cost_usd
       ) VALUES($1, $2, 'alibaba', 'deepseek-v4-pro', 1000, 500, 0.25)`,
      [workspace.id, user.id],
    );

    const reservation = await reservePaygApiCheckout(workspace.id, { requireBillingCustomer: false });

    assert.equal(Number(reservation.apiCostUsd), 0.25);
    assert.equal(reservation.providerCustomerId, null);
    assert.equal(reservation.preferredPaymentMethod, 'wechatpay');
    assert.equal(reservation.billingMode, 'api_pay_now');
    const ledger = await db.query<{ paygPeriodId: string | null }>(
      `SELECT payg_period_id AS "paygPeriodId" FROM ai_usage_ledger WHERE workspace_id=$1`,
      [workspace.id],
    );
    assert.equal(ledger.rows[0]?.paygPeriodId, reservation.id);
  });
});
