import { AppError, conflictError, notFoundError } from '../../utils/app-error.js';
import type { ResourceType } from '../../domain/resource-catalog.js';
import * as repo from './record.repo.js';
import * as adminOAuthRepo from '../admin/admin-oauth.repo.js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describeImage } from '../ai/openai.service.js';
import type {
  CreateRecordInput,
  ListRecordsQuery,
  UpdateRecordInput,
} from './record.validator.js';

export type IngestFile = { name: string; type: string; buffer: Buffer };
export type IngestRecordInput = { name: string; text: string; files: IngestFile[] };

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
  if (resourceType.startsWith('ad_')) {
    const requestedProvider = typeof input.data?.provider === 'string' ? input.data.provider.trim() : '';
    if (!adminOAuthRepo.isLuluManagedProvider(requestedProvider)) {
      throw new AppError(409, 'ADVERTISING_PROVIDER_ADMIN_MANAGED', 'Advertising records must specify a Lulu-managed provider (Google Ads, Meta, LinkedIn or TikTok Ads).', { management: 'lulu_managed' });
    }
    return adminOAuthRepo.getManagedOAuthCredential(requestedProvider).then((connection) => {
      if (!connection || connection.status !== 'connected') {
        throw new AppError(409, 'ADVERTISING_PROVIDER_NOT_CONNECTED', 'The selected advertising provider is not connected in the Lulu Admin Panel.', { provider: requestedProvider, management: 'lulu_managed' });
      }
      return repo.createRecord(workspaceId, resourceType, userId, {
        ...input,
        data: { ...(input.data ?? {}), provider: requestedProvider, management: 'lulu_managed' },
      });
    });
  }
  return repo.createRecord(workspaceId, resourceType, userId, input);
}

const TEXT_FILE_EXTENSIONS = new Set(['txt', 'md', 'csv', 'json', 'html', 'htm', 'xml', 'yaml', 'yml', 'log', 'css', 'js', 'ts', 'tsx', 'jsx', 'rst', 'sql', 'ini', 'env']);

async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const document = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
    let text = '';
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items as Array<{ str?: string }>;
      text += items.map((item) => item.str ?? '').join(' ') + '\n';
    }
    return text.trim();
  } catch {
    return '';
  }
}

export function extractTextFromFile(file: IngestFile, workspaceId: string, userId: string): Promise<string> {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const isPdf = file.type === 'application/pdf' || extension === 'pdf';
  const isImage = file.type.startsWith('image/');
  const isText = file.type.startsWith('text/')
    || file.type === 'application/json'
    || file.type === 'application/xml'
    || TEXT_FILE_EXTENSIONS.has(extension);
  if (isText) return Promise.resolve(file.buffer.toString('utf8'));
  if (isPdf) return extractPdfText(file.buffer);
  if (isImage) {
    const dataUrl = `data:${file.type};base64,${file.buffer.toString('base64')}`;
    return describeImage({ dataUrl, workspaceId, userId });
  }
  return Promise.resolve('');
}

export async function ingestRecord(
  workspaceId: string,
  resourceType: ResourceType,
  userId: string,
  input: IngestRecordInput
) {
  const files: Array<{ name: string; type: string; extractedText: string }> = [];
  for (const file of input.files) {
    files.push({
      name: file.name,
      type: file.type,
      extractedText: await extractTextFromFile(file, workspaceId, userId),
    });
  }
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
  if (resourceType.startsWith('ad_')) {
    const existing = await repo.findRecord(workspaceId, resourceType, recordId);
    if (!existing) throw notFoundError('Record not found');
    const mergedData = { ...(existing.data ?? {}), ...(input.data ?? {}) };
    const requestedProvider = typeof mergedData.provider === 'string' ? mergedData.provider.trim() : '';
    if (!adminOAuthRepo.isLuluManagedProvider(requestedProvider)) {
      throw new AppError(409, 'ADVERTISING_PROVIDER_ADMIN_MANAGED', 'Advertising records must remain assigned to a Lulu-managed provider.', { management: 'lulu_managed' });
    }
    const connection = await adminOAuthRepo.getManagedOAuthCredential(requestedProvider);
    if (!connection || connection.status !== 'connected') {
      throw new AppError(409, 'ADVERTISING_PROVIDER_NOT_CONNECTED', 'The selected advertising provider is not connected in the Lulu Admin Panel.', { provider: requestedProvider, management: 'lulu_managed' });
    }
    input = { ...input, data: { ...mergedData, provider: requestedProvider, management: 'lulu_managed' } };
  }
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
