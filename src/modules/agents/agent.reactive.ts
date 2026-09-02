import { logger } from '../../config/logger.js';
import { subscribeAgentEvents } from './agent.events.js';
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

export function startReactiveDispatcher() {
  if (started) return;
  started = true;
  subscribeAgentEvents((event) => {
    if (event.type !== 'record.created' || !event.workspaceId || !event.resourceType) return;
    void reactToRecordCreated(event.workspaceId, event.resourceType);
  });
  logger.info('Reactive cross-agent dispatcher started');
}
