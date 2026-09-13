import { logger } from '../../config/logger.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { createRuntimeWorkerMonitor } from '../../operations/worker-liveness.js';
import { attachCustomerResponse, processCompanyIntelligence, queueBlockedCompanies, queueLegacyCompanies } from './company-intelligence.service.js';

let started = false;
let stopping = false;
let sweepTimer: NodeJS.Timeout | null = null;
let activeSweep: Promise<void> | null = null;
const activeTasks = new Set<Promise<unknown>>();
const sweepIntervalMs = 5 * 60_000;
const runtimeMonitor = createRuntimeWorkerMonitor('company-intelligence', { staleAfterMs: sweepIntervalMs * 2 + 60_000 });

function trackCompanyIntelligenceTask<T>(operation: () => Promise<T>): Promise<T> | null {
  if (stopping) return null;
  const task = operation();
  activeTasks.add(task);
  task.then(
    () => activeTasks.delete(task),
    (error: unknown) => {
      activeTasks.delete(task);
      runtimeMonitor.failed(error);
    },
  );
  return task;
}

export function runCompanyIntelligenceSweep(): Promise<void> {
  if (stopping) return Promise.resolve();
  if (activeSweep) return activeSweep;
  activeSweep = queueLegacyCompanies(() => !stopping)
    .then((queued) => {
      runtimeMonitor.progress({ phase: queued ? 'legacy-sweep' : 'idle', processed: queued });
      if (queued) logger.info({ queued }, 'Legacy CRM companies queued for autonomous enrichment');
    })
    .catch((error: unknown) => {
      runtimeMonitor.failed(error);
      logger.warn({ error }, 'Legacy CRM companies could not be queued for enrichment');
    })
    .finally(() => { activeSweep = null; });
  return activeSweep;
}

export function startCompanyIntelligenceWorker() {
  if (started) return;
  stopping = false;
  started = true;
  runtimeMonitor.start();
  registerDomainEventHandler({
    name: 'crm.company-intelligence.v1',
    eventTypes: [
      DOMAIN_EVENT_TYPES.RECORD_CREATED,
      DOMAIN_EVENT_TYPES.RECORD_UPDATED,
      DOMAIN_EVENT_TYPES.API_FUNDS_FUNDED,
      DOMAIN_EVENT_TYPES.MESSAGE_RECEIVED,
    ],
    async handle(event) {
      if (!event.workspaceId) return { ignored: true };
      const task = trackCompanyIntelligenceTask(async (): Promise<Record<string, unknown>> => {
        let result: Record<string, unknown>;
        if (event.type === DOMAIN_EVENT_TYPES.API_FUNDS_FUNDED) {
          result = { queued: await queueBlockedCompanies(event.workspaceId!) };
        } else if (event.type === DOMAIN_EVENT_TYPES.MESSAGE_RECEIVED) {
          const conversationId = typeof event.payload.conversationId === 'string' ? event.payload.conversationId : null;
          result = conversationId
            ? await attachCustomerResponse(event.workspaceId!, conversationId) as Record<string, unknown>
            : { ignored: true };
        } else if (event.payload.resourceType !== 'crm_companies') {
          result = { ignored: true };
        } else {
          const recordId = typeof event.payload.recordId === 'string' ? event.payload.recordId : event.aggregateId;
          result = recordId
            ? await processCompanyIntelligence(event.workspaceId!, recordId) as Record<string, unknown>
            : { ignored: true };
        }
        runtimeMonitor.progress({ phase: 'processed', processed: 1 });
        return result;
      });
      return task ?? { ignored: true, stopping: true };
    },
  });
  logger.info('Autonomous CRM company intelligence consumer registered');
  sweepTimer = setInterval(() => void runCompanyIntelligenceSweep(), sweepIntervalMs);
  sweepTimer.unref();
  void runCompanyIntelligenceSweep();
}

export async function stopCompanyIntelligenceWorker() {
  stopping = true;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  await runtimeMonitor.stopping();
  if (activeSweep) await activeSweep;
  while (activeTasks.size > 0) await Promise.allSettled([...activeTasks]);
  started = false;
  await runtimeMonitor.stopped();
}
