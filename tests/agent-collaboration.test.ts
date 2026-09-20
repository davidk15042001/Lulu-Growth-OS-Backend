import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it, mock } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/agent_collaboration_tests_only';
process.env.JWT_SECRET = 'agent-collaboration-tests-only-not-a-production-key';

const { pool } = await import('../src/db/pool.js');
const agentRepo = await import('../src/modules/agents/agent.repo.js');
const collaboration = await import('../src/modules/agent-collaboration/agent-collaboration.service.js');
const memory = await import('../src/modules/agent-memory/agent-memory.service.js');
const db = new PGlite();

function fakeMemoryClient(options: { failMessageIngestionAttempts?: number } = {}) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  let remainingMessageIngestionFailures = options.failMessageIngestionAttempts ?? 0;
  return {
    calls,
    client: {
      user: { async add(...args: unknown[]) { calls.push({ name: 'user.add', args }); return {}; } },
      thread: {
        async create(...args: unknown[]) { calls.push({ name: 'thread.create', args }); return {}; },
        async addMessages(...args: unknown[]) {
          calls.push({ name: 'thread.addMessages', args });
          if (remainingMessageIngestionFailures > 0) {
            remainingMessageIngestionFailures -= 1;
            throw new Error('zep ingestion unavailable');
          }
          return {};
        },
        async getUserContext(...args: unknown[]) { calls.push({ name: 'thread.getUserContext', args }); return { context: 'The workspace prioritizes evidence before customer-facing action.' }; },
      },
      graph: {
        async add(...args: unknown[]) { calls.push({ name: 'graph.add', args }); return {}; },
        async search(...args: unknown[]) { calls.push({ name: 'graph.search', args }); return { context: 'Lulu policy requires verified evidence.' }; },
      },
    },
  };
}

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
  memory.setAgentMemoryClientForTests(undefined);
  mock.restoreAll();
  await pool.end();
  await db.close();
});

async function fixture() {
  const userId = (await db.query<{ id: string }>(
    `INSERT INTO users(email,password_hash,role,verified_at) VALUES($1,'hash','user',NOW()) RETURNING id`,
    [`${crypto.randomUUID()}@example.test`],
  )).rows[0]!.id;
  const workspaceId = (await db.query<{ id: string }>(
    `INSERT INTO workspaces(name,created_by) VALUES('Collaboration',$1) RETURNING id`,
    [userId],
  )).rows[0]!.id;
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId, userId]);
  const run = await agentRepo.createRun(workspaceId, userId, 'Verify a shared operating decision.', { module: 'general' });
  return { userId, workspaceId, runId: run.id };
}

describe('agent collaboration ledger', () => {
  it('persists an idempotent tenant-scoped handoff and mirrors it to the agent-run Zep thread', async () => {
    const f = await fixture();
    const fake = fakeMemoryClient();
    memory.setAgentMemoryClientForTests(fake.client);

    const thread = await collaboration.ensureAgentCollaborationThread({
      workspaceId: f.workspaceId,
      runId: f.runId,
      userId: f.userId,
      topic: 'Verify a shared operating decision.',
    });
    assert.equal(thread.zepThreadId, `agent-run:${f.runId}`);

    const first = await collaboration.postAgentCollaborationMessage({
      workspaceId: f.workspaceId,
      runId: f.runId,
      userId: f.userId,
      senderType: 'agent',
      senderAgentId: 'system:market-intelligence-lead',
      recipientAgentId: 'system:executive-orchestrator',
      messageType: 'handoff',
      content: 'Verified demand signal supports a careful follow-up.',
      structuredContent: { summary: 'Demand is rising.', token: 'must-not-persist' },
      evidenceRefs: [`agent_run:${f.runId}`, 'metric:qualified-demand'],
      confidence: 0.85,
      idempotencyKey: `agent-run:${f.runId}:handoff:v1`,
    });
    const replay = await collaboration.postAgentCollaborationMessage({
      workspaceId: f.workspaceId,
      runId: f.runId,
      userId: f.userId,
      senderType: 'agent',
      senderAgentId: 'system:market-intelligence-lead',
      recipientAgentId: 'system:executive-orchestrator',
      messageType: 'handoff',
      content: 'Verified demand signal supports a careful follow-up.',
      structuredContent: { summary: 'Demand is rising.', token: 'must-not-persist' },
      evidenceRefs: [`agent_run:${f.runId}`, 'metric:qualified-demand'],
      confidence: 0.85,
      idempotencyKey: `agent-run:${f.runId}:handoff:v1`,
    });

    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.equal(first.message.id, replay.message.id);
    assert.equal(first.message.structuredContent.token, undefined);

    const stored = await collaboration.getAgentCollaboration({ workspaceId: f.workspaceId, runId: f.runId, limit: 20 });
    assert.equal(stored.thread?.id, thread.id);
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0]?.recipientAgentId, 'system:executive-orchestrator');
    await assert.rejects(db.query(
      `UPDATE agent_collaboration_messages SET content='Rewritten evidence' WHERE id=$1`,
      [stored.items[0]!.id],
    ));

    const createdThread = fake.calls.find((call) => call.name === 'thread.create');
    assert.equal((createdThread?.args[0] as { threadId?: string }).threadId, `agent-run:${f.runId}`);
    const ingested = fake.calls.filter((call) => call.name === 'thread.addMessages');
    assert.equal(ingested.length, 1);
    assert.equal((ingested[0]?.args[1] as { messages: Array<{ metadata: Record<string, unknown> }> }).messages[0]?.metadata.source, 'lulu.agent_collaboration');

    const context = await collaboration.getAgentCollaborationContext({ workspaceId: f.workspaceId, runId: f.runId, userId: f.userId });
    assert.match(context ?? '', /Verified demand signal/);
    assert.match(context ?? '', /prioritizes evidence/);
  });

  it('retries an unsynced Zep mirror without duplicating an acknowledged ledger message', async () => {
    const f = await fixture();
    const fake = fakeMemoryClient({ failMessageIngestionAttempts: 1 });
    memory.setAgentMemoryClientForTests(fake.client);

    const first = await collaboration.postAgentCollaborationMessage({
      workspaceId: f.workspaceId,
      runId: f.runId,
      userId: f.userId,
      senderType: 'agent',
      senderAgentId: 'system:market-intelligence-lead',
      messageType: 'evidence',
      content: 'The market signal is verified.',
      idempotencyKey: `agent-run:${f.runId}:evidence:v1`,
    });
    assert.equal(first.created, true);
    assert.equal(first.message.zepSyncedAt, null);

    const replay = await collaboration.postAgentCollaborationMessage({
      workspaceId: f.workspaceId,
      runId: f.runId,
      userId: f.userId,
      senderType: 'agent',
      senderAgentId: 'system:market-intelligence-lead',
      messageType: 'evidence',
      content: 'The market signal is verified.',
      idempotencyKey: `agent-run:${f.runId}:evidence:v1`,
    });
    assert.equal(replay.created, false);
    const stored = await collaboration.getAgentCollaboration({ workspaceId: f.workspaceId, runId: f.runId, limit: 20 });
    assert.ok(stored.items[0]?.zepSyncedAt);
    assert.equal(fake.calls.filter((call) => call.name === 'thread.addMessages').length, 2);
  });

  it('rejects a message whose run does not match the collaboration thread', async () => {
    const f = await fixture();
    const foreign = await fixture();
    const thread = await collaboration.ensureAgentCollaborationThread({
      workspaceId: f.workspaceId,
      runId: f.runId,
      userId: f.userId,
      topic: 'Keep run references canonical.',
    });

    await assert.rejects(db.query(
      `INSERT INTO agent_collaboration_messages(
         workspace_id,thread_id,run_id,sender_type,message_type,content,idempotency_key
       ) VALUES($1,$2,$3,'system','status','Invalid cross-run reference',$4)`,
      [f.workspaceId, thread.id, foreign.runId, `cross-run:${crypto.randomUUID()}`],
    ));
  });

  it('keeps collaboration unreadable across workspaces and writes a terminal result to the scoped Zep graph', async () => {
    const f = await fixture();
    const foreign = await fixture();
    const fake = fakeMemoryClient();
    memory.setAgentMemoryClientForTests(fake.client);

    await collaboration.ensureAgentCollaborationThread({ workspaceId: f.workspaceId, runId: f.runId, userId: f.userId, topic: 'Resolve an evidence-backed action.' });
    await collaboration.postAgentCollaborationMessage({
      workspaceId: f.workspaceId,
      runId: f.runId,
      userId: f.userId,
      senderType: 'system',
      senderAgentId: 'system:outcome-auditor',
      messageType: 'verification',
      content: 'The evidence supports a queued action packet only.',
      idempotencyKey: `agent-run:${f.runId}:verification:v1`,
    });

    const foreignRead = await collaboration.getAgentCollaboration({ workspaceId: foreign.workspaceId, runId: f.runId, limit: 20 });
    assert.equal(foreignRead.thread, null);
    assert.deepEqual(foreignRead.items, []);

    await collaboration.completeAgentCollaborationThread({
      workspaceId: f.workspaceId,
      runId: f.runId,
      userId: f.userId,
      status: 'completed',
      outcome: { summary: 'Action packet queued with verified evidence.' },
    });
    const terminal = await collaboration.getAgentCollaboration({ workspaceId: f.workspaceId, runId: f.runId, limit: 20 });
    assert.equal(terminal.thread?.status, 'completed');

    const graphCall = fake.calls.find((call) => call.name === 'graph.add');
    assert.equal((graphCall?.args[0] as { userId?: string }).userId, memory.workspaceScopedZepUserId(f.workspaceId, f.userId));
    assert.equal((graphCall?.args[0] as { graphId?: string }).graphId, undefined);
  });
});
