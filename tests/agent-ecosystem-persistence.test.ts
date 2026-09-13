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
const agentReactive = await import('../src/modules/agents/agent.reactive.js');
const domainEventRepo = await import('../src/events/domain-event.repo.js');
const { DOMAIN_EVENT_TYPES } = await import('../src/events/domain-event.types.js');
const { registeredDomainEventHandlers } = await import('../src/events/domain-event.registry.js');
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

  it('creates exactly one employee run when a domain event is delivered more than once', async () => {
    const f = await fixture();
    const eventId = crypto.randomUUID();
    const pageId = 'mightily-shore-7108';
    const initialPlan = {
      version: 5,
      page: { pageId },
      team: {
        cycleId: crypto.randomUUID(),
        selectedAgentIds: [`page:${pageId}`],
        selectionReason: ['source event responsibility match'],
        trigger: {
          eventId,
          eventType: 'order.created',
          aggregateType: 'commerce_order',
          aggregateId: crypto.randomUUID(),
          occurredAt: '2026-09-13T00:00:00.000Z',
          correlationId: null,
        },
      },
    };
    const first = await agentRepo.createOrReuseTriggeredPageRun({
      workspaceId: f.workspaceId,
      userId: f.owner,
      goal: 'Handle canonical order',
      pageId,
      sourceEventId: eventId,
      initialPlan,
    });
    const retry = await agentRepo.createOrReuseTriggeredPageRun({
      workspaceId: f.workspaceId,
      userId: f.owner,
      goal: 'Handle canonical order',
      pageId,
      sourceEventId: eventId,
      initialPlan,
    });
    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.run.id, first.run.id);
    const count = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_runs
       WHERE workspace_id=$1 AND plan->'team'->'trigger'->>'eventId'=$2`,
      [f.workspaceId, eventId],
    );
    assert.equal(count.rows[0]?.count, '1');
  });

  it('treats an audited admin billing skip as an AI entitlement without minting wallet funds', async () => {
    const owner = (await db.query<{ id: string }>(
      `INSERT INTO users(email,password_hash,role,verified_at) VALUES($1,'hash','user',NOW()) RETURNING id`,
      [`${crypto.randomUUID()}@example.test`],
    )).rows[0]!.id;
    const workspaceId = (await db.query<{ id: string }>(
      `INSERT INTO workspaces(name,created_by,billing_skipped_at,billing_skipped_by)
       VALUES('Billing Skip',$1,NOW(),$1) RETURNING id`,
      [owner],
    )).rows[0]!.id;
    const plan = await agentRepo.getWorkspacePlan(workspaceId);
    assert.deepEqual(plan, { plan_key: 'ai', status: 'billing_skipped' });
    const wallet = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workspace_api_wallets WHERE workspace_id=$1`,
      [workspaceId],
    );
    assert.equal(wallet.rows[0]?.count, '0');
  });

  it('durably defers reactive work until AI funds exist and resumes from the original event', async () => {
    const f = await fixture();
    await db.query(`UPDATE workspace_subscriptions SET provider='airwallex' WHERE workspace_id=$1`,[f.workspaceId]);
    const sourceEvent = await domainEventRepo.appendDomainEvent({
      workspaceId: f.workspaceId,
      type: DOMAIN_EVENT_TYPES.RECORD_CREATED,
      aggregateType: 'workspace_record',
      aggregateId: crypto.randomUUID(),
      payload: { resourceType: 'crm_contacts', recordSource: 'user' },
      metadata: { actorId: f.owner, actorType: 'USER', source: 'records' },
      idempotencyKey: `test:reactive-unfunded:${crypto.randomUUID()}`,
    });
    agentReactive.startReactiveDispatcher();
    const handler = registeredDomainEventHandlers().find((entry) => entry.name === 'agents.reactive-business-events.v2');
    assert.ok(handler);

    const deferred = await handler.handle(sourceEvent);
    assert.equal(deferred?.deferred, true);
    assert.equal((await db.query(`SELECT id FROM agent_runs
      WHERE workspace_id=$1 AND plan->'team'->'trigger'->>'eventId'=$2`,[f.workspaceId,sourceEvent.id])).rows.length,0);
    assert.equal((await db.query<{status:string}>(`SELECT status FROM agent_reactive_deferrals
      WHERE workspace_id=$1 AND source_event_id=$2`,[f.workspaceId,sourceEvent.id])).rows[0]?.status,'WAITING');

    await db.query(`UPDATE workspace_api_wallets
      SET available_amount=100,total_funded_amount=100 WHERE workspace_id=$1`,[f.workspaceId]);
    const fundingEvent = await domainEventRepo.appendDomainEvent({
      workspaceId: f.workspaceId,
      type: DOMAIN_EVENT_TYPES.API_FUNDS_FUNDED,
      aggregateType: 'api_wallet',
      aggregateId: f.workspaceId,
      payload: { amount: 100, availableAmount: 100 },
      metadata: { actorId: f.owner, source: 'test' },
      idempotencyKey: `test:api-funded:${crypto.randomUUID()}`,
    });
    const resumed = await handler.handle(fundingEvent);
    assert.equal(resumed?.resumed,1);
    assert.equal(resumed?.failed,0);
    assert.equal((await db.query<{status:string}>(`SELECT status FROM agent_reactive_deferrals
      WHERE workspace_id=$1 AND source_event_id=$2`,[f.workspaceId,sourceEvent.id])).rows[0]?.status,'RESUMED');
    const runs = await db.query<{executionActorType:string;executionActorRef:string;executionCapabilityScope:string[]}>(
      `SELECT execution_actor_type AS "executionActorType",execution_actor_ref AS "executionActorRef",
              execution_capability_scope AS "executionCapabilityScope"
       FROM agent_runs
       WHERE workspace_id=$1 AND plan->'team'->'trigger'->>'eventId'=$2`,
      [f.workspaceId,sourceEvent.id],
    );
    assert.ok(runs.rows.length > 0);
    for (const run of runs.rows) {
      assert.equal(run.executionActorType,'WORKFLOW');
      assert.match(run.executionActorRef,/^lulu:reactive:/);
      assert.ok(run.executionCapabilityScope.includes('agents.execute'));
    }
  });
});
