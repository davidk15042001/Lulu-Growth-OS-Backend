import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../utils/app-error.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as repo from './website.repo.js';
import { automaticGenerationSchema, createDomainSchema, createJobSchema, createSiteSchema, domainParams, jobParams, siteIdParams } from './website.validator.js';
import { generateWebsitePlan } from './website.generation.service.js';
import { publishWebsiteJob } from './website.publish.service.js';
import { getActiveWebsiteGenerationJob, resetWebsiteProviderState, startAutomaticWebsiteGeneration } from './website.automation.service.js';
import { webflowCollections, webflowCustomDomains, webflowSites, wordpressMedia, wordpressPages, wordpressPosts } from './website.provider.service.js';

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

export async function automaticGenerate(req: WorkspaceRequest, res: Response, next: NextFunction) { try { const input = automaticGenerationSchema.parse(req.body); return createdResponse(res, 'Automatic website generation started', await startAutomaticWebsiteGeneration({ workspaceId: workspaceId(req), userId: req.user!.id, provider: input.provider, ...(input.siteId ? { siteId: input.siteId } : {}), ...(input.language ? { language: input.language } : {}) })); } catch (error) { next(error); } }
export async function cleanupProvider(req: WorkspaceRequest, res: Response, next: NextFunction) { try { const input = automaticGenerationSchema.pick({ provider: true }).parse(req.body); await resetWebsiteProviderState(workspaceId(req), input.provider); return successResponse(res, 'Website provider cleanup completed'); } catch (error) { next(error); } }
export async function create(req: WorkspaceRequest, res: Response, next: NextFunction) { try { const input = createSiteSchema.parse(req.body); if (input.provider === 'managed' && input.ownershipMode !== 'managed') throw new AppError(400, 'WEBSITE_OWNERSHIP_MODE_INVALID', 'Managed provider sites must use managed ownership'); if (input.provider !== 'managed' && input.ownershipMode !== 'connected') throw new AppError(400, 'WEBSITE_OWNERSHIP_MODE_INVALID', 'WordPress and Webflow sites must use connected ownership'); return createdResponse(res, 'Website site created', await repo.createSite({ workspaceId: workspaceId(req), ...input })); } catch (error) { next(error); } }
export async function addDomain(req: Request, res: Response, next: NextFunction) { try { const params = siteIdParams.parse(req.params); const site = await repo.getSite(params.workspaceId, params.siteId); if (!site) throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'Website site was not found'); return createdResponse(res, 'Domain verification created', await repo.createDomain(params.siteId, createDomainSchema.parse(req.body).hostname)); } catch (error) { next(error); } }
export async function verifyDomain(req: Request, res: Response, next: NextFunction) { try { const params = domainParams.parse(req.params); const site = await repo.getSite(params.workspaceId, params.siteId); if (!site) throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'Website site was not found'); const updated = await repo.markDomainVerified(params.siteId, params.domainId); if (!updated) throw new AppError(404, 'WEBSITE_DOMAIN_NOT_FOUND', 'Website domain was not found'); return successResponse(res, 'Domain verified', await repo.getSite(params.workspaceId, params.siteId)); } catch (error) { next(error); } }
export async function createJob(req: WorkspaceRequest, res: Response, next: NextFunction) { try { const params = siteIdParams.parse(req.params); const site = await repo.getSite(params.workspaceId, params.siteId); if (!site) throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'Website site was not found'); await repo.expireStaleActiveJobs(params.siteId); const active = await repo.findActiveJob(params.siteId); if (active) return createdResponse(res, 'Website generation already running', active); const job = await repo.createJob({ siteId: params.siteId, prompt: createJobSchema.parse(req.body).prompt, createdBy: req.user!.id }); if (!job) throw new AppError(500, 'WEBSITE_GENERATION_FAILED', 'Website generation job could not be created'); await repo.updateJob(params.siteId, job.id, { status: 'planning' }); void (async () => { try { const plan = await generateWebsitePlan({ workspaceId: params.workspaceId, userId: req.user!.id, prompt: job.prompt, provider: site.provider }); await repo.updateJob(params.siteId, job.id, { status: 'preview', plan, preview: { provider: site.provider, ownershipMode: site.ownershipMode, pages: plan.pages.map((page) => ({ title: page.title, slug: page.slug, seoTitle: page.seoTitle, seoDescription: page.seoDescription })) } }); } catch (generationError) { await repo.updateJob(params.siteId, job.id, { status: 'failed', errorCode: generationError instanceof AppError ? generationError.code : 'WEBSITE_GENERATION_FAILED', errorMessage: generationError instanceof Error ? generationError.message : 'Website generation failed' }).catch(() => undefined); } })(); return createdResponse(res, 'Website generation job started', await repo.getJob(params.siteId, job.id)); } catch (error) { next(error); } }
export async function getActiveJob(req: Request, res: Response, next: NextFunction) { try { const params = siteIdParams.parse(req.params); return successResponse(res, 'Active website generation job loaded', await getActiveWebsiteGenerationJob({ workspaceId: params.workspaceId, siteId: params.siteId })); } catch (error) { next(error); } }
export async function getJob(req: Request, res: Response, next: NextFunction) { try { const params = jobParams.parse(req.params); const job = await repo.getJob(params.siteId, params.jobId); if (!job) throw new AppError(404, 'WEBSITE_GENERATION_JOB_NOT_FOUND', 'Website generation job was not found'); return successResponse(res, 'Website generation job loaded', job); } catch (error) { next(error); } }
export async function publishJob(req: Request, res: Response, next: NextFunction) { try { const params = jobParams.parse(req.params); return successResponse(res, 'Website published', await publishWebsiteJob(params.workspaceId, params.siteId, params.jobId)); } catch (error) { next(error); } }
