import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './company-brain.service.js';
import { addDependencySchema, brainListQuerySchema, brainMissionParamsSchema, brainTaskParamsSchema, brainWorkspaceParamsSchema, createDecisionSchema, createLearningSchema, createMissionSchema, createTaskSchema, updateMissionSchema, updateTaskSchema } from './company-brain.validator.js';

export async function overview(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = brainWorkspaceParamsSchema.parse(req.params); const { limit } = brainListQuerySchema.parse(req.query); return successResponse(res, 'Company Brain overview loaded', await service.overview(workspaceId, limit)); } catch (error) { next(error); }
}

export async function signals(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = brainWorkspaceParamsSchema.parse(req.params); const input = brainListQuerySchema.parse(req.query); return successResponse(res, 'Company Brain signals loaded', { items: await service.listSignals(workspaceId, input.limit, input.status) }); } catch (error) { next(error); }
}

export async function missions(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = brainWorkspaceParamsSchema.parse(req.params); const input = brainListQuerySchema.parse(req.query); return successResponse(res, 'Company Brain missions loaded', { items: await service.listMissions(workspaceId, input.limit, input.status) }); } catch (error) { next(error); }
}

export async function createMission(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = brainWorkspaceParamsSchema.parse(req.params);
    const input = createMissionSchema.parse(req.body);
    return createdResponse(res, 'Company Brain mission created', await service.createMission({
      workspaceId, signalId: input.signalId, priority: input.priority, createdBy: req.user!.id,
      ...(input.title ? { title: input.title } : {}),
      ...(input.objective ? { objective: input.objective } : {}),
    }));
  } catch (error) { next(error); }
}

export async function updateMission(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const params = brainMissionParamsSchema.parse(req.params); const input = updateMissionSchema.parse(req.body); return successResponse(res, 'Company Brain mission updated', await service.updateMission(params.workspaceId, params.missionId, input.status, input.outcome)); } catch (error) { next(error); }
}

export async function decisions(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = brainWorkspaceParamsSchema.parse(req.params); const { limit } = brainListQuerySchema.parse(req.query); return successResponse(res, 'Company Brain decisions loaded', { items: await service.listDecisions(workspaceId, limit) }); } catch (error) { next(error); }
}

export async function createDecision(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = brainWorkspaceParamsSchema.parse(req.params);
    const input = createDecisionSchema.parse(req.body);
    return createdResponse(res, 'Company Brain decision recorded', await service.createDecision({
      workspaceId, decisionType: input.decisionType, decision: input.decision, confidence: input.confidence,
      rationale: input.rationale, evidence: input.evidence, actorType: input.actorType, actorId: req.user!.id,
      ...(input.signalId ? { signalId: input.signalId } : {}),
      ...(input.missionId ? { missionId: input.missionId } : {}),
    }));
  } catch (error) { next(error); }
}

export async function missionTasks(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const params = brainMissionParamsSchema.parse(req.params); return successResponse(res, 'Company Brain tasks loaded', { items: await service.listTasksForMission(params.workspaceId, params.missionId) }); } catch (error) { next(error); }
}

export async function missionGraph(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const params = brainMissionParamsSchema.parse(req.params); return successResponse(res, 'Company Brain task graph loaded', await service.getTaskGraph(params.workspaceId, params.missionId)); } catch (error) { next(error); }
}

export async function createTask(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = brainMissionParamsSchema.parse(req.params);
    const input = createTaskSchema.parse(req.body);
    return createdResponse(res, 'Company Brain task created', await service.createTask({
      workspaceId: params.workspaceId, missionId: params.missionId, ...input,
      actorType: 'human', actorId: req.user!.id,
    }));
  } catch (error) { next(error); }
}

export async function taskDetail(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const params = brainTaskParamsSchema.parse(req.params); const task = await service.getTask(params.workspaceId, params.taskId); if (!task) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Company Brain task not found' } }); return successResponse(res, 'Company Brain task loaded', task); } catch (error) { next(error); }
}

export async function updateTask(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = brainTaskParamsSchema.parse(req.params);
    const input = updateTaskSchema.parse(req.body);
    return successResponse(res, 'Company Brain task updated', await service.updateTask({ ...params, ...input, actorType: 'human', actorId: req.user!.id }));
  } catch (error) { next(error); }
}

export async function addTaskDependency(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = brainTaskParamsSchema.parse(req.params);
    const input = addDependencySchema.parse(req.body);
    return createdResponse(res, 'Company Brain task dependency added', await service.addTaskDependency({ ...params, ...input, actorId: req.user!.id }));
  } catch (error) { next(error); }
}

export async function learning(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = brainWorkspaceParamsSchema.parse(req.params); const { limit } = brainListQuerySchema.parse(req.query); return successResponse(res, 'Company Brain learning loaded', { items: await service.listLearning(workspaceId, limit) }); } catch (error) { next(error); }
}

export async function createLearning(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = brainWorkspaceParamsSchema.parse(req.params);
    const input = createLearningSchema.parse(req.body);
    return createdResponse(res, 'Company Brain learning recorded', await service.recordLearning({ ...input, workspaceId, actorId: req.user!.id }));
  } catch (error) { next(error); }
}
