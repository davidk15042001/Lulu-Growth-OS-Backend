import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './agent.service.js';
import { subscribeAgentEvents } from './agent.events.js';
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
    return successResponse(res, 'Agent run cancelled', await service.cancelRun(params.workspaceId, params.runId!));
  } catch (error) { next(error); }
}
export async function approve(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = agentRunParamsSchema.extend({ stepId: agentRunParamsSchema.shape.runId }).parse(req.params);
    const decision = agentStepDecisionSchema.parse(req.body);
    return successResponse(res, 'Agent step decision recorded', await service.approveStep(params.workspaceId, params.runId!, params.stepId!, req.user!.id, decision));
  } catch (error) { next(error); }
}

export function stream(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = String(req.params.workspaceId ?? '');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ type: 'connected', workspaceId, occurredAt: new Date().toISOString() });

    const unsubscribe = subscribeAgentEvents((event) => {
      if (event.workspaceId !== workspaceId) return;
      send(event);
    });
    const heartbeat = setInterval(() => { res.write(': heartbeat\n\n'); }, 25_000);
    const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
    req.on('close', cleanup);
    res.on('close', cleanup);
  } catch (error) { next(error); }
}
