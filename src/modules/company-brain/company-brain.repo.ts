import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import type { DomainEvent } from '../../events/domain-event.types.js';
import type { BrainDecision, BrainMission, BrainObservation, BrainSignal, BrainTask } from './company-brain.types.js';

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
  context,result,error_code AS "errorCode",error_message AS "errorMessage",created_at AS "createdAt",updated_at AS "updatedAt"`;
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
