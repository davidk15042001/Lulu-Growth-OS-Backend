import { z } from 'zod';

const uuid = z.string().uuid();
const currency = z.string().trim().length(3).transform((value) => value.toUpperCase());
const idempotencyKey = z.string().trim().min(1).max(200);
const money = z.union([
  z.string().trim().regex(/^\d+(?:\.\d{1,4})?$/),
  z.number().finite().refine((value) => Number.isSafeInteger(Math.trunc(value)) && Math.abs(value) < 10 ** 16, 'Large amounts must be sent as strings'),
]).transform((value) => typeof value === 'number' ? value.toFixed(4).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') : value);

export const payoutAccountParamsSchema = z.object({ workspaceId: uuid });
export const payoutParamsSchema = z.object({ workspaceId: uuid, payoutId: uuid });
export const payoutListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });
export const createPayoutAccountSchema = z.object({
  providerBeneficiaryId: z.string().trim().min(1).max(160),
  label: z.string().trim().min(1).max(160),
  currency,
});
export const requestPayoutSchema = z.object({
  payoutAccountId: uuid,
  amount: money,
  currency,
  reference: z.string().trim().min(1).max(140),
  idempotencyKey,
});

export type CreatePayoutAccountInput = z.infer<typeof createPayoutAccountSchema>;
export type RequestPayoutInput = z.infer<typeof requestPayoutSchema>;
