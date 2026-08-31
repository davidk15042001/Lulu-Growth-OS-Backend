import { isResourceType, type ResourceType } from '../../domain/resource-catalog.js';
import * as agentRepo from './agent.repo.js';
import * as onboardingRepo from '../onboarding/onboarding.repo.js';
import * as recordRepo from '../records/record.repo.js';
import * as metricRepo from '../metrics/metric.repo.js';
import * as emailRepo from '../email/email.repo.js';
import * as calendarRepo from '../calendar/calendar.repo.js';
import * as websiteRepo from '../websites/website.repo.js';
import * as searchRepo from '../search-intelligence/search-intelligence.repo.js';
import type { AgentTool } from './agent.types.js';
import type { ListRecordsQuery } from '../records/record.validator.js';

type AgentSnapshotInput = {
  module?: string;
  pageId?: string;
  pageLabel?: string;
  resourceTypes?: unknown;
  actionResourceType?: unknown;
  goal?: string;
  jobs?: unknown;
  approvalGates?: unknown;
  executionMode?: unknown;
  policyDecision?: unknown;
  approvedBy?: unknown;
  approvedAt?: unknown;
};

const DEFAULT_RECORD_QUERY = {
  page: 1,
  limit: 12,
  sort: 'updatedAt',
  order: 'desc',
} satisfies ListRecordsQuery;

function compactText(value: unknown, maxLength = 240) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function compactRecord(record: Awaited<ReturnType<typeof recordRepo.listRecords>>['items'][number]) {
  return {
    id: record.id,
    resourceType: record.resourceType,
    name: record.name,
    status: record.status,
    stage: record.stage,
    tags: record.tags.slice(0, 4),
    updatedAt: record.updatedAt,
    valueAmount: record.valueAmount,
    description: compactText(record.description),
  };
}

function listSummary<T>(items: readonly T[], mapper: (item: T) => string, limit = 5) {
  return items.slice(0, limit).map(mapper).filter(Boolean);
}

function countBy<T>(items: readonly T[], keyOf: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item).trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8));
}

function uniqueResourceTypes(resourceTypes: unknown): ResourceType[] {
  if (!Array.isArray(resourceTypes)) return [];
  return [...new Set(resourceTypes.filter((value): value is ResourceType => typeof value === 'string' && isResourceType(value)))];
}

function parseStringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

function normalizeActionResourceType(value: unknown) {
  return typeof value === 'string' && isResourceType(value) ? value : 'ai_actions';
}

function resolveTargetSystem(module: string, resourceType: ResourceType) {
  if (module === 'finance' || resourceType.startsWith('finance_')) return 'finance';
  if (module === 'sales' || resourceType.startsWith('sales_')) return 'sales';
  if (module === 'crm' || resourceType.startsWith('crm_')) return 'crm';
  if (module === 'ads' || resourceType.startsWith('ad_')) return 'advertising';
  if (module === 'marketing' || resourceType.startsWith('marketing_')) return 'marketing';
  if (module === 'commerce' || resourceType.startsWith('ecommerce_')) return 'ecommerce';
  if (module === 'website' || module === 'seo' || module === 'geo' || module === 'aeo') return 'website';
  if (module === 'email' || module === 'calendar') return 'communication';
  if (module === 'reputation') return 'reputation';
  return 'ai';
}

function metricSummary(metrics: Awaited<ReturnType<typeof metricRepo.listMetrics>>) {
  return {
    total: metrics.length,
    top: metrics.slice(0, 10).map((metric) => ({
      key: metric.key,
      name: metric.name,
      domain: metric.domain,
      latestValue: metric.latestValue,
      latestRecordedAt: metric.latestRecordedAt,
      unit: metric.unit,
    })),
    byDomain: countBy(metrics, (metric) => metric.domain),
  };
}

function platformSummary(platforms: Awaited<ReturnType<typeof onboardingRepo.listPlatforms>>) {
  return {
    total: platforms.length,
    connected: platforms.filter((platform) => ['connected', 'active', 'syncing', 'pending'].includes(platform.connectionStatus)).length,
    byStatus: countBy(platforms, (platform) => platform.connectionStatus),
    byCategory: countBy(platforms, (platform) => platform.category),
    providers: listSummary(platforms, (platform) => `${platform.name}:${platform.connectionStatus}`, 8),
  };
}

async function loadWorkspaceBase(workspaceId: string) {
  const [offerings, customerSegments, competitors, platforms, preferences, metrics, initialAnalysis, recentRuns] = await Promise.all([
    onboardingRepo.listOfferings(workspaceId),
    onboardingRepo.listCustomerSegments(workspaceId),
    onboardingRepo.listCompetitors(workspaceId),
    onboardingRepo.listPlatforms(workspaceId),
    onboardingRepo.getAiPreferences(workspaceId),
    metricRepo.listMetrics(workspaceId),
    agentRepo.getLatestCompletedInitialAnalysis(workspaceId),
    agentRepo.listRuns(workspaceId, 10),
  ]);

  return {
    offerings,
    customerSegments,
    competitors,
    platforms,
    preferences,
    metrics,
    initialAnalysis,
    recentRuns,
  };
}

async function loadRecordSnapshot(workspaceId: string, resourceTypes: ResourceType[]) {
  const types = [...new Set(resourceTypes)];
  const results = await Promise.all(
    types.map(async (resourceType) => {
      const response = await recordRepo.listRecords(workspaceId, resourceType, DEFAULT_RECORD_QUERY);
      return {
        resourceType,
        total: response.pagination.total,
        items: response.items,
      };
    }),
  );

  const allItems = results.flatMap((result) => result.items);
  return {
    totalRecords: results.reduce((sum, result) => sum + result.total, 0),
    byType: Object.fromEntries(results.map((result) => [result.resourceType, result.total])),
    statuses: countBy(allItems, (item) => item.status),
    stages: countBy(allItems.filter((item) => item.stage), (item) => item.stage ?? ''),
    recent: allItems
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 20)
      .map(compactRecord),
  };
}

async function recordResourceSnapshot(input: AgentSnapshotInput, workspaceId: string) {
  const resourceTypes = uniqueResourceTypes(input.resourceTypes);
  const [base, records] = await Promise.all([
    loadWorkspaceBase(workspaceId),
    loadRecordSnapshot(workspaceId, resourceTypes),
  ]);
  return {
    snapshotType: 'record_resource',
    module: input.module ?? 'general',
    pageId: input.pageId ?? null,
    pageLabel: input.pageLabel ?? null,
    resourceTypes,
    records,
    metrics: metricSummary(base.metrics),
    platforms: platformSummary(base.platforms),
    onboarding: {
      offerings: base.offerings.length,
      customerSegments: base.customerSegments.length,
      competitors: base.competitors.length,
      aiPreferencesConfigured: Boolean(base.preferences),
    },
    recentRuns: base.recentRuns.slice(0, 6).map((run) => ({
      id: run.id,
      goal: run.goal,
      status: run.status,
      updatedAt: run.updatedAt,
    })),
    initialAnalysisSummary: compactText(base.initialAnalysis?.result?.summary),
  };
}

async function workspaceIntelligenceSnapshot(input: AgentSnapshotInput, workspaceId: string) {
  const base = await loadWorkspaceBase(workspaceId);
  const knowledge = await agentRepo.getKnowledgeBundle(workspaceId);
  return {
    snapshotType: 'workspace_intelligence',
    module: input.module ?? 'general',
    pageId: input.pageId ?? null,
    pageLabel: input.pageLabel ?? null,
    platforms: platformSummary(base.platforms),
    metrics: metricSummary(base.metrics),
    onboarding: {
      offerings: listSummary(base.offerings, (offering) => offering.name, 8),
      customerSegments: listSummary(base.customerSegments, (segment) => segment.name, 8),
      competitors: listSummary(base.competitors, (competitor) => competitor.name, 8),
      aiPreferencesConfigured: Boolean(base.preferences),
      responseLanguage: base.preferences?.responseLanguage ?? null,
    },
    recentRuns: base.recentRuns.slice(0, 8).map((run) => ({
      id: run.id,
      goal: run.goal,
      status: run.status,
      pageId: typeof run.plan?.page === 'object' && run.plan?.page && typeof (run.plan.page as Record<string, unknown>).pageId === 'string'
        ? (run.plan.page as Record<string, unknown>).pageId
        : null,
      updatedAt: run.updatedAt,
    })),
    knowledge: knowledge?.snapshot
      ? {
          executiveSummary: compactText(knowledge.snapshot.executiveSummary, 500),
          priorities: knowledge.snapshot.priorities.slice(0, 8),
          verifiedFacts: knowledge.snapshot.verifiedFacts.slice(0, 8),
          dataGaps: knowledge.snapshot.dataGaps.slice(0, 8),
          sectionCount: knowledge.sections.length,
          metricCount: knowledge.metrics.length,
        }
      : null,
    initialAnalysisSummary: compactText(base.initialAnalysis?.result?.summary, 500),
  };
}

async function emailOperationsSnapshot(input: AgentSnapshotInput, workspaceId: string) {
  const [accounts, threads, drafts, rules, platforms] = await Promise.all([
    emailRepo.listAccounts(workspaceId),
    emailRepo.listThreads(workspaceId, { limit: 20, offset: 0 }),
    emailRepo.listDrafts(workspaceId),
    emailRepo.listRules(workspaceId),
    onboardingRepo.listPlatforms(workspaceId),
  ]);
  return {
    snapshotType: 'email_operations',
    module: input.module ?? 'email',
    pageId: input.pageId ?? null,
    pageLabel: input.pageLabel ?? null,
    accounts: {
      total: accounts.length,
      providers: countBy(accounts, (account) => account.provider),
      statuses: countBy(accounts, (account) => account.status),
      top: accounts.slice(0, 10).map((account) => ({
        id: account.id,
        emailAddress: account.emailAddress,
        provider: account.provider,
        status: account.status,
        lastSyncAt: account.lastSyncAt,
        lastErrorCode: account.lastErrorCode,
      })),
    },
    threads: {
      total: threads.total,
      unread: threads.items.filter((thread) => thread.unread).length,
      starred: threads.items.filter((thread) => thread.starred).length,
      recent: threads.items.slice(0, 12).map((thread) => ({
        id: thread.id,
        subject: thread.subject,
        provider: thread.provider,
        unread: thread.unread,
        starred: thread.starred,
        latestAt: thread.latestAt,
      })),
    },
    drafts: {
      total: drafts.length,
      recent: drafts.slice(0, 10).map((draft) => ({
        id: draft.id,
        subject: draft.subject,
        status: draft.status,
        source: draft.source,
        updatedAt: draft.updatedAt,
      })),
    },
    automations: {
      total: rules.length,
      enabled: rules.filter((rule) => rule.enabled).length,
      recent: rules.slice(0, 10).map((rule) => ({
        id: rule.id,
        name: rule.name,
        enabled: rule.enabled,
        runCount: rule.runCount,
        lastRunAt: rule.lastRunAt,
      })),
    },
    platforms: platformSummary(platforms.filter((platform) => platform.category.toLowerCase().includes('email') || platform.name.toLowerCase().includes('mail'))),
  };
}

async function calendarOperationsSnapshot(input: AgentSnapshotInput, workspaceId: string) {
  const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const to = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const [accounts, events, platforms] = await Promise.all([
    calendarRepo.listAccounts(workspaceId),
    calendarRepo.listEvents(workspaceId, { limit: 40, from, to }),
    onboardingRepo.listPlatforms(workspaceId),
  ]);
  return {
    snapshotType: 'calendar_operations',
    module: input.module ?? 'calendar',
    pageId: input.pageId ?? null,
    pageLabel: input.pageLabel ?? null,
    accounts: {
      total: accounts.length,
      providers: countBy(accounts, (account) => account.provider),
      statuses: countBy(accounts, (account) => account.status),
      top: accounts.slice(0, 10).map((account) => ({
        id: account.id,
        provider: account.provider,
        emailAddress: account.emailAddress,
        status: account.status,
        lastSyncAt: account.lastSyncAt,
        lastErrorCode: account.lastErrorCode,
      })),
    },
    events: {
      total: events.length,
      upcoming: events.filter((event) => Date.parse(event.startAt) >= Date.now()).length,
      sources: countBy(events, (event) => event.sourceName ?? event.provider),
      recent: events.slice(0, 15).map((event) => ({
        id: event.id,
        title: event.title,
        provider: event.provider,
        startAt: event.startAt,
        attendeeCount: event.attendeeCount,
        status: event.status,
      })),
    },
    platforms: platformSummary(platforms.filter((platform) => platform.category.toLowerCase().includes('calendar') || platform.name.toLowerCase().includes('calendar'))),
  };
}

async function websiteOperationsSnapshot(input: AgentSnapshotInput, workspaceId: string) {
  const resourceTypes = uniqueResourceTypes(input.resourceTypes);
  const [base, sites, seoItems, geoItems, aeoItems, recordSnapshot] = await Promise.all([
    loadWorkspaceBase(workspaceId),
    websiteRepo.listSites(workspaceId),
    searchRepo.listChannelRecords(workspaceId, 'marketing_seo_items', 25),
    searchRepo.listChannelRecords(workspaceId, 'marketing_geo_items', 25),
    searchRepo.listChannelRecords(workspaceId, 'marketing_aeo_items', 25),
    resourceTypes.length > 0 ? loadRecordSnapshot(workspaceId, resourceTypes) : Promise.resolve(null),
  ]);
  const latestJobs = await Promise.all(
    sites.slice(0, 12).map(async (site) => {
      const latestJob = await websiteRepo.findLatestJob(site.id);
      return {
        siteId: site.id,
        siteName: site.name,
        provider: site.provider,
        status: site.status,
        latestJobStatus: latestJob?.status ?? null,
        latestJobUpdatedAt: latestJob?.updatedAt ?? null,
      };
    }),
  );
  return {
    snapshotType: 'website_operations',
    module: input.module ?? 'website',
    pageId: input.pageId ?? null,
    pageLabel: input.pageLabel ?? null,
    sites: {
      total: sites.length,
      byProvider: countBy(sites, (site) => site.provider),
      byStatus: countBy(sites, (site) => site.status),
      top: latestJobs,
    },
    searchIntelligence: {
      seoItems: seoItems.length,
      geoItems: geoItems.length,
      aeoItems: aeoItems.length,
      seoTop: seoItems.slice(0, 8).map((item) => ({ id: item.id, name: item.name, status: item.status, updatedAt: item.updatedAt })),
      geoTop: geoItems.slice(0, 8).map((item) => ({ id: item.id, name: item.name, status: item.status, updatedAt: item.updatedAt })),
      aeoTop: aeoItems.slice(0, 8).map((item) => ({ id: item.id, name: item.name, status: item.status, updatedAt: item.updatedAt })),
    },
    connectedPlatforms: platformSummary(base.platforms),
    relatedRecords: recordSnapshot,
  };
}

async function aiWorkspaceSnapshot(input: AgentSnapshotInput, workspaceId: string) {
  const recentRuns = await agentRepo.listRuns(workspaceId, 20, input.pageId);
  const [workspaceKnowledge, pageKnowledge, recordSnapshot] = await Promise.all([
    agentRepo.getKnowledgeBundle(workspaceId),
    input.pageId ? agentRepo.getKnowledgeBundle(workspaceId, `page_agent:${input.pageId}`) : Promise.resolve(null),
    loadRecordSnapshot(workspaceId, uniqueResourceTypes(input.resourceTypes)),
  ]);
  return {
    snapshotType: 'ai_workspace',
    module: input.module ?? 'ai',
    pageId: input.pageId ?? null,
    pageLabel: input.pageLabel ?? null,
    runs: {
      total: recentRuns.length,
      statuses: countBy(recentRuns, (run) => run.status),
      recent: recentRuns.slice(0, 12).map((run) => ({
        id: run.id,
        goal: run.goal,
        status: run.status,
        errorCode: run.errorCode,
        updatedAt: run.updatedAt,
      })),
    },
    pageKnowledge: pageKnowledge?.snapshot
      ? {
          executiveSummary: compactText(pageKnowledge.snapshot.executiveSummary, 500),
          priorities: pageKnowledge.snapshot.priorities.slice(0, 8),
          verifiedFacts: pageKnowledge.snapshot.verifiedFacts.slice(0, 8),
          dataGaps: pageKnowledge.snapshot.dataGaps.slice(0, 8),
          sectionCount: pageKnowledge.sections.length,
        }
      : null,
    workspaceKnowledge: workspaceKnowledge?.snapshot
      ? {
          executiveSummary: compactText(workspaceKnowledge.snapshot.executiveSummary, 500),
          priorities: workspaceKnowledge.snapshot.priorities.slice(0, 8),
          verifiedFacts: workspaceKnowledge.snapshot.verifiedFacts.slice(0, 8),
          dataGaps: workspaceKnowledge.snapshot.dataGaps.slice(0, 8),
        }
      : null,
    aiRecords: recordSnapshot,
  };
}

async function reputationSnapshot(input: AgentSnapshotInput, workspaceId: string) {
  const [platforms, recordSnapshot, pageKnowledge] = await Promise.all([
    onboardingRepo.listPlatforms(workspaceId),
    loadRecordSnapshot(workspaceId, uniqueResourceTypes(input.resourceTypes)),
    input.pageId ? agentRepo.getKnowledgeBundle(workspaceId, `page_agent:${input.pageId}`) : Promise.resolve(null),
  ]);
  const googlePlatforms = platforms.filter((platform) => {
    const key = `${platform.integrationKey ?? ''} ${platform.name} ${platform.category}`.toLowerCase();
    return key.includes('google');
  });
  return {
    snapshotType: 'reputation',
    module: input.module ?? 'reputation',
    pageId: input.pageId ?? null,
    pageLabel: input.pageLabel ?? null,
    platforms: platformSummary(googlePlatforms),
    reviews: recordSnapshot,
    pageKnowledge: pageKnowledge?.snapshot
      ? {
          executiveSummary: compactText(pageKnowledge.snapshot.executiveSummary, 500),
          priorities: pageKnowledge.snapshot.priorities.slice(0, 8),
          verifiedFacts: pageKnowledge.snapshot.verifiedFacts.slice(0, 8),
          dataGaps: pageKnowledge.snapshot.dataGaps.slice(0, 8),
        }
      : null,
  };
}

async function pageActionWriteback(input: AgentSnapshotInput, workspaceId: string, userId: string) {
  const resourceType = normalizeActionResourceType(input.actionResourceType);
  const jobs = parseStringList(input.jobs);
  const approvalGates = parseStringList(input.approvalGates);
  const pageLabel = compactText(input.pageLabel, 120) || 'Page agent';
  const module = compactText(input.module, 40) || 'general';
  const goal = compactText(input.goal, 400);
  const executionMode = compactText(input.executionMode, 40) || 'analysis_only';
  const policyDecision = compactText((input as Record<string, unknown>).policyDecision, 40) || 'require_approval';
  const approvedBy = compactText((input as Record<string, unknown>).approvedBy, 120) || userId;
  const approvedAt = compactText((input as Record<string, unknown>).approvedAt, 120) || null;
  const executionReady = policyDecision === 'allow';
  const approvalStatus = executionReady ? 'approved' : 'pending';
  const targetSystem = resolveTargetSystem(module, resourceType);
  const record = await recordRepo.createRecord(workspaceId, resourceType, userId, {
    name: executionReady ? `${pageLabel} execution-ready action packet` : `${pageLabel} action packet`,
    description: compactText(goal || `Backend action packet for ${pageLabel}.`, 500),
    status: 'approved',
    stage: executionReady ? 'queued_for_execution' : 'waiting_approval',
    source: 'page_agent',
    tags: [module, resourceType, ...(input.pageId ? [String(input.pageId)] : [])].slice(0, 12),
    data: {
      pageId: input.pageId ?? null,
      pageLabel: input.pageLabel ?? null,
      module,
      goal: input.goal ?? null,
      resourceTypes: uniqueResourceTypes(input.resourceTypes),
      jobs,
      approvalGates,
      executionMode,
      policyDecision,
      approvalStatus,
      executionReady,
      executionStatus: executionReady ? 'queued' : 'waiting_approval',
      targetSystem,
      targetModule: module,
      approvedBy,
      approvedAt,
      approvedAutomatically: approvedBy === 'system',
      createdByAgent: true,
      createdAt: new Date().toISOString(),
    },
  });
  return {
    snapshotType: 'page_action_writeback',
    module,
    pageId: input.pageId ?? null,
    pageLabel: input.pageLabel ?? null,
    actionResourceType: resourceType,
    actionRecord: compactRecord(record),
    jobs,
    approvalGates,
    executionMode,
    policyDecision,
    approvalStatus,
    executionReady,
    targetSystem,
  };
}

export function registerAgentTools(tools: Map<string, AgentTool>) {
  tools.set('workspace_intelligence_snapshot', {
    name: 'workspace_intelligence_snapshot',
    version: '2.0.0',
    risk: 'read',
    autonomy: 'always_safe',
    description: 'Reads workspace-wide metrics, onboarding context, and recent agent activity.',
    execute: async (input, context) => workspaceIntelligenceSnapshot(input as AgentSnapshotInput, context.workspaceId),
  });

  tools.set('record_resource_snapshot', {
    name: 'record_resource_snapshot',
    version: '2.0.0',
    risk: 'read',
    autonomy: 'always_safe',
    description: 'Reads the page-relevant record collections and summarizes live operational state.',
    execute: async (input, context) => recordResourceSnapshot(input as AgentSnapshotInput, context.workspaceId),
  });

  tools.set('email_operations_snapshot', {
    name: 'email_operations_snapshot',
    version: '1.0.0',
    risk: 'read',
    autonomy: 'always_safe',
    description: 'Reads email accounts, inbox state, drafts, and automation rules.',
    execute: async (input, context) => emailOperationsSnapshot(input as AgentSnapshotInput, context.workspaceId),
  });

  tools.set('calendar_operations_snapshot', {
    name: 'calendar_operations_snapshot',
    version: '1.0.0',
    risk: 'read',
    autonomy: 'always_safe',
    description: 'Reads calendar accounts, upcoming events, and sync health.',
    execute: async (input, context) => calendarOperationsSnapshot(input as AgentSnapshotInput, context.workspaceId),
  });

  tools.set('website_operations_snapshot', {
    name: 'website_operations_snapshot',
    version: '1.0.0',
    risk: 'read',
    autonomy: 'always_safe',
    description: 'Reads website, SEO, GEO, AEO, and related publishing state.',
    execute: async (input, context) => websiteOperationsSnapshot(input as AgentSnapshotInput, context.workspaceId),
  });

  tools.set('ai_workspace_snapshot', {
    name: 'ai_workspace_snapshot',
    version: '1.0.0',
    risk: 'read',
    autonomy: 'always_safe',
    description: 'Reads AI runs, knowledge snapshots, and AI-related workspace records.',
    execute: async (input, context) => aiWorkspaceSnapshot(input as AgentSnapshotInput, context.workspaceId),
  });

  tools.set('reputation_snapshot', {
    name: 'reputation_snapshot',
    version: '1.0.0',
    risk: 'read',
    autonomy: 'always_safe',
    description: 'Reads review-related records, Google connection state, and reputation knowledge.',
    execute: async (input, context) => reputationSnapshot(input as AgentSnapshotInput, context.workspaceId),
  });

  tools.set('page_action_writeback', {
    name: 'page_action_writeback',
    version: '1.0.0',
    risk: 'write',
    autonomy: 'autonomous_only',
    description: 'Creates an approval-gated action packet record for the page-specific backend specialist.',
    execute: async (input, context) => pageActionWriteback(input as AgentSnapshotInput, context.workspaceId, context.userId),
  });
}
