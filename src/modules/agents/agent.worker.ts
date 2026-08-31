import { logger } from '../../config/logger.js';
import * as repo from './agent.repo.js';
import { automaticPageProfiles, buildPageAgentGoal, startAutomaticRun } from './agent.service.js';

const intervalMs = 15 * 60 * 1000;
const dedupeMinutes = 6 * 60;
let timer: NodeJS.Timeout | undefined;
let running = false;

export async function runAutomaticAnalysisCycle() {
  if (running) return;
  running = true;
  try {
    const targets = await repo.listAutomatedTargets();
    for (const target of targets) {
      for (const page of automaticPageProfiles) {
        const goal = buildPageAgentGoal(page);
        if (await repo.getRecentPageRun(target.workspace_id, page.pageId, dedupeMinutes)) continue;
        await startAutomaticRun(target.workspace_id, goal, 'general', page, dedupeMinutes, target.actor_user_id ?? undefined);
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
  timer = setInterval(() => void runAutomaticAnalysisCycle(), intervalMs);
  timer.unref();
  void runAutomaticAnalysisCycle();
  logger.info({ intervalMs }, 'Automatic AI analysis worker started');
}

export function stopAutomaticAnalysisWorker() {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}
