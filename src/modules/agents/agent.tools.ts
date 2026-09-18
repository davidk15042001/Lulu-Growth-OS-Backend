import { isResourceType, type ResourceType } from '../../domain/resource-catalog.js';
import { registerAgentActionPacket, type AgentExecutionIdentity } from './agent.authorization.js';
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
import { AppError } from '../../utils/app-error.js';
import { assertAdBudgetAuthorization } from '../adspend/adspend.repo.js';
import * as commerceService from '../commerce/commerce.service.js';
import * as financeRepo from '../finance/journal.repo.js';
import * as socialPublishingService from '../social-publishing/social-publishing.service.js';
import {
  applyExecutionCommandPolicies,
  listAgentExecutionCommandTypes,
  normalizeAgentExecutionCommands,
  summarizeExecutionReviewReason,
  type AgentExecutionCommand,
} from './agent.execution-command.js';
import { assessAgentReasoningQuality } from '../quality/agent-quality-gate.js';

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
  commands?: unknown;
  accountId?: unknown;
  conversationId?: unknown;
  messageText?: unknown;
  messageType?: unknown;
  recipientId?: unknown;
  recipientType?: unknown;
  threadId?: unknown;
  tone?: unknown;
  language?: unknown;
  instruction?: unknown;
  to?: unknown;
  cc?: unknown;
  subject?: unknown;
  bodyText?: unknown;
  draftId?: unknown;
  emailAction?: unknown;
  replyToProviderMessageId?: unknown;
  reviewId?: unknown;
  locationId?: unknown;
  comment?: unknown;
  siteId?: unknown;
  jobId?: unknown;
  provider?: unknown;
  eventTitle?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  timezone?: unknown;
  location?: unknown;
  customerId?: unknown;
  companyId?: unknown;
  orderId?: unknown;
  orderAction?: unknown;
  orderTargetStatus?: unknown;
  orderExpectedVersion?: unknown;
  fulfillmentId?: unknown;
  fulfillmentAction?: unknown;
  fulfillmentTargetStatus?: unknown;
  fulfillmentExpectedVersion?: unknown;
  fulfillmentExpectedOrderVersion?: unknown;
  fulfillmentCarrier?: unknown;
  fulfillmentTrackingNumber?: unknown;
  fulfillmentTrackingUrl?: unknown;
  fulfillmentNotes?: unknown;
  fulfillmentLines?: unknown;
  commerceAction?: unknown;
  commercePayload?: unknown;
  invoiceId?: unknown;
  invoiceAction?: unknown;
  providerConnectionId?: unknown;
  domainId?: unknown;
  customerRecordId?: unknown;
  companyRecordId?: unknown;
  leadRecordId?: unknown;
  opportunityRecordId?: unknown;
  factoryId?: unknown;
  marketCode?: unknown;
  currency?: unknown;
  validUntil?: unknown;
  shippingTotal?: unknown;
  terms?: unknown;
  quoteLines?: unknown;
  conversationIdForQuote?: unknown;
  quoteId?: unknown;
  quoteAction?: unknown;
  socialAccountId?: unknown;
  contentType?: unknown;
  contentMessage?: unknown;
  contentLinkUrl?: unknown;
  contentMediaUrl?: unknown;
  contentAltText?: unknown;
  scheduledAt?: unknown;
  maxAttempts?: unknown;
  delegatedContext?: unknown;
  noActionReason?: unknown;
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
  if (module === 'email' || module === 'calendar' || module === 'omnichannel' || module === 'communication') return 'communication';
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
  const [base, records, canonicalOperations] = await Promise.all([
    loadWorkspaceBase(workspaceId),
    loadRecordSnapshot(workspaceId, resourceTypes),
    canonicalOperationsSnapshot(compactText(input.module, 40), workspaceId),
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
    canonicalOperations,
  };
}

async function canonicalOperationsSnapshot(module: string, workspaceId: string) {
  if (module === 'commerce') {
    const [orders, locations, inventory] = await Promise.all([
      commerceService.listOrders(workspaceId, { page: 1, limit: 25, sort: 'updatedAt', order: 'desc' }),
      commerceService.listInventoryLocations(workspaceId),
      commerceService.listInventoryLevels(workspaceId, { page: 1, limit: 50 }),
    ]);
    return {
      type: 'canonical_commerce',
      orders: {
        total: orders.pagination.total,
        items: orders.items.map((order) => ({
          id: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          customerRecordId: order.customerRecordId,
          companyRecordId: order.companyRecordId,
          quoteId: order.quoteId,
          currency: order.currency,
          grandTotal: order.grandTotal,
          lineCount: order.lineCount,
          version: order.version,
          updatedAt: order.updatedAt,
        })),
      },
      inventory: {
        total: inventory.pagination.total,
        locations: locations.map((location) => ({
          id: location.id,
          code: location.code,
          name: location.name,
          status: location.status,
          isDefault: location.isDefault,
          version: location.version,
        })),
        levels: inventory.items.map((level) => ({
          id: level.id,
          locationId: level.locationId,
          productId: level.productId,
          variantId: level.variantId,
          onHand: level.onHand,
          reserved: level.reserved,
          available: level.available,
          reorderPoint: level.reorderPoint,
          version: level.version,
        })),
      },
    };
  }

  if (module === 'finance') {
    const journals = await financeRepo.listJournals(workspaceId, { page: 1, limit: 25 });
    const currencies = [...new Set(journals.items.map((journal) => journal.currency))].slice(0, 4);
    const trialBalances = await Promise.all(currencies.map((currency) => financeRepo.getTrialBalance(workspaceId, currency)));
    return {
      type: 'canonical_finance',
      journals: {
        total: journals.pagination.total,
        items: journals.items.map((journal) => ({
          id: journal.id,
          journalType: journal.journalType,
          currency: journal.currency,
          totalDebitsMinor: journal.totalDebitsMinor,
          totalCreditsMinor: journal.totalCreditsMinor,
          referenceType: journal.referenceType,
          referenceId: journal.referenceId,
          occurredAt: journal.occurredAt,
        })),
      },
      trialBalances,
    };
  }

  if (module === 'marketing') {
    const [accounts, content, publications] = await Promise.all([
      socialPublishingService.listAccounts(workspaceId),
      socialPublishingService.listContent(workspaceId),
      socialPublishingService.listPublicationJobs(workspaceId),
    ]);
    return {
      type: 'canonical_social_publishing',
      accounts: accounts.map((account) => ({
        id: account.id,
        provider: account.provider,
        displayName: account.displayName,
        status: account.status,
        version: account.version,
        statusReason: account.statusReason,
      })),
      content: content.slice(0, 25).map((item) => ({
        id: item.id,
        contentType: item.contentType,
        status: item.status,
        message: compactText(item.message, 500),
        linkUrl: item.linkUrl,
        mediaUrl: item.mediaUrl,
        version: item.version,
      })),
      publications: publications.slice(0, 25).map((job) => ({
        id: job.id,
        socialAccountId: job.socialAccountId,
        contentId: job.contentId,
        status: job.status,
        scheduledAt: job.scheduledAt,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        blockCode: job.blockCode,
        version: job.version,
      })),
    };
  }

  return null;
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

async function pageActionWriteback(input: AgentSnapshotInput, workspaceId: string, userId: string, identity: AgentExecutionIdentity) {
  const resourceType = normalizeActionResourceType(input.actionResourceType);
  const jobs = parseStringList(input.jobs);
  const approvalGates = parseStringList(input.approvalGates);
  const pageLabel = compactText(input.pageLabel, 120) || 'Page agent';
  const module = compactText(input.module, 40) || 'general';
  const goal = compactText(input.goal, 400);
  const executionMode = compactText(input.executionMode, 40) || 'analysis_only';
  const policyDecision = compactText((input as Record<string, unknown>).policyDecision, 40) || 'allow';
  const approvedBy = null;
  const approvedAt = null;
  const targetSystem = resolveTargetSystem(module, resourceType);
  const delegatedContext = Array.isArray(input.delegatedContext)
    ? input.delegatedContext.slice(-4)
    : [];
  if (Array.isArray(input.commands) && input.commands.length === 0) {
    return {
      snapshotType: 'page_action_noop',
      module,
      pageId: input.pageId ?? null,
      pageLabel: input.pageLabel ?? null,
      actionResourceType: resourceType,
      executionMode,
      policyDecision,
      executionReady: false,
      commandTypes: [],
      noAction: true,
      noActionReason: compactText(input.noActionReason, 1000) || 'No evidence-backed executable command was available.',
      delegatedContext,
    };
  }
  if (executionMode === 'autonomous' && Array.isArray(input.commands) && input.commands.length > 0) {
    const quality = assessAgentReasoningQuality({
      taskType: 'materialize_execution_commands',
      availableEvidence: delegatedContext,
      result: { commands: input.commands },
    });
    if (!quality.passed) {
      throw new AppError(422, 'AGENT_QUALITY_GATE_BLOCKED', quality.issues.slice(0, 4).join('; ') || 'The autonomous action is not grounded in sufficient evidence.');
    }
  }
  const normalizedCommands = normalizeAgentExecutionCommands(input.commands, {
    module,
    targetSystem,
    actionResourceType: resourceType,
    pageId: compactText(input.pageId, 120) || null,
    pageLabel,
    goal,
    jobs,
    policyDecision: policyDecision === 'allow' ? 'allow' : 'require_budget',
    executionMode: executionMode === 'autonomous' ? 'autonomous' : 'analysis_only',
    accountId: compactText(input.accountId, 120) || null,
    conversationId: compactText(input.conversationId, 120) || null,
    messageText: compactText(input.messageText, 10_000) || null,
    messageType: compactText(input.messageType, 20) || null,
    recipientId: compactText(input.recipientId, 200) || null,
    recipientType: input.recipientType === 'group' || input.recipientType === 'channel' ? input.recipientType : null,
    threadId: compactText(input.threadId, 120) || null,
    tone: compactText(input.tone, 40) || null,
    language: compactText(input.language, 16) || null,
    instruction: compactText(input.instruction, 2000) || null,
    to: input.to,
    cc: input.cc,
    subject: compactText(input.subject, 998) || null,
    bodyText: compactText(input.bodyText, 100_000) || null,
    draftId: compactText(input.draftId, 120) || null,
    emailAction: input.emailAction === 'send' ? input.emailAction : null,
    replyToProviderMessageId: compactText(input.replyToProviderMessageId, 1000) || null,
    reviewId: compactText(input.reviewId, 200) || null,
    locationId: compactText(input.locationId, 200) || null,
    comment: compactText(input.comment, 4000) || null,
    siteId: compactText(input.siteId, 120) || null,
    jobId: compactText(input.jobId, 120) || null,
    provider: compactText(input.provider, 80) || null,
    eventTitle: compactText(input.eventTitle, 240) || null,
    startAt: compactText(input.startAt, 80) || null,
    endAt: compactText(input.endAt, 80) || null,
    timezone: compactText(input.timezone, 100) || null,
    location: compactText(input.location, 500) || null,
    customerId: compactText(input.customerId, 120) || null,
    companyId: compactText(input.companyId, 120) || null,
    orderId: compactText(input.orderId, 120) || null,
    orderAction: input.orderAction === 'transition' ? input.orderAction : null,
    orderTargetStatus: input.orderTargetStatus === 'PLACED' || input.orderTargetStatus === 'CONFIRMED' || input.orderTargetStatus === 'PROCESSING' || input.orderTargetStatus === 'CANCELLED' ? input.orderTargetStatus : null,
    orderExpectedVersion: typeof input.orderExpectedVersion === 'number' && Number.isInteger(input.orderExpectedVersion) ? input.orderExpectedVersion : null,
    fulfillmentId: compactText(input.fulfillmentId, 120) || null,
    fulfillmentAction: input.fulfillmentAction === 'create' || input.fulfillmentAction === 'transition' ? input.fulfillmentAction : null,
    fulfillmentTargetStatus: input.fulfillmentTargetStatus === 'PROCESSING' || input.fulfillmentTargetStatus === 'SHIPPED' || input.fulfillmentTargetStatus === 'DELIVERED' || input.fulfillmentTargetStatus === 'CANCELLED' ? input.fulfillmentTargetStatus : null,
    fulfillmentExpectedVersion: typeof input.fulfillmentExpectedVersion === 'number' && Number.isInteger(input.fulfillmentExpectedVersion) ? input.fulfillmentExpectedVersion : null,
    fulfillmentExpectedOrderVersion: typeof input.fulfillmentExpectedOrderVersion === 'number' && Number.isInteger(input.fulfillmentExpectedOrderVersion) ? input.fulfillmentExpectedOrderVersion : null,
    fulfillmentCarrier: compactText(input.fulfillmentCarrier, 200) || null,
    fulfillmentTrackingNumber: compactText(input.fulfillmentTrackingNumber, 300) || null,
    fulfillmentTrackingUrl: compactText(input.fulfillmentTrackingUrl, 4_000) || null,
    fulfillmentNotes: compactText(input.fulfillmentNotes, 5_000) || null,
    fulfillmentLines: Array.isArray(input.fulfillmentLines) ? input.fulfillmentLines.slice(0, 500) : null,
    commerceAction: input.commerceAction === 'order.create' || input.commerceAction === 'order.update' || input.commerceAction === 'inventory.adjust' ? input.commerceAction : null,
    commercePayload: input.commercePayload && typeof input.commercePayload === 'object' && !Array.isArray(input.commercePayload) ? input.commercePayload as Record<string, unknown> : null,
    invoiceId: compactText(input.invoiceId, 120) || null,
    invoiceAction: input.invoiceAction === 'issue' || input.invoiceAction === 'send' ? input.invoiceAction : null,
    providerConnectionId: compactText(input.providerConnectionId, 120) || null,
    domainId: compactText(input.domainId, 120) || null,
    customerRecordId: compactText(input.customerRecordId, 120) || null,
    companyRecordId: compactText(input.companyRecordId, 120) || null,
    leadRecordId: compactText(input.leadRecordId, 120) || null,
    opportunityRecordId: compactText(input.opportunityRecordId, 120) || null,
    factoryId: compactText(input.factoryId, 120) || null,
    marketCode: compactText(input.marketCode, 20) || null,
    currency: compactText(input.currency, 3) || null,
    validUntil: compactText(input.validUntil, 10) || null,
    shippingTotal: typeof input.shippingTotal === 'number' || typeof input.shippingTotal === 'string' ? input.shippingTotal : null,
    terms: input.terms,
    quoteLines: Array.isArray(input.quoteLines) ? input.quoteLines.slice(0, 500) : null,
    conversationIdForQuote: compactText(input.conversationIdForQuote, 120) || null,
    quoteId: compactText(input.quoteId, 120) || null,
    quoteAction: input.quoteAction === 'send' ? input.quoteAction : null,
    socialAccountId: compactText(input.socialAccountId, 120) || null,
    contentType: input.contentType === 'TEXT' || input.contentType === 'LINK' || input.contentType === 'IMAGE' ? input.contentType : null,
    contentMessage: compactText(input.contentMessage, 63_206) || null,
    contentLinkUrl: compactText(input.contentLinkUrl, 2_048) || null,
    contentMediaUrl: compactText(input.contentMediaUrl, 2_048) || null,
    contentAltText: compactText(input.contentAltText, 1_000) || null,
    scheduledAt: compactText(input.scheduledAt, 80) || null,
    maxAttempts: typeof input.maxAttempts === 'number' && Number.isInteger(input.maxAttempts) ? input.maxAttempts : null,
  });
  const customerBudgetCommands = normalizedCommands.filter(
    (command) => command.budgetAuthority === 'customer_authorization_required',
  );
  for (const command of customerBudgetCommands) {
    const payload = command.payload;
    const authorizationId = compactText(payload.authorizationId, 120);
    const provider = compactText(command.provider ?? payload.provider, 80);
    const accountId = compactText(payload.accountId ?? payload.customerId, 200);
    const campaignId = compactText(payload.campaignId ?? command.targetEntityId, 200);
    const currency = compactText(payload.currency ?? payload.accountCurrency, 3).toUpperCase();
    const amount = typeof payload.budgetAmountCny === 'number'
      ? payload.budgetAmountCny
      : Number(payload.budgetAmountCny);
    if (!authorizationId || !provider || !accountId || !campaignId || !currency || !Number.isFinite(amount) || amount <= 0) {
      throw new AppError(409, 'AD_BUDGET_AUTHORIZATION_REQUIRED', 'Paid advertising requires an explicit customer authorization matching provider, account, campaign, currency and amount.');
    }
    await assertAdBudgetAuthorization({ workspaceId, authorizationId, provider, accountId, campaignId, currency, amount });
  }
  const commandPolicy = applyExecutionCommandPolicies(
    normalizedCommands,
    executionMode === 'autonomous' ? 'autonomous' : 'analysis_only',
    { verifiedCustomerBudget: customerBudgetCommands.length > 0 },
  );
  const budgetProtected = commandPolicy.commands.some(
    (command) => command.budgetAuthority === 'customer_authorization_required',
  );
  const commands: AgentExecutionCommand[] = commandPolicy.commands.map(({ policyDecision: commandDecision, policyReason: _policyReason, ...command }) => ({
    ...command,
    approvalPolicy: commandDecision === 'allow' ? 'allow' : 'budget_required',
  }));
  const hasForbiddenCommand = commandPolicy.commands.some((command) => command.policyDecision === 'forbidden');
  if(hasForbiddenCommand)throw new AppError(403,'AGENT_COMMAND_FORBIDDEN',commandPolicy.reasons.join(' ')||'The command is not registered for autonomous execution.');
  if(commandPolicy.overallDecision==='require_budget')throw new AppError(409,'CUSTOMER_BUDGET_REQUIRED','Customer campaign budget authorization is required before this action can run.');
  const effectivePolicyDecision = 'allow' as const;
  const executionReady = true;
  const approvalStatus = 'not_required';
  const commandTypes = listAgentExecutionCommandTypes(commands);
  const requiresHumanReviewReason = summarizeExecutionReviewReason(commands, effectivePolicyDecision, commandPolicy.reasons);
  const record = await recordRepo.createRecord(workspaceId, resourceType, userId, {
    name: `${pageLabel} autonomous action packet`,
    description: compactText(goal || `Backend action packet for ${pageLabel}.`, 500),
    status: 'approved',
    stage: 'queued_for_execution',
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
      policyDecision: effectivePolicyDecision,
      approvalStatus,
      executionReady: true,
      executionStatus: 'queued',
      targetSystem,
      targetModule: module,
      eventTitle: input.eventTitle ?? null,
      startAt: input.startAt ?? null,
      endAt: input.endAt ?? null,
      timezone: input.timezone ?? null,
      location: input.location ?? null,
      customerId: input.customerId ?? null,
      companyId: input.companyId ?? null,
      orderId: input.orderId ?? null,
      orderAction: input.orderAction ?? null,
      orderTargetStatus: input.orderTargetStatus ?? null,
      orderExpectedVersion: input.orderExpectedVersion ?? null,
      fulfillmentId: input.fulfillmentId ?? null,
      fulfillmentAction: input.fulfillmentAction ?? null,
      fulfillmentTargetStatus: input.fulfillmentTargetStatus ?? null,
      fulfillmentExpectedVersion: input.fulfillmentExpectedVersion ?? null,
      fulfillmentExpectedOrderVersion: input.fulfillmentExpectedOrderVersion ?? null,
      fulfillmentCarrier: input.fulfillmentCarrier ?? null,
      fulfillmentTrackingNumber: input.fulfillmentTrackingNumber ?? null,
      fulfillmentTrackingUrl: input.fulfillmentTrackingUrl ?? null,
      fulfillmentNotes: input.fulfillmentNotes ?? null,
      fulfillmentLines: Array.isArray(input.fulfillmentLines) ? input.fulfillmentLines.slice(0, 500) : null,
      commerceAction: input.commerceAction ?? null,
      commercePayload: input.commercePayload && typeof input.commercePayload === 'object' && !Array.isArray(input.commercePayload) ? input.commercePayload : null,
      invoiceId: input.invoiceId ?? null,
      invoiceAction: input.invoiceAction ?? null,
      draftId: input.draftId ?? null,
      emailAction: input.emailAction ?? null,
      customerRecordId: input.customerRecordId ?? null,
      companyRecordId: input.companyRecordId ?? null,
      leadRecordId: input.leadRecordId ?? null,
      opportunityRecordId: input.opportunityRecordId ?? null,
      factoryId: input.factoryId ?? null,
      marketCode: input.marketCode ?? null,
      currency: input.currency ?? null,
      validUntil: input.validUntil ?? null,
      shippingTotal: input.shippingTotal ?? null,
      terms: input.terms ?? null,
      quoteLines: Array.isArray(input.quoteLines) ? input.quoteLines.slice(0, 500) : null,
      conversationIdForQuote: input.conversationIdForQuote ?? null,
      quoteId: input.quoteId ?? null,
      quoteAction: input.quoteAction ?? null,
      providerConnectionId: input.providerConnectionId ?? null,
      domainId: input.domainId ?? null,
      commands,
      delegatedContext,
      commandTypes,
      primaryCommandType: commandTypes[0] ?? null,
      requiresHumanReviewReason,
      budgetProtected,
      approvedBy,
      approvedAt,
      approvedAutomatically: executionReady,
      createdByAgent: true,
      createdAt: new Date().toISOString(),
    },
  });
  const authorization = await registerAgentActionPacket(identity,record,commands);
  const resolvedPolicyDecision = authorization.executionReady ? 'allow' : effectivePolicyDecision;
  const authorizedRecord=await recordRepo.findRecord(workspaceId,resourceType,record.id);
  return {
    snapshotType: 'page_action_writeback',
    module,
    pageId: input.pageId ?? null,
    pageLabel: input.pageLabel ?? null,
    actionResourceType: resourceType,
    actionRecord: compactRecord(authorizedRecord??record),
    jobs,
    approvalGates,
    executionMode,
    policyDecision: resolvedPolicyDecision,
    approvalStatus: 'not_required',
    executionReady: authorization.executionReady,
    approvalId: authorization.approvalId,
    targetSystem,
    commandTypes,
    requiresHumanReviewReason,
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
    description: 'Creates an autonomous action packet for the page-specific backend specialist.',
    execute: async (input, context) => pageActionWriteback(input as AgentSnapshotInput, context.workspaceId, context.userId, context),
  });
}
