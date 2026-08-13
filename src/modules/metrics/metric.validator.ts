import { z } from 'zod';

const jsonObject = z.record(z.string(), z.unknown());

export const metricParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  metricId: z.string().uuid().optional(),
});

const metricFields = {
  key: z.string().trim().regex(/^[a-z][a-z0-9_]*$/).max(100),
  name: z.string().trim().min(1).max(200),
  domain: z.string().trim().regex(/^[a-z][a-z0-9_]*$/).max(100),
  unit: z.string().trim().min(1).max(50).optional(),
  format: z.string().trim().max(100).nullable().optional(),
  source: z.string().trim().max(200).nullable().optional(),
  configuration: jsonObject.optional(),
};

export const createMetricSchema = z.object(metricFields);
export const updateMetricSchema = z
  .object(metricFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');

export const metricPointSchema = z.object({
  recordedAt: z.string().datetime({ offset: true }),
  value: z.coerce.number().finite(),
  dimensions: jsonObject.optional(),
  sourceRecordId: z.string().uuid().nullable().optional(),
});

export const ingestMetricPointsSchema = z.object({
  points: z.array(metricPointSchema).min(1).max(1_000),
});

export const listMetricPointsQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1_000).default(100),
  order: z.enum(['asc', 'desc']).default('asc'),
});

export type CreateMetricInput = z.infer<typeof createMetricSchema>;
export type UpdateMetricInput = z.infer<typeof updateMetricSchema>;
export type MetricPointInput = z.infer<typeof metricPointSchema>;
export type ListMetricPointsQuery = z.infer<typeof listMetricPointsQuerySchema>;
