import { conflictError, notFoundError } from '../../utils/app-error.js';
import type { ResourceType } from '../../domain/resource-catalog.js';
import * as repo from './record.repo.js';
import type {
  CreateRecordInput,
  IngestRecordInput,
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

const TEXT_FILE_EXTENSIONS = new Set(['txt', 'md', 'csv', 'json', 'html', 'htm', 'xml', 'yaml', 'yml', 'log', 'css', 'js', 'ts', 'tsx', 'jsx', 'rst', 'sql', 'ini', 'env']);

function decodeDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | null {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return null;
  const header = dataUrl.slice(0, comma);
  const mime = /^data:([^;]+)/.exec(header)?.[1] ?? '';
  try {
    return { mime, buffer: Buffer.from(dataUrl.slice(comma + 1), 'base64') };
  } catch {
    return null;
  }
}

function extractTextFromFile(file: { name: string; type: string; dataUrl: string }): string {
  if (!file.dataUrl) return '';
  const decoded = decodeDataUrl(file.dataUrl);
  if (!decoded) return '';
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const isText = decoded.mime.startsWith('text/')
    || decoded.mime === 'application/json'
    || decoded.mime === 'application/xml'
    || TEXT_FILE_EXTENSIONS.has(extension);
  if (!isText) return '';
  return decoded.buffer.toString('utf8');
}

export function ingestRecord(
  workspaceId: string,
  resourceType: ResourceType,
  userId: string,
  input: IngestRecordInput
) {
  const files = input.files.map((file) => ({
    name: file.name,
    type: file.type,
    extractedText: extractTextFromFile(file),
  }));
  const extractedText = files.map((file) => file.extractedText).filter(Boolean).join('\n\n').trim();
  const description = [input.text.trim(), extractedText].filter(Boolean).join('\n\n').slice(0, 20_000) || null;
  return repo.createRecord(workspaceId, resourceType, userId, {
    name: input.name,
    description,
    status: 'Active',
    source: 'upload',
    data: {
      source: 'upload',
      files: files.map((file) => ({ name: file.name, type: file.type, extractedText: file.extractedText })),
    },
  });
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
