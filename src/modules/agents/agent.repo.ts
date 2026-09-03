import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import type { AgentRun, AgentRunEvent, AgentStep } from './agent.types.js';

const runSelect = `id, workspace_id AS "workspaceId", created_by AS "createdBy", goal, status, plan,
 result, error_code AS "errorCode", error_message AS "errorMessage", started_at AS "startedAt",
 finished_at AS "finishedAt", worker_id AS "workerId", locked_at AS "lockedAt",
 heartbeat_at AS "heartbeatAt", attempt_count AS "attemptCount", created_at AS "createdAt", updated_at AS "updatedAt"`;
const stepSelect = `id, run_id AS "runId", workspace_id AS "workspaceId", sequence_no AS "sequenceNo",
 agent_role AS "agentRole", title, instruction, status, depends_on AS "dependsOn", tool_name AS "toolName",
 tool_input AS "toolInput", tool_output AS "toolOutput", approval_id AS "approvalId", result,
 error_code AS "errorCode", error_message AS "errorMessage", started_at AS "startedAt", finished_at AS "finishedAt",
 created_at AS "createdAt", updated_at AS "updatedAt"`;
const eventSelect = `id, run_id AS "runId", step_id AS "stepId", workspace_id AS "workspaceId",
 event_type AS "eventType", agent_role AS "agentRole", payload, created_at AS "createdAt"`;

export async function createRun(
  workspaceId: string,
  userId: string | null,
  goal: string,
  plan: Record<string, unknown> | null = null,
  client?: PoolClient,
): Promise<AgentRun> {
  if (!client) {
    return withTransaction((transactionClient) => createRun(workspaceId, userId, goal, plan, transactionClient));
  }
  const { rows } = await query<AgentRun>(`INSERT INTO agent_runs (workspace_id, created_by, goal, plan)
    VALUES ($1, $2, $3, $4) RETURNING ${runSelect}`, [workspaceId, userId, goal, JSON.stringify(plan ?? {})], client);
  const run = rows[0];
  if (!run) throw new Error('Agent run insert did not return a row');
  const actor = userId ? { actorId: userId } : (await query<{ actorId: string }>(
    `SELECT created_by AS "actorId" FROM workspaces WHERE id=$1`,
    [workspaceId],
    client,
  )).rows[0];
  await appendDomainEvent({
    workspaceId,
    type: DOMAIN_EVENT_TYPES.AGENT_RUN_REQUESTED,
    aggregateType: 'agent_run',
    aggregateId: run.id,
    payload: { runId: run.id, goal },
    metadata: { actorId: actor?.actorId ?? null, source: 'agents' },
    idempotencyKey: `agent-run:${run.id}:requested:v1`,
  }, client);
  return run;
}
export async function listAutomatedTargets() {
  const { rows } = await query<{
    workspace_id: string;
    actor_user_id: string | null;
    plan_key: 'explorer' | 'viewer' | 'starter' | 'ai' | 'test';
    status: string;
  }>(`SELECT ws.workspace_id, w.created_by AS actor_user_id, ws.plan_key, ws.status
      FROM workspace_subscriptions ws
      JOIN workspaces w ON w.id = ws.workspace_id
      WHERE ws.status IN ('active', 'trialing') AND ws.plan_key IN ('starter', 'ai', 'test')`);
  return rows;
}
export async function hasRecentAutomaticRun(workspaceId: string, goal: string, minutes = 30) {
  const { rows } = await query<{ exists: boolean }>(`SELECT EXISTS(SELECT 1 FROM agent_runs WHERE workspace_id=$1 AND goal=$2 AND created_at > NOW() - ($3 * INTERVAL '1 minute') AND status IN ('queued','planning','running','waiting_approval','completed')) AS exists`, [workspaceId, goal, minutes]);
  return Boolean(rows[0]?.exists);
}
export async function getRecentPageRun(workspaceId: string, pageId: string, minutes = 45, client?: PoolClient) {
  const { rows } = await query<AgentRun>(`SELECT ${runSelect}
    FROM agent_runs
    WHERE workspace_id=$1
      AND plan -> 'page' ->> 'pageId' = $2
      AND updated_at > NOW() - ($3 * INTERVAL '1 minute')
      AND status IN ('queued','planning','running','waiting_approval','completed')
    ORDER BY updated_at DESC
    LIMIT 1`, [workspaceId, pageId, minutes], client);
  return rows[0] ?? null;
}

export async function createOrReusePageRun(input: {
  workspaceId: string;
  userId: string | null;
  goal: string;
  pageId: string;
  dedupeMinutes: number;
  initialPlan: Record<string, unknown>;
}) {
  return withTransaction(async (client) => {
    await query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent-page-run:${input.workspaceId}:${input.pageId}`], client);
    const recentRun = await getRecentPageRun(input.workspaceId, input.pageId, input.dedupeMinutes, client);
    if (recentRun) {
      return { run: recentRun, created: false as const };
    }
    const run = await createRun(input.workspaceId, input.userId, input.goal, input.initialPlan, client);
    return { run, created: true as const };
  });
}
export async function listRuns(workspaceId: string, limit = 50, pageId?: string) {
  const values: unknown[] = [workspaceId];
  let where = 'workspace_id=$1';
  if (pageId) {
    values.push(pageId);
    where += ` AND plan -> 'page' ->> 'pageId' = $${values.length}`;
  }
  values.push(limit);
  const { rows } = await query<AgentRun>(`SELECT ${runSelect} FROM agent_runs WHERE ${where} ORDER BY updated_at DESC LIMIT $${values.length}`, values);
  return rows;
}
export async function getRun(workspaceId: string, runId: string) {
  const { rows } = await query<AgentRun>(`SELECT ${runSelect} FROM agent_runs WHERE workspace_id=$1 AND id=$2`, [workspaceId, runId]);
  return rows[0];
}

export async function claimNextRunnableRun(workerId: string, leaseSeconds: number, maxAttempts: number) {
  return withTransaction(async (client) => {
    const exhausted = await query<{ id: string; workspaceId: string; attemptCount: number }>(
      `UPDATE agent_runs
       SET status='failed', error_code='AGENT_RUN_RETRY_EXHAUSTED',
           error_message='The agent run exceeded its crash-recovery retry limit.',
           finished_at=NOW(), worker_id=NULL, locked_at=NULL, heartbeat_at=NULL
       WHERE status IN ('queued','planning','running')
         AND attempt_count >= $2
         AND (worker_id IS NULL OR COALESCE(heartbeat_at, locked_at, updated_at) < NOW() - ($1::integer * INTERVAL '1 second'))
       RETURNING id, workspace_id AS "workspaceId", attempt_count AS "attemptCount"`,
      [leaseSeconds, maxAttempts],
      client,
    );
    for (const run of exhausted.rows) {
      await appendDomainEvent({
        workspaceId: run.workspaceId,
        type: DOMAIN_EVENT_TYPES.AGENT_RUN_FAILED,
        aggregateType: 'agent_run',
        aggregateId: run.id,
        payload: { runId: run.id, code: 'AGENT_RUN_RETRY_EXHAUSTED', attemptCount: run.attemptCount },
        metadata: { source: 'agents.worker' },
        idempotencyKey: `agent-run:${run.id}:failed:retry-exhausted:v1`,
      }, client);
    }
    const { rows } = await query<AgentRun>(
      `WITH candidate AS (
         SELECT id AS candidate_id
         FROM agent_runs
         WHERE status IN ('queued','planning','running')
           AND attempt_count < $3
           AND (
             worker_id IS NULL
             OR COALESCE(heartbeat_at, locked_at, updated_at) < NOW() - ($2::integer * INTERVAL '1 second')
           )
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE agent_runs AS run
       SET worker_id=$1, locked_at=NOW(), heartbeat_at=NOW(), attempt_count=run.attempt_count + 1
       FROM candidate
       WHERE run.id=candidate.candidate_id
       RETURNING ${runSelect}`,
      [workerId, leaseSeconds, maxAttempts],
      client,
    );
    return rows[0] ?? null;
  });
}

export async function heartbeatRun(runId: string, workerId: string) {
  await query(
    `UPDATE agent_runs SET heartbeat_at=NOW()
     WHERE id=$1 AND worker_id=$2 AND status IN ('queued','planning','running')`,
    [runId, workerId],
  );
}

export async function releaseRunLease(runId: string, workerId: string) {
  await query(
    `UPDATE agent_runs SET worker_id=NULL, locked_at=NULL, heartbeat_at=NULL
     WHERE id=$1 AND worker_id=$2`,
    [runId, workerId],
  );
}

export async function getWorkspaceActorId(workspaceId: string) {
  const { rows } = await query<{ actorId: string }>(
    `SELECT created_by AS "actorId" FROM workspaces WHERE id=$1`,
    [workspaceId],
  );
  return rows[0]?.actorId ?? null;
}

export async function getLatestCompletedInitialAnalysis(workspaceId: string) {
  const { rows } = await query<AgentRun>(
    `SELECT ${runSelect}
     FROM agent_runs
     WHERE workspace_id=$1
       AND goal='[initial-business-analysis] Detailed post-onboarding business intelligence analysis'
       AND status='completed'
     ORDER BY finished_at DESC NULLS LAST, updated_at DESC
     LIMIT 1`,
    [workspaceId],
  );
  return rows[0];
}
export async function updateRun(runId: string, patch: Record<string, unknown>, client?: PoolClient) {
  const keys = Object.keys(patch);
  const values = keys.map((key) => patch[key]);
  const assignments = keys.map((key, index) => `${key}=$${index + 2}`).join(', ');
  const { rows } = await query<AgentRun>(`UPDATE agent_runs SET ${assignments}, updated_at=NOW() WHERE id=$1 RETURNING ${runSelect}`, [runId, ...values], client);
  return rows[0];
}

export async function finalizeRun(input: {
  runId: string;
  workspaceId: string;
  status: 'completed' | 'failed' | 'cancelled';
  patch: Record<string, unknown>;
  eventPayload: Record<string, unknown>;
  pageId?: string | null;
  actorId?: string | null;
  agentRole?: string | null;
}) {
  return withTransaction(async (client) => {
    const run = await updateRun(input.runId, { ...input.patch, status: input.status }, client);
    if (!run) throw new Error('Agent run finalization did not return a row');
    const eventType = input.status === 'completed'
      ? DOMAIN_EVENT_TYPES.AGENT_RUN_COMPLETED
      : input.status === 'cancelled' ? DOMAIN_EVENT_TYPES.AGENT_RUN_CANCELLED : DOMAIN_EVENT_TYPES.AGENT_RUN_FAILED;
    await addEvent({
      runId: input.runId,
      workspaceId: input.workspaceId,
      eventType,
      agentRole: input.agentRole ?? null,
      payload: input.eventPayload,
    }, client);
    await appendDomainEvent({
      workspaceId: input.workspaceId,
      type: eventType,
      aggregateType: 'agent_run',
      aggregateId: input.runId,
      payload: {
        runId: input.runId,
        pageId: input.pageId ?? null,
        ...(typeof input.eventPayload.code === 'string' ? { code: input.eventPayload.code } : {}),
      },
      metadata: { actorId: input.actorId ?? null, source: 'agents' },
      idempotencyKey: `agent-run:${input.runId}:${eventType}:v1`,
    }, client);
    return run;
  });
}
export async function createSteps(steps: Array<{ runId: string; workspaceId: string; sequenceNo: number; agentRole: string; title: string; instruction: string; toolName?: string | null; toolInput?: Record<string, unknown> | null }>) {
  const created: AgentStep[] = [];
  for (const step of steps) {
    const { rows } = await query<AgentStep>(`INSERT INTO agent_run_steps (run_id, workspace_id, sequence_no, agent_role, title, instruction, tool_name, tool_input)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${stepSelect}`, [step.runId, step.workspaceId, step.sequenceNo, step.agentRole, step.title, step.instruction, step.toolName ?? null, step.toolInput ?? null]);
    if (rows[0]) created.push(rows[0]);
  }
  return created;
}
export async function listSteps(workspaceId: string, runId: string) {
  const { rows } = await query<AgentStep>(`SELECT ${stepSelect} FROM agent_run_steps WHERE workspace_id=$1 AND run_id=$2 ORDER BY sequence_no ASC`, [workspaceId, runId]);
  return rows;
}
export async function getStep(workspaceId: string, runId: string, stepId: string) {
  const { rows } = await query<AgentStep>(`SELECT ${stepSelect} FROM agent_run_steps WHERE workspace_id=$1 AND run_id=$2 AND id=$3`, [workspaceId, runId, stepId]);
  return rows[0];
}
export async function updateStep(stepId: string, patch: Record<string, unknown>) {
  const keys = Object.keys(patch);
  const values = keys.map((key) => patch[key]);
  const assignments = keys.map((key, index) => `${key}=$${index + 2}`).join(', ');
  const { rows } = await query<AgentStep>(`UPDATE agent_run_steps SET ${assignments}, updated_at=NOW() WHERE id=$1 RETURNING ${stepSelect}`, [stepId, ...values]);
  return rows[0];
}
export async function addEvent(input: { runId: string; stepId?: string | null; workspaceId: string; eventType: string; agentRole?: string | null; payload?: Record<string, unknown> }, client?: PoolClient) {
  const { rows } = await query<AgentRunEvent>(`INSERT INTO agent_run_events (run_id, step_id, workspace_id, event_type, agent_role, payload)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${eventSelect}`, [input.runId, input.stepId ?? null, input.workspaceId, input.eventType, input.agentRole ?? null, input.payload ?? {}], client);
  return rows[0];
}
export async function getWorkspacePlan(workspaceId: string) {
  const { rows } = await query<{ plan_key: 'explorer' | 'viewer' | 'starter' | 'ai' | 'test'; status: string }>(`SELECT plan_key, status FROM workspace_subscriptions WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 1`, [workspaceId]);
  return rows[0] ?? { plan_key: 'explorer' as const, status: 'inactive' };
}

export async function getApprovalStatus(workspaceId: string, approvalId: string) {
  const { rows } = await query<{ status: string }>(`SELECT status FROM approval_requests WHERE workspace_id=$1 AND id=$2`, [workspaceId, approvalId]);
  return rows[0]?.status ?? null;
}

export async function listEvents(workspaceId: string, runId: string) {
  const { rows } = await query<AgentRunEvent>(`SELECT ${eventSelect} FROM agent_run_events WHERE workspace_id=$1 AND run_id=$2 ORDER BY created_at ASC`, [workspaceId, runId]);
  return rows;
}

export async function createKnowledgeSnapshot(input: {
  workspaceId: string;
  sourceRunId: string;
  snapshotType?: string;
  status: 'completed' | 'failed';
  confidence?: string | null;
  executiveSummary?: string | null;
  dataGaps?: unknown[];
  verifiedFacts?: unknown[];
  priorities?: unknown[];
  knowledgeBase?: Record<string, unknown>;
  sourceManifest?: Record<string, unknown>;
  generatedAt?: Date | null;
}) {
  const { rows } = await query(`
    INSERT INTO workspace_knowledge_snapshots
      (workspace_id, source_run_id, snapshot_type, status, confidence, executive_summary, data_gaps,
       verified_facts, priorities, knowledge_base, source_manifest, generated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12)
    ON CONFLICT (workspace_id, snapshot_type, source_run_id)
    DO UPDATE SET status=EXCLUDED.status, confidence=EXCLUDED.confidence,
      executive_summary=EXCLUDED.executive_summary, data_gaps=EXCLUDED.data_gaps,
      verified_facts=EXCLUDED.verified_facts, priorities=EXCLUDED.priorities,
      knowledge_base=EXCLUDED.knowledge_base, source_manifest=EXCLUDED.source_manifest,
      generated_at=EXCLUDED.generated_at, updated_at=NOW()
    RETURNING id, workspace_id AS "workspaceId", source_run_id AS "sourceRunId", status,
      confidence, executive_summary AS "executiveSummary", data_gaps AS "dataGaps",
      verified_facts AS "verifiedFacts", priorities, knowledge_base AS "knowledgeBase",
      source_manifest AS "sourceManifest", generated_at AS "generatedAt", updated_at AS "updatedAt"`,
    [input.workspaceId, input.sourceRunId, input.snapshotType ?? 'initial_business_analysis', input.status, input.confidence ?? null, input.executiveSummary ?? null,
      JSON.stringify(input.dataGaps ?? []), JSON.stringify(input.verifiedFacts ?? []), JSON.stringify(input.priorities ?? []),
      JSON.stringify(input.knowledgeBase ?? {}), JSON.stringify(input.sourceManifest ?? {}), input.generatedAt ?? null]);
  return rows[0];
}

export async function replaceKnowledgeSections(snapshotId: string, workspaceId: string, sections: Record<string, unknown>) {
  for (const [sectionKey, content] of Object.entries(sections)) {
    if (!content || typeof content !== 'object') continue;
    await query(`
      INSERT INTO workspace_knowledge_sections (snapshot_id, workspace_id, section_key, status, content)
      VALUES ($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT (snapshot_id, section_key)
      DO UPDATE SET status=EXCLUDED.status, content=EXCLUDED.content, updated_at=NOW()`,
      [snapshotId, workspaceId, sectionKey, 'completed', JSON.stringify(content)]);
  }
}

export async function replaceIntelligenceMetrics(input: {
  workspaceId: string;
  snapshotId: string;
  metrics: Record<string, unknown>;
}) {
  for (const [metricKey, raw] of Object.entries(input.metrics)) {
    const metric = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const status = typeof metric.sourceStatus === 'string' ? metric.sourceStatus : 'unavailable';
    const safeStatus = ['verified','derived','forecast','unavailable','not_applicable'].includes(status) ? status : 'unavailable';
    await query(`
      INSERT INTO workspace_intelligence_metrics
        (workspace_id, snapshot_id, metric_key, value, unit, period, source, source_status,
         confidence, limitations, measured_at)
      VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::jsonb,$11)
      ON CONFLICT (workspace_id, snapshot_id, metric_key)
      DO UPDATE SET value=EXCLUDED.value, unit=EXCLUDED.unit, period=EXCLUDED.period,
        source=EXCLUDED.source, source_status=EXCLUDED.source_status, confidence=EXCLUDED.confidence,
        limitations=EXCLUDED.limitations, measured_at=EXCLUDED.measured_at, updated_at=NOW()`,
      [input.workspaceId, input.snapshotId, metricKey, JSON.stringify(metric.value ?? null),
        typeof metric.unit === 'string' ? metric.unit : null, typeof metric.period === 'string' ? metric.period : null,
        typeof metric.source === 'string' ? metric.source : null, safeStatus,
        typeof metric.confidence === 'string' ? metric.confidence : null,
        JSON.stringify(Array.isArray(metric.limitations) ? metric.limitations : []), null]);
  }
}

export async function getLatestKnowledgeSnapshot(workspaceId: string, snapshotType = 'initial_business_analysis') {
  const { rows } = await query(`
    SELECT id, workspace_id AS "workspaceId", source_run_id AS "sourceRunId", snapshot_type AS "snapshotType",
      status, confidence, executive_summary AS "executiveSummary", data_gaps AS "dataGaps",
      verified_facts AS "verifiedFacts", priorities, knowledge_base AS "knowledgeBase",
      source_manifest AS "sourceManifest", generated_at AS "generatedAt", updated_at AS "updatedAt"
    FROM workspace_knowledge_snapshots
    WHERE workspace_id=$1 AND snapshot_type=$2 AND status='completed'
    ORDER BY generated_at DESC NULLS LAST, updated_at DESC LIMIT 1`, [workspaceId, snapshotType]);
  return rows[0] ?? null;
}

export async function listKnowledgeSections(workspaceId: string, snapshotId: string) {
  const { rows } = await query(`SELECT section_key AS "sectionKey", status, content, updated_at AS "updatedAt"
    FROM workspace_knowledge_sections WHERE workspace_id=$1 AND snapshot_id=$2 ORDER BY section_key`, [workspaceId, snapshotId]);
  return rows;
}

export async function listIntelligenceMetrics(workspaceId: string, snapshotId?: string) {
  const values: unknown[] = [workspaceId];
  const where = snapshotId ? 'AND snapshot_id=$2' : '';
  if (snapshotId) values.push(snapshotId);
  const { rows } = await query(`SELECT metric_key AS "metricKey", value, unit, period, source,
      source_status AS "sourceStatus", confidence, limitations, measured_at AS "measuredAt", updated_at AS "updatedAt"
    FROM workspace_intelligence_metrics WHERE workspace_id=$1 ${where} ORDER BY metric_key`, values);
  return rows;
}

export async function getKnowledgeBundle(workspaceId: string, snapshotType = 'initial_business_analysis') {
  const snapshot = await getLatestKnowledgeSnapshot(workspaceId, snapshotType);
  if (!snapshot) return null;
  const [sections, metrics] = await Promise.all([
    listKnowledgeSections(workspaceId, snapshot.id),
    listIntelligenceMetrics(workspaceId, snapshot.id),
  ]);
  return { snapshot, sections, metrics };
}
