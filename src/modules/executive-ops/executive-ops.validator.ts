import { z } from 'zod';
import { executiveCycleTypes, executiveProposalStatuses, executiveProposalTypes } from './executive-ops.types.js';

const jsonObject = z.record(z.string(), z.unknown());

function validTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timezoneSchema = z.string().trim().min(1).max(100).refine(validTimeZone, 'Use a valid IANA timezone');

export const executiveWorkspaceParamsSchema = z.object({ workspaceId: z.string().uuid() });
export const executiveCycleParamsSchema = executiveWorkspaceParamsSchema.extend({ cycleId: z.string().uuid() });
export const executiveScenarioParamsSchema = executiveWorkspaceParamsSchema.extend({ scenarioId: z.string().uuid() });
export const executiveProposalParamsSchema = executiveWorkspaceParamsSchema.extend({ proposalId: z.string().uuid() });
export const executiveScheduleParamsSchema = executiveWorkspaceParamsSchema.extend({ cycleType: z.enum(executiveCycleTypes) });

export const executiveListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cycleType: z.enum(executiveCycleTypes).optional(),
  status: z.enum(executiveProposalStatuses).optional(),
});

export const runExecutiveCycleSchema = z.object({
  cycleType: z.enum(executiveCycleTypes).default('daily'),
});

export const saveExecutiveScheduleSchema = z.object({
  timezone: timezoneSchema,
  hourOfDay: z.coerce.number().int().min(0).max(23),
  weekday: z.coerce.number().int().min(0).max(6).default(0),
  active: z.boolean(),
});

export const createExecutiveScenarioSchema = z.object({
  cycleId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).default(''),
  assumptions: z.array(z.unknown()).max(30).default([]),
  projections: z.array(z.object({
    forecastId: z.string().uuid(),
    adjustmentPercent: z.coerce.number().finite().min(-100).max(10_000),
  })).min(1).max(25),
});

export const createExecutiveProposalSchema = z.object({
  cycleId: z.string().uuid().nullable().optional(),
  findingId: z.string().uuid().nullable().optional(),
  proposalType: z.enum(executiveProposalTypes),
  title: z.string().trim().min(1).max(300),
  objective: z.string().trim().min(1).max(4000),
  priority: z.coerce.number().int().min(0).max(100).default(50),
  confidence: z.coerce.number().finite().min(0).max(1).default(0.5),
  expectedImpact: jsonObject.default({}),
  riskNotes: z.array(z.unknown()).max(50).default([]),
  evidence: jsonObject.default({}),
  idempotencyKey: z.string().trim().min(1).max(300).nullable().optional(),
});

export const decideExecutiveProposalSchema = z.object({
  expectedVersion: z.coerce.number().int().min(1),
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(2000).nullable().optional(),
});
