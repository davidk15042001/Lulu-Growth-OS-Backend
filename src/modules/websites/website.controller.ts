import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../utils/app-error.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as repo from './website.repo.js';
import { verifyDomainOwnership, renewDomainChallenge } from './domain-verification.service.js';
import { createDomainSchema, createJobSchema, createSiteSchema, domainParams, jobParams, managedWebsiteAssetSchema, siteIdParams } from './website.validator.js';
import { publishWebsiteJob } from './website.publish.service.js';
import { getActiveWebsiteGenerationJob } from './website.automation.service.js';
import { requestWebsiteGenerationWorkerRun } from './website.worker.js';
import { assertWorkspaceAutomationActive } from '../workspaces/workspace-automation.service.js';
import * as assetEditService from './website-asset-edit.service.js';

type WorkspaceRequest = Request & { user?: { id: string } };
function workspaceId(req: Request) { return String(req.params.workspaceId); }

export async function list(req: Request, res: Response, next: NextFunction) { try { return successResponse(res, 'Website sites loaded', { items: await repo.listSites(workspaceId(req)) }); } catch (error) { next(error); } }
export async function create(req: WorkspaceRequest, res: Response, next: NextFunction) { try { const input = createSiteSchema.parse(req.body); return createdResponse(res, 'Lulu managed website created', await repo.createSite({ workspaceId: workspaceId(req), ...input })); } catch (error) { next(error); } }
export async function addDomain(req: Request, res: Response, next: NextFunction) { try { const params = siteIdParams.parse(req.params); const site = await repo.getSite(params.workspaceId, params.siteId); if (!site) throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'Website site was not found'); return createdResponse(res, 'Domain verification created', await repo.createDomain(params.siteId, createDomainSchema.parse(req.body).hostname)); } catch (error) { next(error); } }
export async function listAssets(req: Request, res: Response, next: NextFunction) { try { const params = siteIdParams.parse(req.params); const site = await repo.getSite(params.workspaceId, params.siteId); if (!site || site.provider !== 'managed') throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'Managed website site was not found'); return successResponse(res, 'Website assets loaded', { items: await repo.listManagedWebsiteAssets(params.workspaceId, params.siteId) }); } catch (error) { next(error); } }
export async function asset(req: Request, res: Response, next: NextFunction) {
  try {
    const params = siteIdParams.extend({ assetId: z.string().uuid() }).parse(req.params);
    const value = await repo.getManagedWebsiteAsset(params.workspaceId, params.siteId, params.assetId);
    if (!value) throw new AppError(404, 'WEBSITE_ASSET_NOT_FOUND', 'The website asset was not found');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Type', value.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${String(value.fileName).replace(/["\\\r\n]/g, '')}"`);
    return res.status(200).send(value.content);
  } catch (error) { next(error); }
}
export async function startAssetEdit(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = siteIdParams.extend({ assetId: z.string().uuid() }).parse(req.params);
    const prompt = z.object({ prompt: z.string() }).parse(req.body).prompt;
    if (!req.user?.id) throw new AppError(401, 'UNAUTHORIZED', 'Authentication is required');
    return createdResponse(res, 'Website image edit started', await assetEditService.startEdit({ workspaceId: params.workspaceId, siteId: params.siteId, assetId: params.assetId, userId: req.user.id, prompt }));
  } catch (error) { next(error); }
}
export async function getAssetEdit(req: Request, res: Response, next: NextFunction) {
  try {
    const params = siteIdParams.extend({ editId: z.string().uuid() }).parse(req.params);
    return successResponse(res, 'Website image edit loaded', await assetEditService.getEdit(params.workspaceId, params.siteId, params.editId));
  } catch (error) { next(error); }
}
export async function assetEditCallback(req: Request, res: Response, next: NextFunction) {
  try {
    const token = z.string().regex(/^[a-f0-9]{64}$/).parse(req.params.token);
    return successResponse(res, 'Website image edit callback accepted', await assetEditService.handleCallback(token, req.body));
  } catch (error) { next(error); }
}
export async function uploadAsset(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = siteIdParams.parse(req.params);
    const site = await repo.getSite(params.workspaceId, params.siteId);
    if (!site || site.provider !== 'managed') throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'Managed website site was not found');
    const file = req.file;
    if (!file) throw new AppError(422, 'WEBSITE_ASSET_REQUIRED', 'Select an image to upload');
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)) throw new AppError(422, 'WEBSITE_ASSET_TYPE_INVALID', 'Only JPEG, PNG, WebP and GIF images are supported');
    let crop: unknown = req.body?.crop;
    if (typeof crop === 'string') {
      try { crop = JSON.parse(crop); } catch { throw new AppError(422, 'WEBSITE_ASSET_CROP_INVALID', 'The crop data is invalid'); }
    }
    const input = managedWebsiteAssetSchema.parse({ ...req.body, crop });
    const asset = await repo.createManagedWebsiteAsset({ workspaceId: params.workspaceId, siteId: params.siteId, uploadedBy: req.user!.id, fileName: file.originalname.slice(0, 255), mimeType: file.mimetype, sizeBytes: file.size, altText: input.altText, placement: input.placement, crop: input.crop, content: file.buffer });
    if (!asset) throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'Managed website site was not found');
    return createdResponse(res, 'Website asset uploaded', asset);
  } catch (error) { next(error); }
}
export async function verifyDomain(req: WorkspaceRequest, res: Response, next: NextFunction) { try { return successResponse(res, 'Domain verification checked', await verifyDomainOwnership({...domainParams.parse(req.params),userId:req.user!.id})); } catch (error) { next(error); } }
export async function renewDomain(req: WorkspaceRequest, res: Response, next: NextFunction) { try { return successResponse(res, 'Domain challenge renewed', await renewDomainChallenge({...domainParams.parse(req.params),userId:req.user!.id})); } catch (error) { next(error); } }
export async function createJob(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = siteIdParams.parse(req.params);
    await assertWorkspaceAutomationActive(params.workspaceId);
    const site = await repo.getSite(params.workspaceId, params.siteId);
    if (!site) throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'Website site was not found');
    const active = await repo.findActiveJob(params.siteId);
    if (active) {
      requestWebsiteGenerationWorkerRun();
      return createdResponse(res, 'Website generation already running', active);
    }
    const cancelled = await repo.findLatestCancelledJob(params.siteId);
    if (cancelled) {
      const resumed = await repo.resumeJob(params.siteId, cancelled.id);
      if (resumed.job) {
        await repo.updateSiteStatus(params.workspaceId, params.siteId, 'generating');
        requestWebsiteGenerationWorkerRun();
        return createdResponse(res, 'Website generation resumed from the last checkpoint', resumed.job);
      }
    }
    const input = createJobSchema.parse(req.body);
    const created = await repo.createJob({ siteId: params.siteId, prompt: input.prompt, createdBy: req.user!.id, autoPublish: false });
    if (!created.job) throw new AppError(500, 'WEBSITE_GENERATION_FAILED', 'Website generation job could not be created');
    requestWebsiteGenerationWorkerRun();
    return createdResponse(res, created.created ? 'Website generation job started' : 'Website generation already running', created.job);
  } catch (error) { next(error); }
}
export async function getActiveJob(req: Request, res: Response, next: NextFunction) { try { const params = siteIdParams.parse(req.params); return successResponse(res, 'Active website generation job loaded', await getActiveWebsiteGenerationJob({ workspaceId: params.workspaceId, siteId: params.siteId })); } catch (error) { next(error); } }
export async function getJob(req: Request, res: Response, next: NextFunction) {
  try {
    const params = jobParams.parse(req.params);
    const site = await repo.getSite(params.workspaceId, params.siteId);
    if (!site) throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'Website site was not found');
    const job = await repo.getJob(params.siteId, params.jobId);
    if (!job) throw new AppError(404, 'WEBSITE_GENERATION_JOB_NOT_FOUND', 'Website generation job was not found');
    return successResponse(res, 'Website generation job loaded', job);
  } catch (error) { next(error); }
}
export async function cancelJob(req: Request, res: Response, next: NextFunction) {
  try {
    const params = jobParams.parse(req.params);
    const site = await repo.getSite(params.workspaceId, params.siteId);
    if (!site) throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'Website site was not found');
    const result = await repo.cancelJob(params.siteId, params.jobId);
    if (!result.job) throw new AppError(404, 'WEBSITE_GENERATION_JOB_NOT_FOUND', 'Website generation job was not found');
    const publishedPages = Array.isArray((result.job.providerResult as { pages?: unknown[] }).pages)
      ? (result.job.providerResult as { pages: unknown[] }).pages.length
      : 0;
    if (result.cancelled) await repo.updateSiteStatus(params.workspaceId, params.siteId, publishedPages > 0 ? 'preview' : 'connected');
    return successResponse(res, result.cancelled ? 'Website generation cancelled' : 'Website generation already finished', result.job);
  } catch (error) { next(error); }
}
export async function resumeJob(req: Request, res: Response, next: NextFunction) {
  try {
    const params = jobParams.parse(req.params);
    await assertWorkspaceAutomationActive(params.workspaceId);
    const site = await repo.getSite(params.workspaceId, params.siteId);
    if (!site) throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'Website site was not found');
    const result = await repo.resumeJob(params.siteId, params.jobId);
    if (!result.job) throw new AppError(404, 'WEBSITE_GENERATION_JOB_NOT_FOUND', 'Website generation job was not found');
    if (!result.resumed && !['queued', 'planning', 'publishing'].includes(result.job.status)) {
      throw new AppError(409, 'WEBSITE_GENERATION_NOT_RESUMABLE', 'Only a cancelled website generation can be resumed');
    }
    await repo.updateSiteStatus(params.workspaceId, params.siteId, 'generating');
    requestWebsiteGenerationWorkerRun();
    return successResponse(res, result.resumed ? 'Website generation resumed from the last checkpoint' : 'Website generation is already running', result.job);
  } catch (error) { next(error); }
}
export async function publishJob(req: Request, res: Response, next: NextFunction) { try { const params = jobParams.parse(req.params); await assertWorkspaceAutomationActive(params.workspaceId); return successResponse(res, 'Website published', await publishWebsiteJob(params.workspaceId, params.siteId, params.jobId)); } catch (error) { next(error); } }
