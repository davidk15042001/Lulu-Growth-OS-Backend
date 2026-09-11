import { z } from 'zod';

export const API_TOPUP_PACKAGES = [1, 1000, 2500, 5000, 9000] as const;
export const apiWalletParamsSchema = z.object({ workspaceId: z.string().uuid() });
export const apiTopupParamsSchema = apiWalletParamsSchema.extend({ topupId: z.string().uuid() });
export const createApiTopupSchema = z.object({
  amount: z.coerce.number().refine(
    (value): value is typeof API_TOPUP_PACKAGES[number] => API_TOPUP_PACKAGES.includes(value as typeof API_TOPUP_PACKAGES[number]),
    'Choose an available AI balance package.',
  ),
  currency: z.literal('CNY').default('CNY'),
  paymentMethod: z.enum(['card', 'alipaycn', 'wechatpay']),
  returnUrl: z.string().url().max(2000),
});
