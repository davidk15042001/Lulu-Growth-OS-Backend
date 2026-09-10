import { z } from 'zod';

const booleanInput = z.preprocess((value) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}, z.boolean());

const urlList = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [value];
  } catch {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
}, z.array(z.string().url().refine((value) => value.startsWith('https://'), 'Reference URLs must use HTTPS')).max(4));

export const premiumMediaParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  productId: z.string().uuid(),
  jobId: z.string().uuid().optional(),
});

export const createPremiumMediaSchema = z.object({
  creativeDirection: z.string().trim().max(4_000).optional(),
  aspectRatio: z.enum(['1:1', '16:9', '9:16']).default('1:1'),
  deliverImage: booleanInput.default(true),
  deliverVideo: booleanInput.default(true),
  referenceImageUrls: urlList.default([]),
}).refine((value) => value.deliverImage || value.deliverVideo, {
  message: 'At least one premium deliverable is required',
});

export type CreatePremiumMediaInput = z.infer<typeof createPremiumMediaSchema>;
