import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../utils/app-error.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as repo from './website.repo.js';
import { automaticGenerationSchema, createDomainSchema, createJobSchema, createSiteSchema, domainParams, jobParams, siteIdParams } from './website.validator.js';
import { publishWebsiteJob } from './website.publish.service.js';
import { getActiveWebsiteGenerationJob, resetWebsiteProviderState, startAutomaticWebsiteGeneration, syncWordpressProviderSites } from './website.automation.service.js';
import { webflowCollections, webflowCustomDomains, webflowSites, wordpressMedia, wordpressPages, wordpressPosts } from './website.provider.service.js';
import { requestWebsiteGenerationWorkerRun } from './website.worker.js';

type WorkspaceRequest = Request & { user?: { id: string } };
function workspaceId(req: Request) { return String(req.params.workspaceId); }

export async function list(req: Request, res: Response, next: NextFunction) { try { return successResponse(res, 'Website sites loaded', { items: await repo.listSites(workspaceId(req)) }); } catch (error) { next(error); } }
export async function providerContent(req: Request, res: Response, next: NextFunction) {
  try {
    const params = siteIdParams.parse(req.params);
    const site = await repo.getSite(params.workspaceId, params.siteId);
    if (!site) throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'The website site was not found');
    if (site.provider === 'wordpress' && site.externalSiteId) {
      const [pages, posts, media] = await Promise.all([
        wordpressPages(params.workspaceId, site.externalSiteId),
        wordpressPosts(params.workspaceId, site.externalSiteId),
        wordpressMedia(params.workspaceId, site.externalSiteId),
      ]);
      return successResponse(res, 'Website provider content loaded', { provider: site.provider, site, pages, posts, media });
    }
    if (site.provider === 'webflow' && site.externalSiteId) {
      const [sites, collections, customDomains] = await Promise.all([
        webflowSites(params.workspaceId),
        webflowCollections(params.workspaceId, site.externalSiteId),
        webflowCustomDomains(params.workspaceId, site.externalSiteId),
      ]);
      return successResponse(res, 'Website provider content loaded', { provider: site.provider, site, sites, collections, customDomains });
    }
    return successResponse(res, 'Website provider content loaded', { provider: site.provider, site });
  } catch (error) { next(error); }
}

export async function wordpressContent(req: Request, res: Response, next: NextFunction) {
  try {
    const params = siteIdParams.parse(req.params);
    const site = await repo.getSite(params.workspaceId, params.siteId);
    if (!site || site.provider !== 'wordpress' || !site.externalSiteId) throw new AppError(404, 'WORDPRESS_SITE_NOT_FOUND', 'The connected WordPress site was not found');
    const [pages, posts, media] = await Promise.all([
      wordpressPages(params.workspaceId, site.externalSiteId),
      wordpressPosts(params.workspaceId, site.externalSiteId),
      wordpressMedia(params.workspaceId, site.externalSiteId),
    ]);
    return successResponse(res, 'WordPress content loaded', {
      site: { id: site.id, name: site.name, url: site.externalSiteUrl, status: site.status },
      pages,
      posts,
      media,
    });
  } catch (error) { next(error); }
}

export async function syncProvider(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const input = automaticGenerationSchema.pick({ provider: true }).parse(req.body);
    if (input.provider !== 'wordpress') throw new AppError(400, 'WEBSITE_PROVIDER_SYNC_UNSUPPORTED', 'Only WordPress site synchronization is supported here');
    return successResponse(res, 'WordPress websites synchronized', { items: await syncWordpressProviderSites(workspaceId(req)) });
  } catch (error) { next(error); }
}

export async function automaticGenerate(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const input = automaticGenerationSchema.parse(req.body);
    const result = await startAutomaticWebsiteGeneration({
      workspaceId: workspaceId(req),
      userId: req.user!.id,
      provider: input.provider,
      ...(input.siteId ? { siteId: input.siteId } : {}),
      ...(input.language ? { language: input.language } : {}),
    });
    requestWebsiteGenerationWorkerRun();
    return createdResponse(res, 'Automatic website generation started', result);
  } catch (error) { next(error); }
}
export async function cleanupProvider(req: WorkspaceRequest, res: Response, next: NextFunction) { try { const input = automaticGenerationSchema.pick({ provider: true }).parse(req.body); await resetWebsiteProviderState(workspaceId(req), input.provider); return successResponse(res, 'Website provider cleanup completed'); } catch (error) { next(error); } }
export async function create(req: WorkspaceRequest, res: Response, next: NextFunction) { try { const input = createSiteSchema.parse(req.body); if (input.provider === 'managed' && input.ownershipMode !== 'managed') throw new AppError(400, 'WEBSITE_OWNERSHIP_MODE_INVALID', 'Managed provider sites must use managed ownership'); if (input.provider !== 'managed' && input.ownershipMode !== 'connected') throw new AppError(400, 'WEBSITE_OWNERSHIP_MODE_INVALID', 'WordPress and Webflow sites must use connected ownership'); return createdResponse(res, 'Website site created', await repo.createSite({ workspaceId: workspaceId(req), ...input })); } catch (error) { next(error); } }
export async function addDomain(req: Request, res: Response, next: NextFunction) { try { const params = siteIdParams.parse(req.params); const site = await repo.getSite(params.workspaceId, params.siteId); if (!site) throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'Website site was not found'); return createdResponse(res, 'Domain verification created', await repo.createDomain(params.siteId, createDomainSchema.parse(req.body).hostname)); } catch (error) { next(error); } }
export async function verifyDomain(req: Request, res: Response, next: NextFunction) { try { const params = domainParams.parse(req.params); const site = await repo.getSite(params.workspaceId, params.siteId); if (!site) throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'Website site was not found'); const updated = await repo.markDomainVerified(params.siteId, params.domainId); if (!updated) throw new AppError(404, 'WEBSITE_DOMAIN_NOT_FOUND', 'Website domain was not found'); return successResponse(res, 'Domain verified', await repo.getSite(params.workspaceId, params.siteId)); } catch (error) { next(error); } }
export async function createJob(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = siteIdParams.parse(req.params);
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
export async function publishJob(req: Request, res: Response, next: NextFunction) { try { const params = jobParams.parse(req.params); return successResponse(res, 'Website published', await publishWebsiteJob(params.workspaceId, params.siteId, params.jobId)); } catch (error) { next(error); } }
