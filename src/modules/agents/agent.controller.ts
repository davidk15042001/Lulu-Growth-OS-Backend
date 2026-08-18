import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './agent.service.js';
import { agentRunParamsSchema, agentStepDecisionSchema, createAgentRunSchema } from './agent.validator.js';

export async function create(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = agentRunParamsSchema.parse(req.params);
    const input = createAgentRunSchema.parse(req.body);
    return createdResponse(res, 'Agent run started', await service.startRun(params.workspaceId, req.user!.id, input.goal, input.module));
  } catch (error) { next(error); }
}
export async function list(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = agentRunParamsSchema.parse(req.params);
    return successResponse(res, 'Agent runs loaded', { items: await service.listRuns(params.workspaceId) });
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
