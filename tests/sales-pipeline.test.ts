import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/sales_pipeline_tests_only';
process.env.JWT_SECRET = 'sales-pipeline-tests-secret-at-least-32-characters';

const { pool } = await import('../src/db/pool.js');
const records = await import('../src/modules/records/record.repo.js');
const pipeline = await import('../src/modules/sales-pipeline/sales-pipeline.service.js');
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

async function fixture(name: string) {
  const userId = (await db.query<{ id: string }>(
    `INSERT INTO users(email,password_hash,verified_at) VALUES($1,'hash',NOW()) RETURNING id`,
    [`${crypto.randomUUID()}@sales-pipeline.test`],
  )).rows[0]!.id;
  const workspaceId = (await db.query<{ id: string }>(
    `INSERT INTO workspaces(name,created_by,onboarding_step,onboarding_completed_at,profile_completed_at,knowledge_base_completed_at)
     VALUES($1,$2,'setup_complete',NOW(),NOW(),NOW()) RETURNING id`, [name, userId],
  )).rows[0]!.id;
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId, userId]);
  await db.query(`INSERT INTO resource_types(key,domain,label,description) VALUES
    ('crm_leads','crm','CRM Leads','CRM lead records.'),
    ('sales_leads','sales','Sales Leads','Sales lead records.'),
    ('sales_opportunities','sales','Sales Opportunities','Qualified sales opportunities.')
    ON CONFLICT (key) DO NOTHING`);
  return { userId, workspaceId };
}

describe('canonical sales pipeline state machine', () => {
  it('transitions a lead with evidence in the same canonical workspace record', async () => {
    const f = await fixture('Pipeline transitions');
    const lead = await records.createRecord(f.workspaceId, 'crm_leads', f.userId, {
      name: 'Acme inbound lead',
      status: 'active',
      stage: 'new',
      source: 'test',
      data: { email: 'buyer@acme.example' },
    });
    const contacted = await pipeline.transitionRecord(f.workspaceId, 'crm_leads', lead.id, f.userId, {
      expectedVersion: lead.version,
      targetState: 'contacted',
      reason: 'First response sent',
    });
    assert.equal(contacted.id, lead.id);
    assert.equal(contacted.pipeline.state, 'contacted');
    assert.equal(contacted.pipeline.previousState, 'new');
    assert.equal(contacted.stage, 'contacted');
    assert.equal(contacted.pipeline.stateVersion, 1);
    const event = (await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM domain_events WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='record.updated'`,
      [f.workspaceId, lead.id],
    )).rows[0]!.count;
    assert.equal(event, '1');
  });

  it('rejects illegal transitions and stale writes without creating duplicate objects', async () => {
    const f = await fixture('Pipeline guards');
    const opportunity = await records.createRecord(f.workspaceId, 'sales_opportunities', f.userId, {
      name: 'Acme expansion', status: 'active', stage: 'open', source: 'test', data: {},
    });
    await assert.rejects(
      () => pipeline.transitionRecord(f.workspaceId, 'sales_opportunities', opportunity.id, f.userId, {
        expectedVersion: opportunity.version, targetState: 'won',
      }),
      /cannot transition/i,
    );
    await assert.rejects(
      () => pipeline.transitionRecord(f.workspaceId, 'sales_opportunities', opportunity.id, f.userId, {
        expectedVersion: opportunity.version - 1, targetState: 'qualified',
      }),
      /changed since version/i,
    );
    const count = (await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workspace_records WHERE workspace_id=$1 AND id=$2`,
      [f.workspaceId, opportunity.id],
    )).rows[0]!.count;
    assert.equal(count, '1');
  });

  it('keeps pipeline reads tenant-scoped', async () => {
    const first = await fixture('Tenant A');
    const second = await fixture('Tenant B');
    const lead = await records.createRecord(first.workspaceId, 'sales_leads', first.userId, {
      name: 'Private lead', status: 'active', stage: 'new', data: {},
    });
    await assert.rejects(
      () => pipeline.getPipelineRecord(second.workspaceId, 'sales_leads', lead.id),
      /not found/i,
    );
  });
});
