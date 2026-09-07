import type { Request, Response, NextFunction } from 'express';
import { latestDomainEventSequence, listDomainEventsAfter } from '../../events/domain-event.repo.js';
import { subscribeDomainEvents } from '../../events/domain-event.runtime.js';
import type { DomainEvent } from '../../events/domain-event.types.js';

const isOmniEvent = (event: DomainEvent) => /^(conversation|message|channel\.identity|routing|website_chat)\./.test(event.type);

const publicEvent = (event: DomainEvent) => ({
  id: event.id,
  sequence: event.sequence,
  workspaceId: event.workspaceId,
  type: event.type,
  version: event.version,
  aggregateType: event.aggregateType,
  aggregateId: event.aggregateId,
  payload: event.payload,
  occurredAt: event.occurredAt,
});

/**
 * Global OmniChannel stream. The route is capability-gated before this
 * controller runs; only normalized OmniChannel events are emitted.
 */
export async function streamAdminOmniEvents(req: Request, res: Response, next: NextFunction) {
  const requested = typeof req.query.afterSequence === 'string' ? req.query.afterSequence : req.header('last-event-id');
  const afterSequence = requested && /^\d+$/.test(requested) ? requested : null;
  const buffered: DomainEvent[] = [];
  let replaying = true;
  let closed = false;
  let heartbeat: NodeJS.Timeout | null = null;
  let catchupTimer: NodeJS.Timeout | null = null;
  let catchupRunning = false;
  let lastSeenSequence = BigInt(afterSequence ?? '0');

  const send = (event: DomainEvent) => {
    if (closed || !isOmniEvent(event)) return;
    res.write(`id: ${event.sequence}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(publicEvent(event))}\n\n`);
  };
  const process = (events: DomainEvent[]) => {
    for (const event of events) {
      const sequence = BigInt(event.sequence);
      if (sequence <= lastSeenSequence) continue;
      lastSeenSequence = sequence;
      send(event);
    }
  };
  const unsubscribe = subscribeDomainEvents((event) => {
    if (replaying) buffered.push(event);
    else process([event]);
  });
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (catchupTimer) clearInterval(catchupTimer);
    heartbeat = null;
    catchupTimer = null;
    unsubscribe();
  };
  req.once('close', cleanup);
  res.once('close', cleanup);

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    if (afterSequence) {
      for (;;) {
        const page = await listDomainEventsAfter(lastSeenSequence.toString(), 500);
        if (page.length === 0) break;
        process(page);
        if (page.length < 500) break;
      }
    } else {
      lastSeenSequence = BigInt(await latestDomainEventSequence());
    }
    replaying = false;
    buffered.sort((left, right) => Number(BigInt(left.sequence) - BigInt(right.sequence)));
    process(buffered.splice(0));
    res.write('data: {"type":"connected","scope":"admin.omnichannel"}\n\n');
    heartbeat = setInterval(() => { if (!closed) res.write(': heartbeat\n\n'); }, 25_000);
    heartbeat.unref();

    const catchUp = async () => {
      if (closed || replaying || catchupRunning) return;
      catchupRunning = true;
      try {
        for (;;) {
          const page = await listDomainEventsAfter(lastSeenSequence.toString(), 500);
          if (page.length === 0) break;
          process(page);
          if (page.length < 500) break;
        }
      } finally {
        catchupRunning = false;
      }
    };
    catchupTimer = setInterval(() => void catchUp().catch(() => undefined), 5_000);
    catchupTimer.unref();
  } catch (error) {
    cleanup();
    if (res.headersSent) res.end();
    else next(error);
  }
}

