import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './social-publishing.service.js';
import { requestSocialPublishingWorkerRun } from './social-publishing.worker.js';
import {
  accountParamsSchema,
  contentParamsSchema,
  createSocialAccountSchema,
  createSocialContentSchema,
  createSocialPublicationSchema,
  publicationParamsSchema,
  socialContentListQuerySchema,
  socialPublicationListQuerySchema,
  transitionSocialPublicationSchema,
  updateSocialContentSchema,
  verifySocialAccountSchema,
  workspaceParamsSchema,
} from './social-publishing.validator.js';

function actorId(req: WorkspaceRequest) {
  if (!req.user?.id) throw new Error('Authentication is required');
  return req.user.id;
}

export async function listAccounts(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = workspaceParamsSchema.parse(req.params); return successResponse(res, 'Social accounts loaded', { items: await service.listAccounts(workspaceId) }); } catch (error) { next(error); }
}

export async function createAccount(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const input = createSocialAccountSchema.parse(req.body);
    const result = await service.createAccount({ workspaceId, actorId: actorId(req), providerConnectionId: input.providerConnectionId, provider: input.provider, displayName: input.displayName, facebookPageId: input.facebookPageId, instagramBusinessAccountId: input.instagramBusinessAccountId ?? null, idempotencyKey: input.idempotencyKey });
    return createdResponse(res, result.created ? 'Social account created; provider verification is required' : 'Existing social account returned', result.account);
  } catch (error) { next(error); }
}

export async function getAccount(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const params = accountParamsSchema.parse(req.params); return successResponse(res, 'Social account loaded', await service.getAccount(params.workspaceId, params.accountId)); } catch (error) { next(error); }
}

export async function verifyAccount(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = accountParamsSchema.parse(req.params);
    const input = verifySocialAccountSchema.parse(req.body);
    return successResponse(res, 'Social account verification completed', await service.verifyAccount({ workspaceId: params.workspaceId, accountId: params.accountId, actorId: actorId(req), expectedVersion: input.expectedVersion }));
  } catch (error) { next(error); }
}

export async function listContent(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = workspaceParamsSchema.parse(req.params); const query = socialContentListQuerySchema.parse(req.query); return successResponse(res, 'Social content loaded', { items: await service.listContent(workspaceId, query.status) }); } catch (error) { next(error); }
}

export async function createContent(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const input = createSocialContentSchema.parse(req.body);
    const result = await service.createContent({ workspaceId, actorId: actorId(req), actorType: 'USER', actorRef: actorId(req), contentType: input.contentType, status: input.status, message: input.message, linkUrl: input.linkUrl ?? null, mediaUrl: input.mediaUrl ?? null, altText: input.altText ?? null, metadata: input.metadata, idempotencyKey: input.idempotencyKey });
    return createdResponse(res, result.created ? 'Social content created' : 'Existing social content returned', result.content);
  } catch (error) { next(error); }
}

export async function getContent(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const params = contentParamsSchema.parse(req.params); return successResponse(res, 'Social content loaded', await service.getContent(params.workspaceId, params.contentId)); } catch (error) { next(error); }
}

export async function updateContent(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = contentParamsSchema.parse(req.params);
    const input = updateSocialContentSchema.parse(req.body);
    return successResponse(res, 'Social content updated', await service.updateContent({
      workspaceId: params.workspaceId,
      contentId: params.contentId,
      actorId: actorId(req),
      expectedVersion: input.expectedVersion,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.message !== undefined ? { message: input.message } : {}),
      ...(input.linkUrl !== undefined ? { linkUrl: input.linkUrl } : {}),
      ...(input.mediaUrl !== undefined ? { mediaUrl: input.mediaUrl } : {}),
      ...(input.altText !== undefined ? { altText: input.altText } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    }));
  } catch (error) { next(error); }
}

export async function listPublications(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = workspaceParamsSchema.parse(req.params); const query = socialPublicationListQuerySchema.parse(req.query); return successResponse(res, 'Social publications loaded', { items: await service.listPublicationJobs(workspaceId, query.status) }); } catch (error) { next(error); }
}

export async function getPublication(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const params = publicationParamsSchema.parse(req.params); return successResponse(res, 'Social publication loaded', await service.getPublicationJob(params.workspaceId, params.publicationId)); } catch (error) { next(error); }
}

export async function createPublication(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = workspaceParamsSchema.parse(req.params);
    const input = createSocialPublicationSchema.parse(req.body);
    const userId = actorId(req);
    const result = await service.createPublication({ workspaceId, actorId: userId, actorType: 'USER', actorRef: userId, socialAccountId: input.socialAccountId, contentId: input.contentId, execution: input.execution, scheduledAt: input.scheduledAt ?? null, maxAttempts: input.maxAttempts, idempotencyKey: input.idempotencyKey });
    if (['QUEUED','SCHEDULED'].includes(result.job.status)) requestSocialPublishingWorkerRun();
    return createdResponse(res, result.created ? 'Social publication created' : 'Existing social publication returned', result.job);
  } catch (error) { next(error); }
}

async function transition(req: WorkspaceRequest, res: Response, next: NextFunction, action: 'QUEUE' | 'CANCEL' | 'RETRY') {
  try {
    const params = publicationParamsSchema.parse(req.params);
    const input = transitionSocialPublicationSchema.parse(req.body);
    const userId = actorId(req);
    const job = await service.transitionPublication({ workspaceId: params.workspaceId, jobId: params.publicationId, actorId: userId, actorType: 'USER', actorRef: userId, expectedVersion: input.expectedVersion, action, ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}) });
    if (action !== 'CANCEL') requestSocialPublishingWorkerRun();
    return successResponse(res, `Social publication ${action.toLowerCase()} accepted`, job);
  } catch (error) { next(error); }
}

export function queuePublication(req: WorkspaceRequest, res: Response, next: NextFunction) { return transition(req, res, next, 'QUEUE'); }
export function retryPublication(req: WorkspaceRequest, res: Response, next: NextFunction) { return transition(req, res, next, 'RETRY'); }
export function cancelPublication(req: WorkspaceRequest, res: Response, next: NextFunction) { return transition(req, res, next, 'CANCEL'); }
