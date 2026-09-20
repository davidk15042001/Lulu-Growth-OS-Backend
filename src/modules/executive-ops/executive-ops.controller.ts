import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import { getWorkspaceActorCapabilities } from '../workspaces/workspace-authorization.service.js';
import * as service from './executive-ops.service.js';
import {
  createExecutiveProposalSchema,
  createExecutiveScenarioSchema,
  decideExecutiveProposalSchema,
  executiveCycleParamsSchema,
  executiveListQuerySchema,
  executiveProposalParamsSchema,
  executiveScenarioParamsSchema,
  executiveScheduleParamsSchema,
  executiveWorkspaceParamsSchema,
  runExecutiveCycleSchema,
  saveExecutiveScheduleSchema,
} from './executive-ops.validator.js';

async function actorAccess(req: WorkspaceRequest, workspaceId: string) {
  return getWorkspaceActorCapabilities(workspaceId, req.user!.id);
}

export async function overview(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = executiveWorkspaceParamsSchema.parse(req.params);
    return successResponse(res, 'Executive operating overview loaded', await service.getOverview(workspaceId, await actorAccess(req, workspaceId)));
  } catch (error) { next(error); }
}

export async function cycles(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = executiveWorkspaceParamsSchema.parse(req.params);
    const input = executiveListQuerySchema.parse(req.query);
    return successResponse(res, 'Executive operating cycles loaded', { items: await service.listCycles(workspaceId, input.limit, input.cycleType) });
  } catch (error) { next(error); }
}

export async function cycleDetail(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, cycleId } = executiveCycleParamsSchema.parse(req.params);
    return successResponse(res, 'Executive operating cycle loaded', await service.getCycleDetail(workspaceId, cycleId, await actorAccess(req, workspaceId)));
  } catch (error) { next(error); }
}

export async function runCycle(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = executiveWorkspaceParamsSchema.parse(req.params);
    const input = runExecutiveCycleSchema.parse(req.body);
    return successResponse(res, 'Executive operating cycle completed', await service.runCycle({
      workspaceId,
      cycleType: input.cycleType,
      triggerType: 'manual',
      startedBy: req.user!.id,
      access: await actorAccess(req, workspaceId),
    }));
  } catch (error) { next(error); }
}

export async function findings(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = executiveWorkspaceParamsSchema.parse(req.params);
    const input = executiveListQuerySchema.parse(req.query);
    return successResponse(res, 'Executive findings loaded', { items: await service.listFindings(workspaceId, input.limit, await actorAccess(req, workspaceId)) });
  } catch (error) { next(error); }
}

export async function forecasts(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = executiveWorkspaceParamsSchema.parse(req.params);
    const input = executiveListQuerySchema.parse(req.query);
    return successResponse(res, 'Executive forecasts loaded', { items: await service.listForecasts(workspaceId, input.limit) });
  } catch (error) { next(error); }
}

export async function schedules(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = executiveWorkspaceParamsSchema.parse(req.params);
    return successResponse(res, 'Executive schedules loaded', { items: await service.listSchedules(workspaceId) });
  } catch (error) { next(error); }
}

export async function saveSchedule(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, cycleType } = executiveScheduleParamsSchema.parse(req.params);
    const input = saveExecutiveScheduleSchema.parse(req.body);
    return successResponse(res, 'Executive schedule saved', await service.saveSchedule({
      workspaceId,
      cycleType,
      timezone: input.timezone,
      hourOfDay: input.hourOfDay,
      weekday: cycleType === 'daily' ? 0 : input.weekday,
      active: input.active,
    }));
  } catch (error) { next(error); }
}

export async function scenarios(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = executiveWorkspaceParamsSchema.parse(req.params);
    const input = executiveListQuerySchema.parse(req.query);
    return successResponse(res, 'Executive scenarios loaded', { items: await service.listScenarios(workspaceId, input.limit) });
  } catch (error) { next(error); }
}

export async function scenarioDetail(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, scenarioId } = executiveScenarioParamsSchema.parse(req.params);
    return successResponse(res, 'Executive scenario loaded', await service.getScenario(workspaceId, scenarioId));
  } catch (error) { next(error); }
}

export async function createScenario(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = executiveWorkspaceParamsSchema.parse(req.params);
    const input = createExecutiveScenarioSchema.parse(req.body);
    return createdResponse(res, 'Executive scenario created', await service.createScenario({
      workspaceId,
      ...input,
      createdBy: req.user!.id,
    }));
  } catch (error) { next(error); }
}

export async function proposals(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = executiveWorkspaceParamsSchema.parse(req.params);
    const input = executiveListQuerySchema.parse(req.query);
    return successResponse(res, 'Executive proposals loaded', {
      items: await service.listProposals(workspaceId, input.limit, await actorAccess(req, workspaceId), input.status),
    });
  } catch (error) { next(error); }
}

export async function proposalDetail(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, proposalId } = executiveProposalParamsSchema.parse(req.params);
    return successResponse(res, 'Executive proposal loaded', await service.getProposal(workspaceId, proposalId, await actorAccess(req, workspaceId)));
  } catch (error) { next(error); }
}

export async function createProposal(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = executiveWorkspaceParamsSchema.parse(req.params);
    const input = createExecutiveProposalSchema.parse(req.body);
    const result = await service.createProposal({
      workspaceId,
      proposalType: input.proposalType,
      title: input.title,
      objective: input.objective,
      priority: input.priority,
      confidence: input.confidence,
      expectedImpact: input.expectedImpact,
      riskNotes: input.riskNotes,
      evidence: input.evidence,
      createdBy: req.user!.id,
      ...(input.cycleId !== undefined ? { cycleId: input.cycleId } : {}),
      ...(input.findingId !== undefined ? { findingId: input.findingId } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    return result.created
      ? createdResponse(res, 'Executive proposal created', result)
      : successResponse(res, 'Executive proposal already exists', result);
  } catch (error) { next(error); }
}

export async function decideProposal(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, proposalId } = executiveProposalParamsSchema.parse(req.params);
    const input = decideExecutiveProposalSchema.parse(req.body);
    return successResponse(res, 'Executive proposal decision recorded', await service.decideProposal({
      workspaceId,
      proposalId,
      expectedVersion: input.expectedVersion,
      decision: input.decision,
      actorId: req.user!.id,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    }));
  } catch (error) { next(error); }
}
