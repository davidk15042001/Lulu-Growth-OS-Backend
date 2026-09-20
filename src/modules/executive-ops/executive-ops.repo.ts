import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import type {
  ExecutiveCycleType,
  ExecutiveFinding,
  ExecutiveLearningRecord,
  ExecutiveMetricForecast,
  ExecutiveOperatingCycle,
  ExecutiveOperatingSchedule,
  ExecutiveProposal,
  ExecutiveProposalEvent,
  ExecutiveScenario,
  ExecutiveScenarioProjection,
} from './executive-ops.types.js';

const scheduleSelect = `id,workspace_id AS "workspaceId",cycle_type AS "cycleType",timezone,
  hour_of_day AS "hourOfDay",weekday,active,next_run_at AS "nextRunAt",last_run_at AS "lastRunAt",
  lease_owner AS "leaseOwner",lease_expires_at AS "leaseExpiresAt",created_at AS "createdAt",updated_at AS "updatedAt"`;

const cycleSelect = `id,workspace_id AS "workspaceId",cycle_type AS "cycleType",trigger_type AS "triggerType",timezone,
  period_start AS "periodStart",period_end AS "periodEnd",data_cutoff_at AS "dataCutoffAt",status,summary,evidence,
  data_gaps AS "dataGaps",failure_code AS "failureCode",failure_message AS "failureMessage",started_by AS "startedBy",
  started_at AS "startedAt",completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt"`;

const findingSelect = `id,workspace_id AS "workspaceId",cycle_id AS "cycleId",source_key AS "sourceKey",
  finding_type AS "findingType",subject_type AS "subjectType",subject_id AS "subjectId",severity,
  materiality::float AS materiality,status,title,description,evidence,created_at AS "createdAt"`;

const forecastSelect = `f.id,f.workspace_id AS "workspaceId",f.cycle_id AS "cycleId",f.metric_id AS "metricId",
  md.key AS "metricKey",md.name AS "metricName",md.domain AS "metricDomain",md.unit AS "metricUnit",
  f.source_metric_point_id::text AS "sourceMetricPointId",f.method,f.model_version AS "modelVersion",
  f.baseline_value AS "baselineValue",f.projected_low AS "projectedLow",f.projected_base AS "projectedBase",
  f.projected_high AS "projectedHigh",f.baseline_recorded_at AS "baselineRecordedAt",f.forecasted_for AS "forecastedFor",
  f.horizon_seconds AS "horizonSeconds",f.confidence::float AS confidence,f.assumptions,f.evidence,f.status,
  f.actual_value AS "actualValue",f.actual_recorded_at AS "actualRecordedAt",f.absolute_error AS "absoluteError",
  f.relative_error AS "relativeError",f.calibrated_at AS "calibratedAt",f.created_at AS "createdAt",f.updated_at AS "updatedAt"`;

const scenarioSelect = `id,workspace_id AS "workspaceId",cycle_id AS "cycleId",name,description,status,assumptions,
  created_by AS "createdBy",created_at AS "createdAt",updated_at AS "updatedAt"`;

const scenarioProjectionSelect = `p.id,p.workspace_id AS "workspaceId",p.scenario_id AS "scenarioId",p.forecast_id AS "forecastId",
  f.metric_id AS "metricId",md.key AS "metricKey",md.name AS "metricName",p.adjustment_percent AS "adjustmentPercent",
  p.projected_value AS "projectedValue",p.evidence,p.created_at AS "createdAt"`;

const proposalSelect = `id,workspace_id AS "workspaceId",cycle_id AS "cycleId",finding_id AS "findingId",
  proposal_type AS "proposalType",title,objective,status,priority,confidence::float AS confidence,
  requires_human_approval AS "requiresHumanApproval",execution_mode AS "executionMode",expected_impact AS "expectedImpact",
  risk_notes AS "riskNotes",evidence,company_brain_signal_id AS "companyBrainSignalId",
  company_brain_mission_id AS "companyBrainMissionId",company_brain_task_id AS "companyBrainTaskId",
  idempotency_key AS "idempotencyKey",created_by AS "createdBy",version,created_at AS "createdAt",updated_at AS "updatedAt"`;

const proposalEventSelect = `id,workspace_id AS "workspaceId",proposal_id AS "proposalId",event_type AS "eventType",
  actor_type AS "actorType",actor_id AS "actorId",payload,created_at AS "createdAt"`;

const learningSelect = `id,workspace_id AS "workspaceId",cycle_id AS "cycleId",forecast_id AS "forecastId",
  proposal_id AS "proposalId",source_key AS "sourceKey",learning_type AS "learningType",outcome,evidence,
  confidence::float AS confidence,verified,created_at AS "createdAt"`;

type QueryClient = PoolClient | undefined;

export type ForecastCandidate = {
  metricId: string;
  metricKey: string;
  metricName: string;
  metricDomain: string;
  metricUnit: string;
  sourceMetricPointId: string;
  baselineValue: string;
  baselineRecordedAt: string;
  forecastedFor: string;
  horizonSeconds: number;
  projectedLow: string;
  projectedBase: string;
  projectedHigh: string;
};

export type FinancialRiskFact = {
  currency: string;
  invoiceCount: number;
  amountDue: string;
  oldestDueDate: string | null;
};

export type OperationalBottleneckFact = {
  taskId: string;
  missionId: string;
  title: string;
  priority: number;
  status: string;
  blockedReason: string | null;
  errorCode: string | null;
  updatedAt: string;
};

export type FailedAgentRunFact = {
  runId: string;
  module: string | null;
  errorCode: string | null;
  updatedAt: string;
};

export type OpenSignalFact = {
  signalId: string;
  signalType: string;
  severity: number;
  materiality: number;
  explanation: string;
  detectedAt: string;
};

export type CreateFindingInput = {
  workspaceId: string;
  cycleId: string;
  sourceKey: string;
  findingType: string;
  subjectType: string;
  subjectId?: string | null;
  severity: number;
  materiality: number;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
};

export type CreateForecastInput = ForecastCandidate & {
  workspaceId: string;
  cycleId: string;
  confidence: number;
  assumptions: unknown[];
  evidence: Record<string, unknown>;
};

export type CreateProposalInput = {
  workspaceId: string;
  cycleId?: string | null;
  findingId?: string | null;
  proposalType: ExecutiveProposal['proposalType'];
  title: string;
  objective: string;
  priority: number;
  confidence: number;
  expectedImpact: Record<string, unknown>;
  riskNotes: unknown[];
  evidence: Record<string, unknown>;
  idempotencyKey: string;
  createdBy?: string | null;
  actorType: 'system' | 'agent' | 'human';
  actorId?: string | null;
};

export type ProposalDecisionResult = {
  proposal: ExecutiveProposal;
  changed: boolean;
  reason?: 'not_decidable' | 'version_conflict';
};

function boundedLimit(limit: number, maximum = 100) {
  return Math.max(1, Math.min(maximum, Math.trunc(limit)));
}

const nextRunAtSql = `
  CASE
    WHEN cycle_type='daily' THEN (
      CASE
        WHEN date_trunc('day', NOW() AT TIME ZONE timezone) + (hour_of_day * INTERVAL '1 hour') > NOW() AT TIME ZONE timezone
          THEN date_trunc('day', NOW() AT TIME ZONE timezone) + (hour_of_day * INTERVAL '1 hour')
        ELSE date_trunc('day', NOW() AT TIME ZONE timezone) + INTERVAL '1 day' + (hour_of_day * INTERVAL '1 hour')
      END
    ) AT TIME ZONE timezone
    ELSE (
      CASE
        WHEN date_trunc('week', NOW() AT TIME ZONE timezone) + (weekday * INTERVAL '1 day') + (hour_of_day * INTERVAL '1 hour') > NOW() AT TIME ZONE timezone
          THEN date_trunc('week', NOW() AT TIME ZONE timezone) + (weekday * INTERVAL '1 day') + (hour_of_day * INTERVAL '1 hour')
        ELSE date_trunc('week', NOW() AT TIME ZONE timezone) + INTERVAL '7 days' + (weekday * INTERVAL '1 day') + (hour_of_day * INTERVAL '1 hour')
      END
    ) AT TIME ZONE timezone
  END`;

export async function getWorkspaceTimezone(workspaceId: string, client?: QueryClient) {
  const { rows } = await query<{ timezone: string }>(
    `SELECT COALESCE(
       (SELECT timezone FROM executive_operating_schedules WHERE workspace_id=$1 AND cycle_type='daily' LIMIT 1),
       f.timezone,
       'UTC'
     ) AS timezone
     FROM workspaces w
     LEFT JOIN factories f ON f.id=w.factory_id
     WHERE w.id=$1`,
    [workspaceId],
    client,
  );
  return rows[0]?.timezone ?? 'UTC';
}

export async function getCycleWindow(cycleType: ExecutiveCycleType, timezone: string) {
  const unit = cycleType === 'daily' ? 'day' : 'week';
  const interval = cycleType === 'daily' ? '1 day' : '1 week';
  const { rows } = await query<{ periodStart: string; periodEnd: string }>(
    `WITH local_clock AS (SELECT NOW() AT TIME ZONE $1 AS local_now)
     SELECT (date_trunc('${unit}', local_now) AT TIME ZONE $1) AS "periodStart",
            ((date_trunc('${unit}', local_now) + INTERVAL '${interval}') AT TIME ZONE $1) AS "periodEnd"
       FROM local_clock`,
    [timezone],
  );
  const window = rows[0];
  if (!window) throw new Error('Executive cycle window could not be calculated');
  return window;
}

export async function listSchedules(workspaceId: string, client?: QueryClient) {
  const { rows } = await query<ExecutiveOperatingSchedule>(
    `SELECT ${scheduleSelect} FROM executive_operating_schedules
     WHERE workspace_id=$1 ORDER BY cycle_type ASC`,
    [workspaceId],
    client,
  );
  return rows;
}

async function recalculateScheduleNextRun(workspaceId: string, cycleType: ExecutiveCycleType, client: PoolClient) {
  const { rows } = await query<ExecutiveOperatingSchedule>(
    `UPDATE executive_operating_schedules
        SET next_run_at=${nextRunAtSql}, lease_owner=NULL, lease_expires_at=NULL
      WHERE workspace_id=$1 AND cycle_type=$2
      RETURNING ${scheduleSelect}`,
    [workspaceId, cycleType],
    client,
  );
  return rows[0] ?? null;
}

export async function ensureDefaultSchedules(workspaceId: string) {
  return withTransaction(async (client) => {
    const timezone = await getWorkspaceTimezone(workspaceId, client);
    await query(
      `INSERT INTO executive_operating_schedules(
         workspace_id,cycle_type,timezone,hour_of_day,weekday,active,next_run_at
       ) VALUES
         ($1,'daily',$2,8,0,TRUE,NOW()),
         ($1,'weekly',$2,9,0,TRUE,NOW())
       ON CONFLICT (workspace_id,cycle_type) DO NOTHING`,
      [workspaceId, timezone],
      client,
    );
    return listSchedules(workspaceId, client);
  });
}

export async function saveSchedule(input: {
  workspaceId: string;
  cycleType: ExecutiveCycleType;
  timezone: string;
  hourOfDay: number;
  weekday: number;
  active: boolean;
}) {
  return withTransaction(async (client) => {
    await query(
      `INSERT INTO executive_operating_schedules(
         workspace_id,cycle_type,timezone,hour_of_day,weekday,active,next_run_at
       ) VALUES($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (workspace_id,cycle_type) DO UPDATE SET
         timezone=EXCLUDED.timezone,hour_of_day=EXCLUDED.hour_of_day,weekday=EXCLUDED.weekday,
         active=EXCLUDED.active,lease_owner=NULL,lease_expires_at=NULL`,
      [input.workspaceId, input.cycleType, input.timezone, input.hourOfDay, input.weekday, input.active],
      client,
    );
    if (!input.active) {
      const { rows } = await query<ExecutiveOperatingSchedule>(
        `SELECT ${scheduleSelect} FROM executive_operating_schedules
         WHERE workspace_id=$1 AND cycle_type=$2`,
        [input.workspaceId, input.cycleType],
        client,
      );
      return rows[0] ?? null;
    }
    return recalculateScheduleNextRun(input.workspaceId, input.cycleType, client);
  });
}

export async function claimDueSchedules(workerId: string, leaseSeconds: number, limit: number, workspaceIds: string[]) {
  if (workspaceIds.length === 0) return [] as ExecutiveOperatingSchedule[];
  return withTransaction(async (client) => {
    const { rows } = await query<ExecutiveOperatingSchedule>(
      `WITH candidates AS (
         SELECT schedule.id AS candidate_id
           FROM executive_operating_schedules schedule
          WHERE schedule.active
            AND schedule.workspace_id=ANY($4::uuid[])
            AND schedule.next_run_at <= NOW()
            AND (schedule.lease_expires_at IS NULL OR schedule.lease_expires_at < NOW())
            AND NOT COALESCE((
              SELECT (settings->'agents'->>'paused')::boolean
                FROM workspace_settings
               WHERE workspace_id=schedule.workspace_id
            ), FALSE)
          ORDER BY schedule.next_run_at ASC, schedule.created_at ASC
          LIMIT $3
          FOR UPDATE SKIP LOCKED
       )
       UPDATE executive_operating_schedules schedule
          SET lease_owner=$1,lease_expires_at=NOW() + ($2::integer * INTERVAL '1 second')
         FROM candidates
        WHERE schedule.id=candidates.candidate_id
       RETURNING ${scheduleSelect}`,
      [workerId, leaseSeconds, boundedLimit(limit, 100), workspaceIds],
      client,
    );
    return rows;
  });
}

export async function completeScheduleRun(input: {
  workspaceId: string;
  cycleType: ExecutiveCycleType;
  workerId: string;
}) {
  const { rows } = await query<ExecutiveOperatingSchedule>(
    `UPDATE executive_operating_schedules
        SET last_run_at=NOW(),next_run_at=${nextRunAtSql},lease_owner=NULL,lease_expires_at=NULL
      WHERE workspace_id=$1 AND cycle_type=$2 AND lease_owner=$3
      RETURNING ${scheduleSelect}`,
    [input.workspaceId, input.cycleType, input.workerId],
  );
  return rows[0] ?? null;
}

export async function releaseScheduleLease(input: {
  workspaceId: string;
  cycleType: ExecutiveCycleType;
  workerId: string;
  retryAfterSeconds: number;
}) {
  await query(
    `UPDATE executive_operating_schedules
        SET next_run_at=NOW() + ($4::integer * INTERVAL '1 second'),lease_owner=NULL,lease_expires_at=NULL
      WHERE workspace_id=$1 AND cycle_type=$2 AND lease_owner=$3`,
    [input.workspaceId, input.cycleType, input.workerId, Math.max(30, Math.min(3600, Math.trunc(input.retryAfterSeconds)))],
  );
}

export async function claimOperatingCycle(input: {
  workspaceId: string;
  cycleType: ExecutiveCycleType;
  triggerType: ExecutiveOperatingCycle['triggerType'];
  timezone: string;
  periodStart: string;
  periodEnd: string;
  startedBy?: string | null;
}) {
  return withTransaction(async (client) => {
    const inserted = await query<ExecutiveOperatingCycle>(
      `INSERT INTO executive_operating_cycles(
         workspace_id,cycle_type,trigger_type,timezone,period_start,period_end,started_by,status
       ) VALUES($1,$2,$3,$4,$5,$6,$7,'running')
       ON CONFLICT (workspace_id,cycle_type,period_start) DO NOTHING
       RETURNING ${cycleSelect}`,
      [input.workspaceId, input.cycleType, input.triggerType, input.timezone, input.periodStart, input.periodEnd, input.startedBy ?? null],
      client,
    );
    if (inserted.rows[0]) return { cycle: inserted.rows[0], claimed: true };

    const existing = (await query<ExecutiveOperatingCycle>(
      `SELECT ${cycleSelect} FROM executive_operating_cycles
       WHERE workspace_id=$1 AND cycle_type=$2 AND period_start=$3
       FOR UPDATE`,
      [input.workspaceId, input.cycleType, input.periodStart],
      client,
    )).rows[0];
    if (!existing) throw new Error('Executive cycle conflict did not return an existing cycle');
    const startedAt = Date.parse(existing.startedAt);
    const stale = existing.status === 'running' && Number.isFinite(startedAt) && startedAt < Date.now() - 30 * 60_000;
    if (existing.status !== 'failed' && !stale) return { cycle: existing, claimed: false };

    const retry = await query<ExecutiveOperatingCycle>(
      `UPDATE executive_operating_cycles
          SET trigger_type=$4,timezone=$5,period_end=$6,data_cutoff_at=NOW(),status='running',summary='{}'::jsonb,
              evidence='{}'::jsonb,data_gaps='[]'::jsonb,failure_code=NULL,failure_message=NULL,started_by=$7,
              started_at=NOW(),completed_at=NULL
        WHERE workspace_id=$1 AND id=$2 AND status=$3
        RETURNING ${cycleSelect}`,
      [input.workspaceId, existing.id, existing.status, input.triggerType, input.timezone, input.periodEnd, input.startedBy ?? null],
      client,
    );
    return { cycle: retry.rows[0] ?? existing, claimed: Boolean(retry.rows[0]) };
  });
}

export async function completeOperatingCycle(input: {
  workspaceId: string;
  cycleId: string;
  summary: Record<string, unknown>;
  evidence: Record<string, unknown>;
  dataGaps: unknown[];
}) {
  const { rows } = await query<ExecutiveOperatingCycle>(
    `UPDATE executive_operating_cycles
        SET status='completed',summary=$3::jsonb,evidence=$4::jsonb,data_gaps=$5::jsonb,completed_at=NOW()
      WHERE workspace_id=$1 AND id=$2 AND status='running'
      RETURNING ${cycleSelect}`,
    [input.workspaceId, input.cycleId, JSON.stringify(input.summary), JSON.stringify(input.evidence), JSON.stringify(input.dataGaps)],
  );
  return rows[0] ?? null;
}

export async function failOperatingCycle(input: {
  workspaceId: string;
  cycleId: string;
  code: string;
  message: string;
}) {
  await query(
    `UPDATE executive_operating_cycles
        SET status='failed',failure_code=$3,failure_message=$4,completed_at=NOW()
      WHERE workspace_id=$1 AND id=$2 AND status='running'`,
    [input.workspaceId, input.cycleId, input.code.slice(0, 160), input.message.slice(0, 4000)],
  );
}

export async function listCycles(workspaceId: string, limit: number, cycleType?: ExecutiveCycleType) {
  const values: unknown[] = [workspaceId, boundedLimit(limit)];
  const typeWhere = cycleType ? 'AND cycle_type=$3' : '';
  if (cycleType) values.push(cycleType);
  const { rows } = await query<ExecutiveOperatingCycle>(
    `SELECT ${cycleSelect} FROM executive_operating_cycles
     WHERE workspace_id=$1 ${typeWhere}
     ORDER BY period_start DESC
     LIMIT $2`,
    values,
  );
  return rows;
}

export async function getCycle(workspaceId: string, cycleId: string) {
  const { rows } = await query<ExecutiveOperatingCycle>(
    `SELECT ${cycleSelect} FROM executive_operating_cycles WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, cycleId],
  );
  return rows[0] ?? null;
}

export async function getLatestCycle(workspaceId: string, cycleType: ExecutiveCycleType) {
  const { rows } = await query<ExecutiveOperatingCycle>(
    `SELECT ${cycleSelect} FROM executive_operating_cycles
     WHERE workspace_id=$1 AND cycle_type=$2
     ORDER BY period_start DESC LIMIT 1`,
    [workspaceId, cycleType],
  );
  return rows[0] ?? null;
}

export async function listOpenSignals(workspaceId: string, limit: number) {
  const { rows } = await query<OpenSignalFact>(
    `SELECT id AS "signalId",signal_type AS "signalType",severity,materiality::float AS materiality,
            explanation,detected_at AS "detectedAt"
       FROM company_brain_signals
      WHERE workspace_id=$1 AND status='OPEN'
      ORDER BY materiality DESC,severity DESC,detected_at DESC
      LIMIT $2`,
    [workspaceId, boundedLimit(limit)],
  );
  return rows;
}

export async function listOperationalBottlenecks(workspaceId: string, limit: number) {
  const { rows } = await query<OperationalBottleneckFact>(
    `SELECT id AS "taskId",mission_id AS "missionId",title,priority,status,blocked_reason AS "blockedReason",
            error_code AS "errorCode",updated_at AS "updatedAt"
       FROM company_brain_tasks
      WHERE workspace_id=$1 AND status IN ('BLOCKED','FAILED')
      ORDER BY priority DESC,updated_at DESC
      LIMIT $2`,
    [workspaceId, boundedLimit(limit)],
  );
  return rows;
}

export async function listRecentFailedAgentRuns(workspaceId: string, limit: number) {
  const { rows } = await query<FailedAgentRunFact>(
    `SELECT id AS "runId",NULLIF(plan->>'module','') AS module,error_code AS "errorCode",updated_at AS "updatedAt"
       FROM agent_runs
      WHERE workspace_id=$1 AND status='failed' AND updated_at >= NOW() - INTERVAL '7 days'
      ORDER BY updated_at DESC
      LIMIT $2`,
    [workspaceId, boundedLimit(limit)],
  );
  return rows;
}

export async function listOverdueInvoiceExposure(workspaceId: string) {
  const { rows } = await query<FinancialRiskFact>(
    `SELECT currency,COUNT(*)::integer AS "invoiceCount",SUM(amount_due) AS "amountDue",MIN(due_date)::text AS "oldestDueDate"
       FROM invoices
      WHERE workspace_id=$1
        AND amount_due > 0
        AND status NOT IN ('PAID','VOID','CANCELLED','REFUNDED')
        AND (status='OVERDUE' OR due_date < CURRENT_DATE)
      GROUP BY currency
      ORDER BY currency ASC`,
    [workspaceId],
  );
  return rows;
}

export async function getMetricCoverage(workspaceId: string) {
  const { rows } = await query<{ defined: string; withTwoPoints: string }>(
    `SELECT COUNT(*)::text AS defined,
            COUNT(*) FILTER (WHERE points.point_count >= 2)::text AS "withTwoPoints"
       FROM metric_definitions md
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::integer AS point_count
           FROM metric_points mp
          WHERE mp.metric_id=md.id
       ) points ON TRUE
      WHERE md.workspace_id=$1 AND md.deleted_at IS NULL`,
    [workspaceId],
  );
  return {
    defined: Number(rows[0]?.defined ?? 0),
    withTwoPoints: Number(rows[0]?.withTwoPoints ?? 0),
  };
}

export async function listForecastCandidates(workspaceId: string, limit: number) {
  const { rows } = await query<ForecastCandidate>(
    `WITH ranked AS (
       SELECT md.id AS "metricId",md.key AS "metricKey",md.name AS "metricName",md.domain AS "metricDomain",md.unit AS "metricUnit",
              mp.id::text AS "sourceMetricPointId",mp.value,mp.recorded_at AS "recordedAt",
              ROW_NUMBER() OVER (PARTITION BY md.id ORDER BY mp.recorded_at DESC,mp.id DESC) AS position
         FROM metric_definitions md
         JOIN metric_points mp ON mp.metric_id=md.id
        WHERE md.workspace_id=$1 AND md.deleted_at IS NULL
     )
     SELECT latest."metricId",latest."metricKey",latest."metricName",latest."metricDomain",latest."metricUnit",
            latest."sourceMetricPointId",latest.value AS "baselineValue",latest."recordedAt" AS "baselineRecordedAt",
            latest."recordedAt" + (latest."recordedAt" - previous."recordedAt") AS "forecastedFor",
            EXTRACT(EPOCH FROM (latest."recordedAt" - previous."recordedAt"))::integer AS "horizonSeconds",
            latest.value + ((latest.value - previous.value) * 0.5::numeric) AS "projectedLow",
            latest.value + (latest.value - previous.value) AS "projectedBase",
            latest.value + ((latest.value - previous.value) * 1.5::numeric) AS "projectedHigh"
       FROM ranked latest
       JOIN ranked previous ON previous."metricId"=latest."metricId" AND previous.position=2
      WHERE latest.position=1 AND latest."recordedAt" > previous."recordedAt"
      ORDER BY latest."metricDomain" ASC,latest."metricName" ASC
      LIMIT $2`,
    [workspaceId, boundedLimit(limit, 50)],
  );
  return rows.filter((row) => Number.isFinite(Number(row.horizonSeconds)) && row.horizonSeconds > 0);
}

export async function upsertFindings(inputs: CreateFindingInput[]) {
  if (inputs.length === 0) return [] as ExecutiveFinding[];
  return withTransaction(async (client) => {
    const findings: ExecutiveFinding[] = [];
    for (const input of inputs) {
      const { rows } = await query<ExecutiveFinding>(
        `INSERT INTO executive_operating_findings(
           workspace_id,cycle_id,source_key,finding_type,subject_type,subject_id,severity,materiality,title,description,evidence
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         ON CONFLICT (workspace_id,cycle_id,source_key) DO UPDATE SET
           finding_type=EXCLUDED.finding_type,subject_type=EXCLUDED.subject_type,subject_id=EXCLUDED.subject_id,
           severity=EXCLUDED.severity,materiality=EXCLUDED.materiality,title=EXCLUDED.title,
           description=EXCLUDED.description,evidence=EXCLUDED.evidence
         RETURNING ${findingSelect}`,
        [input.workspaceId, input.cycleId, input.sourceKey, input.findingType, input.subjectType, input.subjectId ?? null,
          input.severity, input.materiality, input.title, input.description, JSON.stringify(input.evidence)],
        client,
      );
      if (rows[0]) findings.push(rows[0]);
    }
    return findings;
  });
}

export async function createForecasts(inputs: CreateForecastInput[]) {
  if (inputs.length === 0) return [] as string[];
  return withTransaction(async (client) => {
    const ids: string[] = [];
    for (const input of inputs) {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO executive_metric_forecasts(
           workspace_id,cycle_id,metric_id,source_metric_point_id,method,model_version,baseline_value,
           projected_low,projected_base,projected_high,baseline_recorded_at,forecasted_for,horizon_seconds,
           confidence,assumptions,evidence
         ) VALUES($1,$2,$3,$4,'two_point_trend','v1',$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb)
         ON CONFLICT (workspace_id,cycle_id,metric_id,forecasted_for,model_version) DO NOTHING
         RETURNING id`,
        [input.workspaceId, input.cycleId, input.metricId, input.sourceMetricPointId, input.baselineValue,
          input.projectedLow, input.projectedBase, input.projectedHigh, input.baselineRecordedAt, input.forecastedFor,
          input.horizonSeconds, input.confidence, JSON.stringify(input.assumptions), JSON.stringify(input.evidence)],
        client,
      );
      if (rows[0]) ids.push(rows[0].id);
    }
    return ids;
  });
}

export async function listFindings(workspaceId: string, limit: number, cycleId?: string) {
  const values: unknown[] = [workspaceId, boundedLimit(limit)];
  const cycleWhere = cycleId ? 'AND cycle_id=$3' : '';
  if (cycleId) values.push(cycleId);
  const { rows } = await query<ExecutiveFinding>(
    `SELECT ${findingSelect} FROM executive_operating_findings
     WHERE workspace_id=$1 ${cycleWhere}
     ORDER BY severity DESC,materiality DESC,created_at DESC
     LIMIT $2`,
    values,
  );
  return rows;
}

export async function getFinding(workspaceId: string, findingId: string, client?: QueryClient) {
  const { rows } = await query<ExecutiveFinding>(
    `SELECT ${findingSelect} FROM executive_operating_findings
     WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, findingId],
    client,
  );
  return rows[0] ?? null;
}

export async function listForecasts(workspaceId: string, limit: number, cycleId?: string) {
  const values: unknown[] = [workspaceId, boundedLimit(limit)];
  const cycleWhere = cycleId ? 'AND f.cycle_id=$3' : '';
  if (cycleId) values.push(cycleId);
  const { rows } = await query<ExecutiveMetricForecast>(
    `SELECT ${forecastSelect}
       FROM executive_metric_forecasts f
       JOIN metric_definitions md ON md.workspace_id=f.workspace_id AND md.id=f.metric_id
      WHERE f.workspace_id=$1 ${cycleWhere}
      ORDER BY f.forecasted_for DESC,f.created_at DESC
      LIMIT $2`,
    values,
  );
  return rows;
}

export async function getForecast(workspaceId: string, forecastId: string, client?: QueryClient) {
  const { rows } = await query<ExecutiveMetricForecast>(
    `SELECT ${forecastSelect}
       FROM executive_metric_forecasts f
       JOIN metric_definitions md ON md.workspace_id=f.workspace_id AND md.id=f.metric_id
      WHERE f.workspace_id=$1 AND f.id=$2`,
    [workspaceId, forecastId],
    client,
  );
  return rows[0] ?? null;
}

export async function createScenario(input: {
  workspaceId: string;
  cycleId: string;
  name: string;
  description: string;
  assumptions: unknown[];
  createdBy: string;
  projections: Array<{ forecastId: string; adjustmentPercent: number }>;
}) {
  return withTransaction(async (client) => {
    const cycle = await query<{ id: string }>(
      `SELECT id FROM executive_operating_cycles WHERE workspace_id=$1 AND id=$2`,
      [input.workspaceId, input.cycleId],
      client,
    );
    if (!cycle.rows[0]) return null;
    const created = await query<ExecutiveScenario>(
      `INSERT INTO executive_scenarios(workspace_id,cycle_id,name,description,status,assumptions,created_by)
       VALUES($1,$2,$3,$4,'draft',$5::jsonb,$6)
       RETURNING ${scenarioSelect}`,
      [input.workspaceId, input.cycleId, input.name, input.description, JSON.stringify(input.assumptions), input.createdBy],
      client,
    );
    const scenario = created.rows[0];
    if (!scenario) throw new Error('Executive scenario insert did not return a row');
    for (const projection of input.projections) {
      const inserted = await query<{ id: string }>(
        `INSERT INTO executive_scenario_projections(
           workspace_id,scenario_id,forecast_id,adjustment_percent,projected_value,evidence
         )
         SELECT $1,$2,f.id,$4::numeric,
                f.projected_base * (1 + ($4::numeric / 100)),
                jsonb_build_object('baseForecastValue',f.projected_base,'method','explicit_percentage_adjustment')
           FROM executive_metric_forecasts f
          WHERE f.workspace_id=$1 AND f.id=$3
         RETURNING id`,
        [input.workspaceId, scenario.id, projection.forecastId, String(projection.adjustmentPercent)],
        client,
      );
      if (!inserted.rows[0]) {
        throw new Error('Executive scenario references a forecast outside this workspace');
      }
    }
    const { rows } = await query<ExecutiveScenario>(
      `UPDATE executive_scenarios SET status='ready'
        WHERE workspace_id=$1 AND id=$2
        RETURNING ${scenarioSelect}`,
      [input.workspaceId, scenario.id],
      client,
    );
    return rows[0] ?? null;
  });
}

export async function listScenarios(workspaceId: string, limit: number) {
  const { rows } = await query<ExecutiveScenario>(
    `SELECT ${scenarioSelect} FROM executive_scenarios
     WHERE workspace_id=$1
     ORDER BY created_at DESC
     LIMIT $2`,
    [workspaceId, boundedLimit(limit)],
  );
  return rows;
}

export async function getScenario(workspaceId: string, scenarioId: string) {
  const scenario = (await query<ExecutiveScenario>(
    `SELECT ${scenarioSelect} FROM executive_scenarios WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, scenarioId],
  )).rows[0];
  if (!scenario) return null;
  const projections = (await query<ExecutiveScenarioProjection>(
    `SELECT ${scenarioProjectionSelect}
       FROM executive_scenario_projections p
       JOIN executive_metric_forecasts f ON f.workspace_id=p.workspace_id AND f.id=p.forecast_id
       JOIN metric_definitions md ON md.workspace_id=f.workspace_id AND md.id=f.metric_id
      WHERE p.workspace_id=$1 AND p.scenario_id=$2
      ORDER BY p.created_at ASC`,
    [workspaceId, scenarioId],
  )).rows;
  return { ...scenario, projections };
}

async function appendProposalEvent(input: {
  workspaceId: string;
  proposalId: string;
  eventType: string;
  actorType: 'system' | 'agent' | 'human';
  actorId?: string | null;
  payload?: Record<string, unknown>;
}, client: PoolClient) {
  const { rows } = await query<ExecutiveProposalEvent>(
    `INSERT INTO executive_proposal_events(workspace_id,proposal_id,event_type,actor_type,actor_id,payload)
     VALUES($1,$2,$3,$4,$5,$6::jsonb)
     RETURNING ${proposalEventSelect}`,
    [input.workspaceId, input.proposalId, input.eventType, input.actorType, input.actorId ?? null, JSON.stringify(input.payload ?? {})],
    client,
  );
  return rows[0] ?? null;
}

export async function createProposal(input: CreateProposalInput) {
  return withTransaction(async (client) => {
    const existing = await query<ExecutiveProposal>(
      `SELECT ${proposalSelect} FROM executive_proposals WHERE workspace_id=$1 AND idempotency_key=$2`,
      [input.workspaceId, input.idempotencyKey],
      client,
    );
    if (existing.rows[0]) return { proposal: existing.rows[0], created: false as const };
    const { rows } = await query<ExecutiveProposal>(
      `INSERT INTO executive_proposals(
         workspace_id,cycle_id,finding_id,proposal_type,title,objective,status,priority,confidence,
         requires_human_approval,execution_mode,expected_impact,risk_notes,evidence,idempotency_key,created_by
       ) VALUES($1,$2,$3,$4,$5,$6,'proposed',$7,$8,TRUE,'plan_only',$9::jsonb,$10::jsonb,$11::jsonb,$12,$13)
       RETURNING ${proposalSelect}`,
      [input.workspaceId, input.cycleId ?? null, input.findingId ?? null, input.proposalType, input.title, input.objective,
        input.priority, input.confidence, JSON.stringify(input.expectedImpact), JSON.stringify(input.riskNotes),
        JSON.stringify(input.evidence), input.idempotencyKey, input.createdBy ?? null],
      client,
    );
    const proposal = rows[0];
    if (!proposal) throw new Error('Executive proposal insert did not return a row');
    await appendProposalEvent({
      workspaceId: input.workspaceId, proposalId: proposal.id, eventType: 'PROPOSED', actorType: input.actorType,
      actorId: input.actorId ?? null, payload: { proposalType: proposal.proposalType, source: input.actorType },
    }, client);
    return { proposal, created: true as const };
  });
}

export async function listProposals(workspaceId: string, limit: number, status?: ExecutiveProposal['status']) {
  const values: unknown[] = [workspaceId, boundedLimit(limit)];
  const statusWhere = status ? 'AND status=$3' : '';
  if (status) values.push(status);
  const { rows } = await query<ExecutiveProposal>(
    `SELECT ${proposalSelect} FROM executive_proposals
     WHERE workspace_id=$1 ${statusWhere}
     ORDER BY priority DESC,created_at DESC
     LIMIT $2`,
    values,
  );
  return rows;
}

export async function listProposalsForCycle(workspaceId: string, cycleId: string, limit: number) {
  const { rows } = await query<ExecutiveProposal>(
    `SELECT ${proposalSelect} FROM executive_proposals
     WHERE workspace_id=$1 AND cycle_id=$2
     ORDER BY priority DESC,created_at DESC
     LIMIT $3`,
    [workspaceId, cycleId, boundedLimit(limit)],
  );
  return rows;
}

export async function listApprovedProposals(limit: number) {
  const { rows } = await query<ExecutiveProposal>(
    `SELECT ${proposalSelect} FROM executive_proposals
     WHERE status='approved'
     ORDER BY updated_at ASC
     LIMIT $1`,
    [boundedLimit(limit, 100)],
  );
  return rows;
}

export async function getProposal(workspaceId: string, proposalId: string, client?: QueryClient) {
  const { rows } = await query<ExecutiveProposal>(
    `SELECT ${proposalSelect} FROM executive_proposals WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, proposalId],
    client,
  );
  return rows[0] ?? null;
}

export async function listProposalEvents(workspaceId: string, proposalId: string, limit: number) {
  const { rows } = await query<ExecutiveProposalEvent>(
    `SELECT ${proposalEventSelect} FROM executive_proposal_events
     WHERE workspace_id=$1 AND proposal_id=$2
     ORDER BY created_at DESC
     LIMIT $3`,
    [workspaceId, proposalId, boundedLimit(limit)],
  );
  return rows;
}

export async function decideProposal(input: {
  workspaceId: string;
  proposalId: string;
  expectedVersion: number;
  decision: 'approve' | 'reject';
  actorId: string;
  reason?: string | null;
}): Promise<ProposalDecisionResult | null> {
  return withTransaction(async (client) => {
    const current = await getProposal(input.workspaceId, input.proposalId, client);
    if (!current) return null;
    if (current.version !== input.expectedVersion) return { proposal: current, changed: false, reason: 'version_conflict' };
    if (current.status !== 'proposed') return { proposal: current, changed: false, reason: 'not_decidable' };
    const nextStatus = input.decision === 'approve' ? 'approved' : 'rejected';
    const { rows } = await query<ExecutiveProposal>(
      `UPDATE executive_proposals
          SET status=$3,version=version+1
        WHERE workspace_id=$1 AND id=$2 AND version=$4 AND status='proposed'
        RETURNING ${proposalSelect}`,
      [input.workspaceId, input.proposalId, nextStatus, input.expectedVersion],
      client,
    );
    const proposal = rows[0];
    if (!proposal) {
      const latest = await getProposal(input.workspaceId, input.proposalId, client);
      if (!latest) return null;
      return { proposal: latest, changed: false, reason: 'version_conflict' };
    }
    await appendProposalEvent({
      workspaceId: input.workspaceId, proposalId: proposal.id, eventType: nextStatus.toUpperCase(), actorType: 'human',
      actorId: input.actorId, payload: input.reason ? { reason: input.reason } : {},
    }, client);
    return { proposal, changed: true };
  });
}

export async function attachProposalMission(input: {
  workspaceId: string;
  proposalId: string;
  signalId: string;
  missionId: string;
  taskId: string | null;
}) {
  return withTransaction(async (client) => {
    const proposal = await getProposal(input.workspaceId, input.proposalId, client);
    if (!proposal) return null;
    if (proposal.companyBrainMissionId) return proposal;
    if (proposal.status !== 'approved') return proposal;
    const { rows } = await query<ExecutiveProposal>(
      `UPDATE executive_proposals
          SET status='dispatched',company_brain_signal_id=$3,company_brain_mission_id=$4,company_brain_task_id=$5,
              version=version+1
        WHERE workspace_id=$1 AND id=$2 AND status='approved' AND company_brain_mission_id IS NULL
        RETURNING ${proposalSelect}`,
      [input.workspaceId, input.proposalId, input.signalId, input.missionId, input.taskId],
      client,
    );
    const attached = rows[0] ?? proposal;
    if (rows[0]) {
      await appendProposalEvent({
        workspaceId: input.workspaceId, proposalId: input.proposalId, eventType: 'DISPATCHED', actorType: 'system',
        payload: { signalId: input.signalId, missionId: input.missionId, taskId: input.taskId },
      }, client);
    }
    return attached;
  });
}

export async function listLearning(workspaceId: string, limit: number) {
  const { rows } = await query<ExecutiveLearningRecord>(
    `SELECT ${learningSelect} FROM executive_learning_records
     WHERE workspace_id=$1
     ORDER BY created_at DESC
     LIMIT $2`,
    [workspaceId, boundedLimit(limit)],
  );
  return rows;
}

export async function calibrateForecast(workspaceId: string, forecastId: string) {
  return withTransaction(async (client) => {
    const candidate = await query<{
      id: string;
      cycleId: string;
      projectedBase: string;
      actualValue: string;
      actualRecordedAt: string;
    }>(
      `SELECT f.id,f.cycle_id AS "cycleId",f.projected_base AS "projectedBase",
              actual.value AS "actualValue",actual.recorded_at AS "actualRecordedAt"
         FROM executive_metric_forecasts f
         JOIN LATERAL (
           SELECT value,recorded_at
             FROM metric_points
            WHERE metric_id=f.metric_id AND recorded_at >= f.forecasted_for
            ORDER BY recorded_at ASC,id ASC
            LIMIT 1
         ) actual ON TRUE
        WHERE f.workspace_id=$1 AND f.id=$2 AND f.status='active' AND f.forecasted_for <= NOW()`,
      [workspaceId, forecastId],
      client,
    );
    const fact = candidate.rows[0];
    if (!fact) return null;
    const update = await query<{ id: string }>(
      `UPDATE executive_metric_forecasts
          SET status='calibrated',actual_value=$3,actual_recorded_at=$4,
              absolute_error=ABS($3::numeric-projected_base),
              relative_error=CASE WHEN projected_base=0 THEN NULL
                                  ELSE ABS($3::numeric-projected_base)/ABS(projected_base) END,
              calibrated_at=NOW()
        WHERE workspace_id=$1 AND id=$2 AND status='active'
        RETURNING id`,
      [workspaceId, forecastId, fact.actualValue, fact.actualRecordedAt],
      client,
    );
    if (!update.rows[0]) return null;
    await query(
      `INSERT INTO executive_learning_records(
         workspace_id,cycle_id,forecast_id,source_key,learning_type,outcome,evidence,confidence,verified
       ) VALUES($1,$2,$3,$4,'forecast_calibration',
         'Forecast calibrated against the first measured metric point after its horizon.',
         jsonb_build_object('projectedBase',$5::numeric,'actualValue',$6::numeric,'actualRecordedAt',$7::timestamptz),
         1,TRUE)
       ON CONFLICT (workspace_id,source_key) DO NOTHING`,
      [workspaceId, fact.cycleId, forecastId, `forecast:${forecastId}:calibrated:v1`, fact.projectedBase, fact.actualValue, fact.actualRecordedAt],
      client,
    );
    return getForecast(workspaceId, forecastId, client);
  });
}

export async function calibrateDueForecasts(workspaceId: string | undefined, limit: number) {
  const values: unknown[] = [boundedLimit(limit, 100)];
  const workspaceWhere = workspaceId ? 'AND f.workspace_id=$2' : '';
  if (workspaceId) values.push(workspaceId);
  const due = await query<{ workspaceId: string; id: string }>(
    `SELECT f.workspace_id AS "workspaceId",f.id
       FROM executive_metric_forecasts f
      WHERE f.status='active' AND f.forecasted_for <= NOW() ${workspaceWhere}
      ORDER BY f.forecasted_for ASC
      LIMIT $1`,
    values,
  );
  const calibrated: ExecutiveMetricForecast[] = [];
  for (const forecast of due.rows) {
    const result = await calibrateForecast(forecast.workspaceId, forecast.id);
    if (result) calibrated.push(result);
  }
  return calibrated;
}
