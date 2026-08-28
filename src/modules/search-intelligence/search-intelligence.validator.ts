import { z } from 'zod';

export const searchChannelSchema = z.enum(['seo', 'geo', 'aeo']);

export const channelParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  channel: searchChannelSchema,
});

export const analyzeSearchSchema = z.object({
  locationCode: z.coerce.number().int().positive().default(2840),
  languageCode: z.string().trim().min(2).max(10).default('en'),
  depth: z.coerce.number().int().min(10).max(100).default(20),
  maxKeywords: z.coerce.number().int().min(1).max(15).default(5),
  device: z.enum(['desktop', 'mobile']).default('desktop'),
  autoApply: z.coerce.boolean().default(true),
});

export const applySearchSchema = z.object({
  targetSiteIds: z.array(z.string().uuid()).max(20).optional(),
  publish: z.coerce.boolean().default(true),
});

export type SearchChannel = z.infer<typeof searchChannelSchema>;
export type AnalyzeSearchInput = z.infer<typeof analyzeSearchSchema>;
export type ApplySearchInput = z.infer<typeof applySearchSchema>;
