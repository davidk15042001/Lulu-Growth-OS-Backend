import { z } from 'zod';

const jsonObject = z.record(z.string(), z.unknown());

export const approvalParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  approvalId: z.string().uuid().optional(),
});

export const listApprovalsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'expired']).optional(),
  mine: z.enum(['true', 'false']).transform((value) => value === 'true').default(false),
});

export const createApprovalSchema = z.object({
  actionType: z.string().trim().min(1).max(200),
  entityType: z.string().trim().max(200).nullable().optional(),
  entityId: z.string().trim().max(500).nullable().optional(),
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(10_000).nullable().optional(),
  impactAmount: z.coerce.number().finite().nullable().optional(),
  impactCurrency: z.string().trim().length(3).transform((value) => value.toUpperCase()).nullable().optional(),
  payload: jsonObject.optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export const decideApprovalSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'cancelled']),
  note: z.string().trim().max(5_000).nullable().optional(),
});

export type ListApprovalsQuery = z.infer<typeof listApprovalsQuerySchema>;
export type CreateApprovalInput = z.infer<typeof createApprovalSchema>;
export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;
