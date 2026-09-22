import { z } from 'zod';

export const siteIdParams = z.object({ workspaceId: z.string().uuid(), siteId: z.string().uuid() });
export const jobParams = siteIdParams.extend({ jobId: z.string().uuid() });
export const domainParams = siteIdParams.extend({ domainId: z.string().uuid() });
export const createSiteSchema = z.object({
  provider: z.literal('managed'),
  ownershipMode: z.literal('managed'),
  name: z.string().trim().min(1).max(200),
});
export const createDomainSchema = z.object({ hostname: z.string().trim().toLowerCase().regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/) });
export const createJobSchema = z.object({
  prompt: z.string().trim().min(10).max(20000),
  template: z.enum(['auto', 'standard', 'one-product']).default('auto'),
});
export const managedWebsiteAssetSchema = z.object({
  altText: z.string().trim().max(500).default(''),
  placement: z.enum(['website', 'hero', 'product', 'logo', 'gallery']).default('website'),
  crop: z.record(z.string(), z.unknown()).default({}),
});
// Kept only so old queued jobs can be read safely. The public automatic
// generation endpoint was removed; managed sites use generation-jobs.
export const automaticGenerationSchema = z.object({
  provider: z.literal('managed'),
  targetMode: z.enum(['existing', 'new']),
  siteId: z.string().uuid().optional(),
  language: z.string().trim().min(2).max(16).optional(),
});
