import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ResourceType } from '../../domain/resource-catalog.js';

export const agentExecutionCommandTypeSchema = z.enum([
  'record.create_artifact',
  'crm.create_followup_task',
  'sales.create_followup_task',
  'advertising.create_optimization',
  'finance.create_automation',
  'google_reviews.reply',
  'email.create_draft',
  'email.create_ai_draft',
  'website.publish_job',
  'ecommerce.generate_product_images',
]);

export type AgentExecutionCommandType = z.infer<typeof agentExecutionCommandTypeSchema>;
export type AgentExecutionRiskLevel = 'low' | 'medium' | 'high';
export type AgentExecutionCommand = {
  type: AgentExecutionCommandType;
  summary: string;
  targetSystem: string;
  provider: string | null;
  riskLevel: AgentExecutionRiskLevel;
  approvalPolicy: 'allow' | 'require_approval';
  targetEntityType: string | null;
  targetEntityId: string | null;
  payload: Record<string, unknown>;
  idempotencyKey: string;
};

export type AgentExecutionCommandPolicyDecision = 'allow' | 'require_approval' | 'forbidden';
export type AgentExecutionCommandPolicy = {
  decision: AgentExecutionCommandPolicyDecision;
  reason: string;
};

type InferCommandContext = {
  module: string;
  targetSystem: string;
  actionResourceType: ResourceType;
  pageId: string | null;
  pageLabel: string;
  goal: string;
  jobs: string[];
  policyDecision: 'allow' | 'require_approval';
  executionMode: 'analysis_only' | 'autonomous';
  accountId?: string | null;
  threadId?: string | null;
  tone?: string | null;
  language?: string | null;
  instruction?: string | null;
  to?: unknown;
  cc?: unknown;
  subject?: string | null;
  bodyText?: string | null;
  replyToProviderMessageId?: string | null;
  reviewId?: string | null;
  locationId?: string | null;
  comment?: string | null;
  siteId?: string | null;
  jobId?: string | null;
  provider?: string | null;
  sourceText?: string | null;
};

const agentExecutionCommandSchema = z.object({
  type: agentExecutionCommandTypeSchema,
  summary: z.string().trim().min(3).max(500),
  targetSystem: z.string().trim().min(1).max(80),
  provider: z.string().trim().min(1).max(80).nullable().optional(),
  riskLevel: z.enum(['low', 'medium', 'high']).default('medium'),
  approvalPolicy: z.enum(['allow', 'require_approval']).default('require_approval'),
  targetEntityType: z.string().trim().min(1).max(80).nullable().optional(),
  targetEntityId: z.string().trim().min(1).max(200).nullable().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().trim().min(8).max(200),
});

function textValue(value: unknown, maxLength = 240) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength) : '';
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : [];
}

function emailAddressList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const address = textValue((item as Record<string, unknown>).address, 320).toLowerCase();
    if (!address) return [];
    const name = textValue((item as Record<string, unknown>).name, 200) || null;
    return [{ address, ...(name ? { name } : {}) }];
  });
}

function buildIdempotencyKey(parts: Array<string | null | undefined>) {
  const raw = parts.map((part) => part?.trim() ?? '').filter(Boolean).join('|');
  return createHash('sha1').update(raw || 'agent-execution').digest('hex');
}

function defaultSummary(context: InferCommandContext) {
  const jobs = context.jobs.slice(0, 4).join(', ');
  return jobs
    ? `${context.pageLabel}: ${jobs}`
    : `${context.pageLabel}: ${context.goal || 'Execute the next approved agent action.'}`;
}

function defaultArtifactCommand(context: InferCommandContext): AgentExecutionCommand {
  const summary = defaultSummary(context);
  const jobsSummary = context.jobs.slice(0, 4).join(', ');
  return {
    type: 'record.create_artifact',
    summary,
    targetSystem: context.targetSystem,
    provider: null,
    riskLevel: context.executionMode === 'autonomous' ? 'medium' : 'low',
    approvalPolicy: context.policyDecision,
    targetEntityType: context.actionResourceType,
    targetEntityId: context.pageId,
    payload: {
      actionResourceType: context.actionResourceType,
      pageId: context.pageId,
      pageLabel: context.pageLabel,
      goal: context.goal,
      jobs: context.jobs,
      module: context.module,
    },
    idempotencyKey: buildIdempotencyKey([
      'record.create_artifact',
      context.actionResourceType,
      context.pageId,
      context.goal,
      jobsSummary,
    ]),
  };
}

function inferCommand(context: InferCommandContext): AgentExecutionCommand {
  const summary = defaultSummary(context);
  if (context.targetSystem === 'crm') {
    return {
      type: 'crm.create_followup_task',
      summary,
      targetSystem: 'crm',
      provider: null,
      riskLevel: 'low',
      approvalPolicy: context.executionMode === 'autonomous' ? 'allow' : context.policyDecision,
      targetEntityType: 'crm_task',
      targetEntityId: context.pageId,
      payload: {
        title: summary,
        description: context.goal,
        jobs: context.jobs,
        module: context.module,
      },
      idempotencyKey: buildIdempotencyKey(['crm.create_followup_task', context.pageId, context.goal, context.jobs.join('|')]),
    };
  }

  if (context.targetSystem === 'sales') {
    return {
      type: 'sales.create_followup_task',
      summary,
      targetSystem: 'sales',
      provider: null,
      riskLevel: 'low',
      approvalPolicy: context.executionMode === 'autonomous' ? 'allow' : context.policyDecision,
      targetEntityType: 'sales_task',
      targetEntityId: context.pageId,
      payload: {
        title: summary,
        description: context.goal,
        jobs: context.jobs,
        module: context.module,
      },
      idempotencyKey: buildIdempotencyKey(['sales.create_followup_task', context.pageId, context.goal, context.jobs.join('|')]),
    };
  }

  if (context.targetSystem === 'advertising') {
    return {
      type: 'advertising.create_optimization',
      summary,
      targetSystem: 'advertising',
      provider: null,
      riskLevel: 'medium',
      approvalPolicy: context.policyDecision,
      targetEntityType: 'ad_optimization',
      targetEntityId: context.pageId,
      payload: {
        title: summary,
        description: context.goal,
        jobs: context.jobs,
        module: context.module,
      },
      idempotencyKey: buildIdempotencyKey(['advertising.create_optimization', context.pageId, context.goal, context.jobs.join('|')]),
    };
  }

  if (context.targetSystem === 'finance') {
    return {
      type: 'finance.create_automation',
      summary,
      targetSystem: 'finance',
      provider: null,
      riskLevel: 'medium',
      approvalPolicy: context.policyDecision,
      targetEntityType: 'finance_automation',
      targetEntityId: context.pageId,
      payload: {
        title: summary,
        description: context.goal,
        jobs: context.jobs,
        module: context.module,
      },
      idempotencyKey: buildIdempotencyKey(['finance.create_automation', context.pageId, context.goal, context.jobs.join('|')]),
    };
  }

  if (context.reviewId && context.accountId && context.locationId && context.comment) {
    return {
      type: 'google_reviews.reply',
      summary,
      targetSystem: 'reputation',
      provider: 'google_business',
      riskLevel: 'high',
      approvalPolicy: 'require_approval',
      targetEntityType: 'google_review',
      targetEntityId: context.reviewId,
      payload: {
        accountId: context.accountId,
        locationId: context.locationId,
        reviewId: context.reviewId,
        comment: context.comment,
      },
      idempotencyKey: buildIdempotencyKey([
        'google_reviews.reply',
        context.accountId,
        context.locationId,
        context.reviewId,
        context.comment,
      ]),
    };
  }

  if (context.accountId && context.threadId && context.bodyText) {
    return {
      type: 'email.create_draft',
      summary,
      targetSystem: 'communication',
      provider: 'email',
      riskLevel: 'medium',
      approvalPolicy: context.policyDecision,
      targetEntityType: 'email_thread',
      targetEntityId: context.threadId,
      payload: {
        accountId: context.accountId,
        threadId: context.threadId,
        to: emailAddressList(context.to),
        cc: emailAddressList(context.cc),
        subject: textValue(context.subject, 998),
        bodyText: textValue(context.bodyText, 100_000),
        replyToProviderMessageId: textValue(context.replyToProviderMessageId, 1000) || null,
      },
      idempotencyKey: buildIdempotencyKey([
        'email.create_draft',
        context.accountId,
        context.threadId,
        textValue(context.subject, 200),
        textValue(context.bodyText, 400),
      ]),
    };
  }

  if (context.accountId && context.threadId) {
    return {
      type: 'email.create_ai_draft',
      summary,
      targetSystem: 'communication',
      provider: 'email',
      riskLevel: 'medium',
      approvalPolicy: context.policyDecision,
      targetEntityType: 'email_thread',
      targetEntityId: context.threadId,
      payload: {
        accountId: context.accountId,
        threadId: context.threadId,
        instruction: textValue(context.instruction, 2000) || undefined,
        tone: textValue(context.tone, 40) || 'professional',
        language: textValue(context.language, 16) || 'en',
      },
      idempotencyKey: buildIdempotencyKey([
        'email.create_ai_draft',
        context.accountId,
        context.threadId,
        textValue(context.instruction, 200),
        textValue(context.tone, 40),
        textValue(context.language, 16),
      ]),
    };
  }

  if (context.siteId && context.jobId) {
    return {
      type: 'website.publish_job',
      summary,
      targetSystem: 'website',
      provider: textValue(context.provider, 80) || 'website',
      riskLevel: 'high',
      approvalPolicy: 'require_approval',
      targetEntityType: 'website_job',
      targetEntityId: context.jobId,
      payload: {
        siteId: context.siteId,
        jobId: context.jobId,
      },
      idempotencyKey: buildIdempotencyKey([
        'website.publish_job',
        context.siteId,
        context.jobId,
      ]),
    };
  }

  if (context.sourceText) {
    return {
      type: 'ecommerce.generate_product_images',
      summary,
      targetSystem: 'ecommerce',
      provider: null,
      riskLevel: 'medium',
      approvalPolicy: context.executionMode === 'autonomous' ? 'allow' : context.policyDecision,
      targetEntityType: 'ecommerce_products',
      targetEntityId: context.pageId,
      payload: {
        sourceText: context.sourceText,
        module: context.module,
      },
      idempotencyKey: buildIdempotencyKey([
        'ecommerce.generate_product_images',
        context.pageId,
        context.sourceText.slice(0, 400),
      ]),
    };
  }

  return defaultArtifactCommand(context);
}

export function normalizeAgentExecutionCommands(value: unknown, context: InferCommandContext): AgentExecutionCommand[] {
  if (Array.isArray(value) && value.length > 0) {
    const parsed = value.flatMap((item) => {
      const result = agentExecutionCommandSchema.safeParse(item);
      return result.success ? [result.data] : [];
    });
    if (parsed.length > 0) {
      return parsed.map((command) => ({
        ...command,
        provider: command.provider ?? null,
        targetEntityType: command.targetEntityType ?? null,
        targetEntityId: command.targetEntityId ?? null,
      }));
    }
  }
  return [inferCommand(context)];
}

export function listAgentExecutionCommandTypes(commands: readonly AgentExecutionCommand[]) {
  return [...new Set(commands.map((command) => command.type))];
}

function isBudgetCommand(command: AgentExecutionCommand): boolean {
  const haystack = [
    command.type,
    command.targetEntityType ?? '',
    command.targetSystem ?? '',
    command.summary,
  ].join(' ').toLowerCase();
  return haystack.includes('budget');
}

export function decideExecutionCommandPolicy(
  command: AgentExecutionCommand,
  executionMode: 'analysis_only' | 'autonomous',
): AgentExecutionCommandPolicy {
  if (isBudgetCommand(command)) {
    return { decision: 'require_approval', reason: 'Budget changes are never executed automatically; they are suggestions only.' };
  }
  if (executionMode === 'autonomous') {
    return { decision: 'allow', reason: 'Fully autonomous mode executes all commands without human approval.' };
  }
  if (command.type === 'record.create_artifact') {
    return { decision: 'allow', reason: 'Internal artifact creation is safe.' };
  }
  if (command.type === 'crm.create_followup_task' || command.type === 'sales.create_followup_task') {
    return { decision: 'require_approval', reason: 'Task creation requires autonomous mode or a human approval.' };
  }
  if (command.type === 'email.create_ai_draft') {
    return { decision: 'require_approval', reason: 'Draft preparation outside autonomous mode should be reviewed first.' };
  }
  if (command.type === 'advertising.create_optimization' || command.type === 'finance.create_automation' || command.type === 'email.create_draft') {
    return { decision: 'require_approval', reason: `Command ${command.type} affects an operational workflow and must be reviewed.` };
  }
  if (command.type === 'google_reviews.reply' || command.type === 'website.publish_job') {
    return { decision: 'require_approval', reason: `Command ${command.type} has direct external impact and always requires approval.` };
  }
  if (command.type === 'ecommerce.generate_product_images') {
    return { decision: 'require_approval', reason: 'Product image generation outside autonomous mode should be reviewed first.' };
  }
  if (command.riskLevel === 'high') {
    return { decision: 'require_approval', reason: `High-risk command ${command.type} requires explicit approval.` };
  }
  return { decision: 'allow', reason: `Command ${command.type} is allowed by the default safe policy.` };
}

export function applyExecutionCommandPolicies(
  commands: readonly AgentExecutionCommand[],
  executionMode: 'analysis_only' | 'autonomous',
) {
  const decisions = commands.map((command) => {
    const policy = decideExecutionCommandPolicy(command, executionMode);
    return {
      ...command,
      approvalPolicy: policy.decision === 'allow' ? 'allow' : 'require_approval',
      riskLevel: policy.decision === 'allow' ? command.riskLevel : (command.riskLevel === 'low' ? 'medium' : command.riskLevel),
      policyDecision: policy.decision,
      policyReason: policy.reason,
    };
  });
  const overallDecision = decisions.some((entry) => entry.policyDecision !== 'allow') ? 'require_approval' : 'allow';
  const reasons = decisions
    .filter((entry) => entry.policyDecision !== 'allow')
    .map((entry) => `${entry.type}: ${entry.policyReason}`);
  return {
    commands: decisions,
    overallDecision,
    reasons,
  };
}

export function summarizeExecutionReviewReason(
  commands: readonly AgentExecutionCommand[],
  policyDecision: 'allow' | 'require_approval',
  policyReasons: readonly string[] = [],
) {
  if (policyReasons.length > 0) return policyReasons.join(' ');
  if (policyDecision === 'require_approval') return 'The execution includes approval-gated actions and must be reviewed before side effects are applied.';
  const highRisk = commands.find((command) => command.riskLevel === 'high');
  if (highRisk) return `High-risk command ${highRisk.type} was prepared and should be monitored closely even though it is currently allowed.`;
  return 'The execution command set is safe for autonomous processing.';
}

export function parseAgentExecutionStringList(value: unknown) {
  return stringList(value);
}
