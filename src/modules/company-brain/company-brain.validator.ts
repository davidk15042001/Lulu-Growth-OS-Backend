import { z } from 'zod';
import { brainMissionStatuses, brainSignalStatuses } from './company-brain.types.js';

export const brainWorkspaceParamsSchema = z.object({ workspaceId: z.string().uuid() });
export const brainSignalParamsSchema = brainWorkspaceParamsSchema.extend({ signalId: z.string().uuid() });
export const brainMissionParamsSchema = brainWorkspaceParamsSchema.extend({ missionId: z.string().uuid() });
export const brainTaskParamsSchema = brainWorkspaceParamsSchema.extend({ taskId: z.string().uuid() });

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

export const createTaskSchema = z.object({
  parentTaskId: z.string().uuid().nullable().optional(),
  assignedEmployeeId: z.string().uuid().nullable().optional(),
  taskType: z.string().trim().min(1).max(120).default('specialist'),
  title: z.string().trim().min(1).max(300),
  objective: z.string().trim().max(4000).default(''),
  priority: z.coerce.number().int().min(0).max(100).default(50),
  context: z.record(z.string(), z.unknown()).default({}),
  dueAt: z.string().datetime().nullable().optional(),
  maxAttempts: z.coerce.number().int().min(1).max(20).default(3),
  idempotencyKey: z.string().trim().min(1).max(240).nullable().optional(),
});

export const addDependencySchema = z.object({
  dependsOnTaskId: z.string().uuid(),
  dependencyType: z.enum(['BLOCKS', 'CONTEXT', 'VERIFICATION']).default('BLOCKS'),
});

export const updateTaskSchema = z.object({
  status: z.enum(['PROPOSED', 'READY', 'RUNNING', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
  result: z.record(z.string(), z.unknown()).nullable().optional(),
  errorCode: z.string().trim().max(160).nullable().optional(),
  errorMessage: z.string().trim().max(4000).nullable().optional(),
  blockedReason: z.string().trim().max(1000).nullable().optional(),
  confidence: z.coerce.number().min(0).max(1).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'At least one task field is required' });

export const createLearningSchema = z.object({
  taskId: z.string().uuid().nullable().optional(),
  signalId: z.string().uuid().nullable().optional(),
  sourceEventId: z.string().uuid().nullable().optional(),
  outcomeType: z.string().trim().min(1).max(120),
  outcome: z.string().trim().min(1).max(4000),
  evidence: z.record(z.string(), z.unknown()).default({}),
  confidence: z.coerce.number().min(0).max(1),
  verified: z.boolean().default(false),
  actorType: z.enum(['system', 'agent', 'human']).default('human'),
}).refine((value) => Boolean(value.taskId || value.signalId || value.sourceEventId), {
  message: 'A learning record must reference a task, signal, or source event',
  path: ['taskId'],
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
