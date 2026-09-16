import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:1/company_brain';
process.env.JWT_SECRET = 'company-brain-tests-secret-0123456789';

const { pool } = await import('../src/db/pool.js');
const brain = await import('../src/modules/company-brain/company-brain.repo.js');
const db = new PGlite();
let workspaceId: string;

before(async () => {
  for (const file of (await readdir('src/database/migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    await db.exec(await readFile(`src/database/migrations/${file}`, 'utf8'));
  }
  const execute = async (sql: string, values: unknown[] = []) => {
    const result = await db.query(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  const { rows } = await db.query<{ id: string }>(`INSERT INTO users(email,password_hash) VALUES('brain@test.local','hash') RETURNING id`);
  workspaceId = (await db.query<{ id: string }>(`INSERT INTO workspaces(name,created_by) VALUES('Brain',$1) RETURNING id`, [rows[0]!.id])).rows[0]!.id;
  await db.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId, rows[0]!.id]);
  // The repository accepts the same pool abstraction as the rest of the backend;
  // route it into an isolated in-memory PostgreSQL-compatible test database.
  const { mock } = await import('node:test');
  mock.method(pool, 'query', execute as never);
  mock.method(pool, 'connect', (async () => ({ query: execute, release() {} })) as never);
});

after(async () => {
  const { mock } = await import('node:test');
  mock.restoreAll();
  await pool.end();
  await db.close();
});

test('persists an event-backed signal and creates one idempotent root task', async () => {
  const eventId = '00000000-0000-0000-0000-000000000101';
  const event = {
    id: eventId,
    sequence: '1',
    workspaceId,
    type: 'run.failed',
    version: 1,
    aggregateType: 'agent_run',
    aggregateId: '00000000-0000-0000-0000-000000000202',
    payload: { errorCode: 'PROVIDER_UNAVAILABLE' },
    metadata: { source: 'test' },
    idempotencyKey: eventId,
    status: 'processed',
    attempts: 1,
    maxAttempts: 3,
    availableAt: new Date().toISOString(),
    lockedAt: null,
    lockedBy: null,
    processedAt: new Date().toISOString(),
    deadLetteredAt: null,
    lastError: null,
    occurredAt: new Date().toISOString(),
  } as const;
  await db.query(`INSERT INTO domain_events(
    id,workspace_id,event_type,event_version,aggregate_type,aggregate_id,payload,metadata,idempotency_key,status,attempts,max_attempts,occurred_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,'processed',1,3,$10)`, [
    event.id, workspaceId, event.type, event.version, event.aggregateType, event.aggregateId,
    JSON.stringify(event.payload), JSON.stringify(event.metadata), event.idempotencyKey, event.occurredAt,
  ]);

  const first = await brain.observeDomainEvent(event);
  const replay = await brain.observeDomainEvent(event);
  assert.equal(first?.observation.id, replay?.observation.id);
  assert.equal(first?.signal.id, replay?.signal.id);
  assert.equal(first?.signal.signalType, 'execution_failure');
  assert.equal(first?.signal.status, 'OPEN');
  assert.equal(first?.mission?.mission.signalId, first?.signal.id);

  const mission = await brain.createMissionFromSignal({
    workspaceId,
    signalId: first!.signal.id,
    title: 'Investigate provider failure',
    objective: 'Verify the failed provider run and recover safely.',
    priority: 90,
  });
  const replayedMission = await brain.createMissionFromSignal({
    workspaceId,
    signalId: first!.signal.id,
    title: 'Investigate provider failure',
    objective: 'Verify the failed provider run and recover safely.',
    priority: 90,
  });
  assert.equal(mission?.mission.id, replayedMission?.mission.id);
  assert.equal(mission?.task?.id, replayedMission?.task?.id);
  assert.equal((await brain.listTasksForMission(workspaceId, mission!.mission.id)).length, 1);
});
