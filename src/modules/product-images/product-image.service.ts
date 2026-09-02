import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/app-error.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { configuredModel, generateImage, getOpenAIResponsesClient } from '../ai/openai.service.js';
import { extractTextFromFile, type IngestFile } from '../records/record.service.js';
import * as recordRepo from '../records/record.repo.js';
import { getObject, productImageKey, putObject } from '../../storage/s3.service.js';
import { createWebflowItem, firstWebflowSiteWithCollection } from '../websites/website.provider.service.js';

export type ExtractedProduct = {
  name: string;
  description: string;
  color: string;
  material: string;
  category: string;
};

type StoredImage = {
  imageId: string;
  mimeType: 'image/png';
  s3Key: string | null;
  dataUrl: string | null;
};

const MAX_PRODUCTS = 20;

function extractJson<T>(text: string): T {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const candidates = [cleaned];
  const objectStart = cleaned.indexOf('{');
  const objectEnd = cleaned.lastIndexOf('}');
  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']');
  if (objectStart !== -1 && objectEnd > objectStart) candidates.push(cleaned.slice(objectStart, objectEnd + 1));
  if (arrayStart !== -1 && arrayEnd > arrayStart) candidates.push(cleaned.slice(arrayStart, arrayEnd + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // keep trying the next candidate
    }
  }
  throw new AppError(502, 'AI_EMPTY_RESPONSE', 'Could not parse structured product data from the AI response');
}

function normalizeProducts(parsed: unknown): ExtractedProduct[] {
  const raw = Array.isArray(parsed) ? parsed : (parsed as { products?: unknown[] })?.products ?? [];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      name: String(item.name ?? '').trim(),
      description: String(item.description ?? '').trim(),
      color: String(item.color ?? '').trim(),
      material: String(item.material ?? '').trim(),
      category: String(item.category ?? '').trim(),
    }))
    .filter((product) => product.name.length > 0);
}

export async function extractProductsFromText(text: string, workspaceId: string, userId: string): Promise<ExtractedProduct[]> {
  if (!text.trim()) throw new AppError(400, 'EMPTY_PRODUCT_SOURCE', 'No readable text was found in the uploaded document');
  const client = getOpenAIResponsesClient();
  const response = (await client.createChat(
    {
      model: configuredModel(),
      messages: [
        {
          role: 'system',
          content:
            'You extract structured product data from a product catalog document. ' +
            'Return JSON only, in the shape {"products":[{"name":"...","description":"...","color":"...","material":"...","category":"..."}]}. ' +
            'Infer missing attributes from context where possible; leave unknown attributes as empty strings.',
        },
        { role: 'user', content: text.slice(0, 20_000) },
      ],
      response_format: { type: 'json_object' },
      ...(env.AI_PROVIDER === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
      temperature: 0.15,
      max_tokens: 8000,
    },
    { billing: { workspaceId, userId } },
  )) as { choices?: Array<{ message?: { content?: string | null } }> };

  const content = response.choices?.[0]?.message?.content?.trim() ?? '';
  if (!content) throw new AppError(502, 'AI_EMPTY_RESPONSE', 'The AI provider returned an empty product extraction');
  return normalizeProducts(extractJson<unknown>(content));
}

function buildImagePrompt(product: ExtractedProduct): string {
  return [
    'Professional e-commerce product photograph',
    product.name,
    product.color ? `color ${product.color}` : '',
    product.material ? `made of ${product.material}` : '',
    'on a clean light studio background, soft even lighting, high detail, centered product, no text or watermark',
  ]
    .filter(Boolean)
    .join(', ');
}

async function storeProductImage(workspaceId: string, b64Json: string | null): Promise<StoredImage> {
  const imageId = randomUUID();
  if (env.AWS_S3_BUCKET && b64Json) {
    const key = productImageKey(workspaceId, imageId);
    const content = Buffer.from(b64Json, 'base64');
    await putObject({ key, content, mimeType: 'image/png', fileName: `${imageId}.png` });
    return { imageId, mimeType: 'image/png', s3Key: key, dataUrl: null };
  }
  return {
    imageId,
    mimeType: 'image/png',
    s3Key: null,
    dataUrl: b64Json ? `data:image/png;base64,${b64Json}` : null,
  };
}

export async function extractTextFromUpload(
  file: IngestFile | undefined,
  fallbackText: string,
  workspaceId: string,
  userId: string,
): Promise<string> {
  const extracted = file ? await extractTextFromFile(file, workspaceId, userId) : '';
  const text = [fallbackText.trim(), extracted.trim()].filter(Boolean).join('\n\n').trim();
  if (!text) throw new AppError(400, 'EMPTY_PRODUCT_SOURCE', 'Upload a PDF or provide text containing product information');
  return text;
}

async function syncProductsToCommerce(
  workspaceId: string,
  records: Array<recordRepo.WorkspaceRecord>,
): Promise<{ provider: string | null; synced: number; error: string | null }> {
  let provider: string | null = null;
  let synced = 0;
  let error: string | null = null;
  try {
    const site = await firstWebflowSiteWithCollection(workspaceId);
    provider = 'webflow';
    for (const record of records) {
      const data = record.data ?? {};
      await createWebflowItem(workspaceId, site.collectionId, {
        name: record.name,
        slug: record.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
        'product-description': record.description ?? '',
        color: typeof data.color === 'string' ? data.color : '',
        material: typeof data.material === 'string' ? data.material : '',
        'lulu-product-id': record.id,
      }, false);
      synced += 1;
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : 'Commerce sync failed';
  }
  return { provider, synced, error };
}

export async function generateProductImagesFromText(text: string, workspaceId: string, userId: string) {
  const products = (await extractProductsFromText(text, workspaceId, userId)).slice(0, MAX_PRODUCTS);
  if (products.length === 0) throw new AppError(400, 'NO_PRODUCTS_FOUND', 'No products could be identified in the document');

  const generated: Array<{ product: ExtractedProduct; image: StoredImage; model: string }> = [];
  for (const product of products) {
    const { b64Json } = await generateImage({ prompt: buildImagePrompt(product), workspaceId, userId });
    const image = await storeProductImage(workspaceId, b64Json);
    generated.push({ product, image, model: env.IMAGE_MODEL });
  }

  const records: Array<recordRepo.WorkspaceRecord> = [];
  for (const { product, image } of generated) {
    const record = await recordRepo.createRecord(workspaceId, 'ecommerce_products', userId, {
      name: product.name,
      description: product.description || null,
      status: 'Active',
      source: 'ai_generated',
      data: {
        color: product.color || null,
        material: product.material || null,
        category: product.category || null,
        imageModel: image.mimeType === 'image/png' ? env.IMAGE_MODEL : null,
        images: [image],
        syncStatus: 'pending',
      },
    });
    records.push(record);
  }

  const sync = await syncProductsToCommerce(workspaceId, records);
  for (const record of records) {
    try {
      await recordRepo.updateRecord(workspaceId, 'ecommerce_products', record.id, userId, {
        data: {
          ...(record.data ?? {}),
          syncProvider: sync.provider,
          syncStatus: sync.provider ? (sync.error ? 'failed' : 'synced') : 'not_connected',
          syncError: sync.error,
        },
        expectedVersion: record.version,
      });
    } catch (error) {
      logger.warn({ error, workspaceId, recordId: record.id }, 'Could not persist commerce sync status on product record');
    }
  }

  return {
    count: records.length,
    records,
    sync,
    products: generated.map(({ product, image }) => ({
      ...product,
      image,
    })),
  };
}

export async function getProductImage(workspaceId: string, imageId: string) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(imageId)) throw new AppError(400, 'INVALID_IMAGE_ID', 'Invalid image id');
  return getObject(productImageKey(workspaceId, imageId));
}
