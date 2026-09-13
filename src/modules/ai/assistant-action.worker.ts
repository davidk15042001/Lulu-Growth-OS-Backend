import { logger } from '../../config/logger.js';
import { claimAndExecuteNextAssistantAction } from './assistant-actions.service.js';
import { createRuntimeWorkerMonitor } from '../../operations/worker-liveness.js';

const intervalMs = 5_000;
const batchSize = 20;
const runtimeMonitor = createRuntimeWorkerMonitor('assistant-actions', { staleAfterMs: intervalMs * 6 });
let timer: NodeJS.Timeout | undefined;
let activeCycle: Promise<void> | null = null;
let stopping = false;

export function runAssistantActionCycle(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (activeCycle) return activeCycle;
  activeCycle = (async () => {
    let processed = 0;
    for (let index = 0; index < batchSize && !stopping; index += 1) {
      const action = await claimAndExecuteNextAssistantAction();
      if (!action) break;
      processed += 1;
    }
    runtimeMonitor.progress({ phase: processed ? 'processed' : 'idle', processed });
  })()
    .catch((error: unknown) => {
      runtimeMonitor.failed(error);
      logger.error({ error }, 'Assistant action worker cycle failed');
    })
    .finally(() => { activeCycle = null; });
  return activeCycle;
}

export function startAssistantActionWorker() {
  if (timer) return;
  stopping = false;
  runtimeMonitor.start();
  timer = setInterval(() => void runAssistantActionCycle(), intervalMs);
  timer.unref();
  void runAssistantActionCycle();
  logger.info({ intervalMs, batchSize }, 'Assistant action worker started');
}

export async function stopAssistantActionWorker() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = undefined;
  await runtimeMonitor.stopping();
  if (activeCycle) await activeCycle;
  await runtimeMonitor.stopped();
}
