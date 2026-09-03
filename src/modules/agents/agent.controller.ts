import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './agent.service.js';
import { latestWorkspaceDomainEventSequence, listAgentEventsAfter, subscribeAgentEvents, type WorkspaceAgentEvent } from './agent.events.js';
import { agentRunParamsSchema, agentRunQuerySchema, agentStepDecisionSchema, createAgentRunSchema } from './agent.validator.js';

export async function create(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = agentRunParamsSchema.parse(req.params);
    const input = createAgentRunSchema.parse(req.body);
    return createdResponse(res, 'Agent run started', await service.startRun(params.workspaceId, req.user!.id, input.goal, input.module, input.page, input.dedupeMinutes));
  } catch (error) { next(error); }
}
export async function knowledge(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = agentRunParamsSchema.parse(req.params);
    const query = agentRunQuerySchema.parse(req.query);
    const bundle = await service.getKnowledgeBundle(params.workspaceId, query.pageId);
    return successResponse(res, 'Workspace intelligence loaded', bundle ?? { snapshot: null, sections: [], metrics: [] });
  } catch (error) { next(error); }
}
export async function health(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = agentRunParamsSchema.parse(req.params);
    const query = agentRunQuerySchema.parse(req.query);
    return successResponse(res, 'Agent health loaded', await service.getAgentHealth(params.workspaceId, query.pageId));
  } catch (error) { next(error); }
}
export async function list(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = agentRunParamsSchema.parse(req.params);
    const query = agentRunQuerySchema.parse(req.query);
    return successResponse(res, 'Agent runs loaded', { items: await service.listRuns(params.workspaceId, query.pageId) });
  } catch (error) { next(error); }
}
export async function detail(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = agentRunParamsSchema.parse(req.params);
    return successResponse(res, 'Agent run loaded', await service.getRunDetails(params.workspaceId, params.runId!));
  } catch (error) { next(error); }
}
export async function cancel(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = agentRunParamsSchema.parse(req.params);
    return successResponse(res, 'Agent run cancelled', await service.cancelRun(params.workspaceId, params.runId!, req.user!.id));
  } catch (error) { next(error); }
}
export async function approve(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = agentRunParamsSchema.extend({ stepId: agentRunParamsSchema.shape.runId }).parse(req.params);
    const decision = agentStepDecisionSchema.parse(req.body);
    return successResponse(res, 'Agent step decision recorded', await service.approveStep(params.workspaceId, params.runId!, params.stepId!, req.user!.id, decision));
  } catch (error) { next(error); }
}

export async function stream(req: WorkspaceRequest, res: Response, next: NextFunction) {
  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    unsubscribe?.();
    unsubscribe = null;
  };
  try {
    const workspaceId = String(req.params.workspaceId ?? '');
    const headerSequence = req.header('last-event-id');
    const requestedSequence = typeof req.query.afterSequence === 'string' ? req.query.afterSequence : headerSequence;
    const afterSequence = requestedSequence && /^\d+$/.test(requestedSequence) ? requestedSequence : null;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let lastSentSequence = BigInt(afterSequence ?? '0');
    const send = (payload: WorkspaceAgentEvent) => {
      if (closed) return;
      if (payload.sequence) {
        const sequence = BigInt(payload.sequence);
        if (sequence <= lastSentSequence) return;
        lastSentSequence = sequence;
        res.write(`id: ${payload.sequence}\n`);
        res.write(`event: ${payload.type}\n`);
      }
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const buffered: WorkspaceAgentEvent[] = [];
    let replaying = true;
    unsubscribe = subscribeAgentEvents((event) => {
      if (event.workspaceId !== workspaceId) return;
      if (replaying) buffered.push(event);
      else send(event);
    });
    req.once('close', cleanup);
    res.once('close', cleanup);
    const replay: WorkspaceAgentEvent[] = [];
    if (afterSequence) {
      let cursor = afterSequence;
      for (;;) {
        const page = await listAgentEventsAfter(workspaceId, cursor, 500);
        if (page.length === 0) break;
        replay.push(...page);
        cursor = page.at(-1)?.sequence ?? cursor;
        if (page.length < 500) break;
      }
    } else {
      lastSentSequence = BigInt(await latestWorkspaceDomainEventSequence(workspaceId));
    }
    for (const event of replay) send(event);
    replaying = false;
    buffered.splice(0)
      .sort((left, right) => Number(BigInt(left.sequence ?? '0') - BigInt(right.sequence ?? '0')))
      .forEach(send);
    send({ type: 'connected', workspaceId, occurredAt: new Date().toISOString() });
    heartbeat = setInterval(() => { if (!closed) res.write(': heartbeat\n\n'); }, 25_000);
    heartbeat.unref();
  } catch (error) {
    cleanup();
    if (res.headersSent) res.end();
    else next(error);
  }
}
