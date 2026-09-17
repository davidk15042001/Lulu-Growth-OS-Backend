import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { successResponse } from '../../utils/response.js';
import * as service from './sales-pipeline.service.js';
import { salesPipelineParamsSchema, transitionSalesRecordSchema, type TransitionSalesRecordInput } from './sales-pipeline.validator.js';
import { listRecordsQuerySchema } from '../records/record.validator.js';

export async function list(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = salesPipelineParamsSchema.omit({ recordId: true }).parse(req.params);
    return successResponse(res, 'Sales pipeline records loaded', await service.listPipelineRecords(params.workspaceId, params.resourceType as never, listRecordsQuerySchema.parse(req.query)));
  } catch (error) { next(error); }
}

export async function get(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = salesPipelineParamsSchema.parse(req.params);
    return successResponse(res, 'Sales pipeline record loaded', await service.getPipelineRecord(params.workspaceId, params.resourceType as never, params.recordId));
  } catch (error) { next(error); }
}

export async function transition(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = salesPipelineParamsSchema.parse(req.params);
    const input = transitionSalesRecordSchema.parse(req.body) as TransitionSalesRecordInput;
    return successResponse(res, 'Sales pipeline state updated', await service.transitionRecord(params.workspaceId, params.resourceType as never, params.recordId, req.user!.id, input));
  } catch (error) { next(error); }
}
