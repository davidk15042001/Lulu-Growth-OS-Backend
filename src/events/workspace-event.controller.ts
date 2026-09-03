import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../middlewares/workspace.middleware.js';
import { latestWorkspaceDomainEventSequence, listWorkspaceDomainEvents } from './domain-event.repo.js';
import { subscribeDomainEvents } from './domain-event.runtime.js';
import type { DomainEvent } from './domain-event.types.js';

type PublicWorkspaceEvent = Pick<
  DomainEvent,
  'id' | 'sequence' | 'workspaceId' | 'type' | 'version' | 'aggregateType' | 'aggregateId' | 'payload' | 'occurredAt'
>;

function publicEvent(event: DomainEvent): PublicWorkspaceEvent {
  return {
    id: event.id,
    sequence: event.sequence,
    workspaceId: event.workspaceId,
    type: event.type,
    version: event.version,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payload,
    occurredAt: event.occurredAt,
  };
}

export async function streamWorkspaceEvents(req: WorkspaceRequest, res: Response, next: NextFunction) {
  const workspaceId = String(req.params.workspaceId ?? '');
  const headerSequence = req.header('last-event-id');
  const requestedSequence = typeof req.query.afterSequence === 'string' ? req.query.afterSequence : headerSequence;
  const afterSequence = requestedSequence && /^\d+$/.test(requestedSequence) ? requestedSequence : null;
  const buffered: DomainEvent[] = [];
  let replaying = true;
  let closed = false;
  let heartbeat: NodeJS.Timeout | null = null;
  let catchupTimer: NodeJS.Timeout | null = null;
  let catchupRunning = false;
  let lastSentSequence = BigInt(afterSequence ?? '0');

  const send = (event: DomainEvent) => {
    if (closed || !event.workspaceId) return;
    const sequence = BigInt(event.sequence);
    if (sequence <= lastSentSequence) return;
    lastSentSequence = sequence;
    res.write(`id: ${event.sequence}\n`);
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(publicEvent(event))}\n\n`);
  };
  const unsubscribe = subscribeDomainEvents((event) => {
    if (event.workspaceId !== workspaceId) return;
    if (replaying) buffered.push(event);
    else send(event);
  });
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    if (catchupTimer) clearInterval(catchupTimer);
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
      let cursor = afterSequence;
      for (;;) {
        const page = await listWorkspaceDomainEvents(workspaceId, cursor, [], 500);
        if (page.length === 0) break;
        page.forEach(send);
        cursor = page.at(-1)!.sequence;
        if (page.length < 500) break;
      }
    } else {
      lastSentSequence = BigInt(await latestWorkspaceDomainEventSequence(workspaceId));
    }
    replaying = false;
    buffered.splice(0)
      .sort((left, right) => Number(BigInt(left.sequence) - BigInt(right.sequence)))
      .forEach(send);
    res.write(`data: ${JSON.stringify({ type: 'connected', workspaceId, occurredAt: new Date().toISOString() })}\n\n`);
    heartbeat = setInterval(() => { if (!closed) res.write(': heartbeat\n\n'); }, 25_000);
    heartbeat.unref();
    const catchUp = async () => {
      if (closed || replaying || catchupRunning) return;
      catchupRunning = true;
      replaying = true;
      try {
        for (;;) {
          const page = await listWorkspaceDomainEvents(workspaceId, lastSentSequence.toString(), [], 500);
          if (page.length === 0) break;
          page.forEach(send);
          if (page.length < 500) break;
        }
      } finally {
        replaying = false;
        buffered.splice(0)
          .sort((left, right) => Number(BigInt(left.sequence) - BigInt(right.sequence)))
          .forEach(send);
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
