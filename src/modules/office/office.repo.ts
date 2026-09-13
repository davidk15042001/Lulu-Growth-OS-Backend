import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { AppError, conflictError, notFoundError } from '../../utils/app-error.js';
import * as socialPublishingRepo from '../social-publishing/social-publishing.repo.js';
import type {
  CreateOfficeWorkItemInput,
  OfficeControlAction,
  OfficeEmployeeRow,
  OfficeTimelineItem,
  OfficeWorkItem,
  OfficeWorkItemStatus,
} from './office.types.js';

const workItemSelect = (alias = 'wi') => `${alias}.id,
  ${alias}.workspace_id AS "workspaceId",
  ${alias}.parent_work_item_id AS "parentWorkItemId",
  ${alias}.primary_employee_id AS "primaryEmployeeId",
  ${alias}.source_type AS "sourceType",
  ${alias}.source_id AS "sourceId",
  ${alias}.source_agent_run_id AS "sourceAgentRunId",
  ${alias}.source_record_id AS "sourceRecordId",
  ${alias}.title, ${alias}.objective, ${alias}.description, ${alias}.status,
  ${alias}.priority, ${alias}.attempt_count AS "attemptCount",
  ${alias}.max_attempts AS "maxAttempts", ${alias}.version,
  ${alias}.related_object_type AS "relatedObjectType",
  ${alias}.related_object_id AS "relatedObjectId",
  ${alias}.context, ${alias}.result,
  ${alias}.error_code AS "errorCode", ${alias}.error_message AS "errorMessage",
  ${alias}.human_controller_id AS "humanControllerId",
  ${alias}.available_at AS "availableAt", ${alias}.started_at AS "startedAt",
  ${alias}.paused_at AS "pausedAt", ${alias}.finished_at AS "finishedAt",
  ${alias}.created_at AS "createdAt", ${alias}.updated_at AS "updatedAt",
  (SELECT ar.worker_id FROM agent_runs ar
    WHERE ar.workspace_id=${alias}.workspace_id AND ar.id=${alias}.source_agent_run_id) AS "sourceWorkerId",
  EXISTS(SELECT 1 FROM office_work_items child
    WHERE child.workspace_id=${alias}.workspace_id AND child.parent_work_item_id=${alias}.id) AS "hasChildren",
  EXISTS(SELECT 1 FROM office_work_items child
    WHERE child.workspace_id=${alias}.workspace_id AND child.parent_work_item_id=${alias}.id
      AND child.status='running') AS "hasRunningChildren"`;

function availableControls(item: OfficeWorkItem): OfficeControlAction[] {
  const controls: OfficeControlAction[] = [];
  const terminal = item.status === 'completed' || item.status === 'cancelled';
  const sourceBusy = Boolean(item.sourceWorkerId);
  const downstream = Boolean(item.hasChildren);
  const runningDownstream = Boolean(item.hasRunningChildren);

  const providerWaitingPacket = item.sourceType === 'agent_action_packet' && item.status === 'waiting';
  if (['queued', 'waiting'].includes(item.status) && !sourceBusy && !downstream && !providerWaitingPacket) controls.push('pause');
  if (['paused', 'human_controlled'].includes(item.status) && !sourceBusy && !runningDownstream) controls.push('resume');
  if (item.status === 'failed' && !downstream && !sourceBusy) controls.push('retry');
  // A leased agent run may currently be inside an irreversible provider/tool
  // call.  Do not advertise cancellation until that step has yielded its
  // lease; the control endpoint repeats this check under a row lock below.
  if (!terminal && !sourceBusy && !runningDownstream
      && !(item.sourceType === 'agent_action_packet' && item.status === 'running')) {
    controls.push('cancel');
  }
  if (!terminal && item.status !== 'human_controlled' && !sourceBusy && !downstream && !providerWaitingPacket
      && !(item.sourceType === 'agent_action_packet' && item.status === 'running')) {
    controls.push('takeover');
  }
  return controls;
}

function hydrateWorkItem(row: OfficeWorkItem): OfficeWorkItem {
  const item: OfficeWorkItem = {
    ...row,
    priority: Number(row.priority),
    attemptCount: Number(row.attemptCount),
    maxAttempts: Number(row.maxAttempts),
    version: Number(row.version),
    hasChildren: Boolean(row.hasChildren),
    hasRunningChildren: Boolean(row.hasRunningChildren),
  };
  item.availableControls = availableControls(item);
  return item;
}

export async function ensureOfficeRoster(workspaceId: string, client?: PoolClient) {
  await query('SELECT ensure_workspace_office_roster($1)', [workspaceId], client);
}

export async function listOfficeEmployees(workspaceId: string): Promise<OfficeEmployeeRow[]> {
  await ensureOfficeRoster(workspaceId);
  const { rows } = await query<OfficeEmployeeRow>(`
    SELECT
      d.id AS "departmentId", d.department_key AS "departmentKey",
      d.display_name AS "departmentName", d.description AS "departmentDescription",
      d.sort_order AS "departmentSortOrder",
      e.id AS "employeeId", e.employee_key AS "employeeKey", e.display_name AS "employeeName",
      e.role_title AS "roleTitle", e.description AS "employeeDescription",
      e.availability, e.source_agent_ids AS "sourceAgentIds", e.source_modules AS "sourceModules",
      ARRAY(SELECT ec.capability_key FROM digital_employee_capabilities ec
        WHERE ec.workspace_id=e.workspace_id AND ec.employee_id=e.id AND ec.access_mode='OBSERVE'
        ORDER BY ec.capability_key) AS "readCapabilityKeys",
      e.sort_order AS "employeeSortOrder",
      COALESCE(p.display_state,CASE WHEN e.availability='UNAVAILABLE' THEN 'OFFLINE' ELSE 'IDLE' END) AS status,
      COALESCE(p.active_work_count,0) AS "activeWorkCount",
      COALESCE(p.failed_work_count,0) AS "failedWorkCount",
      COALESCE(p.completed_today_count,0) AS "completedTodayCount",
      p.last_activity_at AS "lastActivityAt",
      wi.id AS "currentWorkItemId", wi.title AS "currentWorkItemTitle",
      wi.objective AS "currentWorkItemObjective", wi.status AS "currentWorkItemStatus",
      wi.version AS "currentWorkItemVersion", wi.source_type AS "currentWorkItemSourceType",
      wi.related_object_type AS "currentWorkItemRelatedObjectType",
      wi.related_object_id AS "currentWorkItemRelatedObjectId"
    FROM office_departments d
    JOIN digital_employees e ON e.workspace_id=d.workspace_id AND e.department_id=d.id AND e.active
    LEFT JOIN office_employee_state_projection p
      ON p.workspace_id=e.workspace_id AND p.employee_id=e.id
    LEFT JOIN office_work_items wi
      ON wi.workspace_id=p.workspace_id AND wi.id=p.current_work_item_id
    WHERE d.workspace_id=$1
    ORDER BY d.sort_order,d.display_name,e.sort_order,e.display_name`, [workspaceId]);
  return rows.map((row) => ({
    ...row,
    departmentSortOrder: Number(row.departmentSortOrder),
    employeeSortOrder: Number(row.employeeSortOrder),
    activeWorkCount: Number(row.activeWorkCount),
    failedWorkCount: Number(row.failedWorkCount),
    completedTodayCount: Number(row.completedTodayCount),
    currentWorkItemVersion: row.currentWorkItemVersion == null ? null : Number(row.currentWorkItemVersion),
  }));
}

export async function getOfficeEmployee(workspaceId: string, employeeId: string) {
  await ensureOfficeRoster(workspaceId);
  const employee = (await listOfficeEmployees(workspaceId)).find((item) => item.employeeId === employeeId);
  if (!employee) throw notFoundError('Digital employee not found');
  const { rows: capabilities } = await query<{
    key: string; description: string; accessMode: 'OBSERVE' | 'EXECUTE' | 'MANAGE';
  }>(`SELECT c.key,c.description,ec.access_mode AS "accessMode"
      FROM digital_employee_capabilities ec
      JOIN workspace_capabilities c ON c.key=ec.capability_key
      WHERE ec.workspace_id=$1 AND ec.employee_id=$2
      ORDER BY ec.access_mode,c.key`, [workspaceId, employeeId]);
  return { employee, capabilities };
}

export async function getOfficeSummary(workspaceId: string, employeeIds?: string[]) {
  if (employeeIds && employeeIds.length === 0) {
    return { activeWorkItems: 0, completedToday: 0, failedWorkItems: 0 };
  }
  const { rows } = await query<{
    activeWorkItems: number; completedToday: number; failedWorkItems: number;
  }>(`SELECT
      count(*) FILTER (WHERE status IN ('queued','running','waiting','paused','waiting_for_approval','human_controlled'))::int AS "activeWorkItems",
      count(*) FILTER (WHERE status='completed' AND finished_at>=date_trunc('day',NOW()))::int AS "completedToday",
      count(*) FILTER (WHERE status='failed')::int AS "failedWorkItems"
    FROM office_work_items wi WHERE workspace_id=$1
      AND ($2::uuid[] IS NULL OR wi.primary_employee_id=ANY($2::uuid[])
        OR EXISTS(SELECT 1 FROM office_work_item_assignments assignment
          WHERE assignment.workspace_id=wi.workspace_id AND assignment.work_item_id=wi.id
            AND assignment.employee_id=ANY($2::uuid[])))`, [workspaceId, employeeIds ?? null]);
  return {
    activeWorkItems: Number(rows[0]?.activeWorkItems ?? 0),
    completedToday: Number(rows[0]?.completedToday ?? 0),
    failedWorkItems: Number(rows[0]?.failedWorkItems ?? 0),
  };
}

export async function findWorkItem(workspaceId: string, workItemId: string, client?: PoolClient) {
  const { rows } = await query<OfficeWorkItem>(
    `SELECT ${workItemSelect()} FROM office_work_items wi WHERE wi.workspace_id=$1 AND wi.id=$2`,
    [workspaceId, workItemId], client,
  );
  return rows[0] ? hydrateWorkItem(rows[0]) : null;
}

async function workItemRelations(workspaceId: string, workItemIds: string[]) {
  if (workItemIds.length === 0) return new Map<string, {
    dependencies: Array<Record<string, unknown>>;
    assignments: Array<Record<string, unknown>>;
    attempts: Array<Record<string, unknown>>;
  }>();
  const [dependencies, assignments, attempts] = await Promise.all([
    query<{ workItemId: string; id: string; title: string; status: string; dependencyType: string }>(
      `SELECT d.work_item_id AS "workItemId",dependency.id,dependency.title,dependency.status,
         d.dependency_type AS "dependencyType"
       FROM office_work_item_dependencies d
       JOIN office_work_items dependency
         ON dependency.workspace_id=d.workspace_id AND dependency.id=d.depends_on_work_item_id
       WHERE d.workspace_id=$1 AND d.work_item_id=ANY($2::uuid[])
       ORDER BY d.created_at`, [workspaceId, workItemIds],
    ),
    query<{ workItemId: string; employeeId: string; employeeName: string; employeeKey: string; role: string; assignedAt: string; completedAt: string | null }>(
      `SELECT a.work_item_id AS "workItemId",a.employee_id AS "employeeId",
         e.display_name AS "employeeName",e.employee_key AS "employeeKey",
         a.assignment_role AS role,a.assigned_at AS "assignedAt",a.completed_at AS "completedAt"
       FROM office_work_item_assignments a
       JOIN digital_employees e ON e.workspace_id=a.workspace_id AND e.id=a.employee_id
       WHERE a.workspace_id=$1 AND a.work_item_id=ANY($2::uuid[])
       ORDER BY a.assigned_at`, [workspaceId, workItemIds],
    ),
    query<{ workItemId: string } & Record<string, unknown>>(
      `SELECT work_item_id AS "workItemId",id,attempt_number AS "attemptNumber",status,worker_id AS "workerId",
         error_code AS "errorCode",error_message AS "errorMessage",started_at AS "startedAt",
         heartbeat_at AS "heartbeatAt",finished_at AS "finishedAt",created_at AS "createdAt"
       FROM office_work_item_attempts
       WHERE workspace_id=$1 AND work_item_id=ANY($2::uuid[])
       ORDER BY work_item_id,attempt_number`, [workspaceId, workItemIds],
    ),
  ]);
  const result = new Map<string, { dependencies: Array<Record<string, unknown>>; assignments: Array<Record<string, unknown>>; attempts: Array<Record<string, unknown>> }>();
  for (const id of workItemIds) result.set(id, { dependencies: [], assignments: [], attempts: [] });
  for (const row of dependencies.rows) result.get(row.workItemId)?.dependencies.push(row);
  for (const row of assignments.rows) result.get(row.workItemId)?.assignments.push(row);
  for (const row of attempts.rows) result.get(row.workItemId)?.attempts.push(row);
  return result;
}

export async function listEmployeeWork(input: {
  workspaceId: string; employeeId: string; status?: OfficeWorkItemStatus | undefined; limit: number; offset: number;
}) {
  await getOfficeEmployee(input.workspaceId, input.employeeId);
  const values: unknown[] = [input.workspaceId, input.employeeId];
  let statusSql = '';
  if (input.status) {
    values.push(input.status);
    statusSql = ` AND wi.status=$${values.length}`;
  }
  values.push(input.limit, input.offset);
  const [itemsResult, totalResult] = await Promise.all([
    query<OfficeWorkItem>(`SELECT ${workItemSelect()}
      FROM office_work_items wi
      WHERE wi.workspace_id=$1 AND (
        wi.primary_employee_id=$2 OR EXISTS(SELECT 1 FROM office_work_item_assignments a
          WHERE a.workspace_id=wi.workspace_id AND a.work_item_id=wi.id AND a.employee_id=$2)
      )${statusSql}
      ORDER BY CASE WHEN wi.status IN ('queued','running','waiting','paused','waiting_for_approval','human_controlled','failed') THEN 0 ELSE 1 END,
        wi.priority DESC,wi.updated_at DESC,wi.id
      LIMIT $${values.length - 1} OFFSET $${values.length}`, values),
    query<{ total: number }>(`SELECT count(*)::int AS total FROM office_work_items wi
      WHERE wi.workspace_id=$1 AND (
        wi.primary_employee_id=$2 OR EXISTS(SELECT 1 FROM office_work_item_assignments a
          WHERE a.workspace_id=wi.workspace_id AND a.work_item_id=wi.id AND a.employee_id=$2)
      )${statusSql}`, values.slice(0, input.status ? 3 : 2)),
  ]);
  const items = itemsResult.rows.map(hydrateWorkItem);
  const relations = await workItemRelations(input.workspaceId, items.map((item) => item.id));
  return {
    items: items.map((item) => ({ ...item, ...(relations.get(item.id) ?? {}) })),
    total: Number(totalResult.rows[0]?.total ?? 0), limit: input.limit, offset: input.offset,
  };
}

function timelineTitle(type: string) {
  return type.replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export async function listOfficeTimeline(input: {
  workspaceId: string; before?: string | undefined; employeeId?: string | undefined;
  employeeIds?: string[] | undefined; limit: number;
}) {
  const workEvents = await query<OfficeTimelineItem>(`SELECT
      event.id,'work_item'::text AS source,event.event_type AS type,
      wi.title,event.occurred_at AS "occurredAt",event.employee_id AS "employeeId",
      employee.display_name AS "employeeName",event.work_item_id AS "workItemId",
      wi.related_object_type AS "aggregateType",wi.related_object_id AS "aggregateId",
      event.status_from AS "statusFrom",event.status_to AS "statusTo",
      jsonb_strip_nulls(jsonb_build_object(
        'status',event.payload->'status','direction',event.payload->'direction',
        'action',event.payload->'action','sourceType',event.payload->'sourceType',
        'trigger',event.payload->'trigger'
      )) AS payload
    FROM office_work_item_events event
    JOIN office_work_items wi ON wi.workspace_id=event.workspace_id AND wi.id=event.work_item_id
    LEFT JOIN digital_employees employee
      ON employee.workspace_id=event.workspace_id AND employee.id=event.employee_id
    WHERE event.workspace_id=$1
      AND ($2::timestamptz IS NULL OR event.occurred_at<$2::timestamptz)
      AND ($3::uuid IS NULL OR event.employee_id=$3::uuid)
      AND ($4::uuid[] IS NULL OR event.employee_id=ANY($4::uuid[]))
    ORDER BY event.occurred_at DESC,event.sequence DESC LIMIT $5`,
  [input.workspaceId, input.before ?? null, input.employeeId ?? null, input.employeeIds ?? null, input.limit]);

  const domainEvents = input.employeeId ? { rows: [] as OfficeTimelineItem[] } : await query<OfficeTimelineItem>(`SELECT
      event.id,'domain_event'::text AS source,event.event_type AS type,event.event_type AS title,
      event.occurred_at AS "occurredAt",NULL::uuid AS "employeeId",NULL::text AS "employeeName",
      NULL::uuid AS "workItemId",event.aggregate_type AS "aggregateType",
      event.aggregate_id::text AS "aggregateId",NULL::text AS "statusFrom",NULL::text AS "statusTo",
      jsonb_strip_nulls(jsonb_build_object(
        'status',event.payload->'status','direction',event.payload->'direction',
        'action',event.payload->'action','sourceType',event.payload->'sourceType',
        'trigger',event.payload->'trigger','resourceType',event.payload->'resourceType'
      )) AS payload
    FROM domain_events event
    WHERE event.workspace_id=$1
      AND ($2::timestamptz IS NULL OR event.occurred_at<$2::timestamptz)
      AND event.event_type NOT LIKE 'office.work_item.%'
    ORDER BY event.occurred_at DESC,event.sequence DESC LIMIT $3`,
  [input.workspaceId, input.before ?? null, input.limit]);

  return [...workEvents.rows, ...domainEvents.rows]
    .map((item) => ({ ...item, title: item.source === 'domain_event' ? timelineTitle(item.type) : item.title }))
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
    .slice(0, input.limit);
}

export async function createOfficeWorkItem(input: CreateOfficeWorkItemInput) {
  return withTransaction(async (client) => {
    await ensureOfficeRoster(input.workspaceId, client);
    const employee = (await query<{ availability: string }>(
      `SELECT availability FROM digital_employees WHERE workspace_id=$1 AND id=$2 AND active FOR UPDATE`,
      [input.workspaceId, input.employeeId], client,
    )).rows[0];
    if (!employee) throw notFoundError('Digital employee not found');
    if (employee.availability === 'UNAVAILABLE') throw conflictError('This digital employee is unavailable');
    const { rows } = await query<OfficeWorkItem>(`INSERT INTO office_work_items(
        workspace_id,parent_work_item_id,primary_employee_id,source_type,source_id,idempotency_key,
        title,objective,description,priority,max_attempts,related_object_type,related_object_id,context,created_by
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
      ON CONFLICT (workspace_id,idempotency_key) DO NOTHING
      RETURNING ${workItemSelect('office_work_items')}`, [
      input.workspaceId, input.parentWorkItemId ?? null, input.employeeId, input.sourceType,
      input.sourceId ?? null, input.idempotencyKey, input.title, input.objective ?? '', input.description ?? '',
      input.priority ?? 50, input.maxAttempts ?? 3, input.relatedObjectType ?? null,
      input.relatedObjectId ?? null, JSON.stringify(input.context ?? {}), input.createdBy ?? null,
    ], client);
    let item = rows[0] ? hydrateWorkItem(rows[0]) : await findWorkItemByIdempotency(input.workspaceId, input.idempotencyKey, client);
    if (!item) throw new Error('Office work item insert did not return a row');
    if (!rows[0]) return { item, created: false as const };
    await query(`INSERT INTO office_work_item_assignments(workspace_id,work_item_id,employee_id,assignment_role)
      VALUES($1,$2,$3,'PRIMARY') ON CONFLICT DO NOTHING`, [input.workspaceId, item.id, input.employeeId], client);
    await appendDomainEvent({
      workspaceId: input.workspaceId, type: 'office.work_item.created', aggregateType: 'office_work_item',
      aggregateId: item.id, payload: { workItemId: item.id, employeeId: input.employeeId, sourceType: input.sourceType },
      metadata: { actorId: input.createdBy ?? null, source: 'office' },
      idempotencyKey: `office-work-item:${item.id}:created:v1`,
    }, client);
    item = (await findWorkItem(input.workspaceId, item.id, client)) ?? item;
    return { item, created: true as const };
  });
}

async function findWorkItemByIdempotency(workspaceId: string, idempotencyKey: string, client: PoolClient) {
  const { rows } = await query<OfficeWorkItem>(`SELECT ${workItemSelect()}
    FROM office_work_items wi WHERE wi.workspace_id=$1 AND wi.idempotency_key=$2`,
  [workspaceId, idempotencyKey], client);
  return rows[0] ? hydrateWorkItem(rows[0]) : null;
}

export async function addWorkItemDependency(input: {
  workspaceId: string; workItemId: string; dependsOnWorkItemId: string;
  dependencyType?: 'BLOCKS' | 'CONTEXT' | 'VERIFICATION';
}) {
  await query(`INSERT INTO office_work_item_dependencies(
      workspace_id,work_item_id,depends_on_work_item_id,dependency_type
    ) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [
    input.workspaceId, input.workItemId, input.dependsOnWorkItemId, input.dependencyType ?? 'BLOCKS',
  ]);
}

async function applyAgentRunControl(
  client: PoolClient, item: OfficeWorkItem, action: OfficeControlAction, actorId: string, idempotencyKey: string,
) {
  if (!item.sourceAgentRunId) return;
  const run = (await query<{ id: string; status: string; workerId: string | null }>(
    `SELECT id,status,worker_id AS "workerId" FROM agent_runs
     WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [item.workspaceId, item.sourceAgentRunId], client,
  )).rows[0];
  if (!run) throw notFoundError('Source agent run not found');
  if (run.workerId) {
    throw conflictError('The agent is inside an active step and cannot be safely controlled yet');
  }
  if (action === 'resume' || action === 'retry') {
    await query(`UPDATE agent_run_steps SET status='pending',verification_status='pending',
        error_code=NULL,error_message=NULL,started_at=NULL,finished_at=NULL,updated_at=NOW()
      WHERE workspace_id=$1 AND run_id=$2 AND status='failed'`, [item.workspaceId, run.id], client);
    await query(`UPDATE agent_runs SET status='queued',worker_id=NULL,locked_at=NULL,heartbeat_at=NULL,
        attempt_count=0,error_code=NULL,error_message=NULL,finished_at=NULL,updated_at=NOW()
      WHERE workspace_id=$1 AND id=$2`, [item.workspaceId, run.id], client);
    await appendDomainEvent({
      workspaceId: item.workspaceId, type: DOMAIN_EVENT_TYPES.AGENT_RUN_RESUME_REQUESTED,
      aggregateType: 'agent_run', aggregateId: run.id,
      payload: { runId: run.id, reason: `office_${action}` },
      metadata: { actorId, source: 'office' },
      idempotencyKey: `office:${idempotencyKey}:agent-run-resume`,
    }, client);
  } else {
    await query(`UPDATE agent_runs SET status='cancelled',finished_at=COALESCE(finished_at,NOW()),
        worker_id=NULL,locked_at=NULL,heartbeat_at=NULL,
        error_code=$3,error_message=$4,updated_at=NOW()
      WHERE workspace_id=$1 AND id=$2 AND status NOT IN ('completed','cancelled')`, [
      item.workspaceId, run.id, action === 'pause' ? 'OFFICE_PAUSED' : action === 'takeover' ? 'OFFICE_HUMAN_TAKEOVER' : 'AGENT_RUN_CANCELLED',
      action === 'pause' ? 'Paused by a workspace user' : action === 'takeover' ? 'Handed over to a workspace user' : 'Cancelled by a workspace user',
    ], client);
    await appendDomainEvent({
      workspaceId: item.workspaceId, type: DOMAIN_EVENT_TYPES.AGENT_RUN_CANCELLED,
      aggregateType: 'agent_run', aggregateId: run.id,
      payload: { runId: run.id, reason: `office_${action}` },
      metadata: { actorId, source: 'office' },
      idempotencyKey: `office:${idempotencyKey}:agent-run-cancel`,
    }, client);
  }
}

async function applyActionPacketControl(client: PoolClient, item: OfficeWorkItem, action: OfficeControlAction, actorId: string) {
  if (!item.sourceRecordId) return null;
  const record = (await query<{ id: string; stage: string | null; version: number }>(
    `SELECT id,stage,version FROM workspace_records WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
    [item.workspaceId, item.sourceRecordId], client,
  )).rows[0];
  if (!record) throw notFoundError('Source action packet not found');
  const linkedSocialJobs = await socialPublishingRepo.listExecutionPublications(
    item.workspaceId,
    record.id,
    client,
  );
  if (linkedSocialJobs.length > 0 && (action === 'pause' || action === 'takeover')) {
    throw conflictError('A provider publication cannot be safely paused or handed over after it has been queued');
  }
  if (linkedSocialJobs.length > 0 && action === 'cancel') {
    const unsafe = linkedSocialJobs.find((job) => ['PUBLISHING','PUBLISHED'].includes(job.status));
    if (unsafe) {
      throw conflictError('A provider publication has started and cannot be safely cancelled');
    }
    for (const job of linkedSocialJobs) {
      if (job.status === 'CANCELLED') continue;
      const transition = await socialPublishingRepo.transitionPublicationJob({
        workspaceId: item.workspaceId,
        jobId: job.id,
        actorId,
        actorType: 'USER',
        actorRef: actorId,
        expectedVersion: job.version,
        action: 'CANCEL',
      }, client);
      if (!transition.job || transition.conflict || transition.invalidState) {
        throw conflictError('The linked provider publication could not be cancelled safely');
      }
    }
  }
  if (linkedSocialJobs.length > 0 && action === 'retry') {
    const retryableJobs = linkedSocialJobs.filter((job) => ['FAILED','BLOCKED'].includes(job.status));
    if (retryableJobs.length === 0 || linkedSocialJobs.some((job) => ['DRAFT','SCHEDULED','QUEUED','PUBLISHING','CANCELLED'].includes(job.status))) {
      throw conflictError('The linked provider publication cannot be retried safely from its current state');
    }
    for (const job of retryableJobs) {
      const transition = await socialPublishingRepo.transitionPublicationJob({
        workspaceId: item.workspaceId,
        jobId: job.id,
        actorId,
        actorType: 'USER',
        actorRef: actorId,
        expectedVersion: job.version,
        action: 'RETRY',
      }, client);
      if (!transition.job || transition.conflict || transition.invalidState) {
        throw conflictError('The linked provider publication could not be retried safely');
      }
    }
  }
  if (record.stage === 'executing' && action !== 'cancel') {
    throw conflictError('The external action has started and cannot be safely paused or handed over');
  }
  if (record.stage === 'executing' && action === 'cancel') {
    throw conflictError('The external action has started and cannot be safely cancelled');
  }
  const providerRetry = action === 'retry' && linkedSocialJobs.length > 0;
  const stage = providerRetry ? 'waiting_for_provider'
    : action === 'pause' ? 'execution_paused'
    : action === 'takeover' ? 'human_controlled'
      : action === 'cancel' ? 'execution_cancelled' : 'queued_for_execution';
  const executionStatus = providerRetry ? 'waiting_for_provider'
    : action === 'pause' ? 'paused'
    : action === 'takeover' ? 'human_controlled'
      : action === 'cancel' ? 'cancelled' : 'queued';
  await query(`UPDATE workspace_records SET stage=$3,
      status=CASE WHEN $3='execution_cancelled' THEN 'cancelled'
        WHEN $3='human_controlled' THEN 'human_controlled'
        WHEN $3='waiting_for_provider' THEN 'active' ELSE 'approved' END,
      data=data || jsonb_build_object('executionStatus',$4::text,'executionReady',$5::boolean,
        'officeControlledBy',$6::text,'officeControlledAt',NOW()),
      version=version+1,updated_by=$6::uuid,updated_at=NOW()
    WHERE workspace_id=$1 AND id=$2`, [
    item.workspaceId, record.id, stage, executionStatus, !providerRetry && ['resume', 'retry'].includes(action), actorId,
  ], client);
  return providerRetry ? 'waiting' as const : null;
}

const desiredStatus: Record<OfficeControlAction, OfficeWorkItemStatus> = {
  pause: 'paused', resume: 'queued', retry: 'queued', cancel: 'cancelled', takeover: 'human_controlled',
};

export async function controlWorkItem(input: {
  workspaceId: string; workItemId: string; action: OfficeControlAction; actorId: string;
  expectedVersion: number; idempotencyKey: string; reason?: string | undefined;
}) {
  return withTransaction(async (client) => {
    const reservation = await query<{ id: string }>(`INSERT INTO office_work_item_commands(
        workspace_id,work_item_id,actor_id,command,idempotency_key,expected_version
      ) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT (workspace_id,idempotency_key) DO NOTHING RETURNING id`, [
      input.workspaceId,input.workItemId,input.actorId,input.action,input.idempotencyKey,input.expectedVersion,
    ], client);
    if (!reservation.rows[0]) {
      const prior = (await query<{ id: string; workItemId: string; command: string; result: Record<string, unknown>; createdAt: string }>(
        `SELECT id,work_item_id AS "workItemId",command,result,created_at AS "createdAt"
         FROM office_work_item_commands WHERE workspace_id=$1 AND idempotency_key=$2`,
        [input.workspaceId,input.idempotencyKey],client,
      )).rows[0];
      if (!prior || prior.workItemId !== input.workItemId || prior.command !== input.action) {
        throw conflictError('The office command idempotency key was already used for another operation');
      }
      const item = await findWorkItem(input.workspaceId,input.workItemId,client);
      if (!item) throw notFoundError('Office work item not found');
      return { item,idempotent:true as const,command:prior };
    }

    const item = (await query<OfficeWorkItem>(`SELECT ${workItemSelect()}
      FROM office_work_items wi WHERE wi.workspace_id=$1 AND wi.id=$2 FOR UPDATE`,
    [input.workspaceId,input.workItemId],client)).rows[0];
    if (!item) throw notFoundError('Office work item not found');
    const hydrated = hydrateWorkItem(item);
    if (hydrated.version !== input.expectedVersion) {
      throw new AppError(409,'OFFICE_WORK_ITEM_VERSION_CONFLICT','The work item changed; reload it before applying this control.',{
        expectedVersion:input.expectedVersion,currentVersion:hydrated.version,
      });
    }
    if (!hydrated.availableControls?.includes(input.action)) {
      throw new AppError(409,'OFFICE_CONTROL_NOT_AVAILABLE',`The ${input.action} control is not valid for this work item state.`,{
        status:hydrated.status,availableControls:hydrated.availableControls,
      });
    }

    let targetOverride: OfficeWorkItemStatus | null = null;
    if (hydrated.sourceType === 'agent_run') {
      await applyAgentRunControl(client,hydrated,input.action,input.actorId,input.idempotencyKey);
    } else if (hydrated.sourceType === 'agent_action_packet') {
      targetOverride = await applyActionPacketControl(client,hydrated,input.action,input.actorId);
    }

    const target = targetOverride ?? desiredStatus[input.action];
    const current = await findWorkItem(input.workspaceId,input.workItemId,client);
    if (!current) throw notFoundError('Office work item not found');
    const nextAttemptCount = input.action === 'retry' && !current.sourceAgentRunId && !current.sourceRecordId
      ? current.attemptCount + 1 : current.attemptCount;
    await query(`UPDATE office_work_items SET status=$3,
        human_controller_id=CASE WHEN $3='human_controlled' THEN $4::uuid ELSE NULL END,
        paused_at=CASE WHEN $3='paused' THEN NOW() ELSE NULL END,
        finished_at=CASE WHEN $3='cancelled' THEN NOW() ELSE NULL END,
        error_code=CASE WHEN $3='queued' THEN NULL ELSE error_code END,
        error_message=CASE WHEN $3='queued' THEN NULL ELSE error_message END,
        attempt_count=$5,version=version+1,updated_at=NOW()
      WHERE workspace_id=$1 AND id=$2`, [input.workspaceId,input.workItemId,target,input.actorId,nextAttemptCount],client);

    if (input.action === 'retry' && !current.sourceAgentRunId && !current.sourceRecordId) {
      await query(`INSERT INTO office_work_item_attempts(workspace_id,work_item_id,attempt_number,status,input)
        VALUES($1,$2,$3,'queued',$4::jsonb)`, [
        input.workspaceId,input.workItemId,nextAttemptCount,JSON.stringify({ reason:input.reason ?? null,actorId:input.actorId }),
      ],client);
    }

    const updated = await findWorkItem(input.workspaceId,input.workItemId,client);
    if (!updated) throw notFoundError('Office work item not found');
    const commandResult = { workItemId:updated.id,status:updated.status,version:updated.version };
    await query(`UPDATE office_work_item_commands SET result=$3::jsonb
      WHERE workspace_id=$1 AND id=$2`, [input.workspaceId,reservation.rows[0].id,JSON.stringify(commandResult)],client);
    await query(`INSERT INTO audit_log(workspace_id,actor_id,action,entity_type,entity_id,after_data)
      VALUES($1,$2,$3,'office_work_item',$4,$5::jsonb)`, [
      input.workspaceId,input.actorId,`office.work_item.${input.action}`,input.workItemId,
      JSON.stringify({ from:hydrated.status,to:updated.status,reason:input.reason ?? null,version:updated.version }),
    ],client);
    const eventType = input.action === 'takeover' ? 'office.work_item.taken_over' : `office.work_item.${input.action}d`;
    await appendDomainEvent({
      workspaceId:input.workspaceId,type:eventType,aggregateType:'office_work_item',aggregateId:input.workItemId,
      payload:{workItemId:input.workItemId,from:hydrated.status,to:updated.status,reason:input.reason ?? null},
      metadata:{actorId:input.actorId,source:'office'},idempotencyKey:`office:${input.idempotencyKey}:control`,
    },client);
    return {
      item:updated,idempotent:false as const,
      command:{id:reservation.rows[0].id,workItemId:input.workItemId,command:input.action,result:commandResult,createdAt:new Date().toISOString()},
    };
  });
}
