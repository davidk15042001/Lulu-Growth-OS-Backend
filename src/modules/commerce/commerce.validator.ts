import { z } from 'zod';
import { FULFILLMENT_STATUSES, ORDER_STATUSES } from './commerce.types.js';

const uuid = z.string().uuid();
const idempotencyKey = z.string().trim().min(1).max(200);
const metadata = z.record(z.string(), z.unknown()).default({});
const optionalMetadata = z.record(z.string(), z.unknown()).optional();
const address = z.record(z.string(), z.unknown()).default({});
const optionalAddress = z.record(z.string(), z.unknown()).optional();

function decimal(options: { positive?: boolean; nonNegative?: boolean; nonZero?: boolean } = {}) {
  return z.union([
    z.string().trim().regex(/^-?\d+(?:\.\d{1,4})?$/),
    z.number().finite(),
  ]).transform((value, ctx) => {
    if (typeof value === 'number' && (!Number.isSafeInteger(Math.trunc(value)) || Math.abs(value) >= 10 ** 16)) {
      ctx.addIssue({ code: 'custom', message: 'Decimal number is outside the supported range; send large values as strings' });
      return z.NEVER;
    }
    const normalized = typeof value === 'number'
      ? value.toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
      : value;
    const numeric = Number(normalized);
    if (!/^-?\d+(?:\.\d{1,4})?$/.test(normalized)
      || !Number.isFinite(numeric)
      || (options.positive && numeric <= 0)
      || (options.nonNegative && numeric < 0)
      || (options.nonZero && numeric === 0)) {
      ctx.addIssue({ code: 'custom', message: 'Invalid decimal value' });
      return z.NEVER;
    }
    return normalized;
  });
}

const money = decimal({ nonNegative: true });
const quantity = decimal({ positive: true });

export const commerceWorkspaceParamsSchema = z.object({ workspaceId: uuid });
export const orderParamsSchema = z.object({ workspaceId: uuid, orderId: uuid });
export const locationParamsSchema = z.object({ workspaceId: uuid, locationId: uuid });
export const levelParamsSchema = z.object({ workspaceId: uuid, levelId: uuid });
export const fulfillmentParamsSchema = z.object({ workspaceId: uuid, orderId: uuid, fulfillmentId: uuid });

const orderLineSchema = z.object({
  productId: uuid,
  variantId: uuid.nullable().optional(),
  inventoryLocationId: uuid.nullable().optional(),
  quantity,
  quantityUnit: z.string().trim().min(1).max(80).nullable().optional(),
  unitPrice: money.optional(),
  discount: money.default('0'),
  tax: money.default('0'),
  metadata,
}).superRefine((line, ctx) => {
  if (line.unitPrice !== undefined && Number(line.discount) > Number(line.quantity) * Number(line.unitPrice)) {
    ctx.addIssue({ code: 'custom', path: ['discount'], message: 'Discount cannot exceed the line subtotal' });
  }
});

const orderFields = {
  customerRecordId: uuid.nullable().optional(),
  companyRecordId: uuid.nullable().optional(),
  quoteId: uuid.nullable().optional(),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  shippingTotal: money.default('0'),
  source: z.enum(['workspace', 'conversation', 'email', 'website_chat', 'api', 'import', 'provider']).default('workspace'),
  sourceProvider: z.string().trim().min(1).max(120).nullable().optional(),
  externalReference: z.string().trim().min(1).max(300).nullable().optional(),
  notes: z.string().trim().max(20_000).nullable().optional(),
  shippingAddress: address,
  billingAddress: address,
  metadata,
  lines: z.array(orderLineSchema).min(1).max(500),
};

export const createOrderSchema = z.object({
  idempotencyKey,
  ...orderFields,
}).superRefine((value, ctx) => {
  if (value.source === 'provider' && !value.sourceProvider) {
    ctx.addIssue({ code: 'custom', path: ['sourceProvider'], message: 'Provider source requires sourceProvider' });
  }
  if (value.externalReference && !value.sourceProvider) {
    ctx.addIssue({ code: 'custom', path: ['externalReference'], message: 'External reference requires sourceProvider' });
  }
});

export const updateOrderSchema = z.object({
  idempotencyKey,
  expectedVersion: z.coerce.number().int().positive(),
  customerRecordId: orderFields.customerRecordId,
  companyRecordId: orderFields.companyRecordId,
  quoteId: orderFields.quoteId,
  currency: orderFields.currency.optional(),
  shippingTotal: money.optional(),
  notes: orderFields.notes,
  shippingAddress: optionalAddress,
  billingAddress: optionalAddress,
  metadata: optionalMetadata,
  lines: z.array(orderLineSchema).min(1).max(500).optional(),
}).refine((value) => Object.keys(value).some((key) => !['idempotencyKey', 'expectedVersion'].includes(key)), {
  message: 'At least one order field must be provided',
});

export const transitionOrderSchema = z.object({
  idempotencyKey,
  expectedVersion: z.coerce.number().int().positive(),
  targetStatus: z.enum(['PLACED', 'CONFIRMED', 'PROCESSING', 'CANCELLED']),
  reason: z.string().trim().min(1).max(2000).optional(),
});

export const listOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(ORDER_STATUSES).optional(),
  customerRecordId: uuid.optional(),
  search: z.string().trim().max(200).optional(),
  sort: z.enum(['createdAt', 'updatedAt', 'orderNumber', 'grandTotal']).default('updatedAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const createInventoryLocationSchema = z.object({
  idempotencyKey,
  code: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  isDefault: z.boolean().default(false),
  address,
  metadata,
});

export const updateInventoryLocationSchema = z.object({
  idempotencyKey,
  expectedVersion: z.coerce.number().int().positive(),
  code: z.string().trim().min(1).max(80).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
  isDefault: z.boolean().optional(),
  address: optionalAddress,
  metadata: optionalMetadata,
}).superRefine((value, ctx) => {
  if (!Object.keys(value).some((key) => !['idempotencyKey', 'expectedVersion'].includes(key))) {
    ctx.addIssue({ code: 'custom', message: 'At least one inventory location field must be provided' });
  }
  if (value.isDefault && value.status && value.status !== 'ACTIVE') {
    ctx.addIssue({ code: 'custom', path: ['isDefault'], message: 'Only an active location can be the default' });
  }
});

export const listInventoryLocationsQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'INACTIVE', 'ARCHIVED']).optional(),
});

export const listInventoryLevelsQuerySchema = z.object({
  locationId: uuid.optional(),
  productId: uuid.optional(),
  variantId: uuid.optional(),
  belowReorderPoint: z.stringbool().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const adjustInventorySchema = z.object({
  idempotencyKey,
  locationId: uuid,
  productId: uuid,
  variantId: uuid.nullable().optional(),
  delta: decimal({ nonZero: true }),
  expectedVersion: z.coerce.number().int().min(0),
  reason: z.string().trim().min(1).max(2000),
  reorderPoint: money.optional(),
  metadata,
});

export const listInventoryMovementsQuerySchema = z.object({
  levelId: uuid.optional(),
  orderId: uuid.optional(),
  movementType: z.enum(['INITIAL', 'ADJUSTMENT', 'RESERVATION', 'RELEASE', 'FULFILLMENT', 'RETURN']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const createFulfillmentSchema = z.object({
  idempotencyKey,
  expectedOrderVersion: z.coerce.number().int().positive(),
  carrier: z.string().trim().max(200).nullable().optional(),
  trackingNumber: z.string().trim().max(300).nullable().optional(),
  trackingUrl: z.string().url().max(4000).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  metadata,
  lines: z.array(z.object({
    orderLineId: uuid,
    quantity,
  })).min(1).max(500),
}).superRefine((value, ctx) => {
  const ids = value.lines.map((line) => line.orderLineId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', path: ['lines'], message: 'Each order line may appear only once' });
  }
});

export const transitionFulfillmentSchema = z.object({
  idempotencyKey,
  expectedVersion: z.coerce.number().int().positive(),
  expectedOrderVersion: z.coerce.number().int().positive(),
  targetStatus: z.enum(FULFILLMENT_STATUSES).exclude(['DRAFT']),
  carrier: z.string().trim().max(200).nullable().optional(),
  trackingNumber: z.string().trim().max(300).nullable().optional(),
  trackingUrl: z.string().url().max(4000).nullable().optional(),
  reason: z.string().trim().min(1).max(2000).optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;
export type TransitionOrderInput = z.infer<typeof transitionOrderSchema>;
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
export type CreateInventoryLocationInput = z.infer<typeof createInventoryLocationSchema>;
export type UpdateInventoryLocationInput = z.infer<typeof updateInventoryLocationSchema>;
export type ListInventoryLevelsQuery = z.infer<typeof listInventoryLevelsQuerySchema>;
export type AdjustInventoryInput = z.infer<typeof adjustInventorySchema>;
export type ListInventoryMovementsQuery = z.infer<typeof listInventoryMovementsQuerySchema>;
export type CreateFulfillmentInput = z.infer<typeof createFulfillmentSchema>;
export type TransitionFulfillmentInput = z.infer<typeof transitionFulfillmentSchema>;
