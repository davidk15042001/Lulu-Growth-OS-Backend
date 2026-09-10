import { AppError } from '../../utils/app-error.js';
import { env } from '../../config/env.js';
import { configuredModel, getOpenAIResponsesClient } from '../ai/openai.service.js';
import { extractTextFromFile, type IngestFile } from '../records/record.service.js';
import * as recordRepo from '../records/record.repo.js';
import { getObject, productImageKey } from '../../storage/s3.service.js';
import { createProductSchema } from '../products/product.validator.js';
import { createProduct } from '../products/product.service.js';
import {
  ensurePremiumMediaRuntimeReady,
  premiumMediaConfiguration,
  startPremiumMediaFromProductBrief,
} from '../premium-media/premium-media.service.js';

export type ExtractedProduct = {
  name: string;
  description: string;
  color: string;
  material: string;
  category: string;
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

export async function generateProductImagesFromText(text: string, workspaceId: string, userId: string) {
  const products = (await extractProductsFromText(text, workspaceId, userId)).slice(0, MAX_PRODUCTS);
  if (products.length === 0) throw new AppError(400, 'NO_PRODUCTS_FOUND', 'No products could be identified in the document');
  await ensurePremiumMediaRuntimeReady();
  const models = premiumMediaConfiguration();
  const records: Array<recordRepo.WorkspaceRecord> = [];
  const queued: Array<ExtractedProduct & { canonicalProductId: string; premiumMediaJobId: string; productionStatus: string }> = [];
  for (const product of products) {
    const description = [
      product.description,
      product.color ? `Color: ${product.color}` : '',
      product.material ? `Material: ${product.material}` : '',
      product.category ? `Category: ${product.category}` : '',
    ].filter(Boolean).join('\n');
    const canonical = await createProduct(workspaceId, userId, createProductSchema.parse({
      name: product.name,
      shortDescription: product.description || null,
      longDescription: description || null,
      productType: 'PHYSICAL_PRODUCT',
      status: 'DRAFT',
      sourceLanguage: 'en',
    }));
    const canonicalProductId = String(canonical.id);
    const production = await startPremiumMediaFromProductBrief(workspaceId, canonicalProductId, userId, true);
    const record = await recordRepo.createRecord(workspaceId, 'ecommerce_products', userId, {
      name: product.name,
      description: product.description || null,
      status: 'Processing',
      source: 'premium_media',
      data: {
        color: product.color || null,
        material: product.material || null,
        category: product.category || null,
        canonicalProductId,
        premiumMediaJobId: production.job.id,
        imageModels: models.textImageModels,
        videoModels: models.videoModels,
        mediaProductionStatus: production.job.status,
        syncStatus: 'awaiting_premium_media',
      },
    });
    records.push(record);
    queued.push({ ...product, canonicalProductId, premiumMediaJobId: production.job.id, productionStatus: production.job.status });
  }
  return {
    count: records.length,
    records,
    sync: { provider: null, synced: 0, error: null, status: 'awaiting_premium_media' },
    products: queued,
  };
}

export async function getProductImage(workspaceId: string, imageId: string) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(imageId)) throw new AppError(400, 'INVALID_IMAGE_ID', 'Invalid image id');
  return getObject(productImageKey(workspaceId, imageId));
}
