import { z } from 'zod';
import { isResourceType } from '../../domain/resource-catalog.js';

const resourceTypeSchema = z.string().refine(isResourceType, 'Unsupported resource type');
const nullableText = (maximum: number) => z.string().trim().max(maximum).nullable().optional();
const jsonObject = z.record(z.string(), z.unknown());
const dateTime = z.string().datetime({ offset: true }).nullable().optional();

export const recordParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  resourceType: resourceTypeSchema,
  recordId: z.string().uuid().optional(),
});

export const listRecordsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
  status: z.string().trim().max(100).optional(),
  stage: z.string().trim().max(100).optional(),
  tag: z.string().trim().max(100).optional(),
  assigneeId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  sort: z.enum(['name', 'createdAt', 'updatedAt', 'dueAt', 'valueAmount']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

const recordFields = {
  name: z.string().trim().min(1).max(300),
  description: nullableText(20_000),
  status: z.string().trim().min(1).max(100).optional(),
  stage: nullableText(100),
  valueAmount: z.coerce.number().finite().nullable().optional(),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).nullable().optional(),
  startsAt: dateTime,
  endsAt: dateTime,
  dueAt: dateTime,
  assigneeId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  externalId: nullableText(500),
  source: nullableText(200),
  tags: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  data: jsonObject.optional(),
};

export const createRecordSchema = z.object(recordFields);

export const ingestRecordSchema = z.object({
  name: z.string().trim().min(1).max(300),
  text: z.string().max(20_000).optional().default(''),
  files: z.array(z.object({
    name: z.string().trim().min(1).max(300),
    type: z.string().max(100).optional().default(''),
    dataUrl: z.string().max(15_000_000).optional().default(''),
  })).max(50).optional().default([]),
});

export const updateRecordSchema = z
  .object({
    ...recordFields,
    expectedVersion: z.coerce.number().int().positive().optional(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');

export type ListRecordsQuery = z.infer<typeof listRecordsQuerySchema>;
export type CreateRecordInput = z.infer<typeof createRecordSchema>;
export type IngestRecordInput = z.infer<typeof ingestRecordSchema>;
export type UpdateRecordInput = z.infer<typeof updateRecordSchema>;
