import { z } from 'zod';

export const adSpendWorkspaceParamsSchema = z.object({ workspaceId: z.string().uuid() });
export const adSpendTopupParamsSchema = z.object({ workspaceId: z.string().uuid(), topupId: z.string().uuid() });
export const adBudgetAuthorizationParamsSchema = z.object({ workspaceId: z.string().uuid(), authorizationId: z.string().uuid() });

export const createAdSpendTopupSchema = z.object({
  amount: z.coerce.number().refine((value) => [1, 10_000, 25_000, 50_000, 90_000].includes(value), 'Choose an available advertising package.'),
  currency: z.literal('CNY').default('CNY'),
  paymentMethod: z.enum(['card', 'alipaycn', 'wechatpay']),
  returnUrl: z.string().url().max(2000),
});

export const createAdBudgetAuthorizationSchema = z.object({
  provider: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,79}$/),
  accountId: z.string().trim().min(1).max(200),
  campaignId: z.string().trim().min(1).max(200),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  amount: z.coerce.number().positive().max(1_000_000_000),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(8).max(240),
  reason: z.string().trim().max(2000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const revokeAdBudgetAuthorizationSchema = z.object({
  reason: z.string().trim().max(2000).nullable().optional(),
}).strict();
