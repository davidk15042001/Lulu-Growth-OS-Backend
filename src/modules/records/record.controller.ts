import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './record.service.js';
import {
  createRecordSchema,
  listRecordsQuerySchema,
  recordParamsSchema,
  updateRecordSchema,
} from './record.validator.js';

export async function list(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = recordParamsSchema.parse(req.params);
    const filters = listRecordsQuerySchema.parse(req.query);
    const result = await service.listRecords(params.workspaceId, params.resourceType, filters);
    return successResponse(res, 'Records loaded', result);
  } catch (error) {
    next(error);
  }
}

export async function get(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = recordParamsSchema.parse(req.params);
    const record = await service.getRecord(params.workspaceId, params.resourceType, params.recordId!);
    return successResponse(res, 'Record loaded', record);
  } catch (error) {
    next(error);
  }
}

export async function create(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = recordParamsSchema.parse(req.params);
    const input = createRecordSchema.parse(req.body);
    const record = await service.createRecord(params.workspaceId, params.resourceType, req.user!.id, input);
    return createdResponse(res, 'Record created', record);
  } catch (error) {
    next(error);
  }
}

export async function update(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = recordParamsSchema.parse(req.params);
    const input = updateRecordSchema.parse(req.body);
    const record = await service.updateRecord(
      params.workspaceId,
      params.resourceType,
      params.recordId!,
      req.user!.id,
      input
    );
    return successResponse(res, 'Record updated', record);
  } catch (error) {
    next(error);
  }
}

export async function archive(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = recordParamsSchema.parse(req.params);
    await service.archiveRecord(params.workspaceId, params.resourceType, params.recordId!, req.user!.id);
    return successResponse(res, 'Record archived');
  } catch (error) {
    next(error);
  }
}

export async function restore(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = recordParamsSchema.parse(req.params);
    const record = await service.restoreRecord(params.workspaceId, params.resourceType, params.recordId!, req.user!.id);
    return successResponse(res, 'Record restored', record);
  } catch (error) {
    next(error);
  }
}
