import { deflateSync } from 'node:zlib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describeImage } from '../ai/openai.service.js';

export type CatalogSourceDocument = {
  id: string;
  fileName: string;
  mimeType: string;
  content: Buffer;
  storageKey: string | null;
};

export type CatalogEvidenceDraft = {
  assetId: string;
  sourceDocumentId: string;
  kind: 'DOCUMENT_TEXT' | 'PDF_PAGE_TEXT' | 'PDF_IMAGE' | 'UPLOADED_IMAGE';
  pageNumber: number | null;
  mimeType: string | null;
  content: Buffer | null;
  sourceStorageReference: string | null;
  extractedText: string;
  metadata: Record<string, unknown>;
};

const MAX_PDF_PAGES = 80;
const MAX_PDF_IMAGES = 24;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(kind: string, data: Uint8Array) {
  const type = Buffer.from(kind, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, Buffer.from(data)])), 0);
  return Buffer.concat([length, type, Buffer.from(data), checksum]);
}

/** Converts PDF.js' decoded RGB/RGBA/gray image data without a native canvas dependency. */
export function catalogImageDataToPng(input: { width?: unknown; height?: unknown; data?: unknown }): Buffer | null {
  const width = typeof input.width === 'number' ? Math.trunc(input.width) : 0;
  const height = typeof input.height === 'number' ? Math.trunc(input.height) : 0;
  const pixels = width * height;
  if (width < 32 || height < 32 || pixels > 20_000_000 || !input.data) return null;
  const source = input.data instanceof Uint8Array ? input.data : null;
  if (!source || !pixels || source.byteLength % pixels !== 0) return null;
  const channels = source.byteLength / pixels;
  const colorType = channels === 4 ? 6 : channels === 3 ? 2 : channels === 1 ? 0 : null;
  if (colorType === null) return null;
  const rowBytes = width * channels;
  const scanlines = Buffer.allocUnsafe(height * (rowBytes + 1));
  for (let row = 0; row < height; row += 1) {
    const outputOffset = row * (rowBytes + 1);
    scanlines[outputOffset] = 0;
    Buffer.from(source.buffer, source.byteOffset + row * rowBytes, rowBytes).copy(scanlines, outputOffset + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return png.byteLength <= MAX_IMAGE_BYTES ? png : null;
}

function isPdf(document: CatalogSourceDocument) {
  return document.mimeType === 'application/pdf' || document.fileName.toLowerCase().endsWith('.pdf');
}

function isSupportedImage(document: CatalogSourceDocument) {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(document.mimeType.toLowerCase());
}

async function pageImageData(page: unknown, objectName: string) {
  const objects = (page as { objs?: { get?: (name: string) => unknown } }).objs;
  if (!objects?.get) return null;
  try {
    const image = objects.get(objectName);
    return image && typeof image === 'object' ? image as { width?: unknown; height?: unknown; data?: unknown } : null;
  } catch {
    return null;
  }
}

function pageText(content: unknown) {
  const items = (content as { items?: Array<{ str?: unknown }> }).items ?? [];
  return items.map((item) => typeof item.str === 'string' ? item.str : '').join(' ').replace(/\s+/g, ' ').trim();
}

async function describeCatalogImage(content: Buffer, mimeType: string) {
  const description = await describeImage({ dataUrl: `data:${mimeType};base64,${content.toString('base64')}` });
  return description.slice(0, 4_000);
}

export async function collectCatalogEvidence(documents: CatalogSourceDocument[]): Promise<CatalogEvidenceDraft[]> {
  const evidence: CatalogEvidenceDraft[] = [];
  let extractedImageCount = 0;

  for (const document of documents) {
    if (isSupportedImage(document)) {
      const description = await describeCatalogImage(document.content, document.mimeType);
      evidence.push({
        assetId: `document:${document.id}:image`, sourceDocumentId: document.id, kind: 'UPLOADED_IMAGE', pageNumber: null,
        mimeType: document.mimeType, content: null, sourceStorageReference: document.storageKey, extractedText: description,
        metadata: { fileName: document.fileName, origin: 'uploaded-image' },
      });
      continue;
    }
    if (!isPdf(document)) continue;
    try {
      const pdf = await getDocument({ data: new Uint8Array(document.content), useSystemFonts: true }).promise;
      const pageLimit = Math.min(pdf.numPages, MAX_PDF_PAGES);
      for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const text = pageText(await page.getTextContent());
        if (text) {
          evidence.push({
            assetId: `document:${document.id}:page:${pageNumber}:text`, sourceDocumentId: document.id, kind: 'PDF_PAGE_TEXT', pageNumber,
            mimeType: 'application/pdf', content: null, sourceStorageReference: document.storageKey, extractedText: text,
            metadata: { fileName: document.fileName, origin: 'pdf-text' },
          });
        }
        if (extractedImageCount >= MAX_PDF_IMAGES) continue;
        const operatorList = await page.getOperatorList() as unknown as { args?: unknown[][] };
        const names = new Set<string>();
        for (const args of operatorList.args ?? []) {
          for (const argument of args) if (typeof argument === 'string' && argument.length <= 200) names.add(argument);
        }
        let imageIndex = 0;
        for (const name of names) {
          if (extractedImageCount >= MAX_PDF_IMAGES) break;
          const decoded = await pageImageData(page, name);
          const png = decoded ? catalogImageDataToPng(decoded) : null;
          if (!png) continue;
          imageIndex += 1;
          extractedImageCount += 1;
          const description = await describeCatalogImage(png, 'image/png');
          evidence.push({
            assetId: `document:${document.id}:page:${pageNumber}:image:${imageIndex}`, sourceDocumentId: document.id, kind: 'PDF_IMAGE', pageNumber,
            mimeType: 'image/png', content: png, sourceStorageReference: null, extractedText: description,
            metadata: { fileName: document.fileName, origin: 'pdf-image', width: decoded?.width ?? null, height: decoded?.height ?? null },
          });
        }
      }
    } catch {
      // Text extraction below still gives the importer a chance to classify a
      // PDF whose visual resources are encrypted or malformed.
    }
  }
  return evidence;
}
