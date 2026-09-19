import { logger } from '../../config/logger.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { findDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES, type DomainEvent } from '../../events/domain-event.types.js';
import type { AgentModule } from './agent.capabilities.js';
import { automaticPageProfiles, type AgentPageContext } from './agent.page-context.js';
import { prepareAutomaticAgentTeam, startAutomaticRun, type AgentTeamContext } from './agent.service.js';
import { modulesReactingToResourceType } from './agent.graph.js';
import { assertApiWalletFunded, isApiWalletMeteredWorkspace } from '../api-wallet/api-wallet.repo.js';
import {
  claimWorkspaceReactiveDeferrals,
  countOutstandingReactiveDeferrals,
  deferReactiveEvent,
  markReactiveDeferralResumed,
  releaseReactiveDeferral,
} from './agent-reactive-deferral.repo.js';
import { isWorkspaceAutomationPaused } from '../workspaces/workspace-automation.service.js';

const REACTIVE_DEDUPE_MINUTES = 30;

export type ReactiveTarget = {
  modules: AgentModule[];
  pageIds?: string[];
  instruction: string;
};

// These responsibilities point at existing canonical Workspace employees. The
// run uses the same services, policies and records as the corresponding UI.
const EVENT_TARGETS: Readonly<Record<string, ReactiveTarget>> = Object.freeze({
  [DOMAIN_EVENT_TYPES.MESSAGE_RECEIVED]: {
    modules: ['email', 'crm', 'sales'],
    pageIds: ['email-inbox', 'sturdy-month-1562'],
    instruction: 'understand intent, update customer context and coordinate the permitted response and follow-up',
  },
  [DOMAIN_EVENT_TYPES.CONVERSATION_ESCALATED]: {
    modules: ['email', 'crm'],
    pageIds: ['email-inbox', 'sturdy-month-1562'],
    instruction: 'resolve the escalation using the complete conversation and customer context',
  },
  [DOMAIN_EVENT_TYPES.QUOTE_CREATED]: {
    modules: ['finance', 'sales'],
    pageIds: ['tender-creek-3139'],
    instruction: 'verify quote completeness, commercial consistency and the next permitted sales step',
  },
  [DOMAIN_EVENT_TYPES.QUOTE_ACCEPTED]: {
    modules: ['commerce', 'finance'],
    pageIds: ['mightily-shore-7108', 'breezy-soil-2475'],
    instruction: 'coordinate canonical order and invoicing follow-through without duplicating the accepted quote',
  },
  [DOMAIN_EVENT_TYPES.INVOICE_CREATED]: {
    modules: ['finance'],
    pageIds: ['breezy-soil-2475'],
    instruction: 'verify the invoice and perform the next permitted collection step',
  },
  [DOMAIN_EVENT_TYPES.INVOICE_OVERDUE]: {
    modules: ['finance', 'sales'],
    pageIds: ['breezy-soil-2475'],
    instruction: 'coordinate evidence-backed collection and customer follow-up',
  },
  [DOMAIN_EVENT_TYPES.INVOICE_PARTIALLY_PAID]: {
    modules: ['finance'],
    pageIds: ['calm-tide-3752'],
    instruction: 'reconcile the partial payment and maintain the remaining receivable',
  },
  [DOMAIN_EVENT_TYPES.INVOICE_PAID]: {
    modules: ['finance'],
    pageIds: ['calm-tide-3752'],
    instruction: 'verify reconciliation and continue the canonical post-payment workflow',
  },
  [DOMAIN_EVENT_TYPES.PRODUCT_CREATED]: {
    modules: ['commerce', 'marketing'],
    pageIds: ['nicely-ocean-1051'],
    instruction: 'verify catalog quality and coordinate missing market-ready product assets',
  },
  [DOMAIN_EVENT_TYPES.PRODUCT_UPDATED]: {
    modules: ['commerce'],
    pageIds: ['nicely-ocean-1051'],
    instruction: 'verify the changed product data and dependent commerce state',
  },
  [DOMAIN_EVENT_TYPES.PREMIUM_MEDIA_COMPLETED]: {
    modules: ['commerce', 'website', 'marketing'],
    pageIds: ['nicely-ocean-1051', 'website-media-assets-9017'],
    instruction: 'attach and distribute the verified premium asset where it is relevant',
  },
  [DOMAIN_EVENT_TYPES.PREMIUM_MEDIA_FAILED]: {
    modules: ['commerce', 'website'],
    pageIds: ['nicely-ocean-1051', 'website-media-assets-9017'],
    instruction: 'diagnose the failed media job and use a safe retry or fallback',
  },
  [DOMAIN_EVENT_TYPES.WEBSITE_GENERATION_COMPLETED]: {
    modules: ['website', 'marketing'],
    pageIds: ['website-pages-cms-9015'],
    instruction: 'verify the published online presence and coordinate the next measurable improvement',
  },
  [DOMAIN_EVENT_TYPES.WEBSITE_GENERATION_FAILED]: {
    modules: ['website'],
    pageIds: ['website-pages-cms-9015'],
    instruction: 'diagnose the failed website operation and recover without publishing unverified content',
  },
  [DOMAIN_EVENT_TYPES.CALENDAR_SYNC_COMPLETED]: {
    modules: ['calendar', 'sales'],
    pageIds: ['calendar-overview'],
    instruction: 'evaluate new commitments and keep related follow-ups current',
  },
  [DOMAIN_EVENT_TYPES.CALENDAR_SYNC_FAILED]: {
    modules: ['calendar', 'settings'],
    pageIds: ['calendar-overview', 'fresh-tide-9404'],
    instruction: 'diagnose the calendar failure and preserve scheduled commitments',
  },
  [DOMAIN_EVENT_TYPES.EMAIL_SYNC_COMPLETED]: {
    modules: ['email', 'crm'],
    pageIds: ['email-inbox'],
    instruction: 'triage new inbound work and update customer context',
  },
  [DOMAIN_EVENT_TYPES.EMAIL_SYNC_FAILED]: {
    modules: ['email', 'settings'],
    pageIds: ['email-settings', 'fresh-tide-9404'],
    instruction: 'diagnose the inbox failure while preserving unsent work',
  },
  [DOMAIN_EVENT_TYPES.PROVIDER_CONNECTION_ERROR]: {
    modules: ['settings'],
    pageIds: ['fresh-tide-9404'],
    instruction: 'diagnose the provider connection and recover without weakening permissions',
  },
  [DOMAIN_EVENT_TYPES.PROVIDER_SYNC_FAILED]: {
    modules: ['settings'],
    pageIds: ['fresh-tide-9404'],
    instruction: 'diagnose the provider sync and safely recover incomplete work',
  },
  [DOMAIN_EVENT_TYPES.ORDER_CREATED]: {
    modules: ['commerce', 'finance'],
    pageIds: ['mightily-shore-7108'],
    instruction: 'verify inventory reservation, payment state and fulfillment readiness',
  },
  [DOMAIN_EVENT_TYPES.ORDER_UPDATED]: {
    modules: ['commerce', 'crm'],
    pageIds: ['mightily-shore-7108'],
    instruction: 'continue fulfillment and customer communication from the canonical order state',
  },
  [DOMAIN_EVENT_TYPES.ORDER_PLACED]: {
    modules: ['commerce', 'finance'],
    pageIds: ['mightily-shore-7108'],
    instruction: 'verify inventory, commercial terms and readiness for confirmation',
  },
  [DOMAIN_EVENT_TYPES.ORDER_CONFIRMED]: {
    modules: ['commerce', 'crm'],
    pageIds: ['mightily-shore-7108'],
    instruction: 'continue fulfillment from the reserved canonical order state and keep customer context current',
  },
  [DOMAIN_EVENT_TYPES.ORDER_PARTIALLY_FULFILLED]: {
    modules: ['commerce', 'crm'],
    pageIds: ['mightily-shore-7108'],
    instruction: 'coordinate the remaining fulfillment and accurate customer communication',
  },
  [DOMAIN_EVENT_TYPES.ORDER_FULFILLED]: {
    modules: ['commerce', 'finance', 'crm'],
    pageIds: ['mightily-shore-7108'],
    instruction: 'verify completion, financial follow-through and the next customer relationship action',
  },
  [DOMAIN_EVENT_TYPES.INVENTORY_ADJUSTED]: {
    modules: ['commerce'],
    pageIds: ['smart-village-1099'],
    instruction: 'assess availability and demand risk after the stock change without overselling',
  },
  [DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_FAILED]: {
    modules: ['marketing'],
    pageIds: ['wondrous-cloud-1355'],
    instruction: 'diagnose the failed publication and retry only when provider policy permits',
  },
  [DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_PUBLISHED]: {
    modules: ['marketing'],
    pageIds: ['wondrous-cloud-1355'],
    instruction: 'verify the live publication and record distribution outcomes',
  },
  'review.received': {
    modules: ['reputation', 'crm'],
    pageIds: ['daring-brook-9034'],
    instruction: 'understand sentiment, update customer context and prepare the permitted response',
  },
  'campaign.performance_changed': {
    modules: ['ads', 'marketing', 'intelligence'],
    instruction: 'analyze the performance change and optimize only inside settled prepaid budget authority',
  },
});

const IGNORED_RESOURCE_TYPES = new Set<string>([
  'activities', 'ai_actions', 'ai_activity', 'ai_recommendations',
  'ai_optimizations', 'ai_insights', 'reports', 'kpis', 'forecasts',
  'trends', 'benchmarks', 'comparisons', 'anomalies', 'decisions',
  'risk_items', 'growth_opportunities', 'intelligence_signals',
]);

let started = false;
let stopping = false;
const activeDispatches = new Set<Promise<unknown>>();

function trackReactiveDispatch<T>(operation: () => Promise<T>): Promise<T> | null {
  if (stopping) return null;
  const task = operation();
  activeDispatches.add(task);
  task.then(() => activeDispatches.delete(task), () => activeDispatches.delete(task));
  return task;
}

function triggerFromEvent(event: DomainEvent) {
  return {
    eventId: event.id,
    eventType: event.type,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    occurredAt: event.occurredAt,
    correlationId: event.metadata.correlationId ?? null,
  };
}

function eventInstruction(event: DomainEvent, instruction: string) {
  const subject = event.aggregateId ? `${event.aggregateType} ${event.aggregateId}` : event.aggregateType;
  return `A persisted ${event.type} event occurred for ${subject}. ${instruction}. Verify current canonical state before acting and do not repeat the source action.`;
}

function isAgentOutput(event: DomainEvent) {
  const source = typeof event.metadata.source === 'string' ? event.metadata.source.toLowerCase() : '';
  const actorType = typeof event.metadata.actorType === 'string' ? event.metadata.actorType.toUpperCase() : '';
  return source.includes('agent') || actorType === 'AI_AGENT' || event.aggregateType === 'agent_run';
}

async function runReactiveTarget(event: DomainEvent, target: ReactiveTarget) {
  if (!event.workspaceId || stopping) return 0;
  const prepared = await prepareAutomaticAgentTeam(
    event.workspaceId,
    'reactive',
    target.modules,
    target.pageIds ?? [],
  );
  const pageIds = new Set(target.pageIds ?? []);
  const selected = prepared.selection.specialists.filter((entry) => {
    if (pageIds.size > 0) return Boolean(entry.definition.pageId && pageIds.has(entry.definition.pageId));
    return target.modules.includes(entry.definition.module);
  });
  const selectedAgentIds = prepared.selection.allAgents.map((entry) => entry.definition.id);
  const trigger = triggerFromEvent(event);
  let triggered = 0;
  let firstFailure: unknown = null;
  for (const entry of selected) {
    if (stopping) break;
    const page = automaticPageProfiles.find((profile: AgentPageContext) => profile.pageId === entry.definition.pageId);
    if (!page) continue;
    const teamContext: AgentTeamContext = {
      cycleId: prepared.cycle!.id,
      selectedAgentIds,
      selectionReason: entry.reasons,
      trigger,
    };
    try {
      const run = await startAutomaticRun(
        event.workspaceId,
        eventInstruction(event, target.instruction),
        entry.definition.module,
        page,
        REACTIVE_DEDUPE_MINUTES,
        undefined,
        teamContext,
      );
      if (run) triggered += 1;
    } catch (error) {
      firstFailure ??= error;
      logger.warn({
        error,
        workspaceId: event.workspaceId,
        pageId: page.pageId,
        sourceEventId: event.id,
        sourceEventType: event.type,
      }, 'Reactive agent trigger failed');
    }
  }
  // Source-event identity makes retries idempotent. Failing the whole dispatch
  // here keeps a partially scheduled event durable instead of silently marking
  // its deferral resumed.
  if (firstFailure) throw firstFailure;
  return triggered;
}

function targetForRecordEvent(event: DomainEvent) {
  const resourceType = typeof event.payload.resourceType === 'string' ? event.payload.resourceType : null;
  const recordSource = typeof event.payload.recordSource === 'string' ? event.payload.recordSource.toLowerCase() : '';
  if (recordSource.includes('agent')) return null;
  if (!resourceType || IGNORED_RESOURCE_TYPES.has(resourceType)) return null;
  const modules = modulesReactingToResourceType(resourceType);
  if (modules.length === 0) return null;
  return {
    modules,
    instruction: `understand the ${resourceType} change and coordinate the next highest-leverage permitted action`,
  } satisfies ReactiveTarget;
}

async function hasFundedAiWallet(workspaceId: string) {
  if (!(await isApiWalletMeteredWorkspace(workspaceId))) return true;
  try {
    await assertApiWalletFunded(workspaceId);
    return true;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'AI_FUNDS_REQUIRED' || code === 'AI_FUNDS_EXHAUSTED' || code === 'AI_REVERSAL_DEBT') return false;
    throw error;
  }
}

async function dispatchFundedReactiveEvent(event: DomainEvent) {
  if (event.type === DOMAIN_EVENT_TYPES.RECORD_CREATED || event.type === DOMAIN_EVENT_TYPES.RECORD_UPDATED) {
    const target = targetForRecordEvent(event);
    if (!target) return { ignored: true };
    const triggeredRuns = await runReactiveTarget(event, target);
    return { triggered: triggeredRuns > 0, triggeredRuns, resourceType: event.payload.resourceType };
  }

  if (event.type === DOMAIN_EVENT_TYPES.INTEGRATION_CONNECTED) {
    const triggeredRuns = await runReactiveTarget(event, {
      modules: ['settings'],
      pageIds: ['fresh-tide-9404'],
      instruction: 'discover permitted capabilities and incorporate the connected system into ongoing operations',
    });
    return { triggered: triggeredRuns > 0, triggeredRuns };
  }

  if (event.type === DOMAIN_EVENT_TYPES.AD_SPEND_FUNDED) {
    const triggeredRuns = await runReactiveTarget(event, {
      modules: ['ads'],
      instruction: 'resume paid-media work only inside a settled, campaign-specific budget authorization',
    });
    return { triggered: triggeredRuns > 0, triggeredRuns, source: event.type };
  }

  const target = EVENT_TARGETS[event.type];
  if (!target) return { ignored: true };
  const triggeredRuns = await runReactiveTarget(event, target);
  return { triggered: triggeredRuns > 0, triggeredRuns, source: event.type };
}

function isActionableReactiveEvent(event: DomainEvent) {
  if (event.type === DOMAIN_EVENT_TYPES.RECORD_CREATED || event.type === DOMAIN_EVENT_TYPES.RECORD_UPDATED) {
    return Boolean(targetForRecordEvent(event));
  }
  return event.type === DOMAIN_EVENT_TYPES.INTEGRATION_CONNECTED
    || event.type === DOMAIN_EVENT_TYPES.AD_SPEND_FUNDED
    || Boolean(EVENT_TARGETS[event.type]);
}

async function resumeFundedReactiveEvents(workspaceId: string) {
  let resumed = 0;
  let failed = 0;
  // Bound each funding-event turn. A later funding event or stale-claim recovery
  // can safely continue because source-event run creation is idempotent.
  for (let batch = 0; batch < 10 && !stopping; batch += 1) {
    const deferrals = await claimWorkspaceReactiveDeferrals(workspaceId, 100);
    if (deferrals.length === 0) break;
    for (const deferral of deferrals) {
      if (stopping) break;
      try {
        const sourceEvent = await findDomainEvent(deferral.sourceEventId);
        if (sourceEvent && !isAgentOutput(sourceEvent)) await dispatchFundedReactiveEvent(sourceEvent);
        await markReactiveDeferralResumed(deferral.id);
        resumed += 1;
      } catch (error) {
        await releaseReactiveDeferral(deferral.id, error);
        failed += 1;
      }
    }
    if (deferrals.length < 100) break;
  }
  const outstanding = await countOutstandingReactiveDeferrals(workspaceId);
  if (failed > 0 || outstanding > 0) {
    throw new Error(`Reactive event resumption is incomplete (${failed} failed in this attempt, ${outstanding} still waiting).`);
  }
  return { resumed, failed };
}

const REGISTERED_EVENT_TYPES = Object.freeze([
  DOMAIN_EVENT_TYPES.RECORD_CREATED,
  DOMAIN_EVENT_TYPES.RECORD_UPDATED,
  DOMAIN_EVENT_TYPES.INTEGRATION_CONNECTED,
  DOMAIN_EVENT_TYPES.AD_SPEND_FUNDED,
  DOMAIN_EVENT_TYPES.API_FUNDS_FUNDED,
  ...Object.keys(EVENT_TARGETS),
]);

export function startReactiveDispatcher() {
  if (started) return;
  stopping = false;
  started = true;
  registerDomainEventHandler({
    name: 'agents.reactive-business-events.v2',
    eventTypes: [...new Set(REGISTERED_EVENT_TYPES)],
    async handle(event) {
      if (!event.workspaceId || isAgentOutput(event)) return { ignored: true };
      if (await isWorkspaceAutomationPaused(event.workspaceId)) return { ignored: true, paused: true };
      const dispatch = trackReactiveDispatch(async () => {
        if (event.type === DOMAIN_EVENT_TYPES.API_FUNDS_FUNDED) {
          if (!(await hasFundedAiWallet(event.workspaceId!))) return { triggered: false, waitingFor: 'ai_funds' };
          return { triggered: false, ...(await resumeFundedReactiveEvents(event.workspaceId!)), source: event.type };
        }

        if (!isActionableReactiveEvent(event)) return { ignored: true };
        if (!(await hasFundedAiWallet(event.workspaceId!))) {
          const deferral = await deferReactiveEvent(event);
          // Close the check/insert race with a concurrently committed top-up.
          if (await hasFundedAiWallet(event.workspaceId!)) {
            return { triggered: false, deferred: false, ...(await resumeFundedReactiveEvents(event.workspaceId!)) };
          }
          return { triggered: false, deferred: true, waitingFor: 'ai_funds', deferralId: deferral?.id ?? null };
        }

        return dispatchFundedReactiveEvent(event);
      });
      return dispatch ?? { ignored: true, stopping: true };
    },
  });
  logger.info('Reactive cross-agent business event consumer registered');
}

export async function stopReactiveDispatcher() {
  stopping = true;
  while (activeDispatches.size > 0) await Promise.allSettled([...activeDispatches]);
  started = false;
}

export function reactiveTargetForEvent(eventType: string) {
  return EVENT_TARGETS[eventType] ?? null;
}
