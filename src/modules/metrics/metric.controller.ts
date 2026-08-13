import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './metric.service.js';
import {
  createMetricSchema,
  ingestMetricPointsSchema,
  listMetricPointsQuerySchema,
  metricParamsSchema,
  updateMetricSchema,
} from './metric.validator.js';

export async function list(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = metricParamsSchema.parse(req.params);
    const items = await service.listMetrics(workspaceId);
    return successResponse(res, 'Metrics loaded', { items });
  } catch (error) {
    next(error);
  }
}

export async function get(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = metricParamsSchema.parse(req.params);
    const metric = await service.getMetric(params.workspaceId, params.metricId!);
    return successResponse(res, 'Metric loaded', metric);
  } catch (error) {
    next(error);
  }
}

export async function create(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = metricParamsSchema.parse(req.params);
    const input = createMetricSchema.parse(req.body);
    const metric = await service.createMetric(workspaceId, input);
    return createdResponse(res, 'Metric created', metric);
  } catch (error) {
    next(error);
  }
}

export async function update(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = metricParamsSchema.parse(req.params);
    const input = updateMetricSchema.parse(req.body);
    const metric = await service.updateMetric(params.workspaceId, params.metricId!, input);
    return successResponse(res, 'Metric updated', metric);
  } catch (error) {
    next(error);
  }
}

export async function archive(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = metricParamsSchema.parse(req.params);
    await service.archiveMetric(params.workspaceId, params.metricId!);
    return successResponse(res, 'Metric archived');
  } catch (error) {
    next(error);
  }
}

export async function ingestPoints(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = metricParamsSchema.parse(req.params);
    const input = ingestMetricPointsSchema.parse(req.body);
    const result = await service.insertPoints(params.workspaceId, params.metricId!, input.points);
    return createdResponse(res, 'Metric points ingested', result);
  } catch (error) {
    next(error);
  }
}

export async function listPoints(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = metricParamsSchema.parse(req.params);
    const filters = listMetricPointsQuerySchema.parse(req.query);
    const result = await service.listPoints(params.workspaceId, params.metricId!, filters);
    return successResponse(res, 'Metric points loaded', result);
  } catch (error) {
    next(error);
  }
}
