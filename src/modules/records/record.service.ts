import { AppError, conflictError, notFoundError } from '../../utils/app-error.js';
import type { ResourceType } from '../../domain/resource-catalog.js';
import * as repo from './record.repo.js';
import * as adminOAuthRepo from '../admin/admin-oauth.repo.js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describeImage } from '../ai/openai.service.js';
import ExcelJS from 'exceljs';
import * as productService from '../products/product.service.js';
import type {
  CreateRecordInput,
  ListRecordsQuery,
  UpdateRecordInput,
} from './record.validator.js';

export type IngestFile = { name: string; type: string; buffer: Buffer };
export type IngestRecordInput = { name: string; text: string; files: IngestFile[] };

function parseCsvRow(line: string) {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && line[index + 1] === '"' && quoted) { cell += '"'; index += 1; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (character === ',' && !quoted) { cells.push(cell.trim()); cell = ''; continue; }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function tabularCandidates(text: string, maximumRows = 500) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // Spreadsheet extraction prefixes each sheet with `Sheet: …`. Skip that
  // marker and stop at the next sheet so one import cannot mix columns from
  // unrelated tables.
  let headerIndex = lines.findIndex((line) => !/^Sheet:\s*/i.test(line) && /,/.test(line));
  if (headerIndex < 0 || lines.length <= headerIndex + 1) return [] as Array<Record<string, string>>;
  const headerLine = lines[headerIndex] ?? '';
  const normalize = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, '');
  const headers = parseCsvRow(headerLine).map(normalize);
  return lines.slice(headerIndex + 1).filter((line) => !/^Sheet:\s*/i.test(line)).slice(0, maximumRows).map((line) => {
    const cells = parseCsvRow(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => { if (header && cells[index]) row[header] = cells[index]; });
    return row;
  }).filter((row) => Object.keys(row).length > 0);
}

function productCandidates(text: string) {
  return tabularCandidates(text, 100).filter((row) => {
    return Boolean(row.productname || row.product || row.name || row.title);
  });
}

function crmCandidates(text: string, resourceType: ResourceType) {
  return tabularCandidates(text).map((row) => {
    const name = resourceType === 'crm_companies'
      ? row.companyname || row.company || row.name || row.title
      : row.fullname || row.contactname || row.name || row.title || row.subject || row.companyname || row.company;
    return name ? { name, row } : null;
  }).filter((candidate): candidate is { name: string; row: Record<string, string> } => Boolean(candidate));
}

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

async function extractSpreadsheetText(buffer: Buffer): Promise<string> {
  try {
    const workbook = new ExcelJS.Workbook();
    // ExcelJS brings its own Node Buffer type in some dependency trees; the
    // runtime value is still the same byte buffer used by Multer.
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheets = workbook.worksheets.map((sheet) => {
      const rows: string[] = [];
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const cells = row.values as Array<unknown>;
        const values = cells.slice(1).map((value) => {
          if (value === null || value === undefined) return '';
          if (typeof value === 'object' && value && 'result' in value) return String((value as { result?: unknown }).result ?? '');
          if (typeof value === 'object' && value && 'text' in value) return String((value as { text?: unknown }).text ?? '');
          return String(value);
        });
        rows.push(values.map((value) => /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value).join(','));
      });
      const csv = rows.join('\n').trim();
      return csv ? `Sheet: ${sheet.name}\n${csv}` : '';
    }).filter(Boolean);
    return sheets.join('\n\n').slice(0, 100_000);
  } catch {
    return '';
  }
}

export function extractTextFromFile(
  file: IngestFile,
  workspaceId: string,
  userId: string,
  options: { platformFunded?: boolean } = {},
): Promise<string> {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const isPdf = file.type === 'application/pdf' || extension === 'pdf';
  const isImage = file.type.startsWith('image/');
  const isSpreadsheet = ['xls', 'xlsx', 'xlsm', 'ods'].includes(extension)
    || ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.oasis.opendocument.spreadsheet'].includes(file.type);
  const isUnsupportedSpreadsheet = extension === 'xls' || extension === 'ods'
    || file.type === 'application/vnd.ms-excel'
    || file.type === 'application/vnd.oasis.opendocument.spreadsheet';
  const isText = file.type.startsWith('text/')
    || file.type === 'application/json'
    || file.type === 'application/xml'
    || TEXT_FILE_EXTENSIONS.has(extension);
  if (isText) return Promise.resolve(file.buffer.toString('utf8'));
  if (isPdf) return extractPdfText(file.buffer);
  if (isUnsupportedSpreadsheet) {
    throw new AppError(422, 'SPREADSHEET_FORMAT_UNSUPPORTED', 'Legacy XLS and ODS files are not supported for structured import. Please save the file as XLSX and upload it again.');
  }
  if (isSpreadsheet) return extractSpreadsheetText(file.buffer);
  if (isImage) {
    const dataUrl = `data:${file.type};base64,${file.buffer.toString('base64')}`;
    return describeImage(options.platformFunded ? { dataUrl } : { dataUrl, workspaceId, userId });
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
  // The current ingestion path is intentionally deterministic: it extracts
  // text/table data locally and records exactly which downstream targets were
  // prepared. A DeepSeek run or external publish is not implied by a stored
  // knowledge record and must be performed by an explicitly configured agent
  // workflow/provider later.
  const analysis: Record<string, unknown> = {
    status: 'completed',
    engine: 'deterministic-parser',
    aiRequested: false,
    externalPublishRequested: false,
    analyzedAt: new Date().toISOString(),
    targets: ['ai', 'website', 'commerce'],
  };
  if (resourceType === 'ai_knowledge') {
    const candidates = productCandidates(extractedText || input.text);
    let importedProducts = 0;
    for (const candidate of candidates) {
      try {
        const name = candidate.productname || candidate.product || candidate.name || candidate.title;
        if (!name) continue;
        await productService.createProduct(workspaceId, userId, {
          name,
          sku: candidate.sku || null,
          shortDescription: candidate.description || candidate.shortdescription || null,
          longDescription: candidate.longdescription || null,
          defaultCurrency: (candidate.currency || 'CNY').toUpperCase().slice(0, 3),
          defaultPrice: candidate.price || candidate.defaultprice || null,
          pricingType: candidate.price || candidate.defaultprice ? 'FIXED' : 'QUOTE_REQUIRED',
          moqQuantity: candidate.moq || candidate.moqquantity || null,
          moqUnit: candidate.unit || candidate.moqunit || 'pcs',
          status: 'DRAFT',
          productType: 'PHYSICAL_PRODUCT',
          visibility: 'PRIVATE',
          sourceLanguage: 'en',
        });
        importedProducts += 1;
      } catch {
        // A duplicate or incomplete row must not prevent the knowledge record
        // from being stored. It remains visible as an analyzed candidate.
      }
    }
    analysis.productCandidates = candidates.length;
    analysis.productsCreated = importedProducts;
  }
  if (['crm_contacts', 'crm_companies', 'crm_activities', 'crm_tasks'].includes(resourceType)) {
    const candidates = crmCandidates(extractedText || input.text, resourceType);
    let importedRecords = 0;
    let firstImported: Awaited<ReturnType<typeof repo.createRecord>> | null = null;
    for (const candidate of candidates) {
      try {
        const row = candidate.row;
        const imported = await repo.createRecord(workspaceId, resourceType, userId, {
          name: candidate.name.slice(0, 300),
          description: row.description || row.notes || row.note || null,
          status: row.status || (resourceType === 'crm_tasks' ? 'Open' : 'Active'),
          dueAt: row.dueat || row.duedate || null,
          source: 'import',
          data: {
            ...row,
            importFile: input.name,
            importedAt: new Date().toISOString(),
          },
        });
        firstImported ??= imported;
        importedRecords += 1;
      } catch {
        // Keep processing the remaining rows. The file itself remains safely
        // available through the import metadata and partial imports are
        // reported in the resulting analysis object.
      }
    }
    analysis.importCandidates = candidates.length;
    analysis.importedRecords = importedRecords;
    if (firstImported) {
      return firstImported;
    }
  }
  return repo.createRecord(workspaceId, resourceType, userId, {
    name: input.name,
    description,
    status: 'Active',
    source: 'upload',
    data: {
      source: 'upload',
      analysis,
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
