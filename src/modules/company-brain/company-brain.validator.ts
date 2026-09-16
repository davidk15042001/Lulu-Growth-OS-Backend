import { z } from 'zod';
import { brainMissionStatuses, brainSignalStatuses } from './company-brain.types.js';

export const brainWorkspaceParamsSchema = z.object({ workspaceId: z.string().uuid() });
export const brainSignalParamsSchema = brainWorkspaceParamsSchema.extend({ signalId: z.string().uuid() });
export const brainMissionParamsSchema = brainWorkspaceParamsSchema.extend({ missionId: z.string().uuid() });

export const brainListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.string().optional(),
});

export const createMissionSchema = z.object({
  signalId: z.string().uuid(),
  title: z.string().trim().min(1).max(300).optional(),
  objective: z.string().trim().min(1).max(4000).optional(),
  priority: z.coerce.number().int().min(0).max(100).default(70),
});

export const updateMissionSchema = z.object({
  status: z.enum(brainMissionStatuses),
  outcome: z.record(z.string(), z.unknown()).optional(),
});

export const createDecisionSchema = z.object({
  signalId: z.string().uuid().optional(),
  missionId: z.string().uuid().optional(),
  decisionType: z.string().trim().min(1).max(120),
  decision: z.string().trim().min(1).max(4000),
  confidence: z.coerce.number().min(0).max(1),
  rationale: z.string().trim().max(4000).default(''),
  evidence: z.record(z.string(), z.unknown()).default({}),
  actorType: z.enum(['system', 'agent', 'human']).default('human'),
}).refine((value) => Boolean(value.signalId || value.missionId), {
  message: 'A decision must reference a signal or mission',
  path: ['signalId'],
});

export function isBrainSignalStatus(value: string): value is typeof brainSignalStatuses[number] {
  return (brainSignalStatuses as readonly string[]).includes(value);
}
