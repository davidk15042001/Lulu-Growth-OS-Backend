import { z } from 'zod';

const uuid=z.string().uuid();
const isoTimestamp=z.string().datetime({offset:true});
const currency=z.string().trim().length(3).transform((value)=>value.toUpperCase());
const accountCode=z.string().trim().min(2).max(80).regex(/^[A-Za-z][A-Za-z0-9_.-]+$/).transform((value)=>value.toUpperCase());

export const workspaceFinanceParamsSchema=z.object({workspaceId:uuid});
export const journalParamsSchema=workspaceFinanceParamsSchema.extend({journalId:uuid});
export const accountBalanceParamsSchema=workspaceFinanceParamsSchema.extend({accountCode});
export const journalListQuerySchema=z.object({
  page:z.coerce.number().int().min(1).default(1),
  limit:z.coerce.number().int().min(1).max(100).default(25),
  currency:currency.optional(),
  accountCode:accountCode.optional(),
  referenceType:z.string().trim().min(1).max(100).optional(),
  referenceId:z.string().trim().min(1).max(200).optional(),
  from:isoTimestamp.optional(),
  to:isoTimestamp.optional(),
}).superRefine((value,context)=>{if(value.from&&value.to&&Date.parse(value.from)>Date.parse(value.to))context.addIssue({code:z.ZodIssueCode.custom,path:['to'],message:'to must be on or after from'});});
export const accountBalanceQuerySchema=z.object({currency,asOf:isoTimestamp.optional()});
export const trialBalanceQuerySchema=accountBalanceQuerySchema;
