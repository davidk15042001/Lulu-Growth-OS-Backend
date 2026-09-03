import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Notification, PoolClient } from 'pg';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getPool } from '../db/pool.js';
import { handlersForDomainEvent, registeredDomainEventHandlers } from './domain-event.registry.js';
import {
  claimDomainEvents,
  heartbeatDomainEvent,
  hasConsumerReceipt,
  latestDomainEventSequence,
  listDomainEventsAfter,
  markDomainEventProcessed,
  recordConsumerReceipt,
  retryDomainEvent,
} from './domain-event.repo.js';
import type { DomainEvent } from './domain-event.types.js';

const workerId = `events-${process.pid}-${randomUUID()}`;
const liveEvents = new EventEmitter();
liveEvents.setMaxListeners(1_000);

let listenerClient: PoolClient | null = null;
let listenerReconnectTimer: NodeJS.Timeout | null = null;
let listenerReconnectAttempt = 0;
let fallbackTimer: NodeJS.Timeout | null = null;
let activeDrain: Promise<void> | null = null;
let activeBroadcastDrain: Promise<void> | null = null;
let broadcastRequested = false;
let lastBroadcastSequence = '0';
let stopping = false;
let processingEnabled = false;
let runtimeStarted = false;

export function eventRetryDelayMs(attempt: number) {
  return Math.min(60_000, 500 * (2 ** Math.max(0, attempt - 1)));
}

async function dispatchEvent(event: DomainEvent) {
  for (const handler of handlersForDomainEvent(event)) {
    if (await hasConsumerReceipt(event.id, handler.name)) continue;
    const result = await handler.handle(event);
    await recordConsumerReceipt(event.id, handler.name, result || undefined);
  }
}

async function processClaimedEvent(event: DomainEvent) {
  const heartbeat = setInterval(
    () => void heartbeatDomainEvent(event.id, workerId).catch((error: unknown) => {
      logger.warn({ error, eventId: event.id }, 'Domain event lease heartbeat failed');
    }),
    Math.max(5_000, Math.floor(env.EVENT_WORKER_LEASE_SECONDS * 1_000 / 3)),
  );
  heartbeat.unref();
  try {
    await dispatchEvent(event);
    await markDomainEventProcessed(event.id, workerId);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown domain event consumer failure';
    await retryDomainEvent(event.id, workerId, message, eventRetryDelayMs(event.attempts));
    logger.error({ error, eventId: event.id, eventType: event.type, attempts: event.attempts }, 'Domain event delivery failed');
  } finally {
    clearInterval(heartbeat);
  }
}

async function drainDomainEvents() {
  while (!stopping) {
    const events = await claimDomainEvents(
      workerId,
      env.EVENT_WORKER_BATCH_SIZE,
      env.EVENT_WORKER_LEASE_SECONDS,
    );
    if (events.length === 0) return;
    for (let offset = 0; offset < events.length; offset += env.EVENT_WORKER_CONCURRENCY) {
      await Promise.all(events.slice(offset, offset + env.EVENT_WORKER_CONCURRENCY).map(processClaimedEvent));
    }
  }
}

export function requestDomainEventDrain() {
  if (!processingEnabled || stopping || activeDrain) return activeDrain;
  activeDrain = drainDomainEvents()
    .catch((error: unknown) => logger.error({ error }, 'Domain event worker cycle failed'))
    .finally(() => { activeDrain = null; });
  return activeDrain;
}

function requestDomainEventBroadcast() {
  broadcastRequested = true;
  if (stopping || activeBroadcastDrain) return activeBroadcastDrain;
  activeBroadcastDrain = (async () => {
    while (broadcastRequested && !stopping) {
      broadcastRequested = false;
      for (;;) {
        const events = await listDomainEventsAfter(lastBroadcastSequence, 500);
        if (events.length === 0) break;
        for (const event of events) {
          liveEvents.emit('event', event);
          lastBroadcastSequence = event.sequence;
        }
        if (events.length < 500) break;
      }
    }
  })()
    .catch((error: unknown) => logger.error({ error }, 'Domain event live broadcast catch-up failed'))
    .finally(() => {
      activeBroadcastDrain = null;
      if (broadcastRequested && !stopping) requestDomainEventBroadcast();
    });
  return activeBroadcastDrain;
}

function onNotification(payload: string | undefined) {
  if (payload) {
    try {
      const parsed = JSON.parse(payload) as { id?: unknown };
      if (typeof parsed.id !== 'string') throw new Error('Notification event id is missing');
    } catch (error) {
      logger.warn({ error }, 'Invalid domain event notification payload ignored');
      return;
    }
  }
  requestDomainEventBroadcast();
  requestDomainEventDrain();
}

function scheduleListenerReconnect() {
  if (!runtimeStarted || stopping || listenerReconnectTimer) return;
  const delayMs = Math.min(30_000, 500 * (2 ** listenerReconnectAttempt));
  listenerReconnectAttempt += 1;
  listenerReconnectTimer = setTimeout(() => {
    listenerReconnectTimer = null;
    void connectListener().catch((error: unknown) => {
      logger.error({ error, retryInMs: Math.min(30_000, 500 * (2 ** listenerReconnectAttempt)) }, 'Domain event LISTEN reconnect failed');
      scheduleListenerReconnect();
    });
  }, delayMs);
  listenerReconnectTimer.unref();
}

function disconnectListener(client: PoolClient, error: unknown) {
  if (listenerClient !== client) return;
  listenerClient = null;
  client.release(true);
  logger.error({ error }, 'Domain event LISTEN connection lost');
  scheduleListenerReconnect();
}

async function connectListener() {
  if (!runtimeStarted || stopping || listenerClient) return;
  const client = await getPool().connect();
  if (!runtimeStarted || stopping) {
    client.release();
    return;
  }

  const onListenerError = (error: Error) => disconnectListener(client, error);
  const onListenerEnd = () => disconnectListener(client, new Error('PostgreSQL LISTEN connection ended'));
  const onListenerNotification = (notification: Notification) => {
    if (notification.channel === 'lulu_domain_events') void onNotification(notification.payload);
  };
  client.on('notification', onListenerNotification);
  client.once('error', onListenerError);
  client.once('end', onListenerEnd);
  listenerClient = client;

  try {
    await client.query('LISTEN lulu_domain_events');
    listenerReconnectAttempt = 0;
    requestDomainEventBroadcast();
    logger.info('Domain event LISTEN connection ready');
  } catch (error) {
    client.off('notification', onListenerNotification);
    client.off('error', onListenerError);
    client.off('end', onListenerEnd);
    if (listenerClient === client) listenerClient = null;
    client.release(true);
    throw error;
  }
}

export function subscribeDomainEvents(listener: (event: DomainEvent) => void) {
  liveEvents.on('event', listener);
  return () => liveEvents.off('event', listener);
}

export async function startDomainEventRuntime(options: { processEvents?: boolean } = {}) {
  if (runtimeStarted) return;
  runtimeStarted = true;
  stopping = false;
  processingEnabled = options.processEvents !== false;
  lastBroadcastSequence = await latestDomainEventSequence();
  try {
    await connectListener();
  } catch (error) {
    logger.error({ error }, 'Initial domain event LISTEN connection failed');
    scheduleListenerReconnect();
  }
  fallbackTimer = setInterval(() => {
    requestDomainEventBroadcast();
    requestDomainEventDrain();
  }, env.EVENT_WORKER_POLL_INTERVAL_MS);
  fallbackTimer.unref();
  requestDomainEventBroadcast();
  requestDomainEventDrain();
  logger.info(
    {
      workerId,
      consumers: registeredDomainEventHandlers().map((handler) => handler.name),
      processingEnabled,
      fallbackPollMs: env.EVENT_WORKER_POLL_INTERVAL_MS,
      concurrency: env.EVENT_WORKER_CONCURRENCY,
    },
    'Durable domain event runtime started',
  );
}

export async function stopDomainEventRuntime() {
  runtimeStarted = false;
  stopping = true;
  processingEnabled = false;
  if (listenerReconnectTimer) clearTimeout(listenerReconnectTimer);
  listenerReconnectTimer = null;
  listenerReconnectAttempt = 0;
  if (fallbackTimer) clearInterval(fallbackTimer);
  fallbackTimer = null;
  if (activeDrain) await activeDrain;
  if (activeBroadcastDrain) await activeBroadcastDrain;
  if (listenerClient) {
    await listenerClient.query('UNLISTEN lulu_domain_events').catch(() => undefined);
    listenerClient.release();
    listenerClient = null;
  }
}
