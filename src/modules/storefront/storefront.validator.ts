import { z } from 'zod';

export const storefrontSlugSchema = z.object({ slug: z.string().trim().min(1).max(160).regex(/^[a-z0-9][a-z0-9-]*$/i) });
export const storefrontWorkspaceParamsSchema = z.object({ workspaceId: z.string().uuid() });
export const createCartSchema = z.object({ currency: z.string().trim().length(3).default('CNY').transform((value) => value.toUpperCase()) });
export const cartTokenSchema = z.string().trim().min(24).max(200);
export const cartItemSchema = z.object({
  token: cartTokenSchema,
  productId: z.string().uuid(),
  variantId: z.string().uuid().nullable().optional(),
  quantity: z.union([z.string(), z.number()]).transform(String).refine((value) => Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 10_000, 'Quantity must be positive and within the supported range'),
});
export const checkoutSchema = z.object({
  token: cartTokenSchema,
  email: z.string().trim().email().max(320),
  shippingAddress: z.record(z.string(), z.unknown()).default({}),
});

export type CreateCartInput = z.infer<typeof createCartSchema>;
export type CartItemInput = z.infer<typeof cartItemSchema>;
export type CheckoutInput = z.infer<typeof checkoutSchema>;
