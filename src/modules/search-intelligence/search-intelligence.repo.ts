import { query } from '../../db/pool.js';
import type { ResourceType } from '../../domain/resource-catalog.js';
import * as recordRepo from '../records/record.repo.js';

export type SearchRecord = {
  id: string;
  workspaceId: string;
  resourceType: ResourceType;
  name: string;
  description: string | null;
  status: string;
  stage: string | null;
  externalId: string | null;
  data: Record<string, unknown>;
  updatedAt: string;
  createdAt: string;
};

const recordSelect = `
  id,
  workspace_id AS "workspaceId",
  resource_type AS "resourceType",
  name,
  description,
  status,
  stage,
  external_id AS "externalId",
  data,
  updated_at AS "updatedAt",
  created_at AS "createdAt"
`;

export async function listChannelRecords(workspaceId: string, resourceType: ResourceType, limit = 100) {
  const { rows } = await query<SearchRecord>(
    `SELECT ${recordSelect}
     FROM workspace_records
     WHERE workspace_id = $1
       AND resource_type = $2
       AND deleted_at IS NULL
     ORDER BY updated_at DESC, created_at DESC
     LIMIT $3`,
    [workspaceId, resourceType, limit],
  );
  return rows;
}

export async function findRecordByExternalId(
  workspaceId: string,
  resourceType: ResourceType,
  externalId: string,
) {
  const { rows } = await query<{ id: string }>(
    `SELECT id
     FROM workspace_records
     WHERE workspace_id = $1
       AND resource_type = $2
       AND external_id = $3
       AND deleted_at IS NULL
     LIMIT 1`,
    [workspaceId, resourceType, externalId],
  );
  return rows[0]?.id ?? null;
}

export async function upsertChannelRecord(input: {
  workspaceId: string;
  resourceType: ResourceType;
  userId: string;
  externalId: string;
  name: string;
  description?: string | null;
  status?: string;
  stage?: string | null;
  tags?: string[];
  data?: Record<string, unknown>;
}) {
  const existingId = await findRecordByExternalId(
    input.workspaceId,
    input.resourceType,
    input.externalId,
  );

  if (!existingId) {
    return recordRepo.createRecord(input.workspaceId, input.resourceType, input.userId, {
      name: input.name,
      description: input.description ?? null,
      status: input.status ?? 'active',
      stage: input.stage ?? null,
      externalId: input.externalId,
      tags: input.tags ?? [],
      data: input.data ?? {},
    });
  }

  const updated = await recordRepo.updateRecord(
    input.workspaceId,
    input.resourceType,
    existingId,
    input.userId,
    {
      name: input.name,
      description: input.description ?? null,
      status: input.status ?? 'active',
      stage: input.stage ?? null,
      externalId: input.externalId,
      tags: input.tags ?? [],
      data: input.data ?? {},
    },
  );

  if (updated.status !== 'updated') {
    throw new Error(`Search intelligence record ${existingId} could not be updated`);
  }

  return updated.record;
}
