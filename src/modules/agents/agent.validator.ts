import { z } from 'zod';
import { decideApprovalSchema } from '../approvals/approval.validator.js';

export const agentRunParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  stepId: z.string().uuid().optional(),
});
export const agentStepDecisionSchema = decideApprovalSchema;
export const agentRunQuerySchema = z.object({
  pageId: z.string().trim().regex(/^[a-z0-9-]+$/).max(120).optional(),
});
export const createAgentRunSchema = z.object({
  goal: z.string().trim().min(3).max(4000),
  module: z.enum([
    'general',
    'dashboard',
    'intelligence',
    'finance',
    'sales',
    'crm',
    'ai',
    'email',
    'calendar',
    'marketing',
    'ads',
    'website',
    'commerce',
    'reputation',
    'settings',
    'seo',
    'geo',
    'aeo',
  ]).default('general'),
  page: z.object({
    pageId: z.string().trim().regex(/^[a-z0-9-]+$/).max(120),
    pageLabel: z.string().trim().min(1).max(200),
    sectionLabel: z.string().trim().min(1).max(120),
    agentName: z.string().trim().max(200).nullable().optional(),
    objective: z.string().trim().max(1000).nullable().optional(),
    autonomy: z.string().trim().max(16).nullable().optional(),
    jobs: z.array(z.string().trim().min(1).max(160)).max(12).optional(),
    integrations: z.array(z.string().trim().min(1).max(160)).max(12).optional(),
    successMetrics: z.array(z.string().trim().min(1).max(160)).max(12).optional(),
    approvalGates: z.array(z.string().trim().min(1).max(160)).max(12).optional(),
  }).optional(),
  dedupeMinutes: z.number().int().min(1).max(1440).optional(),
});
