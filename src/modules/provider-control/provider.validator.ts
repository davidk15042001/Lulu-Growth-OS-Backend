import { z } from 'zod';

export const connectionParamsSchema = z.object({ connectionId: z.string().uuid() });
export const providerParamsSchema = z.object({ provider: z.string().trim().min(1).max(80) });
export const providerSyncSchema = z.object({ syncType: z.string().trim().min(1).max(100).default('full') }).strict();
export const providerModeSchema = z.object({ mode: z.enum(['LULU_MANAGED', 'CUSTOMER_OWNED', 'PARTNER_MANAGED', 'HYBRID']) }).strict();
export const providerAccessSchema = z.object({ workspaceId: z.string().uuid(), grantedCapabilities: z.array(z.string().trim().min(1).max(160)).max(100).default([]) }).strict();
export const providerMappingQuerySchema = z.object({ luluObjectType: z.string().trim().min(1).max(120).optional(), luluObjectId: z.string().uuid().optional() });
export const providerMappingSchema = z.object({
  providerConnectionId: z.string().uuid(),
  providerAccountId: z.string().uuid(),
  providerAssetId: z.string().uuid().nullable().optional(),
  luluObjectType: z.string().trim().min(1).max(120),
  luluObjectId: z.string().uuid(),
  externalObjectType: z.string().trim().min(1).max(120),
  externalObjectId: z.string().trim().min(1).max(500),
  sourceOfTruth: z.enum(['LULU_MASTER', 'PROVIDER_MASTER', 'BIDIRECTIONAL', 'READ_ONLY', 'LULU_TO_PROVIDER']).default('LULU_MASTER'),
}).strict();

export type ProviderMappingInput = z.infer<typeof providerMappingSchema>;
