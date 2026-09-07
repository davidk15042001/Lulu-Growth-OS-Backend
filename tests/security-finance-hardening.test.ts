import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/security_finance_tests_only';
process.env.JWT_SECRET = 'security-finance-tests-only-secret';

const { pool } = await import('../src/db/pool.js');
const ledger = await import('../src/modules/finance/ledger.repo.js');
const usage = await import('../src/modules/usage/usage.service.js');
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

after(async () => { mock.restoreAll(); await pool.end(); await db.close(); });

describe('security and finance hardening', () => {
  it('keeps ledger entries append-only and idempotent', async () => {
    const user = (await db.query<{ id: string }>(`INSERT INTO users(email,password_hash,verified_at) VALUES($1,'hash',NOW()) RETURNING id`, [`${crypto.randomUUID()}@example.test`])).rows[0]!.id;
    const workspace = (await db.query<{ id: string }>(`INSERT INTO workspaces(name,created_by) VALUES('Ledger workspace',$1) RETURNING id`, [user])).rows[0]!.id;
    await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspace, user]);
    const input = { workspaceId: workspace, entryGroupId: crypto.randomUUID(), accountCode: 'LULU_COMMISSION', direction: 'CREDIT' as const, amountMinor: 5000, currency: 'cny', idempotencyKey: 'order:one:commission', actorId: user };
    const first = await ledger.appendLedgerEntry(input);
    const second = await ledger.appendLedgerEntry(input);
    assert.equal(first.id, second.id);
    await assert.rejects(() => db.query(`DELETE FROM financial_ledger_entries WHERE id=$1`, [first.id]), /append-only/);
    const balance = await ledger.getLedgerBalance(workspace, 'LULU_COMMISSION', 'CNY');
    assert.equal(balance.credits, 5000n);
  });

  it('records system AI usage without a human user and deduplicates provider retries', async () => {
    const user = (await db.query<{ id: string }>(`INSERT INTO users(email,password_hash,verified_at) VALUES($1,'hash',NOW()) RETURNING id`, [`${crypto.randomUUID()}@example.test`])).rows[0]!.id;
    const workspace = (await db.query<{ id: string }>(`INSERT INTO workspaces(name,created_by) VALUES('Usage workspace',$1) RETURNING id`, [user])).rows[0]!.id;
    await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspace, user]);
    const input = { workspaceId: workspace, userId: null, provider: 'deepseek', model: 'deepseek-v4-pro', inputTokens: 100, outputTokens: 50, responseId: `response-${crypto.randomUUID()}` };
    const first = await usage.recordUsage(input);
    const second = await usage.recordUsage(input);
    assert.ok(first?.id);
    assert.equal(first?.id, second?.id);
    const row = await db.query<{ user_id: string | null }>(`SELECT user_id FROM ai_usage_ledger WHERE id=$1`, [first?.id]);
    assert.equal(row.rows[0]?.user_id, null);
  });
});
