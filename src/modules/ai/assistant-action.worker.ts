import { logger } from '../../config/logger.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { claimAndExecuteNextAssistantAction } from './assistant-actions.service.js';

const intervalMs = 5_000;
const batchSize = 20;
let timer: NodeJS.Timeout | undefined;
let running = false;
let registered = false;

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

export function registerAssistantActionHandlers() {
  if (registered) return;
  registered = true;
  registerDomainEventHandler({
    name: 'ai.assistant-action-wakeup.v1',
    eventTypes: [DOMAIN_EVENT_TYPES.APPROVAL_DECIDED],
    async handle() {
      await runAssistantActionCycle();
      return { woken: true };
    },
  });
}

export function startAssistantActionWorker() {
  if (timer) return;
  registerAssistantActionHandlers();
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
