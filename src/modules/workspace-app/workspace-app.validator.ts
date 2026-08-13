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

export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
export type ListSavedViewsQuery = z.infer<typeof listSavedViewsQuerySchema>;
export type CreateSavedViewInput = z.infer<typeof createSavedViewSchema>;
export type UpdateSavedViewInput = z.infer<typeof updateSavedViewSchema>;
export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;
export type ListUsageQuery = z.infer<typeof listUsageQuerySchema>;
