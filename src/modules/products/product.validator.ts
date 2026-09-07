import { z } from 'zod';

const uuid = z.string().uuid();
const decimal = z.union([z.string(), z.number()]).transform((value) => String(value));
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();

export const productParamsSchema = z.object({ workspaceId: uuid, productId: uuid.optional(), childId: uuid.optional() });

export const productStatus = z.enum(['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED']);
export const productType = z.enum(['PHYSICAL_PRODUCT', 'CUSTOM_MANUFACTURING', 'OEM', 'ODM', 'SERVICE', 'COMPONENT', 'MATERIAL', 'MACHINE', 'OTHER']);
export const pricingType = z.enum(['FIXED', 'STARTING_FROM', 'RANGE', 'QUOTE_REQUIRED', 'TIERED']);

const productFields = {
  factoryId: uuid.nullable().optional(), brandId: uuid.nullable().optional(), categoryId: uuid.nullable().optional(),
  status: productStatus.optional(), productType: productType.optional(), sku: nullableText(120), internalCode: nullableText(120),
  name: z.string().trim().min(1).max(300), shortDescription: nullableText(2000), longDescription: nullableText(20_000),
  defaultCurrency: z.string().trim().length(3).transform((v) => v.toUpperCase()).nullable().optional(),
  defaultPrice: decimal.nullable().optional(), pricingType: pricingType.optional(), moqQuantity: decimal.nullable().optional(), moqUnit: nullableText(50),
  leadTimeMinDays: z.coerce.number().int().min(0).nullable().optional(), leadTimeMaxDays: z.coerce.number().int().min(0).nullable().optional(),
  productionCapacityValue: decimal.nullable().optional(), productionCapacityUnit: nullableText(50), productionCapacityPeriod: nullableText(50),
  countryOfOrigin: nullableText(100), hsCode: nullableText(30), visibility: z.enum(['PRIVATE', 'WORKSPACE', 'PUBLIC']).optional(),
  sourceLanguage: z.string().trim().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/).optional(),
};

const productObjectSchema = z.object(productFields);
export const createProductSchema = productObjectSchema.superRefine((value, ctx) => {
  if (!value.name) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['name'], message: 'Name is required' });
  if (value.leadTimeMinDays != null && value.leadTimeMaxDays != null && value.leadTimeMaxDays < value.leadTimeMinDays) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['leadTimeMaxDays'], message: 'Maximum lead time must be greater than minimum' });
  }
});
export const updateProductSchema = productObjectSchema.partial().extend({ expectedVersion: z.coerce.number().int().positive().optional() }).refine((value) => Object.keys(value).some((key) => key !== 'expectedVersion'), 'At least one field must be provided');

export const listProductsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(), status: productStatus.optional(), productType: productType.optional(), categoryId: uuid.optional(),
  sort: z.enum(['name', 'createdAt', 'updatedAt', 'status']).default('updatedAt'), order: z.enum(['asc', 'desc']).default('desc'),
});

const childBase = { variantId: uuid.nullable().optional() };
export const variantSchema = z.object({
  name: z.string().trim().min(1).max(200), sku: nullableText(120), status: productStatus.optional(), barcode: nullableText(100),
  weight: decimal.nullable().optional(), weightUnit: nullableText(20), dimensionLength: decimal.nullable().optional(), dimensionWidth: decimal.nullable().optional(), dimensionHeight: decimal.nullable().optional(), dimensionUnit: nullableText(20),
  defaultPrice: decimal.nullable().optional(), defaultCurrency: z.string().trim().length(3).transform((v) => v.toUpperCase()).nullable().optional(), moqQuantity: decimal.nullable().optional(), moqUnit: nullableText(50), leadTimeMinDays: z.coerce.number().int().min(0).nullable().optional(), leadTimeMaxDays: z.coerce.number().int().min(0).nullable().optional(), metadata: z.record(z.string(), z.unknown()).optional(),
});
export const specificationSchema = z.object({ ...childBase, name: z.string().trim().min(1).max(200), value: z.string().trim().min(1).max(2000), unit: nullableText(50), groupName: nullableText(100), sortOrder: z.coerce.number().int().default(0), marketVisibility: z.enum(['ALL', 'PUBLIC', 'PRIVATE']).default('ALL'), key: nullableText(100) });
export const mediaSchema = z.object({ ...childBase, mediaType: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT', 'CAD_FILE', 'DATASHEET', 'BROCHURE', 'OTHER']), storageReference: z.string().trim().min(1).max(2000), externalUrl: nullableText(4000), title: nullableText(300), altText: nullableText(1000), sortOrder: z.coerce.number().int().default(0), isPrimary: z.boolean().default(false), language: nullableText(20) });
export const certificateSchema = z.object({ ...childBase, certificateType: z.string().trim().min(1).max(100), certificateNumber: nullableText(200), issuer: nullableText(300), issuedAt: z.string().date().nullable().optional(), expiresAt: z.string().date().nullable().optional(), documentMediaId: uuid.nullable().optional(), status: z.enum(['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED']).default('UNVERIFIED'), notes: nullableText(2000) });
export const marketSchema = z.object({ marketCode: z.string().trim().min(2).max(20).transform((v) => v.toUpperCase()), marketName: nullableText(200), localizedDescription: nullableText(4000), marketPrice: decimal.nullable().optional(), status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED']).default('ACTIVE'), language: nullableText(20), currency: z.string().trim().length(3).transform((v) => v.toUpperCase()).nullable().optional(), moqQuantity: decimal.nullable().optional(), moqUnit: nullableText(50), leadTimeDays: z.coerce.number().int().min(0).nullable().optional(), notes: nullableText(2000), availability: nullableText(100), salesPriority: z.coerce.number().int().default(0) });
export const translationSchema = z.object({ language: z.string().trim().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/), name: z.string().trim().min(1).max(300), shortDescription: nullableText(2000), longDescription: nullableText(20_000), status: z.enum(['DRAFT', 'GENERATED', 'VERIFIED', 'ACTIVE', 'OUTDATED']).default('DRAFT'), seoTitle: nullableText(300), seoDescription: nullableText(1000), source: z.enum(['MANUAL', 'AI_GENERATED', 'IMPORTED']).default('MANUAL') });
export const applicationSchema = z.object({ application: z.string().trim().min(1).max(300), industries: z.array(z.string().trim().max(100)).max(50).default([]), notes: nullableText(2000), sortOrder: z.coerce.number().int().default(0) });
export const packagingSchema = z.object({ packageType: z.string().trim().min(1).max(100), quantity: decimal.nullable().optional(), unit: nullableText(30), length: decimal.nullable().optional(), width: decimal.nullable().optional(), height: decimal.nullable().optional(), dimensionUnit: nullableText(20), grossWeight: decimal.nullable().optional(), netWeight: decimal.nullable().optional(), weightUnit: nullableText(20), piecesPerCarton: z.coerce.number().int().min(1).nullable().optional(), notes: nullableText(2000) });
export const capacitySchema = z.object({ variantId: uuid.nullable().optional(), value: decimal, unit: z.string().trim().min(1).max(50), period: z.string().trim().min(1).max(50), minimum: decimal.nullable().optional(), maximum: decimal.nullable().optional(), notes: nullableText(2000) });
export const priceSchema = z.object({ variantId: uuid.nullable().optional(), marketCode: nullableText(20), currency: z.string().trim().length(3).transform((v) => v.toUpperCase()), priceType: pricingType.default('FIXED'), minQuantity: decimal.nullable().optional(), maxQuantity: decimal.nullable().optional(), unitPrice: decimal.nullable().optional(), validFrom: z.string().datetime({ offset: true }).nullable().optional(), validUntil: z.string().datetime({ offset: true }).nullable().optional(), status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE', 'EXPIRED']).default('ACTIVE') });
export const seoSchema = z.object({ language: z.string().trim().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/), slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]*$/).max(300), title: nullableText(300), description: nullableText(1000), keywords: z.array(z.string().trim().max(100)).max(100).default([]), canonicalUrl: nullableText(4000), faqCandidates: z.array(z.unknown()).max(100).default([]), buyerQuestions: z.array(z.string().trim().max(500)).max(100).default([]), applications: z.array(z.string().trim().max(200)).max(100).default([]), searchIntent: nullableText(100), source: z.enum(['MANUAL', 'AI_GENERATED', 'IMPORTED']).default('MANUAL'), status: z.enum(['DRAFT', 'ACTIVE', 'OUTDATED']).default('DRAFT') });
export const relationshipSchema = z.object({ relatedProductId: uuid, relationshipType: z.enum(['ACCESSORY', 'REPLACEMENT', 'COMPATIBLE_WITH', 'UPSELL', 'CROSS_SELL', 'COMPONENT_OF', 'ALTERNATIVE']), notes: nullableText(2000) });

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
export type VariantInput = z.infer<typeof variantSchema>;
export type SpecificationInput = z.infer<typeof specificationSchema>;
export type MediaInput = z.infer<typeof mediaSchema>;
export type CertificateInput = z.infer<typeof certificateSchema>;
export type MarketInput = z.infer<typeof marketSchema>;
export type TranslationInput = z.infer<typeof translationSchema>;
export type ApplicationInput = z.infer<typeof applicationSchema>;
export type PackagingInput = z.infer<typeof packagingSchema>;
export type CapacityInput = z.infer<typeof capacitySchema>;
export type PriceInput = z.infer<typeof priceSchema>;
export type SeoInput = z.infer<typeof seoSchema>;
export type RelationshipInput = z.infer<typeof relationshipSchema>;
