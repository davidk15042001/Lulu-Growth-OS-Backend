import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import { requestPremiumMediaWorkerRun } from './premium-media.worker.js';
import {
  createPremiumMediaSchema,
  premiumMediaParamsSchema,
} from './premium-media.validator.js';
import * as service from './premium-media.service.js';

const callbackParamsSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) });
const assetParamsSchema = premiumMediaParamsSchema.extend({ candidateId: z.string().uuid() });

function userId(req: WorkspaceRequest) {
  if (!req.user?.id) throw new Error('Authentication is required');
  return req.user.id;
}

export async function start(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, productId } = premiumMediaParamsSchema.parse(req.params);
    if (!productId) throw new Error('Product id is required');
    const input = createPremiumMediaSchema.parse(req.body);
    const files = Array.isArray(req.files) ? req.files : [];
    const result = await service.startPremiumMedia(workspaceId, productId, userId(req), input, files);
    requestPremiumMediaWorkerRun();
    return createdResponse(res, result.reused ? 'Premium media production is already running' : 'Premium media production started', result);
  } catch (error) {
    next(error);
  }
}

export async function latest(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, productId } = premiumMediaParamsSchema.parse(req.params);
    if (!productId) throw new Error('Product id is required');
    return successResponse(res, 'Latest premium media production loaded', {
      job: await service.getLatestPremiumMediaJob(workspaceId, productId),
      configuration: service.premiumMediaConfiguration(),
    });
  } catch (error) {
    next(error);
  }
}

export async function get(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, productId, jobId } = premiumMediaParamsSchema.parse(req.params);
    if (!productId || !jobId) throw new Error('Product and premium media job ids are required');
    return successResponse(res, 'Premium media production loaded', await service.getPremiumMediaJob(workspaceId, productId, jobId));
  } catch (error) {
    next(error);
  }
}

export async function asset(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, productId, candidateId } = assetParamsSchema.parse(req.params);
    if (!productId) throw new Error('Product id is required');
    const result = await service.getPremiumMediaAsset(workspaceId, productId, candidateId);
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=3600, immutable');
    return res.status(200).send(result.buffer);
  } catch (error) {
    next(error);
  }
}

export async function callback(req: Request, res: Response, next: NextFunction) {
  try {
    const { token } = callbackParamsSchema.parse(req.params);
    await service.handleKieCallback(token, req.body);
    requestPremiumMediaWorkerRun();
    return successResponse(res, 'Callback accepted');
  } catch (error) {
    next(error);
  }
}
