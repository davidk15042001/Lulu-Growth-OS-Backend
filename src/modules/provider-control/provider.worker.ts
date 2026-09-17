import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { getProviderAdapter } from './provider-registry.js';
import * as repo from './provider.repo.js';
import type { ProviderAdapterContext } from './provider.types.js';
import { createRuntimeWorkerMonitor } from '../../operations/worker-liveness.js';

const syncWorkerId = `provider-sync-${process.pid}-${randomUUID()}`;
const webhookWorkerId = `provider-webhook-${process.pid}-${randomUUID()}`;
const runtimeMonitor = createRuntimeWorkerMonitor('provider-control', {
  staleAfterMs: Math.max(60_000, env.PROVIDER_SYNC_WORKER_INTERVAL_MS * 4, env.PROVIDER_WEBHOOK_WORKER_INTERVAL_MS * 4),
});
let syncTimer: NodeJS.Timeout | null = null;
let webhookTimer: NodeJS.Timeout | null = null;
let stopping = false;
let syncDrain: Promise<void> | null = null;
let webhookDrain: Promise<void> | null = null;

function retryDelayMs(attempt: number) {
  return Math.min(300_000, 1_000 * (2 ** Math.max(0, attempt - 1)));
}

async function processSyncJob(job: repo.ProviderSyncJob) {
  const pendingHeartbeats = new Set<Promise<unknown>>();
  const heartbeat = setInterval(() => {
    const task = repo.heartbeatProviderSyncJob(job.id, syncWorkerId);
    pendingHeartbeats.add(task);
    task.then(
      () => pendingHeartbeats.delete(task),
      (error: unknown) => {
        pendingHeartbeats.delete(task);
        logger.warn({ error, jobId: job.id }, 'Provider sync heartbeat failed');
      },
    );
  }, Math.max(5_000, Math.floor(env.PROVIDER_SYNC_JOB_LEASE_SECONDS * 1_000 / 3)));
  heartbeat.unref();
  try {
    const connection = await repo.getProviderConnectionInternal(job.providerConnectionId);
    if (!connection) throw new Error('Provider connection no longer exists');
    if (String(connection.status) === 'DISCONNECTED') throw new Error('Provider connection is disconnected');
    const adapter = getProviderAdapter(String(connection.providerKey));
    if (!adapter.sync) {
      await repo.finishProviderSyncState({ connectionId: job.providerConnectionId, syncType: job.syncType, status: 'PAUSED', error: 'No provider sync adapter is registered for this provider.' });
      await repo.finishProviderSyncJob({ job, workerId: syncWorkerId, status: 'failed', errorMessage: 'No provider sync adapter is registered for this provider.' });
      return;
    }
    const context: ProviderAdapterContext = {
      connectionId: String(connection.id),
      providerKey: String(connection.providerKey),
      workspaceId: job.workspaceId,
      externalAccountId: connection.externalAccountId == null ? null : String(connection.externalAccountId),
      grantedScopes: Array.isArray(connection.grantedScopesRaw ?? connection.grantedScopes) ? ((connection.grantedScopesRaw ?? connection.grantedScopes) as unknown[]).map(String) : [],
      metadata: ((connection.metadataRaw ?? {}) as Record<string, unknown>),
    };
    const result = await adapter.sync(context, job.syncType);
    let discovery: { accountCount: number; assetCount: number } | null = null;
    if (result.status === 'SUCCESS' && adapter.discoverAccounts) {
      const discoveredAccounts = await adapter.discoverAccounts(context);
      const graph: Array<{ account: import('./provider.types.js').ProviderDiscoveredAccount; assets: import('./provider.types.js').ProviderDiscoveredAsset[] }> = [];
      for (const account of discoveredAccounts) {
        graph.push({ account, assets: adapter.discoverAssets ? await adapter.discoverAssets(context, account) : [] });
      }
      discovery = await repo.persistDiscoveredProviderGraph({ connectionId: job.providerConnectionId, providerKey: String(connection.providerKey), accounts: graph });
    }
    await repo.finishProviderSyncState({ connectionId: job.providerConnectionId, syncType: job.syncType, status: result.status, ...(result.cursor === undefined ? {} : { cursor: result.cursor }), ...(result.status === 'FAILED' ? { error: 'Provider adapter reported a failed synchronization.' } : {}) });
    await repo.finishProviderSyncJob({ job, workerId: syncWorkerId, status: result.status === 'FAILED' ? 'failed' : 'succeeded', ...(result.status === 'FAILED' ? { errorMessage: 'Provider adapter reported a failed synchronization.' } : {}) });
    await appendDomainEvent({ workspaceId: job.workspaceId, type: result.status === 'FAILED' ? 'provider.sync.failed' : 'provider.sync.completed', aggregateType: 'provider_connection', aggregateId: job.providerConnectionId, payload: { providerKey: String(connection.providerKey), syncType: job.syncType, status: result.status, details: { ...(result.details ?? {}), ...(discovery ? { discoveredAccounts: discovery.accountCount, discoveredAssets: discovery.assetCount } : {}) } }, metadata: { source: 'provider.sync.worker', jobId: job.id } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Provider synchronization failed';
    await repo.finishProviderSyncState({ connectionId: job.providerConnectionId, syncType: job.syncType, status: 'FAILED', error: message }).catch(() => undefined);
    await repo.finishProviderSyncJob({ job, workerId: syncWorkerId, status: 'failed', errorMessage: message });
    await appendDomainEvent({ workspaceId: job.workspaceId, type: 'provider.sync.failed', aggregateType: 'provider_connection', aggregateId: job.providerConnectionId, payload: { syncType: job.syncType, error: message, retryable: job.attempts < env.PROVIDER_SYNC_MAX_ATTEMPTS }, metadata: { source: 'provider.sync.worker', jobId: job.id } }).catch(() => undefined);
    logger.error({ error, jobId: job.id, connectionId: job.providerConnectionId, attempts: job.attempts }, 'Provider synchronization failed');
  } finally {
    clearInterval(heartbeat);
    if (pendingHeartbeats.size > 0) await Promise.allSettled([...pendingHeartbeats]);
  }
}

async function processWebhookEvent(event: repo.ProviderWebhookEvent) {
  try {
    const adapter = getProviderAdapter(event.providerKey);
    if (!adapter.handleWebhook) {
      await repo.markProviderWebhookProcessed(event, webhookWorkerId, true);
      return;
    }
    const result = await adapter.handleWebhook({ eventType: event.eventType, externalEventId: event.externalEventId, metadata: event.normalizedMetadata });
    await repo.markProviderWebhookProcessed(event, webhookWorkerId, !result.handled);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Provider webhook handling failed';
    await repo.markProviderWebhookFailed(event, webhookWorkerId, message, retryDelayMs(event.attempts), env.PROVIDER_WEBHOOK_MAX_ATTEMPTS);
    logger.error({ error, eventId: event.id, provider: event.providerKey, attempts: event.attempts }, 'Provider webhook handling failed');
  }
}

async function drainSyncJobs() {
  let processed = 0;
  while (!stopping) {
    const job = await repo.claimNextProviderSyncJob(syncWorkerId, env.PROVIDER_SYNC_JOB_LEASE_SECONDS, env.PROVIDER_SYNC_MAX_ATTEMPTS);
    if (!job) break;
    await processSyncJob(job);
    processed += 1;
  }
  runtimeMonitor.progress({ phase: 'sync-idle', processed });
}

async function drainWebhookEvents() {
  let processed = 0;
  while (!stopping) {
    const event = await repo.claimNextProviderWebhookEvent(webhookWorkerId, env.PROVIDER_WEBHOOK_LEASE_SECONDS, env.PROVIDER_WEBHOOK_MAX_ATTEMPTS);
    if (!event) break;
    await processWebhookEvent(event);
    processed += 1;
  }
  runtimeMonitor.progress({ phase: 'webhook-idle', processed });
}

function requestSyncDrain() {
  if (stopping || syncDrain) return syncDrain;
  syncDrain = drainSyncJobs().catch((error) => { runtimeMonitor.failed(error); logger.error({ error }, 'Provider sync worker cycle failed'); }).finally(() => { syncDrain = null; });
  return syncDrain;
}

function requestWebhookDrain() {
  if (stopping || webhookDrain) return webhookDrain;
  webhookDrain = drainWebhookEvents().catch((error) => { runtimeMonitor.failed(error); logger.error({ error }, 'Provider webhook worker cycle failed'); }).finally(() => { webhookDrain = null; });
  return webhookDrain;
}

export function startProviderControlWorkers() {
  stopping = false;
  runtimeMonitor.start({ syncWorkerId, webhookWorkerId });
  if (!syncTimer) syncTimer = setInterval(requestSyncDrain, env.PROVIDER_SYNC_WORKER_INTERVAL_MS);
  if (!webhookTimer) webhookTimer = setInterval(requestWebhookDrain, env.PROVIDER_WEBHOOK_WORKER_INTERVAL_MS);
  syncTimer.unref();
  webhookTimer.unref();
  requestSyncDrain();
  requestWebhookDrain();
  logger.info({ syncIntervalMs: env.PROVIDER_SYNC_WORKER_INTERVAL_MS, webhookIntervalMs: env.PROVIDER_WEBHOOK_WORKER_INTERVAL_MS }, 'Provider control workers started');
}

export async function stopProviderControlWorkers() {
  stopping = true;
  if (syncTimer) clearInterval(syncTimer);
  if (webhookTimer) clearInterval(webhookTimer);
  syncTimer = null;
  webhookTimer = null;
  await runtimeMonitor.stopping();
  if (syncDrain) await syncDrain;
  if (webhookDrain) await webhookDrain;
  await runtimeMonitor.stopped();
}
