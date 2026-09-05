import { z } from 'zod';
import { isResourceType } from '../../domain/resource-catalog.js';

const workspaceId = z.string().uuid();
const resourceType = z.string().refine(isResourceType, 'Unsupported resource type');
const jsonObject = z.record(z.string(), z.unknown());

export const workspaceAppParamsSchema = z.object({
  workspaceId,
  memberId: z.string().uuid().optional(),
  viewId: z.string().uuid().optional(),
  platformId: z.string().uuid().optional(),
  reviewId: z.string().trim().min(1).max(200).optional(),
});

export const inviteTokenParamsSchema = z.object({ token: z.string().min(32).max(500) });

export const inviteMemberSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
});

export const updateMemberSchema = z.object({
  role: z.enum(['admin', 'member', 'viewer']),
});

export const listSavedViewsQuerySchema = z.object({
  resourceType: resourceType.optional(),
});

export const createSavedViewSchema = z.object({
  resourceType,
  name: z.string().trim().min(1).max(200),
  filters: jsonObject.default({}),
  sorting: jsonObject.default({}),
  isDefault: z.boolean().default(false),
  isShared: z.boolean().default(false),
});

export const updateSavedViewSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    filters: jsonObject.optional(),
    sorting: jsonObject.optional(),
    isDefault: z.boolean().optional(),
    isShared: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');

export const listAuditQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().trim().min(1).max(200).optional(),
  entityType: z.string().trim().min(1).max(200).optional(),
  entityId: z.string().trim().min(1).max(500).optional(),
});

export const listUsageQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const salesSettingsSchema = z.object({
  moduleName: z.string().trim().max(120).optional(),
  defaultCurrency: z.string().trim().toUpperCase().refine(
    (value) => value === '' || /^[A-Z]{3}$/.test(value),
    'Currency must be a 3-letter ISO code',
  ).optional(),
  defaultTimeZone: z.string().trim().max(100).optional(),
  defaultLanguage: z.string().trim().max(35).optional(),
  defaultDateFormat: z.string().trim().max(40).optional(),
  defaultNumberFormat: z.string().trim().max(40).optional(),
  salesModuleEnabled: z.boolean().optional(),
  aiSalesAssistanceEnabled: z.boolean().optional(),
  salesNotificationsEnabled: z.boolean().optional(),
  salesActivityTrackingEnabled: z.boolean().optional(),
}).strict();

export const updateWorkspaceSettingsSchema = z.object({
  sales: salesSettingsSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one settings group must be provided');

export const listGoogleReviewsQuerySchema = z.object({
  locationId: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(250).default(120),
});

export const updateGoogleReviewReplySchema = z.object({
  accountId: z.string().trim().min(1).max(200),
  locationId: z.string().trim().min(1).max(200),
  comment: z.string().trim().min(3).max(4_000),
});

export const googleBusinessConnectSchema = z.object({
  returnTo: z.string().trim().min(1).max(500).optional(),
});

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
export type ListSavedViewsQuery = z.infer<typeof listSavedViewsQuerySchema>;
export type CreateSavedViewInput = z.infer<typeof createSavedViewSchema>;
export type UpdateSavedViewInput = z.infer<typeof updateSavedViewSchema>;
export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;
export type ListUsageQuery = z.infer<typeof listUsageQuerySchema>;
export type UpdateWorkspaceSettingsInput = z.infer<typeof updateWorkspaceSettingsSchema>;
export type ListGoogleReviewsQuery = z.infer<typeof listGoogleReviewsQuerySchema>;
export type UpdateGoogleReviewReplyInput = z.infer<typeof updateGoogleReviewReplySchema>;
export type GoogleBusinessConnectInput = z.infer<typeof googleBusinessConnectSchema>;
