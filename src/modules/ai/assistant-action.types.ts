import { z } from 'zod';

export const assistantActionTypeSchema = z.enum([
  'crm.create_followup_task',
  'sales.create_followup_task',
  'advertising.create_optimization',
  'finance.create_automation',
  'google_reviews.reply',
  'email.create_draft',
  'email.create_ai_draft',
  'omnichannel.send_message',
  'website.publish_job',
  'workspace.refresh',
]);

export type AssistantActionType = z.infer<typeof assistantActionTypeSchema>;
export type AssistantActionStatus =
  | 'pending_approval'
  | 'ready'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export type AssistantActionInput = {
  type: AssistantActionType;
  summary: string;
  payload: Record<string, unknown>;
};

export type AssistantPendingAction = AssistantActionInput & {
  id: string;
  conversationId: string;
  status: AssistantActionStatus;
  approvalId: string | null;
  requiresApproval: boolean;
  result?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  expiresAt?: string | null;
};

export const assistantActionInputSchema = z.object({
  type: assistantActionTypeSchema,
  summary: z.string().trim().min(3).max(500),
  payload: z.record(z.string(), z.unknown()),
}).strict();

export const assistantActionExecutionSchema = z.object({
  actionId: z.string().uuid(),
}).strict();
