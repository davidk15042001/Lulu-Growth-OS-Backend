import { z } from 'zod';
import { isResourceType } from '../../domain/resource-catalog.js';
import { SALES_PIPELINE_RESOURCE_TYPES, SALES_PIPELINE_STAGES } from './sales-pipeline.types.js';

const stage = z.string().trim().min(1).max(40).transform((value) => value.toLowerCase().replace(/\s+/g, '_'));

export const salesPipelineParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  resourceType: z.string().refine((value) => isResourceType(value) && (SALES_PIPELINE_RESOURCE_TYPES as readonly string[]).includes(value), 'Unsupported sales pipeline resource type'),
  recordId: z.string().uuid(),
});

export const transitionSalesRecordSchema = z.object({
  targetState: stage,
  expectedVersion: z.coerce.number().int().positive().optional(),
  reason: z.string().trim().max(2_000).nullable().optional(),
});

export type TransitionSalesRecordInput = z.infer<typeof transitionSalesRecordSchema>;

export function allowedStates(resourceType: typeof SALES_PIPELINE_RESOURCE_TYPES[number]) {
  if (resourceType.includes('task')) return SALES_PIPELINE_STAGES.task;
  if (resourceType.includes('lead')) return SALES_PIPELINE_STAGES.lead;
  return SALES_PIPELINE_STAGES.opportunity;
}
