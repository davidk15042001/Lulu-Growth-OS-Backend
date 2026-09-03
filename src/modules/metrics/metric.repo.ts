import { query, withTransaction } from '../../db/pool.js';
import { buildUpdateSet } from '../../db/update-builder.js';
import type {
  CreateMetricInput,
  ListMetricPointsQuery,
  MetricPointInput,
  UpdateMetricInput,
} from './metric.validator.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';

export type MetricDefinition = {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  domain: string;
  unit: string;
  format: string | null;
  source: string | null;
  configuration: Record<string, unknown>;
  latestValue: string | null;
  latestRecordedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const metricSelect = `
  md.id,
  md.workspace_id AS "workspaceId",
  md.key,
  md.name,
  md.domain,
  md.unit,
  md.format,
  md.source,
  md.configuration,
  latest.value AS "latestValue",
  latest.recorded_at AS "latestRecordedAt",
  md.created_at AS "createdAt",
  md.updated_at AS "updatedAt"
`;

const metricFrom = `
  FROM metric_definitions md
  LEFT JOIN LATERAL (
    SELECT mp.value, mp.recorded_at
    FROM metric_points mp
    WHERE mp.metric_id = md.id
    ORDER BY mp.recorded_at DESC
    LIMIT 1
  ) latest ON TRUE
`;

export async function listMetrics(workspaceId: string) {
  const { rows } = await query<MetricDefinition>(
    `SELECT ${metricSelect}
     ${metricFrom}
     WHERE md.workspace_id = $1 AND md.deleted_at IS NULL
     ORDER BY md.domain, md.name`,
    [workspaceId]
  );
  return rows;
}

export async function findMetric(workspaceId: string, metricId: string) {
  const { rows } = await query<MetricDefinition>(
    `SELECT ${metricSelect}
     ${metricFrom}
     WHERE md.workspace_id = $1 AND md.id = $2 AND md.deleted_at IS NULL
     LIMIT 1`,
    [workspaceId, metricId]
  );
  return rows[0];
}

export async function createMetric(workspaceId: string, input: CreateMetricInput) {
  return withTransaction(async (client) => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO metric_definitions (
         workspace_id, key, name, domain, unit, format, source, configuration
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [workspaceId, input.key, input.name, input.domain, input.unit ?? 'number', input.format ?? null, input.source ?? null, input.configuration ?? {}],
      client,
    );
    const metricId = rows[0]?.id;
    if (metricId) await appendDomainEvent({
      workspaceId,
      type: DOMAIN_EVENT_TYPES.METRIC_CREATED,
      aggregateType: 'metric',
      aggregateId: metricId,
      payload: { metricId, key: input.key, domain: input.domain },
      metadata: { source: 'metrics' },
      idempotencyKey: `metric:${metricId}:created:v1`,
    }, client);
    return metricId;
  });
}

const updateColumns: Partial<Record<keyof UpdateMetricInput, string>> = {
  key: 'key',
  name: 'name',
  domain: 'domain',
  unit: 'unit',
  format: 'format',
  source: 'source',
  configuration: 'configuration',
};

export async function updateMetric(workspaceId: string, metricId: string, input: UpdateMetricInput) {
  const update = buildUpdateSet(input, updateColumns, 2);
  return withTransaction(async (client) => {
    const { rowCount } = await query(
      `UPDATE metric_definitions
       SET ${update.assignments.join(', ')}
       WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [workspaceId, metricId, ...update.values],
      client,
    );
    if (rowCount > 0) await appendDomainEvent({
      workspaceId,
      type: DOMAIN_EVENT_TYPES.METRIC_UPDATED,
      aggregateType: 'metric',
      aggregateId: metricId,
      payload: { metricId, changedFields: Object.keys(input) },
      metadata: { source: 'metrics' },
    }, client);
    return rowCount > 0;
  });
}

export async function archiveMetric(workspaceId: string, metricId: string) {
  return withTransaction(async (client) => {
    const { rowCount } = await query(
      `UPDATE metric_definitions
       SET deleted_at = NOW()
       WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [workspaceId, metricId],
      client,
    );
    if (rowCount > 0) await appendDomainEvent({
      workspaceId,
      type: DOMAIN_EVENT_TYPES.METRIC_ARCHIVED,
      aggregateType: 'metric',
      aggregateId: metricId,
      payload: { metricId },
      metadata: { source: 'metrics' },
      idempotencyKey: `metric:${metricId}:archived:v1`,
    }, client);
    return rowCount > 0;
  });
}

export async function insertPoints(
  workspaceId: string,
  metricId: string,
  points: MetricPointInput[]
) {
  return withTransaction(async (client) => {
    const metric = await query<{ id: string }>(
      `SELECT id FROM metric_definitions
       WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
       LIMIT 1`,
      [workspaceId, metricId],
      client
    );
    if (!metric.rows[0]) return undefined;

    const values: unknown[] = [];
    const placeholders = points.map((point, index) => {
      const offset = index * 5;
      values.push(metricId, point.recordedAt, point.value, point.dimensions ?? {}, point.sourceRecordId ?? null);
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
    });

    const result = await query(
      `INSERT INTO metric_points (metric_id, recorded_at, value, dimensions, source_record_id)
       VALUES ${placeholders.join(', ')}`,
      values,
      client
    );
    await appendDomainEvent({
      workspaceId,
      type: DOMAIN_EVENT_TYPES.METRIC_POINTS_RECORDED,
      aggregateType: 'metric',
      aggregateId: metricId,
      payload: {
        metricId,
        pointsRecorded: result.rowCount,
        firstRecordedAt: points[0]?.recordedAt ?? null,
        lastRecordedAt: points.at(-1)?.recordedAt ?? null,
      },
      metadata: { source: 'metrics' },
    }, client);
    return result.rowCount;
  });
}

export async function listPoints(
  workspaceId: string,
  metricId: string,
  filters: ListMetricPointsQuery
) {
  const values: unknown[] = [workspaceId, metricId];
  const conditions = [
    'md.workspace_id = $1',
    'md.id = $2',
    'md.deleted_at IS NULL',
  ];
  if (filters.from) {
    values.push(filters.from);
    conditions.push(`mp.recorded_at >= $${values.length}`);
  }
  if (filters.to) {
    values.push(filters.to);
    conditions.push(`mp.recorded_at <= $${values.length}`);
  }

  const offset = (filters.page - 1) * filters.limit;
  const order = filters.order === 'desc' ? 'DESC' : 'ASC';
  const where = conditions.join(' AND ');

  const [items, count] = await Promise.all([
    query<{
      id: string;
      recordedAt: string;
      value: string;
      dimensions: Record<string, unknown>;
      sourceRecordId: string | null;
    }>(
      `SELECT
         mp.id::text AS id,
         mp.recorded_at AS "recordedAt",
         mp.value,
         mp.dimensions,
         mp.source_record_id AS "sourceRecordId"
       FROM metric_points mp
       JOIN metric_definitions md ON md.id = mp.metric_id
       WHERE ${where}
       ORDER BY mp.recorded_at ${order}, mp.id ${order}
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, filters.limit, offset]
    ),
    query<{ total: string }>(
      `SELECT count(*)::text AS total
       FROM metric_points mp
       JOIN metric_definitions md ON md.id = mp.metric_id
       WHERE ${where}`,
      values
    ),
  ]);

  const total = Number.parseInt(count.rows[0]?.total ?? '0', 10);
  return {
    items: items.rows,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      pages: Math.ceil(total / filters.limit),
    },
  };
}
