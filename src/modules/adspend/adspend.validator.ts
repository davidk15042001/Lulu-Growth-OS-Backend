import { z } from 'zod';

export const adSpendWorkspaceParamsSchema = z.object({ workspaceId: z.string().uuid() });
export const adSpendTopupParamsSchema = z.object({ workspaceId: z.string().uuid(), topupId: z.string().uuid() });

export const createAdSpendTopupSchema = z.object({
  amount: z.coerce.number().finite().min(1).max(100_000_000),
  currency: z.literal('CNY').default('CNY'),
  paymentMethod: z.enum(['card', 'alipaycn', 'wechatpay']),
  returnUrl: z.string().url().max(2000),
});
