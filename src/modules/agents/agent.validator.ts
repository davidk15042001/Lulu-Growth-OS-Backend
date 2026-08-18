import { z } from 'zod';

export const agentRunParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  stepId: z.string().uuid().optional(),
});
export const createAgentRunSchema = z.object({
  goal: z.string().trim().min(3).max(4000),
});
