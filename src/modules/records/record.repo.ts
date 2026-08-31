import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { buildUpdateSet } from '../../db/update-builder.js';
import type { ResourceType } from '../../domain/resource-catalog.js';
import type {
  CreateRecordInput,
  ListRecordsQuery,
  UpdateRecordInput,
} from './record.validator.js';

export type WorkspaceRecord = {
  id: string;
  workspaceId: string;
  resourceType: ResourceType;
  parentId: string | null;
  name: string;
  description: string | null;
  status: string;
  stage: string | null;
  valueAmount: string | null;
  currency: string | null;
  startsAt: string | null;
  endsAt: string | null;
  dueAt: string | null;
  assigneeId: string | null;
  externalId: string | null;
  source: string | null;
  tags: string[];
  data: Record<string, unknown>;
  version: number;
  createdBy: string;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

const recordSelect = `
  id,
  workspace_id AS "workspaceId",
  resource_type AS "resourceType",
  parent_id AS "parentId",
  name,
  description,
  status,
  stage,
  value_amount AS "valueAmount",
  currency,
  starts_at AS "startsAt",
  ends_at AS "endsAt",
  due_at AS "dueAt",
  assignee_id AS "assigneeId",
  external_id AS "externalId",
  source,
  tags,
  data,
  version,
  created_by AS "createdBy",
  updated_by AS "updatedBy",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const sortColumns: Record<ListRecordsQuery['sort'], string> = {
  name: 'name',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  dueAt: 'due_at',
  valueAmount: 'value_amount',
};

function listConditions(
  workspaceId: string,
  resourceType: ResourceType,
  filters: ListRecordsQuery
) {
  const values: unknown[] = [workspaceId, resourceType];
  const conditions = ['workspace_id = $1', 'resource_type = $2', 'deleted_at IS NULL'];

  const add = (sql: (parameter: string) => string, value: unknown) => {
    values.push(value);
    conditions.push(sql(`$${values.length}`));
  };

  if (filters.search) {
    add(
      (parameter) => `(name ILIKE '%' || ${parameter} || '%' OR description ILIKE '%' || ${parameter} || '%')`,
      filters.search
    );
  }
  if (filters.status) add((parameter) => `status = ${parameter}`, filters.status);
  if (filters.stage) add((parameter) => `stage = ${parameter}`, filters.stage);
  if (filters.tag) add((parameter) => `${parameter} = ANY(tags)`, filters.tag);
  if (filters.assigneeId) add((parameter) => `assignee_id = ${parameter}`, filters.assigneeId);
  if (filters.parentId) add((parameter) => `parent_id = ${parameter}`, filters.parentId);

  return { values, where: conditions.join(' AND ') };
}

export async function listRecords(
  workspaceId: string,
  resourceType: ResourceType,
  filters: ListRecordsQuery
) {
  const list = listConditions(workspaceId, resourceType, filters);
  const offset = (filters.page - 1) * filters.limit;
  const sortColumn = sortColumns[filters.sort];
  const sortOrder = filters.order === 'asc' ? 'ASC' : 'DESC';

  const [itemsResult, countResult] = await Promise.all([
    query<WorkspaceRecord>(
      `SELECT ${recordSelect}
       FROM workspace_records
       WHERE ${list.where}
       ORDER BY ${sortColumn} ${sortOrder} NULLS LAST, id ${sortOrder}
       LIMIT $${list.values.length + 1}
       OFFSET $${list.values.length + 2}`,
      [...list.values, filters.limit, offset]
    ),
    query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM workspace_records
       WHERE ${list.where}`,
      list.values
    ),
  ]);

  const total = Number.parseInt(countResult.rows[0]?.total ?? '0', 10);
  return {
    items: itemsResult.rows,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      pages: Math.ceil(total / filters.limit),
    },
  };
}

export async function findRecord(
  workspaceId: string,
  resourceType: ResourceType,
  recordId: string,
  includeDeleted = false,
  client?: PoolClient
) {
  const { rows } = await query<WorkspaceRecord>(
    `SELECT ${recordSelect}
     FROM workspace_records
     WHERE workspace_id = $1 AND resource_type = $2 AND id = $3
       ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
     LIMIT 1`,
    [workspaceId, resourceType, recordId],
    client
  );
  return rows[0];
}

export async function listExecutionArtifactsBySourceRecordId(
  workspaceId: string,
  sourceRecordId: string,
  client?: PoolClient
) {
  const { rows } = await query<WorkspaceRecord>(
    `SELECT ${recordSelect}
     FROM workspace_records
     WHERE workspace_id = $1
       AND deleted_at IS NULL
       AND source = 'agent_executor'
       AND COALESCE(data ->> 'sourceActionRecordId', '') = $2
     ORDER BY created_at ASC, id ASC`,
    [workspaceId, sourceRecordId],
    client
  );
  return rows;
}

async function insertAudit(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  action: string,
  resourceType: string,
  recordId: string,
  beforeData: WorkspaceRecord | null,
  afterData: WorkspaceRecord | null
) {
  await query(
    `INSERT INTO audit_log (
       workspace_id, actor_id, action, entity_type, entity_id, before_data, after_data
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [workspaceId, actorId, action, resourceType, recordId, beforeData, afterData],
    client
  );
}

export async function createRecord(
  workspaceId: string,
  resourceType: ResourceType,
  userId: string,
  input: CreateRecordInput
) {
  return withTransaction(async (client) => {
    const { rows } = await query<WorkspaceRecord>(
      `INSERT INTO workspace_records (
         workspace_id, resource_type, parent_id, name, description, status, stage,
         value_amount, currency, starts_at, ends_at, due_at, assignee_id,
         external_id, source, tags, data, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18
       )
       RETURNING ${recordSelect}`,
      [
        workspaceId,
        resourceType,
        input.parentId ?? null,
        input.name,
        input.description ?? null,
        input.status ?? 'active',
        input.stage ?? null,
        input.valueAmount ?? null,
        input.currency ?? null,
        input.startsAt ?? null,
        input.endsAt ?? null,
        input.dueAt ?? null,
        input.assigneeId ?? null,
        input.externalId ?? null,
        input.source ?? null,
        input.tags ?? [],
        input.data ?? {},
        userId,
      ],
      client
    );
    const record = rows[0];
    if (!record) throw new Error('Record insert did not return a row');
    await insertAudit(client, workspaceId, userId, 'record.created', resourceType, record.id, null, record);
    return record;
  });
}

type MutableRecordInput = Omit<UpdateRecordInput, 'expectedVersion'>;

const updateColumns: Partial<Record<keyof MutableRecordInput, string>> = {
  name: 'name',
  description: 'description',
  status: 'status',
  stage: 'stage',
  valueAmount: 'value_amount',
  currency: 'currency',
  startsAt: 'starts_at',
  endsAt: 'ends_at',
  dueAt: 'due_at',
  assigneeId: 'assignee_id',
  parentId: 'parent_id',
  externalId: 'external_id',
  source: 'source',
  tags: 'tags',
  data: 'data',
};

export async function updateRecord(
  workspaceId: string,
  resourceType: ResourceType,
  recordId: string,
  userId: string,
  input: UpdateRecordInput
) {
  return withTransaction(async (client) => {
    const before = await findRecord(workspaceId, resourceType, recordId, false, client);
    if (!before) return { status: 'not_found' as const };
    if (input.expectedVersion !== undefined && before.version !== input.expectedVersion) {
      return { status: 'version_conflict' as const, current: before };
    }

    const { expectedVersion: _expectedVersion, ...mutableInput } = input;
    const update = buildUpdateSet(mutableInput, updateColumns, 4);
    const assignments = [...update.assignments, 'updated_by = $4', 'version = version + 1'];
    const { rows } = await query<WorkspaceRecord>(
      `UPDATE workspace_records
       SET ${assignments.join(', ')}
       WHERE workspace_id = $1 AND resource_type = $2 AND id = $3 AND deleted_at IS NULL
       RETURNING ${recordSelect}`,
      [workspaceId, resourceType, recordId, userId, ...update.values],
      client
    );
    const record = rows[0];
    if (!record) return { status: 'not_found' as const };
    await insertAudit(client, workspaceId, userId, 'record.updated', resourceType, record.id, before, record);
    return { status: 'updated' as const, record };
  });
}

export async function archiveRecord(
  workspaceId: string,
  resourceType: ResourceType,
  recordId: string,
  userId: string
) {
  return withTransaction(async (client) => {
    const before = await findRecord(workspaceId, resourceType, recordId, false, client);
    if (!before) return false;
    const { rows } = await query<WorkspaceRecord>(
      `UPDATE workspace_records
       SET deleted_at = NOW(), updated_by = $4, version = version + 1
       WHERE workspace_id = $1 AND resource_type = $2 AND id = $3 AND deleted_at IS NULL
       RETURNING ${recordSelect}`,
      [workspaceId, resourceType, recordId, userId],
      client
    );
    await insertAudit(client, workspaceId, userId, 'record.archived', resourceType, recordId, before, rows[0] ?? null);
    return true;
  });
}

export async function restoreRecord(
  workspaceId: string,
  resourceType: ResourceType,
  recordId: string,
  userId: string
) {
  return withTransaction(async (client) => {
    const before = await findRecord(workspaceId, resourceType, recordId, true, client);
    if (!before) return undefined;
    const { rows } = await query<WorkspaceRecord>(
      `UPDATE workspace_records
       SET deleted_at = NULL, updated_by = $4, version = version + 1
       WHERE workspace_id = $1 AND resource_type = $2 AND id = $3 AND deleted_at IS NOT NULL
       RETURNING ${recordSelect}`,
      [workspaceId, resourceType, recordId, userId],
      client
    );
    const record = rows[0];
    if (!record) return undefined;
    await insertAudit(client, workspaceId, userId, 'record.restored', resourceType, recordId, before, record);
    return record;
  });
}

export async function claimExecutionReadyRecords(limit = 20) {
  return withTransaction(async (client) => {
    const { rows: candidates } = await query<WorkspaceRecord>(
      `SELECT ${recordSelect}
       FROM workspace_records
       WHERE deleted_at IS NULL
         AND source = 'page_agent'
         AND stage = 'queued_for_execution'
         AND COALESCE(data ->> 'executionReady', 'false') = 'true'
       ORDER BY updated_at ASC, id ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
      client,
    );
    const claimed: WorkspaceRecord[] = [];
    for (const candidate of candidates) {
      const nextData = {
        ...(candidate.data ?? {}),
        executionStatus: 'executing',
        executionStartedAt: new Date().toISOString(),
      };
      const { rows } = await query<WorkspaceRecord>(
        `UPDATE workspace_records
         SET stage = 'executing',
             data = $2,
             updated_by = $3,
             version = version + 1
         WHERE id = $1
         RETURNING ${recordSelect}`,
        [candidate.id, nextData, candidate.createdBy],
        client,
      );
      const record = rows[0];
      if (!record) continue;
      await insertAudit(client, candidate.workspaceId, candidate.createdBy, 'record.execution_claimed', candidate.resourceType, candidate.id, candidate, record);
      claimed.push(record);
    }
    return claimed;
  });
}
