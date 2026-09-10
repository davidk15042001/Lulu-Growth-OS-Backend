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

  it('records premium provider costs once for callback and polling retries', async () => {
    const user = (await db.query<{ id: string }>(`INSERT INTO users(email,password_hash,verified_at) VALUES($1,'hash',NOW()) RETURNING id`, [`${crypto.randomUUID()}@example.test`])).rows[0]!.id;
    const workspace = (await db.query<{ id: string }>(`INSERT INTO workspaces(name,created_by) VALUES('Premium usage workspace',$1) RETURNING id`, [user])).rows[0]!.id;
    await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspace, user]);
    const input = { workspaceId: workspace, userId: null, provider: 'kie.ai', model: 'veo3', providerCostUsd: 0.42, customerCostUsd: 0.84, responseId: `kie-task:${crypto.randomUUID()}`, metadata: { creditsConsumed: 84 } };
    const first = await usage.recordMeteredUsage(input);
    const second = await usage.recordMeteredUsage(input);
    assert.ok(first?.id);
    assert.equal(first?.id, second?.id);
    const rows = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ai_usage_ledger WHERE workspace_id=$1 AND metadata->>'responseId'=$2`, [workspace, input.responseId]);
    assert.equal(rows.rows[0]?.count, '1');
  });

  it('rejects generic record parents, relationships and assignees from another workspace', async () => {
    const userA = (await db.query<{ id: string }>(`INSERT INTO users(email,password_hash,verified_at) VALUES($1,'hash',NOW()) RETURNING id`, [`${crypto.randomUUID()}@example.test`])).rows[0]!.id;
    const userB = (await db.query<{ id: string }>(`INSERT INTO users(email,password_hash,verified_at) VALUES($1,'hash',NOW()) RETURNING id`, [`${crypto.randomUUID()}@example.test`])).rows[0]!.id;
    const workspaceA = (await db.query<{ id: string }>(`INSERT INTO workspaces(name,created_by) VALUES('Records A',$1) RETURNING id`, [userA])).rows[0]!.id;
    const workspaceB = (await db.query<{ id: string }>(`INSERT INTO workspaces(name,created_by) VALUES('Records B',$1) RETURNING id`, [userB])).rows[0]!.id;
    await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')`, [workspaceA, userA, workspaceB, userB]);
    await db.query(`INSERT INTO resource_types(key,domain,label) VALUES('crm_leads','crm','CRM Leads') ON CONFLICT (key) DO NOTHING`);
    const recordA = (await db.query<{ id: string }>(`INSERT INTO workspace_records(workspace_id,resource_type,name,created_by) VALUES($1,'crm_leads','A',$2) RETURNING id`, [workspaceA, userA])).rows[0]!.id;
    const recordB = (await db.query<{ id: string }>(`INSERT INTO workspace_records(workspace_id,resource_type,name,created_by) VALUES($1,'crm_leads','B',$2) RETURNING id`, [workspaceB, userB])).rows[0]!.id;
    await assert.rejects(() => db.query(`INSERT INTO workspace_records(workspace_id,resource_type,parent_id,name,created_by) VALUES($1,'crm_leads',$2,'cross',$3)`, [workspaceA, recordB, userA]), /workspace_records_parent_same_workspace_fk/);
    await assert.rejects(() => db.query(`INSERT INTO record_relationships(workspace_id,source_record_id,target_record_id,relationship_type,created_by) VALUES($1,$2,$3,'related_to',$4)`, [workspaceA, recordA, recordB, userA]), /record_relationships_target_same_workspace_fk/);
    await assert.rejects(() => db.query(`UPDATE workspace_records SET assignee_id=$1 WHERE id=$2`, [userB, recordA]), /workspace_records_assignee_workspace_fk/);
  });
});
