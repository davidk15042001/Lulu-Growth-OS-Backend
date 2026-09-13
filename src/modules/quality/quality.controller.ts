import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './quality.service.js';
import {
  artifactParamsSchema, createArtifactSchema, createReviewSchema, feedbackSchema,
  createEvidenceSchema, listArtifactsQuerySchema, outcomeSchema, qualityConfigSchema, repairSchema,
  providerStatusSchema, releaseDecisionSchema, workspaceParamsSchema,
} from './quality.validator.js';

export async function overview(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = workspaceParamsSchema.parse(req.params); return successResponse(res,'Quality overview loaded',await service.getOverview(workspaceId)); } catch (error) { next(error); }
}
export async function list(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = workspaceParamsSchema.parse(req.params); return successResponse(res,'Quality artifacts loaded',{items:await service.listArtifacts(workspaceId,listArtifactsQuerySchema.parse(req.query))}); } catch (error) { next(error); }
}
export async function create(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = workspaceParamsSchema.parse(req.params); return createdResponse(res,'Quality artifact created',await service.createArtifact(workspaceId,req.user!.id,createArtifactSchema.parse(req.body))); } catch (error) { next(error); }
}
export async function evidence(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = workspaceParamsSchema.parse(req.params); return createdResponse(res,'Quality evidence recorded',await service.addEvidence(workspaceId,req.user!.id,createEvidenceSchema.parse(req.body))); } catch (error) { next(error); }
}
export async function rubrics(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = workspaceParamsSchema.parse(req.params); const artifactType = typeof req.query.artifactType === 'string' ? req.query.artifactType : undefined; return successResponse(res,'Quality rubrics loaded',await service.listRubrics(workspaceId,artifactType)); } catch (error) { next(error); }
}
export async function get(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const p=artifactParamsSchema.parse(req.params); return successResponse(res,'Quality artifact loaded',await service.getArtifact(p.workspaceId,p.artifactId)); } catch (error) { next(error); }
}
export async function review(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId }=workspaceParamsSchema.parse(req.params); return createdResponse(res,'Quality review recorded',await service.createReview(workspaceId,req.user!.id,createReviewSchema.parse(req.body))); } catch (error) { next(error); }
}
export async function repair(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const p=artifactParamsSchema.parse(req.params); return createdResponse(res,'Quality repair requested',await service.requestRepair(p.workspaceId,req.user!.id,p.artifactId,repairSchema.parse(req.body))); } catch (error) { next(error); }
}
export async function providerStatus(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const p=artifactParamsSchema.parse(req.params); return successResponse(res,'Quality provider status updated',await service.updateProviderStatus(p.workspaceId,req.user!.id,p.artifactId,providerStatusSchema.parse(req.body))); } catch (error) { next(error); }
}
export async function release(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const p=artifactParamsSchema.parse(req.params); return successResponse(res,'Quality release decision recorded',await service.decideRelease(p.workspaceId,req.user!.id,p.artifactId,releaseDecisionSchema.parse(req.body),false)); } catch (error) { next(error); }
}
export async function override(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const p=artifactParamsSchema.parse(req.params); return successResponse(res,'Quality override recorded',await service.decideRelease(p.workspaceId,req.user!.id,p.artifactId,releaseDecisionSchema.parse(req.body),true)); } catch (error) { next(error); }
}
export async function feedback(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const p=artifactParamsSchema.parse(req.params); return createdResponse(res,'Quality feedback recorded',await service.addFeedback(p.workspaceId,req.user!.id,p.artifactId,feedbackSchema.parse(req.body))); } catch (error) { next(error); }
}
export async function outcome(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const p=artifactParamsSchema.parse(req.params); return createdResponse(res,'Quality outcome recorded',await service.addOutcome(p.workspaceId,p.artifactId,outcomeSchema.parse(req.body))); } catch (error) { next(error); }
}
export async function config(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId }=workspaceParamsSchema.parse(req.params); return successResponse(res,'Quality configuration loaded',await service.getConfig(workspaceId)); } catch (error) { next(error); }
}
export async function updateConfig(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId }=workspaceParamsSchema.parse(req.params); return successResponse(res,'Quality configuration updated',await service.updateConfig(workspaceId,req.user!.id,qualityConfigSchema.parse(req.body))); } catch (error) { next(error); }
}
