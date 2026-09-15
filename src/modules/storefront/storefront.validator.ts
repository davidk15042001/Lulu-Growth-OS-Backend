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

const optionalUrl = z.preprocess((value) => value === '' ? undefined : value, z.string().trim().url().max(2_000).optional());
const optionalText = (max: number) => z.preprocess((value) => value === '' ? undefined : value, z.string().trim().max(max).optional());

export const storefrontAttachmentSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120),
  sizeBytes: z.number().int().min(1).max(5 * 1024 * 1024),
  dataBase64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(7_000_000),
});

export const storefrontRequestDetailsSchema = z.object({
  note: optionalText(4_000),
  websiteUrl: optionalUrl,
  whatsappNumber: optionalText(40).refine((value) => !value || /^[+0-9()\s-]+$/.test(value), 'WhatsApp number is invalid'),
  attachment: storefrontAttachmentSchema.optional(),
}).passthrough();

export const checkoutSchema = z.object({
  token: cartTokenSchema,
  email: z.string().trim().email().max(320),
  shippingAddress: storefrontRequestDetailsSchema.default({}),
});

export const contactRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  requestDetails: storefrontRequestDetailsSchema.default({}),
});

export type CreateCartInput = z.infer<typeof createCartSchema>;
export type CartItemInput = z.infer<typeof cartItemSchema>;
export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type StorefrontRequestDetails = z.infer<typeof storefrontRequestDetailsSchema>;
