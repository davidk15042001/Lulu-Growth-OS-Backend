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

export const unifyPortAccountSchema = z.object({
  name: z.string().trim().min(1).max(160),
  provider: z.string().trim().min(1).max(80),
  region: z.string().trim().min(1).max(80),
  status: z.string().trim().min(1).max(40).optional(),
  auth_mode: z.string().trim().min(1).max(40).optional(),
  provider_data: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const unifyPortIdentitySchema = z.object({
  accountId: z.string().trim().min(1).max(160),
  workspaceId: z.string().uuid().nullable().optional(),
  displayName: z.string().trim().min(1).max(160),
  phone: z.string().trim().regex(/^\+?[1-9][0-9]{6,14}$/).nullable().optional(),
  defaultLanguage: z.string().trim().min(2).max(20).nullable().optional(),
}).strict();

export const twilioIdentitySchema = z.object({
  workspaceId: z.string().uuid(),
  channelType: z.enum(['WHATSAPP', 'FACEBOOK_MESSENGER']),
  address: z.string().trim().min(3).max(300),
  displayName: z.string().trim().min(1).max(160),
  defaultLanguage: z.string().trim().min(2).max(20).nullable().optional(),
}).strict();

export const twilioAdminWhatsAppSenderSchema = z.object({
  address: z.string().trim().min(8).max(30),
  displayName: z.string().trim().min(1).max(160),
}).strict();

export const twilioWorkspaceContentTemplateSchema = z.object({
  contentSid: z.string().trim().regex(/^HX[a-fA-F0-9]{32}$/),
}).strict();

export const twilioWorkspaceParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

export type ProviderMappingInput = z.infer<typeof providerMappingSchema>;
