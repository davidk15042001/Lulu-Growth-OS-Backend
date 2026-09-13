import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/agent_provider_reconciliation_only';
process.env.JWT_SECRET = 'agent-provider-reconciliation-test-secret';

const { pool } = await import('../src/db/pool.js');
const records = await import('../src/modules/records/record.repo.js');
const { normalizeAgentExecutionCommands } = await import('../src/modules/agents/agent.execution-command.js');
const { registerAgentExecutionHandlers } = await import('../src/modules/agents/agent-execution.worker.js');
const { registeredDomainEventHandlers } = await import('../src/events/domain-event.registry.js');
const { DOMAIN_EVENT_TYPES } = await import('../src/events/domain-event.types.js');
const { RESOURCE_CATALOG } = await import('../src/domain/resource-catalog.js');
import type { DomainEvent } from '../src/events/domain-event.types.js';

const db = new PGlite();

before(async () => {
  for (const file of (await readdir('src/database/migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`src/database/migrations/${file}`, 'utf8'));
  }
  for (const resource of RESOURCE_CATALOG) {
    await db.query(
      'INSERT INTO resource_types(key,domain,label,description) VALUES($1,$2,$3,$4)',
      [resource.key, resource.domain, resource.label, resource.description],
    );
  }
  const execute = async (sql: string, values: unknown[] = []) => {
    const result = await db.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  mock.method(pool, 'query', execute as never);
  mock.method(pool, 'connect', (async () => ({ query: execute, release() {} })) as never);
  registerAgentExecutionHandlers();
});

after(async () => {
  mock.restoreAll();
  await pool.end();
  await db.close();
});

async function providerPacketFixture() {
  const userId = (await db.query<{ id: string }>(
    `INSERT INTO users(email,password_hash,role,verified_at)
     VALUES($1,'hash','user',NOW()) RETURNING id`,
    [`${crypto.randomUUID()}@example.test`],
  )).rows[0]!.id;
  const workspaceId = (await db.query<{ id: string }>(
    `INSERT INTO workspaces(name,created_by) VALUES('Provider reconciliation',$1) RETURNING id`,
    [userId],
  )).rows[0]!.id;
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId, userId]);
  const runId = (await db.query<{ id: string }>(
    `INSERT INTO agent_runs(workspace_id,created_by,goal,status,plan)
     VALUES($1,$2,'Publish verified social content','completed',$3::jsonb) RETURNING id`,
    [workspaceId, userId, JSON.stringify({ module: 'marketing', page: { pageId: 'wondrous-cloud-1355' } })],
  )).rows[0]!.id;
  const stepId = (await db.query<{ id: string }>(
    `INSERT INTO agent_run_steps(run_id,workspace_id,sequence_no,agent_role,title,instruction,tool_name,status)
     VALUES($1,$2,1,'executor','Publish','Publish','page_action_writeback','completed') RETURNING id`,
    [runId, workspaceId],
  )).rows[0]!.id;
  const defaults = {
    module: 'marketing' as const,
    targetSystem: 'marketing',
    actionResourceType: 'marketing_content' as const,
    pageId: 'wondrous-cloud-1355',
    pageLabel: 'Social Publishing',
    goal: 'Publish verified social content',
    jobs: ['Publish content'],
    policyDecision: 'allow' as const,
    executionMode: 'autonomous' as const,
  };
  const [command] = normalizeAgentExecutionCommands([{
    type: 'social.content.publish',
    summary: 'Publish verified social content',
    targetSystem: 'marketing',
    provider: 'facebook',
    riskLevel: 'high',
    approvalPolicy: 'allow',
    targetEntityType: 'social_publication',
    targetEntityId: null,
    payload: {
      socialAccountId: crypto.randomUUID(),
      contentType: 'TEXT',
      message: 'Provider-backed launch',
    },
    idempotencyKey: 'untrusted-model-key',
  }], defaults);
  assert.ok(command);
  const action = await records.createRecord(workspaceId, 'marketing_content', userId, {
    name: 'Social action packet',
    source: 'page_agent',
    status: 'active',
    stage: 'waiting_for_provider',
    data: {
      ...defaults,
      commands: [command],
      commandTypes: [command.type],
      executionReady: false,
      executionStatus: 'waiting_for_provider',
    },
  });
  await db.query(
    `INSERT INTO agent_action_packets(record_id,workspace_id,run_id,step_id,user_id,commands_digest)
     VALUES($1,$2,$3,$4,$5,'test-digest')`,
    [action.id, workspaceId, runId, stepId, userId],
  );
  const publicationId = crypto.randomUUID();
  const receipt = await records.createRecord(workspaceId, 'activities', userId, {
    parentId: action.id,
    name: 'social.content.publish result',
    source: 'agent_executor_command',
    status: 'active',
    stage: 'waiting_for_provider',
    externalId: command.idempotencyKey,
    data: {
      sourceActionRecordId: action.id,
      commandIdempotencyKey: command.idempotencyKey,
      commandType: command.type,
      commandProvider: command.provider,
      commandResult: { publicationId, status: 'QUEUED' },
    },
  });
  return { workspaceId, userId, action, receipt, publicationId };
}

function socialResultHandler() {
  const handler = registeredDomainEventHandlers().find((item) => item.name === 'agents.social-provider-result.v1');
  assert.ok(handler);
  return handler;
}

function providerEvent(fixture: Awaited<ReturnType<typeof providerPacketFixture>>, type: string, payload: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    type,
    workspaceId: fixture.workspaceId,
    aggregateType: 'social_publication_job',
    aggregateId: fixture.publicationId,
    payload: { jobId: fixture.publicationId, ...payload },
    metadata: { actorType: 'AI_AGENT', actorRef: fixture.action.id, source: 'social-publishing.worker' },
    occurredAt: new Date().toISOString(),
  } as unknown as DomainEvent;
}

describe('agent provider result reconciliation', () => {
  it('keeps a social packet waiting until the provider confirms publication', async () => {
    const fixture = await providerPacketFixture();
    const createdEvent = (await db.query<{ payload: Record<string, unknown>; metadata: Record<string, unknown> }>(
      `SELECT payload,metadata FROM domain_events WHERE idempotency_key=$1`,
      [`record:${fixture.receipt.id}:created:v1`],
    )).rows[0];
    assert.equal(createdEvent?.payload.recordSource, 'agent_executor_command');
    assert.equal(createdEvent?.metadata.actorType, 'AI_AGENT');
    assert.equal(createdEvent?.metadata.actorRef, fixture.action.id);
    await socialResultHandler().handle(providerEvent(fixture, DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_PUBLISHED, {
      status: 'PUBLISHED',
      providerPublicationId: 'page_post_123',
      providerPermalink: 'https://example.test/post/123',
    }));

    const action = await records.findRecord(fixture.workspaceId, 'marketing_content', fixture.action.id);
    const receipt = await records.findRecord(fixture.workspaceId, 'activities', fixture.receipt.id);
    assert.equal(receipt?.stage, 'completed');
    assert.equal(receipt?.data?.providerTerminalEventId != null, true);
    assert.equal(action?.stage, 'executed');
    assert.equal(action?.data?.executionStatus, 'executed');
    assert.equal((await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM workspace_records
       WHERE workspace_id=$1 AND source IN ('agent_executor','agent_executor_command')
         AND resource_type IN ('marketing_publications','ecommerce_orders','ecommerce_inventory','finance_invoices')`,
      [fixture.workspaceId],
    )).rows[0]?.count, 0);
  });

  it('projects a terminal provider failure back to the originating packet without executor retry', async () => {
    const fixture = await providerPacketFixture();
    await socialResultHandler().handle(providerEvent(fixture, DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_FAILED, {
      status: 'FAILED',
      code: 'META_GRAPH_REJECTED',
      message: 'Provider rejected the publication.',
    }));

    const action = await records.findRecord(fixture.workspaceId, 'marketing_content', fixture.action.id);
    const receipt = await records.findRecord(fixture.workspaceId, 'activities', fixture.receipt.id);
    assert.equal(receipt?.stage, 'provider_failed');
    assert.equal(action?.stage, 'execution_failed');
    assert.equal(action?.data?.executionRetryable, false);
    assert.match(String(action?.data?.executionError), /provider rejected/i);
  });

  it('treats a provider cancellation as terminal and never strands the action packet', async () => {
    const fixture = await providerPacketFixture();
    await socialResultHandler().handle(providerEvent(fixture, DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_CANCELLED, {
      status: 'CANCELLED',
    }));

    const action = await records.findRecord(fixture.workspaceId, 'marketing_content', fixture.action.id);
    const receipt = await records.findRecord(fixture.workspaceId, 'activities', fixture.receipt.id);
    assert.equal(receipt?.status, 'cancelled');
    assert.equal(receipt?.stage, 'execution_cancelled');
    assert.equal(action?.status, 'cancelled');
    assert.equal(action?.stage, 'execution_cancelled');
    assert.equal(action?.data?.executionStatus, 'cancelled');
    assert.deepEqual(action?.data?.pendingProviderOperations, []);
  });

  it('ignores a stale provider failure delivered after a newer manual retry', async () => {
    const fixture = await providerPacketFixture();
    await db.query(
      `UPDATE workspace_records
       SET data=jsonb_set(data,'{commandResult,version}','5'::jsonb),version=version+1
       WHERE workspace_id=$1 AND id=$2`,
      [fixture.workspaceId, fixture.receipt.id],
    );
    const result = await socialResultHandler().handle(providerEvent(fixture, DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_FAILED, {
      status: 'FAILED',
      code: 'OLD_FAILURE',
      message: 'This belongs to the previous attempt.',
      version: 4,
    }));
    assert.equal(result?.reason, 'stale_provider_transition');
    const action = await records.findRecord(fixture.workspaceId, 'marketing_content', fixture.action.id);
    const receipt = await records.findRecord(fixture.workspaceId, 'activities', fixture.receipt.id);
    assert.equal(action?.stage, 'waiting_for_provider');
    assert.equal(receipt?.stage, 'waiting_for_provider');
  });
});
