import { logger } from '../../config/logger.js';
import * as repo from './agent.repo.js';
import { startAutomaticRun } from './agent.service.js';

const intervalMs = 15 * 60 * 1000;
const modules = ['general', 'seo', 'geo', 'aeo', 'website'] as const;
let timer: NodeJS.Timeout | undefined;
let running = false;

export async function runAutomaticAnalysisCycle() {
  if (running) return;
  running = true;
  try {
    const targets = await repo.listAutomatedTargets();
    for (const target of targets) {
      for (const module of modules) {
        const goal = `[automatic-analysis:${module}] Refresh AI analysis and statistics for the ${module} workspace module.`;
        if (await repo.hasRecentAutomaticRun(target.workspace_id, goal)) continue;
        await startAutomaticRun(target.workspace_id, goal, module);
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
