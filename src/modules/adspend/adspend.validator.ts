import { z } from 'zod';

export const adSpendWorkspaceParamsSchema = z.object({ workspaceId: z.string().uuid() });
export const adSpendTopupParamsSchema = z.object({ workspaceId: z.string().uuid(), topupId: z.string().uuid() });

export const createAdSpendTopupSchema = z.object({
  amount: z.coerce.number().refine((value) => [10_000, 25_000, 50_000, 90_000].includes(value), 'Choose an available advertising package.'),
  currency: z.literal('CNY').default('CNY'),
  paymentMethod: z.enum(['card', 'alipaycn', 'wechatpay']),
  returnUrl: z.string().url().max(2000),
});
