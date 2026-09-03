import { logger } from '../../config/logger.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import {
  automaticPageProfiles,
  buildPageAgentGoal,
  resolveAgentModule,
  type AgentPageContext,
} from './agent.page-context.js';
import { startAutomaticRun } from './agent.service.js';
import { modulesReactingToResourceType } from './agent.graph.js';

const REACTIVE_DEDUPE_MINUTES = 30;

// Derived/audit resource types that agents produce as output. Reacting to these
// would create self-reinforcing loops, so they are excluded from reactive triggers.
const IGNORED_RESOURCE_TYPES = new Set<string>([
  'activities',
  'ai_actions',
  'ai_activity',
  'ai_recommendations',
  'ai_optimizations',
  'ai_insights',
  'reports',
  'kpis',
  'forecasts',
  'trends',
  'benchmarks',
  'comparisons',
  'anomalies',
  'decisions',
  'risk_items',
  'growth_opportunities',
  'intelligence_signals',
]);

let started = false;

async function reactToRecordCreated(workspaceId: string, resourceType: string) {
  if (IGNORED_RESOURCE_TYPES.has(resourceType)) return;
  const modules = modulesReactingToResourceType(resourceType);
  if (modules.length === 0) return;
  const pages = automaticPageProfiles.filter((page: AgentPageContext) =>
    modules.includes(resolveAgentModule('general', page)),
  );
  for (const page of pages) {
    const module = resolveAgentModule('general', page);
    const goal = buildPageAgentGoal(page);
    try {
      await startAutomaticRun(workspaceId, goal, module, page, REACTIVE_DEDUPE_MINUTES);
    } catch (error) {
      logger.warn({ error, workspaceId, pageId: page.pageId, resourceType }, 'Reactive agent trigger failed');
    }
  }
}

async function reactToIntegrationConnected(workspaceId: string, category: string, provider: string) {
  const terms = [category, provider].map((value) => value.trim().toLowerCase()).filter(Boolean);
  const pages = automaticPageProfiles.filter((page) => {
    const haystack = `${page.sectionLabel} ${page.pageLabel} ${page.integrations.join(' ')}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });
  for (const page of pages) {
    const module = resolveAgentModule('general', page);
    try {
      await startAutomaticRun(workspaceId, buildPageAgentGoal(page), module, page, REACTIVE_DEDUPE_MINUTES);
    } catch (error) {
      logger.warn({ error, workspaceId, pageId: page.pageId, category, provider }, 'Integration-connected agent trigger failed');
    }
  }
}

export function startReactiveDispatcher() {
  if (started) return;
  started = true;
  registerDomainEventHandler({
    name: 'agents.reactive-record-created.v1',
    eventTypes: [DOMAIN_EVENT_TYPES.RECORD_CREATED, DOMAIN_EVENT_TYPES.INTEGRATION_CONNECTED],
    async handle(event) {
      if (!event.workspaceId) return { ignored: true };
      if (event.type === DOMAIN_EVENT_TYPES.RECORD_CREATED) {
        const resourceType = typeof event.payload.resourceType === 'string' ? event.payload.resourceType : null;
        if (!resourceType) return { ignored: true };
        await reactToRecordCreated(event.workspaceId, resourceType);
        return { triggered: true, resourceType };
      }
      const category = typeof event.payload.category === 'string' ? event.payload.category : '';
      const provider = typeof event.payload.provider === 'string'
        ? event.payload.provider
        : typeof event.payload.integrationKey === 'string' ? event.payload.integrationKey : '';
      await reactToIntegrationConnected(event.workspaceId, category, provider);
      return { triggered: true, category, provider };
    },
  });
  logger.info('Reactive cross-agent event consumer registered');
}
