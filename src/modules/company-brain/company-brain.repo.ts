import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import type { DomainEvent } from '../../events/domain-event.types.js';
import type { BrainDecision, BrainLearningRecord, BrainMission, BrainObservation, BrainSignal, BrainTask, BrainTaskDependency, BrainTaskEvent } from './company-brain.types.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';

const observationSelect = `id,workspace_id AS "workspaceId",source_type AS "sourceType",source_key AS "sourceKey",
  source_event_id AS "sourceEventId",subject_type AS "subjectType",subject_id AS "subjectId",event_type AS "eventType",
  summary,evidence,trust_score::float AS "trustScore",observed_at AS "observedAt",created_at AS "createdAt"`;
const signalSelect = `id,workspace_id AS "workspaceId",observation_id AS "observationId",signal_type AS "signalType",
  severity,materiality::float AS materiality,status,explanation,evidence,detected_at AS "detectedAt",resolved_at AS "resolvedAt"`;
const missionSelect = `id,workspace_id AS "workspaceId",signal_id AS "signalId",title,objective,status,priority,north_star AS "northStar",
  owner_employee_id AS "ownerEmployeeId",created_by AS "createdBy",context,outcome,started_at AS "startedAt",
  completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt"`;
const taskSelect = `id,workspace_id AS "workspaceId",mission_id AS "missionId",parent_task_id AS "parentTaskId",
  assigned_employee_id AS "assignedEmployeeId",task_type AS "taskType",title,objective,status,priority,dependency_count AS "dependencyCount",
  idempotency_key AS "idempotencyKey",agent_run_id AS "agentRunId",dispatch_key AS "dispatchKey",claimed_by AS "claimedBy",
  claimed_at AS "claimedAt",dispatched_at AS "dispatchedAt",due_at AS "dueAt",attempt_count AS "attemptCount",max_attempts AS "maxAttempts",
  confidence::float AS confidence,blocked_reason AS "blockedReason",last_error AS "lastError",
  context,result,error_code AS "errorCode",error_message AS "errorMessage",created_at AS "createdAt",updated_at AS "updatedAt"`;
const taskDependencySelect = `d.task_id AS "taskId",d.depends_on_task_id AS "dependsOnTaskId",d.dependency_type AS "dependencyType",
  t.title,t.status`;
const taskEventSelect = `id,workspace_id AS "workspaceId",task_id AS "taskId",event_type AS "eventType",actor_type AS "actorType",
  actor_id AS "actorId",payload,created_at AS "createdAt"`;
const learningSelect = `id,workspace_id AS "workspaceId",task_id AS "taskId",signal_id AS "signalId",source_event_id AS "sourceEventId",
  outcome_type AS "outcomeType",outcome,evidence,confidence::float AS confidence,verified,actor_type AS "actorType",actor_id AS "actorId",created_at AS "createdAt"`;
const decisionSelect = `id,workspace_id AS "workspaceId",signal_id AS "signalId",mission_id AS "missionId",decision_type AS "decisionType",
  decision,confidence::float AS confidence,rationale,evidence,actor_type AS "actorType",actor_id AS "actorId",created_at AS "createdAt"`;

export type ObservationInput = {
  workspaceId: string;
  sourceType: 'domain_event' | 'metric' | 'provider' | 'user';
  sourceKey: string;
  sourceEventId?: string | null;
  subjectType: string;
  subjectId?: string | null;
  eventType?: string | null;
  summary: string;
  evidence?: Record<string, unknown>;
  trustScore?: number;
  observedAt?: Date;
};

export type SignalInput = {
  workspaceId: string;
  observationId: string;
  signalType: string;
  severity: number;
  materiality: number;
  explanation: string;
  evidence?: Record<string, unknown>;
};

export async function upsertObservation(input: ObservationInput, client?: PoolClient) {
  const { rows } = await query<BrainObservation>(
    `INSERT INTO company_brain_observations(
       workspace_id,source_type,source_key,source_event_id,subject_type,subject_id,event_type,summary,evidence,trust_score,observed_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
     ON CONFLICT(workspace_id,source_type,source_key) DO UPDATE SET
       evidence=EXCLUDED.evidence,trust_score=EXCLUDED.trust_score,summary=EXCLUDED.summary
     RETURNING ${observationSelect}`,
    [input.workspaceId,input.sourceType,input.sourceKey,input.sourceEventId ?? null,input.subjectType,input.subjectId ?? null,
      input.eventType ?? null,input.summary,input.evidence ?? {},input.trustScore ?? 1,input.observedAt ?? new Date()], client,
  );
  const observation = rows[0];
  if (!observation) throw new Error('Brain observation upsert did not return a row');
  return observation;
}

export async function upsertSignal(input: SignalInput, client?: PoolClient) {
  const { rows } = await query<BrainSignal>(
    `INSERT INTO company_brain_signals(workspace_id,observation_id,signal_type,severity,materiality,explanation,evidence)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT(workspace_id,observation_id,signal_type) DO UPDATE SET
       severity=EXCLUDED.severity,materiality=EXCLUDED.materiality,explanation=EXCLUDED.explanation,evidence=EXCLUDED.evidence
     RETURNING ${signalSelect}`,
    [input.workspaceId,input.observationId,input.signalType,input.severity,input.materiality,input.explanation,input.evidence ?? {}], client,
  );
  const signal = rows[0];
  if (!signal) throw new Error('Brain signal upsert did not return a row');
  return signal;
}

export async function createMissionFromSignal(input: {
  workspaceId: string; signalId: string; title: string; objective: string; priority: number; createdBy?: string | null;
}) {
  return withTransaction((client) => createMissionFromSignalWithClient(input, client));
}

async function createMissionFromSignalWithClient(input: {
  workspaceId: string; signalId: string; title: string; objective: string; priority: number; createdBy?: string | null;
}, client: PoolClient) {
  const missionResult = await query<BrainMission>(
    `INSERT INTO company_brain_missions(workspace_id,signal_id,title,objective,priority,created_by)
     SELECT $1,id,$3,$4,$5,$6 FROM company_brain_signals WHERE workspace_id=$1 AND id=$2
     ON CONFLICT(workspace_id,signal_id) DO UPDATE SET title=EXCLUDED.title,objective=EXCLUDED.objective,priority=EXCLUDED.priority
     RETURNING ${missionSelect}`,
    [input.workspaceId,input.signalId,input.title,input.objective,input.priority,input.createdBy ?? null], client,
  );
  const mission = missionResult.rows[0];
  if (!mission) return null;
  const taskResult = await query<BrainTask>(
    `INSERT INTO company_brain_tasks(workspace_id,mission_id,task_type,title,objective,priority)
     VALUES($1,$2,'investigate',$3,$4,$5)
     ON CONFLICT DO NOTHING
     RETURNING ${taskSelect}`,
    [input.workspaceId,mission.id,input.title,input.objective,input.priority], client,
  );
  const task = taskResult.rows[0] ?? (await query<BrainTask>(
    `SELECT ${taskSelect} FROM company_brain_tasks WHERE workspace_id=$1 AND mission_id=$2 ORDER BY created_at ASC LIMIT 1`,
    [input.workspaceId,mission.id], client,
  )).rows[0];
  return { mission, task: task ?? null };
}

export async function listSignals(workspaceId: string, limit: number, status?: string) {
  const values: unknown[] = [workspaceId, limit];
  const where = status ? 'workspace_id=$1 AND status=$3' : 'workspace_id=$1';
  if (status) values.push(status);
  const { rows } = await query<BrainSignal>(`SELECT ${signalSelect} FROM company_brain_signals WHERE ${where} ORDER BY materiality DESC, detected_at DESC LIMIT $2`, values);
  return rows;
}

export async function getSignal(workspaceId: string, signalId: string) {
  const { rows } = await query<BrainSignal>(`SELECT ${signalSelect} FROM company_brain_signals WHERE workspace_id=$1 AND id=$2`, [workspaceId, signalId]);
  return rows[0] ?? null;
}

export async function listMissions(workspaceId: string, limit: number, status?: string) {
  const values: unknown[] = [workspaceId, limit];
  const where = status ? 'workspace_id=$1 AND status=$3' : 'workspace_id=$1';
  if (status) values.push(status);
  const { rows } = await query<BrainMission>(`SELECT ${missionSelect} FROM company_brain_missions WHERE ${where} ORDER BY priority DESC, updated_at DESC LIMIT $2`, values);
  return rows;
}

export async function listDecisions(workspaceId: string, limit: number) {
  const { rows } = await query<BrainDecision>(`SELECT ${decisionSelect} FROM company_brain_decisions WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT $2`, [workspaceId,limit]);
  return rows;
}

export async function listTasksForMission(workspaceId: string, missionId: string) {
  const { rows } = await query<BrainTask>(`SELECT ${taskSelect} FROM company_brain_tasks WHERE workspace_id=$1 AND mission_id=$2 ORDER BY priority DESC, created_at ASC`, [workspaceId,missionId]);
  return rows;
}

async function appendTaskEvent(input: {
  workspaceId: string; taskId: string; eventType: string; actorType?: 'system' | 'agent' | 'human' | undefined; actorId?: string | null | undefined; payload?: Record<string, unknown>;
}, client: PoolClient) {
  const { rows } = await query<BrainTaskEvent>(
    `INSERT INTO company_brain_task_events(workspace_id,task_id,event_type,actor_type,actor_id,payload)
     VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING ${taskEventSelect}`,
    [input.workspaceId,input.taskId,input.eventType,input.actorType ?? 'system',input.actorId ?? null,input.payload ?? {}], client,
  );
  return rows[0];
}

export async function getTask(workspaceId: string, taskId: string, client?: PoolClient) {
  const { rows } = await query<BrainTask>(`SELECT ${taskSelect} FROM company_brain_tasks WHERE workspace_id=$1 AND id=$2`, [workspaceId, taskId], client);
  return rows[0] ?? null;
}

/** Claim one dependency-ready task without ever replaying a task that already
 * has a canonical agent run. A claim is a durable state transition and is
 * therefore observable through both the task timeline and domain events. */
export async function claimNextRunnableTask(workerId: string, leaseSeconds = 120) {
  return withTransaction(async (client) => {
    const { rows } = await query<BrainTask>(
      `WITH candidate AS (
         SELECT t.id
         FROM company_brain_tasks t
         WHERE (
           t.status IN ('PROPOSED','READY')
           OR (t.status='RUNNING' AND t.agent_run_id IS NULL AND t.claimed_at < NOW() - ($1::integer * INTERVAL '1 second'))
         )
           AND t.agent_run_id IS NULL
           AND t.attempt_count < t.max_attempts
           AND (t.due_at IS NULL OR t.due_at <= NOW())
           AND (t.claimed_by IS NULL OR t.claimed_at < NOW() - ($1::integer * INTERVAL '1 second'))
           AND NOT EXISTS (
             SELECT 1
             FROM company_brain_task_dependencies d
             JOIN company_brain_tasks dependency
               ON dependency.workspace_id=d.workspace_id AND dependency.id=d.depends_on_task_id
             WHERE d.workspace_id=t.workspace_id AND d.task_id=t.id AND dependency.status <> 'COMPLETED'
           )
         ORDER BY t.priority DESC, t.due_at NULLS FIRST, t.created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE company_brain_tasks t
       SET status='RUNNING', attempt_count=t.attempt_count + 1,
           claimed_by=$2, claimed_at=NOW(), dispatched_at=NOW(),
           dispatch_key=COALESCE(t.dispatch_key, 'brain-task:' || t.id::text), updated_at=NOW()
       FROM candidate
       WHERE t.id=candidate.id
       RETURNING ${taskSelect}`,
      [leaseSeconds, workerId], client,
    );
    const task = rows[0];
    if (!task) return null;
    await appendTaskEvent({
      workspaceId: task.workspaceId, taskId: task.id, eventType: 'CLAIMED', actorType: 'system', actorId: workerId,
      payload: { attemptCount: task.attemptCount, claimedBy: workerId },
    }, client);
    await appendDomainEvent({
      workspaceId: task.workspaceId, type: 'brain.task.claimed', aggregateType: 'company_brain_task', aggregateId: task.id,
      payload: { missionId: task.missionId, attemptCount: task.attemptCount, claimedBy: workerId },
      metadata: { actorType: 'system', actorId: workerId, source: 'company-brain.dispatcher' },
      idempotencyKey: `brain-task:${task.id}:claimed:${task.attemptCount}`,
    }, client);
    return task;
  });
}

export async function attachAgentRun(input: { workspaceId: string; taskId: string; runId: string; workerId: string }) {
  return withTransaction(async (client) => {
    const task = (await query<BrainTask>(`SELECT ${taskSelect} FROM company_brain_tasks WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [input.workspaceId, input.taskId], client)).rows[0];
    if (!task) return null;
    const run = (await query<{ id: string }>(`SELECT id FROM agent_runs WHERE workspace_id=$1 AND id=$2`, [input.workspaceId, input.runId], client)).rows[0];
    if (!run) return null;
    if (task.agentRunId && task.agentRunId !== input.runId) return null;
    const result = await query<BrainTask>(
      `UPDATE company_brain_tasks
       SET agent_run_id=$3,claimed_by=NULL,claimed_at=NULL,updated_at=NOW()
       WHERE workspace_id=$1 AND id=$2 AND status='RUNNING' AND (agent_run_id IS NULL OR agent_run_id=$3)
       RETURNING ${taskSelect}`,
      [input.workspaceId, input.taskId, input.runId], client,
    );
    const linked = result.rows[0] ?? null;
    if (!linked || task.agentRunId === input.runId) return linked;
    await appendTaskEvent({ workspaceId: input.workspaceId, taskId: input.taskId, eventType: 'AGENT_RUN_LINKED', actorType: 'system', actorId: input.workerId, payload: { runId: input.runId } }, client);
    await appendDomainEvent({
      workspaceId: input.workspaceId, type: 'brain.task.agent_run_linked', aggregateType: 'company_brain_task', aggregateId: input.taskId,
      payload: { missionId: linked.missionId, runId: input.runId }, metadata: { actorType: 'system', actorId: input.workerId, source: 'company-brain.dispatcher' },
      idempotencyKey: `brain-task:${input.taskId}:run:${input.runId}:linked`,
    }, client);
    return linked;
  });
}

/** Resolve a task from either the explicit link or the immutable run plan.
 * The plan fallback closes the small race between run creation and linking. */
export async function getTaskForAgentRun(workspaceId: string, runId: string) {
  const { rows } = await query<BrainTask>(
    `SELECT ${taskSelect}
     FROM company_brain_tasks
     WHERE workspace_id=$1 AND agent_run_id=$2
     UNION ALL
     SELECT ${taskSelect}
     FROM (
       SELECT t.*
       FROM company_brain_tasks t
       JOIN agent_runs r ON r.workspace_id=t.workspace_id AND r.id=$2
       WHERE t.workspace_id=$1 AND t.agent_run_id IS NULL
         AND r.plan -> 'companyBrainTask' ->> 'taskId' = t.id::text
     ) AS t
     LIMIT 1`,
    [workspaceId, runId],
  );
  return rows[0] ?? null;
}

export async function createTask(input: {
  workspaceId: string; missionId: string; parentTaskId?: string | null | undefined; assignedEmployeeId?: string | null | undefined;
  taskType: string; title: string; objective?: string; priority: number; context?: Record<string, unknown>;
  dueAt?: string | null | undefined; maxAttempts?: number; idempotencyKey?: string | null | undefined; actorType?: 'system' | 'agent' | 'human' | undefined; actorId?: string | null | undefined;
}) {
  return withTransaction(async (client) => {
    if (input.idempotencyKey) {
      const existing = await query<BrainTask>(`SELECT ${taskSelect} FROM company_brain_tasks WHERE workspace_id=$1 AND idempotency_key=$2`, [input.workspaceId, input.idempotencyKey], client);
      if (existing.rows[0]) return { task: existing.rows[0], created: false as const };
    }
    const mission = (await query<{ id: string }>(`SELECT id FROM company_brain_missions WHERE workspace_id=$1 AND id=$2`, [input.workspaceId,input.missionId], client)).rows[0];
    if (!mission) return null;
    if (input.parentTaskId) {
      const parent = (await query<{ id: string }>(`SELECT id FROM company_brain_tasks WHERE workspace_id=$1 AND id=$2 AND mission_id=$3`, [input.workspaceId,input.parentTaskId,input.missionId], client)).rows[0];
      if (!parent) return null;
    }
    if (input.assignedEmployeeId) {
      const employee = (await query<{ id: string }>(`SELECT id FROM digital_employees WHERE workspace_id=$1 AND id=$2`, [input.workspaceId,input.assignedEmployeeId], client)).rows[0];
      if (!employee) return null;
    }
    const result = await query<BrainTask>(
      `INSERT INTO company_brain_tasks(
        workspace_id,mission_id,parent_task_id,assigned_employee_id,task_type,title,objective,priority,context,due_at,max_attempts,idempotency_key
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
      RETURNING ${taskSelect}`,
      [input.workspaceId,input.missionId,input.parentTaskId ?? null,input.assignedEmployeeId ?? null,input.taskType,input.title,input.objective ?? '',input.priority,input.context ?? {},input.dueAt ?? null,input.maxAttempts ?? 3,input.idempotencyKey ?? null], client,
    );
    const task = result.rows[0];
    if (!task) throw new Error('Company Brain task insert did not return a row');
    await appendTaskEvent({ workspaceId: input.workspaceId, taskId: task.id, eventType: 'CREATED', actorType: input.actorType, actorId: input.actorId, payload: { missionId: input.missionId, parentTaskId: input.parentTaskId ?? null } }, client);
    await appendDomainEvent({
      workspaceId: input.workspaceId, type: 'brain.task.created', aggregateType: 'company_brain_task', aggregateId: task.id,
      payload: { missionId: input.missionId, taskType: input.taskType, parentTaskId: input.parentTaskId ?? null },
      metadata: { actorId: input.actorId ?? null, actorType: input.actorType ?? 'system', source: 'company-brain' },
      idempotencyKey: `brain-task:${task.id}:created:v1`,
    }, client);
    return { task, created: true as const };
  });
}

export async function addTaskDependency(input: {
  workspaceId: string; taskId: string; dependsOnTaskId: string; dependencyType: 'BLOCKS' | 'CONTEXT' | 'VERIFICATION'; actorId?: string | null;
}) {
  return withTransaction(async (client) => {
    const tasks = (await query<{ id: string; missionId: string }>(
      `SELECT id,mission_id AS "missionId" FROM company_brain_tasks WHERE workspace_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE`,
      [input.workspaceId, [input.taskId,input.dependsOnTaskId]], client,
    )).rows;
    const task = tasks.find((item) => item.id === input.taskId);
    const dependency = tasks.find((item) => item.id === input.dependsOnTaskId);
    if (!task || !dependency || task.missionId !== dependency.missionId || task.id === dependency.id) return null;
    const cycle = (await query<{ exists: boolean }>(
      `WITH RECURSIVE ancestors(id) AS (
         SELECT $3::uuid
         UNION
         SELECT d.depends_on_task_id FROM company_brain_task_dependencies d
         JOIN ancestors a ON a.id=d.task_id WHERE d.workspace_id=$1
       ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=$2) AS exists`,
      [input.workspaceId,input.taskId,input.dependsOnTaskId], client,
    )).rows[0]?.exists;
    if (cycle) throw new Error('Company Brain task dependency would create a cycle');
    const inserted = await query<{ taskId: string }>(`INSERT INTO company_brain_task_dependencies(workspace_id,task_id,depends_on_task_id,dependency_type)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING task_id AS "taskId"`, [input.workspaceId,input.taskId,input.dependsOnTaskId,input.dependencyType], client);
    await query(`UPDATE company_brain_tasks SET dependency_count=(SELECT count(*) FROM company_brain_task_dependencies WHERE workspace_id=$1 AND task_id=$2),updated_at=NOW()
      WHERE workspace_id=$1 AND id=$2`, [input.workspaceId,input.taskId], client);
    if (inserted.rows[0]) {
      await appendTaskEvent({ workspaceId: input.workspaceId, taskId: input.taskId, eventType: 'DEPENDENCY_ADDED', actorType: 'human', actorId: input.actorId, payload: { dependsOnTaskId: input.dependsOnTaskId, dependencyType: input.dependencyType } }, client);
      await appendDomainEvent({
        workspaceId: input.workspaceId, type: 'brain.task.dependency_added', aggregateType: 'company_brain_task', aggregateId: input.taskId,
        payload: { dependsOnTaskId: input.dependsOnTaskId, dependencyType: input.dependencyType }, metadata: { actorId: input.actorId ?? null, source: 'company-brain' },
        idempotencyKey: `brain-task:${input.taskId}:dependency:${input.dependsOnTaskId}:${input.dependencyType}`,
      }, client);
    }
    const result = await query<BrainTaskDependency>(`SELECT ${taskDependencySelect} FROM company_brain_task_dependencies d
      JOIN company_brain_tasks t ON t.workspace_id=d.workspace_id AND t.id=d.depends_on_task_id
      WHERE d.workspace_id=$1 AND d.task_id=$2 AND d.depends_on_task_id=$3`, [input.workspaceId,input.taskId,input.dependsOnTaskId], client);
    return result.rows[0] ?? null;
  });
}

export async function updateTask(input: {
  workspaceId: string; taskId: string; status?: string | undefined; result?: Record<string, unknown> | null | undefined; errorCode?: string | null | undefined;
  errorMessage?: string | null | undefined; blockedReason?: string | null | undefined; confidence?: number | null | undefined; agentRunId?: string | null | undefined;
  actorType?: 'system' | 'agent' | 'human' | undefined; actorId?: string | null | undefined;
}) {
  return withTransaction(async (client) => {
    const current = await getTask(input.workspaceId, input.taskId, client);
    if (!current) return null;
    const nextStatus = input.status ?? current.status;
    if (['COMPLETED','CANCELLED'].includes(current.status) && !['READY','RUNNING'].includes(nextStatus)) return current;
    const nextAttemptCount = nextStatus === 'RUNNING' && current.status !== 'RUNNING' ? current.attemptCount + 1 : current.attemptCount;
    if (nextAttemptCount > current.maxAttempts) throw new Error('Company Brain task retry limit reached');
    const { rows } = await query<BrainTask>(
      `UPDATE company_brain_tasks SET status=$3,result=COALESCE($4::jsonb,result),error_code=$5,error_message=$6,
         blocked_reason=$7,confidence=COALESCE($8,confidence),attempt_count=$9,
         agent_run_id=COALESCE($10,agent_run_id),
         claimed_by=CASE WHEN $3 IN ('COMPLETED','FAILED','CANCELLED','BLOCKED') THEN NULL ELSE claimed_by END,
         claimed_at=CASE WHEN $3 IN ('COMPLETED','FAILED','CANCELLED','BLOCKED') THEN NULL ELSE claimed_at END,
         last_error=CASE WHEN $3='FAILED' THEN COALESCE($6,last_error) ELSE NULL END,updated_at=NOW()
       WHERE workspace_id=$1 AND id=$2 RETURNING ${taskSelect}`,
      [input.workspaceId,input.taskId,nextStatus,input.result === undefined ? null : input.result,input.errorCode ?? null,input.errorMessage ?? null,input.blockedReason ?? null,input.confidence ?? null,nextAttemptCount,input.agentRunId ?? null], client,
    );
    const task = rows[0];
    if (!task) return null;
    await appendTaskEvent({ workspaceId: input.workspaceId, taskId: task.id, eventType: `STATUS_${nextStatus}`, actorType: input.actorType, actorId: input.actorId, payload: { result: input.result ?? null, errorCode: input.errorCode ?? null, confidence: input.confidence ?? null } }, client);
    await appendDomainEvent({
      workspaceId: input.workspaceId, type: 'brain.task.updated', aggregateType: 'company_brain_task', aggregateId: task.id,
      payload: { status: task.status, attemptCount: task.attemptCount }, metadata: { actorId: input.actorId ?? null, actorType: input.actorType ?? 'system', source: 'company-brain' },
      idempotencyKey: `brain-task:${task.id}:status:${task.updatedAt}`,
    }, client);
    await syncMissionStateWithClient(input.workspaceId, task.missionId, client);
    return task;
  });
}

async function syncMissionStateWithClient(workspaceId: string, missionId: string, client: PoolClient) {
  const mission = (await query<{ status: string; signalId: string | null }>(
    `SELECT status,signal_id AS "signalId" FROM company_brain_missions WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
    [workspaceId, missionId], client,
  )).rows[0];
  if (!mission || mission.status === 'CANCELLED') return null;
  const counts = (await query<{ total: string; completed: string; running: string; blocked: string; failed: string }>(
    `SELECT count(*)::text AS total,
       count(*) FILTER (WHERE status='COMPLETED')::text AS completed,
       count(*) FILTER (WHERE status='RUNNING')::text AS running,
       count(*) FILTER (WHERE status='BLOCKED')::text AS blocked,
       count(*) FILTER (WHERE status='FAILED')::text AS failed
     FROM company_brain_tasks WHERE workspace_id=$1 AND mission_id=$2`,
    [workspaceId, missionId], client,
  )).rows[0];
  const total = Number(counts?.total ?? 0);
  const completed = Number(counts?.completed ?? 0);
  const nextStatus = total > 0 && completed === total
    ? 'COMPLETED'
    : Number(counts?.blocked ?? 0) > 0 || Number(counts?.failed ?? 0) > 0
      ? 'BLOCKED'
      : Number(counts?.running ?? 0) > 0
        ? 'RUNNING'
        : 'PLANNED';
  if (nextStatus === mission.status) return mission;
  const updated = (await query<BrainMission>(
    `UPDATE company_brain_missions SET status=$3,
       started_at=CASE WHEN $3='RUNNING' THEN COALESCE(started_at,NOW()) ELSE started_at END,
       completed_at=CASE WHEN $3='COMPLETED' THEN COALESCE(completed_at,NOW()) ELSE NULL END,
       updated_at=NOW()
     WHERE workspace_id=$1 AND id=$2 RETURNING ${missionSelect}`,
    [workspaceId, missionId, nextStatus], client,
  )).rows[0];
  if (updated) {
    await appendDomainEvent({
      workspaceId, type: 'brain.mission.updated', aggregateType: 'company_brain_mission', aggregateId: missionId,
      payload: { status: nextStatus, completedTasks: completed, totalTasks: total }, metadata: { actorType: 'system', source: 'company-brain' },
      idempotencyKey: `brain-mission:${missionId}:status:${nextStatus}`,
    }, client);
    if (nextStatus === 'COMPLETED' && mission.signalId) {
      await query(`UPDATE company_brain_signals SET status='ACTIONED',resolved_at=COALESCE(resolved_at,NOW())
        WHERE workspace_id=$1 AND id=$2 AND status IN ('OPEN','ACTIONED')`, [workspaceId, mission.signalId], client);
    }
  }
  return updated ?? null;
}

export async function syncMissionState(workspaceId: string, missionId: string) {
  return withTransaction((client) => syncMissionStateWithClient(workspaceId, missionId, client));
}

export async function getTaskGraph(workspaceId: string, missionId: string) {
  const [tasks, dependencies, events] = await Promise.all([
    listTasksForMission(workspaceId, missionId),
    query<BrainTaskDependency>(`SELECT ${taskDependencySelect} FROM company_brain_task_dependencies d
      JOIN company_brain_tasks t ON t.workspace_id=d.workspace_id AND t.id=d.depends_on_task_id
      WHERE d.workspace_id=$1 AND t.mission_id=$2 ORDER BY d.created_at ASC`, [workspaceId,missionId]),
    query<BrainTaskEvent>(`SELECT e.id,e.workspace_id AS "workspaceId",e.task_id AS "taskId",e.event_type AS "eventType",e.actor_type AS "actorType",
      e.actor_id AS "actorId",e.payload,e.created_at AS "createdAt" FROM company_brain_task_events e
      JOIN company_brain_tasks t ON t.workspace_id=e.workspace_id AND t.id=e.task_id
      WHERE e.workspace_id=$1 AND t.mission_id=$2 ORDER BY e.created_at ASC`, [workspaceId,missionId]),
  ]);
  return { tasks, dependencies: dependencies.rows, events: events.rows };
}

export async function recordLearning(input: {
  workspaceId: string; taskId?: string | null | undefined; signalId?: string | null | undefined; sourceEventId?: string | null | undefined;
  outcomeType: string; outcome: string; evidence?: Record<string, unknown>; confidence: number; verified: boolean;
  actorType?: 'system' | 'agent' | 'human' | undefined; actorId?: string | null | undefined;
}) {
  const { rows } = await query<BrainLearningRecord>(
    `INSERT INTO company_brain_learning_records(workspace_id,task_id,signal_id,source_event_id,outcome_type,outcome,evidence,confidence,verified,actor_type,actor_id)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
     ON CONFLICT(workspace_id,source_event_id,outcome_type) WHERE source_event_id IS NOT NULL DO UPDATE SET
       outcome=EXCLUDED.outcome,evidence=EXCLUDED.evidence,confidence=EXCLUDED.confidence,verified=EXCLUDED.verified
     RETURNING ${learningSelect}`,
    [input.workspaceId,input.taskId ?? null,input.signalId ?? null,input.sourceEventId ?? null,input.outcomeType,input.outcome,input.evidence ?? {},input.confidence,input.verified,input.actorType ?? 'system',input.actorId ?? null],
  );
  return rows[0];
}

export async function listLearning(workspaceId: string, limit: number) {
  const { rows } = await query<BrainLearningRecord>(`SELECT ${learningSelect} FROM company_brain_learning_records WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT $2`, [workspaceId,limit]);
  return rows;
}

export async function counts(workspaceId: string) {
  const { rows } = await query<{ signals: string; openSignals: string; missions: string; activeMissions: string; tasks: string; decisions: string }>(
    `SELECT
       (SELECT count(*) FROM company_brain_signals WHERE workspace_id=$1) AS signals,
       (SELECT count(*) FROM company_brain_signals WHERE workspace_id=$1 AND status='OPEN') AS "openSignals",
       (SELECT count(*) FROM company_brain_missions WHERE workspace_id=$1) AS missions,
       (SELECT count(*) FROM company_brain_missions WHERE workspace_id=$1 AND status IN ('PROPOSED','PLANNED','RUNNING','BLOCKED')) AS "activeMissions",
       (SELECT count(*) FROM company_brain_tasks WHERE workspace_id=$1) AS tasks,
       (SELECT count(*) FROM company_brain_decisions WHERE workspace_id=$1) AS decisions`, [workspaceId],
  );
  return Object.fromEntries(Object.entries(rows[0] ?? {}).map(([key,value]) => [key, Number(value)]));
}

export async function updateMission(workspaceId: string, missionId: string, status: string, outcome?: Record<string, unknown>) {
  const { rows } = await query<BrainMission>(
    `UPDATE company_brain_missions SET status=$3,outcome=COALESCE($4::jsonb,outcome),
       started_at=CASE WHEN $3='RUNNING' THEN COALESCE(started_at,NOW()) ELSE started_at END,
       completed_at=CASE WHEN $3 IN ('COMPLETED','CANCELLED') THEN COALESCE(completed_at,NOW()) ELSE NULL END
     WHERE workspace_id=$1 AND id=$2 RETURNING ${missionSelect}`,
    [workspaceId,missionId,status,outcome ? JSON.stringify(outcome) : null],
  );
  return rows[0] ?? null;
}

export async function createDecision(input: {
  workspaceId: string; signalId?: string; missionId?: string; decisionType: string; decision: string;
  confidence: number; rationale: string; evidence: Record<string, unknown>; actorType: string; actorId?: string | null;
}) {
  const { rows } = await query<BrainDecision>(
    `INSERT INTO company_brain_decisions(workspace_id,signal_id,mission_id,decision_type,decision,confidence,rationale,evidence,actor_type,actor_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING ${decisionSelect}`,
    [input.workspaceId,input.signalId ?? null,input.missionId ?? null,input.decisionType,input.decision,input.confidence,input.rationale,input.evidence,input.actorType,input.actorId ?? null],
  );
  return rows[0];
}

export async function observeDomainEvent(event: DomainEvent) {
  if (!event.workspaceId) return null;
  return withTransaction(async (client) => {
    const signal = classifyEvent(event);
    const observation = await upsertObservation({
      workspaceId: event.workspaceId!, sourceType: 'domain_event', sourceKey: event.id, sourceEventId: event.id,
      subjectType: event.aggregateType, subjectId: event.aggregateId, eventType: event.type,
      summary: `${event.type} observed for ${event.aggregateType}${event.aggregateId ? ` ${event.aggregateId}` : ''}.`,
      evidence: { eventType: event.type, aggregateType: event.aggregateType, aggregateId: event.aggregateId, source: event.metadata.source ?? null },
      trustScore: 1, observedAt: new Date(event.occurredAt),
    }, client);
    const persistedSignal = await upsertSignal({ ...signal, workspaceId: event.workspaceId!, observationId: observation.id }, client);
    const mission = signal.routeToMission
      ? await createMissionFromSignalWithClient({
        workspaceId: event.workspaceId!, signalId: persistedSignal.id,
        title: `Investigate ${persistedSignal.signalType.replaceAll('_', ' ')}`,
        objective: persistedSignal.explanation, priority: Math.min(100, persistedSignal.severity * 20),
      }, client)
      : null;
    return { observation, signal: persistedSignal, mission };
  });
}

function classifyEvent(event: DomainEvent) {
  const type = event.type.toLowerCase();
  const failed = type.includes('failed') || type.includes('error') || type.includes('dead_letter');
  const financial = type.includes('payment') || type.includes('invoice') || type.includes('billing') || type.includes('ad_budget');
  const provider = type.includes('provider') || type.includes('integration');
  const routeToMission = failed || provider || type.includes('overdue') || type.includes('approval_required') || type.includes('authorization_required') || type.includes('blocked');
  const severity = failed ? 4 : financial ? 3 : provider ? 2 : 1;
  const materiality = failed ? 0.9 : financial ? 0.75 : provider ? 0.55 : 0.25;
  return {
    signalType: failed ? 'execution_failure' : financial ? 'financial_change' : provider ? 'provider_change' : 'business_activity',
    severity, materiality,
    explanation: failed ? 'A persisted failure or error requires review before new side effects.' : financial ? 'A financial state change was observed and should remain auditable.' : provider ? 'A provider or integration state changed.' : 'A verified business event was observed.',
    routeToMission,
    evidence: { eventType: event.type, materialityReason: failed ? 'failure' : financial ? 'financial' : provider ? 'provider' : 'activity', routeToMission },
  };
}
