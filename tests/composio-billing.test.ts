import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/composio_billing_tests_only';
process.env.JWT_SECRET = 'composio-billing-tests-secret-0123456789';

const { pool } = await import('../src/db/pool.js');
const { chargeComposioUsage } = await import('../src/modules/composio/composio-usage.repo.js');
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

it('waives platform-admin Composio usage without debiting the workspace and keeps idempotency', async () => {
  const user = (await db.query<{ id: string }>(
    `INSERT INTO users(email,password_hash,verified_at) VALUES($1,'hash',NOW()) RETURNING id`,
    [`${crypto.randomUUID()}@test.local`],
  )).rows[0]!;
  const workspace = (await db.query<{ id: string }>(
    `INSERT INTO workspaces(name,created_by) VALUES($1,$2) RETURNING id`,
    [`Composio billing ${crypto.randomUUID()}`, user.id],
  )).rows[0]!;
  await db.query(`INSERT INTO workspace_api_wallets(workspace_id,available_amount) VALUES($1,2)`, [workspace.id]);

  const input = {
    workspaceId: workspace.id,
    userId: user.id,
    billingExempt: true,
    usageType: 'TOOL_CALL' as const,
    toolkitSlug: 'github',
    toolSlug: 'GITHUB_GET_ISSUES',
    idempotencyKey: `admin-${crypto.randomUUID()}`,
  };
  const first = await chargeComposioUsage(input);
  const duplicate = await chargeComposioUsage(input);

  assert.equal(first.waived, true);
  assert.equal(first.charged, false);
  assert.equal(first.amountCny, '0.000000');
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.waived, true);

  const wallet = (await db.query<{ availableAmount: string; spentAmount: string }>(
    `SELECT available_amount AS "availableAmount", spent_amount AS "spentAmount"
       FROM workspace_api_wallets WHERE workspace_id=$1`,
    [workspace.id],
  )).rows[0]!;
  assert.equal(wallet.availableAmount, '2.000000');
  assert.equal(wallet.spentAmount, '0.000000');

  const usage = (await db.query<{ amountCny: string; billingExempt: boolean }>(
    `SELECT amount_cny AS "amountCny", billing_exempt AS "billingExempt"
       FROM workspace_composio_usage_ledger WHERE workspace_id=$1`,
    [workspace.id],
  )).rows[0]!;
  assert.equal(usage.amountCny, '0.000000');
  assert.equal(usage.billingExempt, true);
});
