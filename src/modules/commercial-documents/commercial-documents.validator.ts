import { z } from 'zod';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.coerce.number().finite().nonnegative();

export const quoteListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.string().trim().max(40).optional(),
  search: z.string().trim().max(200).optional(),
});

export const invoiceListQuerySchema = quoteListQuerySchema.extend({
  dueBefore: date.optional(),
});

const quoteLineFields = {
  productId: uuid.nullable().optional(),
  variantId: uuid.nullable().optional(),
  sku: z.string().trim().max(200).nullable().optional(),
  productName: z.string().trim().min(1).max(300),
  description: z.string().trim().max(5000).nullable().optional(),
  specifications: z.record(z.string(), z.unknown()).optional(),
  quantity: money.refine((value) => value > 0, 'Quantity must be greater than zero'),
  quantityUnit: z.string().trim().max(40).nullable().optional(),
  unitPrice: money,
  discount: money.optional(),
  tax: money.optional(),
  leadTime: z.string().trim().max(200).nullable().optional(),
  moq: z.string().trim().max(200).nullable().optional(),
  customizationNotes: z.string().trim().max(5000).nullable().optional(),
  priceSource: z.enum(['CATALOG','MARKET_PRICE','CUSTOMER_PRICE','NEGOTIATED','MANUAL','AI_PROPOSED','PROMOTION','CONTRACT']).optional(),
  sourceReference: z.string().trim().max(500).nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
};
const validateLineDiscount = (line: { quantity: number; unitPrice: number; discount?: number | undefined }, ctx: z.RefinementCtx) => {
  if ((line.discount ?? 0) > line.quantity * line.unitPrice) {
    ctx.addIssue({ code: z.ZodIssueCode.too_big, maximum: line.quantity * line.unitPrice, inclusive: true, origin: 'number', path: ['discount'], message: 'Discount cannot exceed the line subtotal' });
  }
};
const quoteLine = z.object(quoteLineFields).superRefine(validateLineDiscount);

const documentReferences = {
  customerRecordId: uuid.nullable().optional(),
  companyRecordId: uuid.nullable().optional(),
  leadRecordId: uuid.nullable().optional(),
  opportunityRecordId: uuid.nullable().optional(),
  factoryId: uuid.nullable().optional(),
  language: z.string().trim().min(2).max(12).optional(),
  marketCode: z.string().trim().max(20).nullable().optional(),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
};

export const createQuoteSchema = z.object({
  ...documentReferences,
  validUntil: date.nullable().optional(),
  shippingTotal: money.optional(),
  terms: z.record(z.string(), z.unknown()).optional(),
  source: z.enum(['workspace','conversation','email','website_chat','api','import']).optional(),
  creationMode: z.enum(['MANUAL','AI_ASSISTED','AUTOMATIC','API','IMPORT']).optional(),
  handlingMode: z.enum(['AUTONOMOUS','LIMITED_AUTONOMOUS','USER_AUTHORIZATION_REQUIRED','PROHIBITED']).optional(),
  conversationId: uuid.nullable().optional(),
  lines: z.array(quoteLine).min(1).max(500),
});

export const quoteRevisionSchema = createQuoteSchema;

export const sendDocumentSchema = z.object({
  conversationId: uuid.nullable().optional(),
  channel: z.enum(['conversation','email','secure_link']).default('secure_link'),
  recipient: z.string().trim().max(320).nullable().optional(),
  operationKey: z.string().trim().min(1).max(200).optional(),
});

const invoiceLine = z.object(quoteLineFields).omit({ variantId: true, leadTime: true, moq: true, customizationNotes: true, priceSource: true, sourceReference: true, specifications: true }).extend({
  productName: z.string().trim().min(1).max(300),
}).superRefine(validateLineDiscount);

export const createInvoiceSchema = z.object({
  ...documentReferences,
  orderRecordId: uuid.nullable().optional(),
  quoteId: uuid.nullable().optional(),
  invoiceType: z.enum(['PROFORMA','COMMERCIAL','STANDARD','DEPOSIT','FINAL']).default('STANDARD'),
  issueDate: date.nullable().optional(),
  dueDate: date.nullable().optional(),
  shippingTotal: money.optional(),
  source: z.enum(['workspace','conversation','email','website_chat','api','import']).optional(),
  creationMode: z.enum(['MANUAL','AI_ASSISTED','AUTOMATIC','API','IMPORT']).optional(),
  conversationId: uuid.nullable().optional(),
  lines: z.array(invoiceLine).min(1).max(500),
});

export const policySchema = z.object({
  automaticQuoteEnabled: z.boolean().optional(),
  automaticQuoteSendEnabled: z.boolean().optional(),
  maxAutomaticQuoteValue: money.nullable().optional(),
  automaticDiscountLimit: z.coerce.number().finite().min(0).max(100).optional(),
  minimumMargin: z.coerce.number().finite().min(0).max(100).nullable().optional(),
  allowedCurrencies: z.array(z.string().length(3).transform((value) => value.toUpperCase())).min(1).max(50).optional(),
  allowedIncoterms: z.array(z.string().trim().max(30)).max(50).optional(),
  defaultQuoteValidityDays: z.coerce.number().int().min(1).max(365).optional(),
  defaultPaymentTerms: z.string().trim().max(1000).nullable().optional(),
  invoiceCreationPolicy: z.record(z.string(), z.unknown()).optional(),
  invoiceAutoSendEnabled: z.boolean().optional(),
  invoiceReminderPolicy: z.record(z.string(), z.unknown()).optional(),
});

export const documentParamsSchema = z.object({ workspaceId: uuid, documentId: uuid });
export const publicDocumentParamsSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/i) });
export const acceptQuoteSchema = z.object({ decision: z.enum(['ACCEPTED','DECLINED']), comment: z.string().trim().max(5000).nullable().optional() });

export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type SendDocumentInput = z.infer<typeof sendDocumentSchema>;
export type PolicyInput = z.infer<typeof policySchema>;
