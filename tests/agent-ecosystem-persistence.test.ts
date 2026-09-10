import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/agent_ecosystem_tests_only';
process.env.JWT_SECRET = 'agent-ecosystem-tests-only-not-a-production-key';

const { pool } = await import('../src/db/pool.js');
const agentRepo = await import('../src/modules/agents/agent.repo.js');
const agentService = await import('../src/modules/agents/agent.service.js');
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

async function fixture() {
  const owner = (await db.query<{ id: string }>(
    `INSERT INTO users(email,password_hash,role,verified_at) VALUES($1,'hash','user',NOW()) RETURNING id`,
    [`${crypto.randomUUID()}@example.test`],
  )).rows[0]!.id;
  const workspaceId = (await db.query<{ id: string }>(
    `INSERT INTO workspaces(name,created_by) VALUES('Agent Ecosystem',$1) RETURNING id`,
    [owner],
  )).rows[0]!.id;
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId, owner]);
  await db.query(`INSERT INTO workspace_subscriptions(workspace_id,plan_key,status) VALUES($1,'ai','active')`, [workspaceId]);
  await db.query(`INSERT INTO resource_types(key,domain,label) VALUES
    ('crm_contacts','crm','CRM Contacts'),
    ('finance_invoices','finance','Finance Invoices'),
    ('ecommerce_orders','ecommerce','Ecommerce Orders')
    ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO workspace_records(workspace_id,resource_type,name,created_by)
    VALUES($1,'crm_contacts','Customer',$2),($1,'finance_invoices','Invoice',$2),($1,'ecommerce_orders','Order',$2)`, [workspaceId, owner]);
  return { workspaceId, owner };
}

describe('agent ecosystem persistence', () => {
  it('persists a tenant-scoped dynamic team and learns from verified outcomes', async () => {
    const f = await fixture();
    const prepared = await agentService.prepareAutomaticAgentTeam(f.workspaceId, 'scheduled');
    assert.ok(prepared.selection.specialists.length > 0);
    assert.ok(prepared.selection.specialists.length <= 8);

    const ecosystem = await agentService.getAgentEcosystem(f.workspaceId);
    assert.ok(ecosystem.summary.registeredAgents >= 140);
    assert.equal(ecosystem.latestCycle?.id, prepared.cycle.id);
    assert.equal(ecosystem.latestCycle?.selectedAgentIds.length, prepared.selection.allAgents.length);

    const specialist = prepared.selection.specialists[0]!.definition;
    const run = await agentRepo.createRun(f.workspaceId, f.owner, 'verify learning', {
      version: 4,
      agentDefinition: {
        id: specialist.id,
        name: specialist.name,
        module: specialist.module,
        tier: specialist.tier,
      },
    });
    await agentRepo.updateRun(run.id, { team_cycle_id: prepared.cycle.id });
    await agentRepo.markAgentTeamCycleRunning(f.workspaceId, prepared.cycle.id);
    assert.equal((await agentRepo.getLatestAgentTeamCycle(f.workspaceId))?.status, 'running');
    await agentRepo.finalizeRun({
      runId: run.id,
      workspaceId: f.workspaceId,
      status: 'completed',
      patch: { result: { verified: true }, finished_at: new Date() },
      eventPayload: { verified: true },
      pageId: specialist.pageId,
      actorId: f.owner,
      agentRole: 'reviewer',
    });
    assert.equal((await agentRepo.getLatestAgentTeamCycle(f.workspaceId))?.status, 'completed');

    const performance = await agentRepo.listAgentPerformance(f.workspaceId);
    const learned = performance.find((entry) => entry.agentId === specialist.id);
    assert.equal(learned?.runCount, 1);
    assert.equal(learned?.successCount, 1);
    assert.equal(learned?.failureCount, 0);
    assert.equal(learned?.performanceScore, 52);
  });
});
