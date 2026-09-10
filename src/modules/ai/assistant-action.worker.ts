import { logger } from '../../config/logger.js';
import { claimAndExecuteNextAssistantAction } from './assistant-actions.service.js';

const intervalMs = 5_000;
const batchSize = 20;
let timer: NodeJS.Timeout | undefined;
let running = false;

export async function runAssistantActionCycle() {
  if (running) return;
  running = true;
  try {
    for (let index = 0; index < batchSize; index += 1) {
      const action = await claimAndExecuteNextAssistantAction();
      if (!action) break;
    }
  } catch (error) {
    logger.error({ error }, 'Assistant action worker cycle failed');
  } finally {
    running = false;
  }
}

export function startAssistantActionWorker() {
  if (timer) return;
  timer = setInterval(() => void runAssistantActionCycle(), intervalMs);
  timer.unref();
  void runAssistantActionCycle();
  logger.info({ intervalMs, batchSize }, 'Assistant action worker started');
}

export function stopAssistantActionWorker() {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}
