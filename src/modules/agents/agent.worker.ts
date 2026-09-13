import { logger } from '../../config/logger.js';
import * as repo from './agent.repo.js';
import { automaticPageProfiles, buildPageAgentGoal, prepareAutomaticAgentTeam, startAutomaticRun } from './agent.service.js';
import { startReactiveDispatcher, stopReactiveDispatcher } from './agent.reactive.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { createRuntimeWorkerMonitor } from '../../operations/worker-liveness.js';

const intervalMs = 15 * 60 * 1000;
const dedupeMinutes = 6 * 60;
const runtimeMonitor = createRuntimeWorkerMonitor('automatic-analysis', { staleAfterMs: intervalMs + 60_000 });
let timer: NodeJS.Timeout | undefined;
let activeCycle: Promise<void> | null = null;
let activeScheduleRequest: Promise<void> | null = null;
let stopping = false;

function requestAutomaticAnalysisCycle(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (activeScheduleRequest) return activeScheduleRequest;
  const bucket = Math.floor(Date.now() / intervalMs);
  activeScheduleRequest = appendDomainEvent({
    type: DOMAIN_EVENT_TYPES.AGENT_AUTOMATIC_CYCLE_REQUESTED,
    aggregateType: 'agent_scheduler',
    aggregateId: 'automatic-analysis',
    payload: { scheduledAt: new Date().toISOString() },
    metadata: { source: 'agent.scheduler' },
    idempotencyKey: `schedule:agent-automatic-analysis:${bucket}`,
  }).then(() => undefined).finally(() => { activeScheduleRequest = null; });
  return activeScheduleRequest;
}

export function runAutomaticAnalysisCycle(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (activeCycle) return activeCycle;
  activeCycle = (async () => {
    const targets = await repo.listAutomatedTargets();
    let processed = 0;
    for (const target of targets) {
      if (stopping) break;
      const prepared = await prepareAutomaticAgentTeam(target.workspace_id, 'scheduled');
      const selectedAgentIds = prepared.selection.allAgents.map((entry) => entry.definition.id);
      for (const selected of prepared.selection.specialists) {
        if (stopping) break;
        if (selected.definition.module === 'ads' && !target.ad_spend_funded) continue;
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
      processed += 1;
    }
    runtimeMonitor.progress({ phase: 'completed', processed });
  })()
    .catch((error: unknown) => {
      runtimeMonitor.failed(error);
      logger.error({ error }, 'Automatic AI analysis cycle failed');
    })
    .finally(() => { activeCycle = null; });
  return activeCycle;
}

export function startAutomaticAnalysisWorker() {
  if (timer) return;
  stopping = false;
  runtimeMonitor.start();
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

export async function stopAutomaticAnalysisWorker() {
  stopping = true;
  const reactiveDrain = stopReactiveDispatcher();
  if (timer) clearInterval(timer);
  timer = undefined;
  await runtimeMonitor.stopping();
  if (activeScheduleRequest) await activeScheduleRequest.catch(() => undefined);
  if (activeCycle) await activeCycle;
  await reactiveDrain;
  await runtimeMonitor.stopped();
}
