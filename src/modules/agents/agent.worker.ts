import { logger } from '../../config/logger.js';
import * as repo from './agent.repo.js';
import { automaticPageProfiles, buildPageAgentGoal, prepareAutomaticAgentTeam, startAutomaticRun } from './agent.service.js';
import { startReactiveDispatcher } from './agent.reactive.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';

const intervalMs = 15 * 60 * 1000;
const dedupeMinutes = 6 * 60;
let timer: NodeJS.Timeout | undefined;
let running = false;

async function requestAutomaticAnalysisCycle() {
  const bucket = Math.floor(Date.now() / intervalMs);
  await appendDomainEvent({
    type: DOMAIN_EVENT_TYPES.AGENT_AUTOMATIC_CYCLE_REQUESTED,
    aggregateType: 'agent_scheduler',
    aggregateId: 'automatic-analysis',
    payload: { scheduledAt: new Date().toISOString() },
    metadata: { source: 'agent.scheduler' },
    idempotencyKey: `schedule:agent-automatic-analysis:${bucket}`,
  });
}

export async function runAutomaticAnalysisCycle() {
  if (running) return;
  running = true;
  try {
    const targets = await repo.listAutomatedTargets();
    for (const target of targets) {
      const prepared = await prepareAutomaticAgentTeam(target.workspace_id, 'scheduled');
      const selectedAgentIds = prepared.selection.allAgents.map((entry) => entry.definition.id);
      for (const selected of prepared.selection.specialists) {
        const page = automaticPageProfiles.find((profile) => profile.pageId === selected.definition.pageId);
        if (!page) continue;
        const goal = buildPageAgentGoal(page);
        const pageDedupeMinutes = selected.reasons.includes('recovery required') ? 15 : dedupeMinutes;
        if (await repo.getRecentPageRun(target.workspace_id, page.pageId, pageDedupeMinutes)) continue;
        await startAutomaticRun(
          target.workspace_id,
          goal,
          selected.definition.module,
          page,
          pageDedupeMinutes,
          target.actor_user_id ?? undefined,
          {
            cycleId: prepared.cycle!.id,
            selectedAgentIds,
            selectionReason: selected.reasons,
          },
        );
      }
    }
  } catch (error) {
    logger.error({ error }, 'Automatic AI analysis cycle failed');
  } finally {
    running = false;
  }
}

export function startAutomaticAnalysisWorker() {
  if (timer) return;
  startReactiveDispatcher();
  registerDomainEventHandler({
    name: 'agents.automatic-analysis-cycle.v1',
    eventTypes: [DOMAIN_EVENT_TYPES.AGENT_AUTOMATIC_CYCLE_REQUESTED],
    async handle() {
      await runAutomaticAnalysisCycle();
      return { completed: true };
    },
  });
  timer = setInterval(() => void requestAutomaticAnalysisCycle().catch((error: unknown) => {
    logger.error({ error }, 'Automatic AI analysis schedule event could not be published');
  }), intervalMs);
  timer.unref();
  void requestAutomaticAnalysisCycle().catch((error: unknown) => {
    logger.error({ error }, 'Initial automatic AI analysis schedule event could not be published');
  });
  logger.info({ intervalMs }, 'Automatic AI analysis worker started');
}

export function stopAutomaticAnalysisWorker() {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}
