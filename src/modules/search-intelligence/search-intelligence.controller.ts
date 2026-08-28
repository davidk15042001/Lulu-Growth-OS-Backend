import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { successResponse } from '../../utils/response.js';
import * as service from './search-intelligence.service.js';
import {
  analyzeSearchSchema,
  applySearchSchema,
  channelParamsSchema,
} from './search-intelligence.validator.js';

export async function summary(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = channelParamsSchema.parse(req.params);
    const result = await service.getChannelSummary(params.workspaceId, req.user!.id, params.channel);
    return successResponse(res, 'Search intelligence summary loaded', result);
  } catch (error) {
    next(error);
  }
}

export async function analyze(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = channelParamsSchema.parse(req.params);
    const input = analyzeSearchSchema.parse(req.body);
    const result = await service.analyzeChannel(params.workspaceId, req.user!.id, params.channel, input);
    return successResponse(res, 'Search intelligence analysis completed', result);
  } catch (error) {
    next(error);
  }
}

export async function apply(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = channelParamsSchema.parse(req.params);
    const input = applySearchSchema.parse(req.body);
    const result = await service.applyChannel(params.workspaceId, req.user!.id, params.channel, input);
    return successResponse(res, 'Search intelligence apply completed', result);
  } catch (error) {
    next(error);
  }
}
