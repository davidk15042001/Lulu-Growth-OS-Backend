import { z } from 'zod';
import { decideApprovalSchema } from '../approvals/approval.validator.js';

export const agentRunParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  stepId: z.string().uuid().optional(),
});
export const agentStepDecisionSchema = decideApprovalSchema;
export const createAgentRunSchema = z.object({
  goal: z.string().trim().min(3).max(4000),
});
