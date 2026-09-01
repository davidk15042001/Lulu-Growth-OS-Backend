import crypto from 'node:crypto';
import { isResourceType, type ResourceType } from '../../domain/resource-catalog.js';
import * as recordRepo from '../records/record.repo.js';
import * as agentRepo from '../agents/agent.repo.js';
import * as agentService from '../agents/agent.service.js';
import { agentExecutionCommandTypeSchema } from '../agents/agent.execution-command.js';

export type AssistantToolContext = { workspaceId: string; userId: string };

export type AssistantTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: AssistantToolContext) => Promise<unknown>;
  action?: boolean;
};

export type AssistantPendingAction = {
  id: string;
  type: string;
  summary: string;
  payload: Record<string, unknown>;
};

const ACTION_TOOL_NAME = 'request_action';

function stringValue(value: unknown, maxLength = 400) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function compactRecord(record: Awaited<ReturnType<typeof recordRepo.listRecords>>['items'][number]) {
  return {
    id: record.id,
    resourceType: record.resourceType,
    name: record.name,
    status: record.status,
    stage: record.stage,
    tags: record.tags.slice(0, 6),
    dueAt: record.dueAt,
    valueAmount: record.valueAmount,
    currency: record.currency,
    description: stringValue(record.description, 300),
    updatedAt: record.updatedAt,
  };
}

function compactRecords(records: Awaited<ReturnType<typeof recordRepo.listRecords>>['items']) {
  return records.map(compactRecord);
}

async function queryRecords(args: Record<string, unknown>, ctx: AssistantToolContext) {
  const resourceType = stringValue(args.resourceType);
  if (!isResourceType(resourceType)) {
    return { error: `Unsupported resource type "${resourceType}". Provide one of the known workspace record types.` };
  }
  const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30);
  const search = stringValue(args.search, 200) || undefined;
  const status = stringValue(args.status, 100) || undefined;
  const result = await recordRepo.listRecords(ctx.workspaceId, resourceType as ResourceType, {
    page: 1,
    limit,
    search,
    status,
    sort: 'updatedAt',
    order: 'desc',
  });
  return {
    resourceType,
    total: result.pagination.total,
    items: compactRecords(result.items),
  };
}

async function queryKnowledge(ctx: AssistantToolContext) {
  const bundle = await agentRepo.getKnowledgeBundle(ctx.workspaceId, 'initial_business_analysis');
  if (!bundle) return { available: false, message: 'No initial intelligence analysis has been completed yet.' };
  return {
    available: true,
    executiveSummary: bundle.snapshot?.executiveSummary ?? null,
    verifiedFacts: (bundle.snapshot?.verifiedFacts ?? []).slice(0, 20),
    priorities: (bundle.snapshot?.priorities ?? []).slice(0, 20),
    dataGaps: (bundle.snapshot?.dataGaps ?? []).slice(0, 20),
    sections: bundle.sections.map((section) => ({
      key: section.sectionKey,
      status: section.status,
      content: section.content,
    })),
    metrics: bundle.metrics.slice(0, 40).map((metric) => ({
      key: metric.metricKey,
      value: metric.value,
      unit: metric.unit,
      status: metric.sourceStatus,
      confidence: metric.confidence,
    })),
  };
}

async function queryAgentHealth(ctx: AssistantToolContext) {
  const health = await agentService.getAgentHealth(ctx.workspaceId);
  return {
    summary: health.summary,
    pagesNeedingAttention: health.items
      .filter((item) => item.lastRunStatus !== 'never_run' && item.lastRunStatus !== 'completed')
      .slice(0, 20)
      .map((item) => ({
        pageId: item.pageId,
        pageLabel: item.pageLabel,
        sectionLabel: item.sectionLabel,
        lastRunStatus: item.lastRunStatus,
        lastErrorCode: item.lastErrorCode,
        latestActionSummary: item.latestActionSummary,
      })),
  };
}

function createPendingAction(args: Record<string, unknown>): AssistantPendingAction {
  const rawType = stringValue(args.type, 120);
  const parsed = agentExecutionCommandTypeSchema.safeParse(rawType);
  const type = parsed.success ? parsed.data : '';
  return {
    id: crypto.randomUUID(),
    type,
    summary: stringValue(args.summary, 500) || 'Requested action',
    payload: objectValue(args.payload),
  };
}

export const assistantToolNames = {
  listRecords: 'list_records',
  knowledge: 'get_knowledge',
  agentHealth: 'get_agent_health',
  action: ACTION_TOOL_NAME,
};

export function buildAssistantTools(): AssistantTool[] {
  return [
    {
      name: assistantToolNames.listRecords,
      description:
        'List workspace records of a given type. Use this to answer questions about leads, deals, tasks, contacts, orders, campaigns, reviews, and other stored business data. Provide a resourceType and optionally search/status filters.',
      parameters: {
        type: 'object',
        properties: {
          resourceType: { type: 'string', description: 'The workspace record type key, e.g. crm_leads, sales_deals, crm_tasks, ecommerce_orders, marketing_content, ai_actions, activities.' },
          search: { type: 'string', description: 'Optional free-text search across the record name and description.' },
          status: { type: 'string', description: 'Optional status filter.' },
          limit: { type: 'number', description: 'Maximum number of records to return (1-30).' },
        },
        required: ['resourceType'],
      },
      handler: queryRecords,
    },
    {
      name: assistantToolNames.knowledge,
      description:
        'Return the workspace intelligence knowledge base: executive summary, verified facts, priorities, data gaps, sections and metrics produced by the initial business analysis. Use this for high-level questions about the company and its strategy.',
      parameters: { type: 'object', properties: {} },
      handler: (_args, ctx) => queryKnowledge(ctx),
    },
    {
      name: assistantToolNames.agentHealth,
      description:
        'Return the health status of all workspace AI agents: which pages are healthy and which need attention. Use this for questions about what the AI agents are doing or where problems exist.',
      parameters: { type: 'object', properties: {} },
      handler: (_args, ctx) => queryAgentHealth(ctx),
    },
    {
      name: ACTION_TOOL_NAME,
      description:
        'Request a real write action on the workspace (do not execute immediately). Use this only when the user explicitly asks you to perform an action. The action requires user approval before it runs.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: [
              'crm.create_followup_task',
              'sales.create_followup_task',
              'advertising.create_optimization',
              'finance.create_automation',
              'google_reviews.reply',
              'email.create_draft',
              'email.create_ai_draft',
              'website.publish_job',
            ],
          },
          summary: { type: 'string', description: 'Short human-readable description of the action.' },
          payload: { type: 'object', description: 'Parameters required to perform the action.' },
        },
        required: ['type', 'summary', 'payload'],
      },
      action: true,
      handler: (args) => Promise.resolve(createPendingAction(args)),
    },
  ];
}

export function pendingActionFromArgs(args: Record<string, unknown>): AssistantPendingAction {
  return createPendingAction(args);
}
