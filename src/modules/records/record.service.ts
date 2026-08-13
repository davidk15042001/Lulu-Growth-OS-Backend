import { conflictError, notFoundError } from '../../utils/app-error.js';
import type { ResourceType } from '../../domain/resource-catalog.js';
import * as repo from './record.repo.js';
import type {
  CreateRecordInput,
  ListRecordsQuery,
  UpdateRecordInput,
} from './record.validator.js';

export function listRecords(
  workspaceId: string,
  resourceType: ResourceType,
  filters: ListRecordsQuery
) {
  return repo.listRecords(workspaceId, resourceType, filters);
}

export async function getRecord(workspaceId: string, resourceType: ResourceType, recordId: string) {
  const record = await repo.findRecord(workspaceId, resourceType, recordId);
  if (!record) throw notFoundError('Record not found');
  return record;
}

export function createRecord(
  workspaceId: string,
  resourceType: ResourceType,
  userId: string,
  input: CreateRecordInput
) {
  return repo.createRecord(workspaceId, resourceType, userId, input);
}

export async function updateRecord(
  workspaceId: string,
  resourceType: ResourceType,
  recordId: string,
  userId: string,
  input: UpdateRecordInput
) {
  const result = await repo.updateRecord(workspaceId, resourceType, recordId, userId, input);
  if (result.status === 'not_found') throw notFoundError('Record not found');
  if (result.status === 'version_conflict') {
    throw conflictError(`Record changed since version ${input.expectedVersion}`);
  }
  return result.record;
}

export async function archiveRecord(
  workspaceId: string,
  resourceType: ResourceType,
  recordId: string,
  userId: string
) {
  if (!(await repo.archiveRecord(workspaceId, resourceType, recordId, userId))) {
    throw notFoundError('Record not found');
  }
}

export async function restoreRecord(
  workspaceId: string,
  resourceType: ResourceType,
  recordId: string,
  userId: string
) {
  const record = await repo.restoreRecord(workspaceId, resourceType, recordId, userId);
  if (!record) throw notFoundError('Archived record not found');
  return record;
}
