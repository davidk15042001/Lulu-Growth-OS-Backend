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
  const delegatedTasks = await brain.listTasksForMission(workspaceId, mission!.mission.id);
  assert.equal(delegatedTasks.length, 4);
  assert.ok(mission?.mission.ownerEmployeeId);
  assert.ok(delegatedTasks.slice(1).every((task) => task.assignedEmployeeId && task.status === 'PROPOSED'));

  const child = await brain.createTask({
    workspaceId, missionId: mission!.mission.id, parentTaskId: mission!.task!.id,
    taskType: 'provider-diagnosis', title: 'Verify provider state', objective: 'Read the provider evidence and classify recovery.',
    priority: 80, idempotencyKey: 'brain-test-child-v1', actorType: 'human', actorId: 'test-user',
  });
  assert.ok(child?.created);
  const dependency = await brain.addTaskDependency({
    workspaceId, taskId: child!.task.id, dependsOnTaskId: mission!.task!.id, dependencyType: 'BLOCKS', actorId: 'test-user',
  });
  assert.equal(dependency?.dependsOnTaskId, mission!.task!.id);
  const replayedDependency = await brain.addTaskDependency({
    workspaceId, taskId: child!.task.id, dependsOnTaskId: mission!.task!.id, dependencyType: 'BLOCKS', actorId: 'test-user',
  });
  assert.equal(replayedDependency?.taskId, dependency?.taskId);
  await assert.rejects(
    () => brain.addTaskDependency({ workspaceId, taskId: mission!.task!.id, dependsOnTaskId: child!.task.id, dependencyType: 'BLOCKS' }),
    /cycle/i,
  );
  const running = await brain.updateTask({ workspaceId, taskId: child!.task.id, status: 'RUNNING', actorType: 'system' });
  assert.equal(running?.attemptCount, 1);
  const failed = await brain.updateTask({ workspaceId, taskId: child!.task.id, status: 'FAILED', errorCode: 'PROVIDER_UNAVAILABLE', errorMessage: 'provider offline', confidence: 0.9 });
  assert.equal(failed?.lastError, 'provider offline');
  const learning = await brain.recordLearning({
    workspaceId, taskId: child!.task.id, sourceEventId: event.id, outcomeType: 'provider_diagnosis',
    outcome: 'Provider unavailable; task held for a later recovery cycle.', evidence: { code: 'PROVIDER_UNAVAILABLE' }, confidence: 0.9, verified: false,
  });
  const replayLearning = await brain.recordLearning({
    workspaceId, taskId: child!.task.id, sourceEventId: event.id, outcomeType: 'provider_diagnosis',
    outcome: 'Provider unavailable; task held for a later recovery cycle.', evidence: { code: 'PROVIDER_UNAVAILABLE' }, confidence: 0.9, verified: false,
  });
  assert.equal(learning?.id, replayLearning?.id);
  const graph = await brain.getTaskGraph(workspaceId, mission!.mission.id);
  assert.equal(graph.tasks.length, 5);
  assert.equal(graph.dependencies.length, 4);
  assert.ok(graph.events.length >= 8);
  assert.equal((await brain.listLearning(workspaceId, 10)).length, 1);
  assert.equal(await brain.claimNextRunnableTask('blocked-mission-worker', 120), null);

  // The dispatcher must claim only dependency-ready work and keep the
  // canonical task linked to the agent run that it started. This protects the
  // idempotent Company Brain -> agent execution hand-off from regressions.
  const dispatchObservation = await brain.upsertObservation({
    workspaceId,
    sourceType: 'user',
    sourceKey: 'brain-dispatch-test-observation',
    subjectType: 'company_brain_test',
    summary: 'Dispatch test observation',
    evidence: { test: true },
  });
  const dispatchSignal = await brain.upsertSignal({
    workspaceId,
    observationId: dispatchObservation.id,
    signalType: 'provider_change',
    severity: 2,
    materiality: 0.6,
    explanation: 'Dispatch test provider change',
  });
  const dispatchMission = await brain.createMissionFromSignal({
    workspaceId,
    signalId: dispatchSignal.id,
    title: 'Dispatch test mission',
    objective: 'Verify dispatcher behavior.',
    priority: 70,
  });
  const dispatchTask = await brain.createTask({
    workspaceId,
    missionId: dispatchMission!.mission.id,
    taskType: 'provider-diagnosis',
    title: 'Dispatchable provider check',
    objective: 'Verify the current provider state once.',
    priority: 95,
    idempotencyKey: 'brain-test-dispatchable-v1',
    actorType: 'system',
    actorId: 'test-dispatcher',
  });
  assert.ok(dispatchTask?.created);
  const claimed = await brain.claimNextRunnableTask('test-dispatcher', 120);
  assert.equal(claimed?.id, dispatchTask!.task.id);
  assert.equal(claimed?.status, 'RUNNING');
  assert.equal(claimed?.attemptCount, 1);
  assert.equal((await brain.listMissions(workspaceId, 20)).find((item) => item.id === dispatchMission!.mission.id)?.status, 'RUNNING');

  const runId = '00000000-0000-0000-0000-000000000303';
  await db.query(`INSERT INTO agent_runs(
    id,workspace_id,goal,status,plan,created_at,updated_at
  ) VALUES($1,$2,'Company Brain dispatch test','queued',$3::jsonb,NOW(),NOW())`, [
    runId,
    workspaceId,
    JSON.stringify({ companyBrainTask: { taskId: dispatchTask!.task.id, missionId: dispatchMission!.mission.id } }),
  ]);
  const linked = await brain.attachAgentRun({
    workspaceId,
    taskId: dispatchTask!.task.id,
    runId,
    workerId: 'test-dispatcher',
  });
  assert.equal(linked?.agentRunId, runId);
  const resolved = await brain.getTaskForAgentRun(workspaceId, runId);
  assert.equal(resolved?.id, dispatchTask!.task.id);

  // A workspace missing a delegated specialist must be visibly blocked once,
  // rather than creating an unassigned task that the worker can keep replaying.
  await db.query(`UPDATE digital_employees SET active=FALSE WHERE workspace_id=$1 AND employee_key='integration-manager'`, [workspaceId]);
  const missingObservation = await brain.upsertObservation({
    workspaceId, sourceType: 'user', sourceKey: 'brain-missing-employee-observation',
    subjectType: 'company_brain_test', summary: 'Missing employee test', evidence: { test: true },
  });
  const missingSignal = await brain.upsertSignal({
    workspaceId, observationId: missingObservation.id, signalType: 'provider_change', severity: 3,
    materiality: 0.7, explanation: 'Missing employee test signal',
  });
  const missingMission = await brain.createMissionFromSignal({
    workspaceId, signalId: missingSignal.id, title: 'Missing employee mission', objective: 'Verify setup blocker.', priority: 80,
  });
  const missingTasks = await brain.listTasksForMission(workspaceId, missingMission!.mission.id);
  const blockedSpecialist = missingTasks.find((item) => item.taskType === 'provider-review');
  assert.equal(blockedSpecialist?.status, 'BLOCKED');
  assert.equal(blockedSpecialist?.blockedReason, 'DIGITAL_EMPLOYEE_NOT_CONFIGURED');
  assert.equal((await brain.listMissions(workspaceId, 20)).find((item) => item.id === missingMission!.mission.id)?.status, 'BLOCKED');

  const decision = await brain.recordEventDecision({
    workspaceId, missionId: mission!.mission.id, signalId: first!.signal.id,
    sourceEventId: event.id, decisionType: 'agent_run.run.failed',
    decision: 'The persisted execution failed and remains paused.', confidence: 0.5,
    rationale: 'Decision is derived from the terminal event.', evidence: { taskId: child!.task.id },
    actorId: 'company-brain.test',
  });
  const replayedDecision = await brain.recordEventDecision({
    workspaceId, missionId: mission!.mission.id, signalId: first!.signal.id,
    sourceEventId: event.id, decisionType: 'agent_run.run.failed',
    decision: 'The persisted execution failed and remains paused.', confidence: 0.5,
    rationale: 'Decision is derived from the terminal event.', evidence: { taskId: child!.task.id },
    actorId: 'company-brain.test',
  });
  assert.equal(decision?.id, replayedDecision?.id);
  assert.equal(decision?.evidence.sourceEventId, event.id);
});
