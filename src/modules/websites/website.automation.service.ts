import { AppError } from '../../utils/app-error.js';
import { firstWebflowSiteWithCollection, firstWordpressSite } from './website.provider.service.js';
import * as repo from './website.repo.js';
import { generateWebsitePlan } from './website.generation.service.js';
import { publishWebsiteJob } from './website.publish.service.js';
import * as onboardingRepo from '../onboarding/onboarding.repo.js';

export const DEFAULT_WEBSITE_PROMPT = `Create a high-converting, production-ready website for this business using the verified workspace information and the completed AI business analysis as the only source of truth. Build a clear information architecture, compelling but factual copy, strong SEO/GEO/AEO foundations, accessible responsive layouts, and a consistent brand voice. Include the most relevant pages for the business, meaningful calls to action, metadata, and content sections. Never invent facts, testimonials, prices, certifications, locations, customers, metrics, or legal claims. If information is missing, omit it or mark it for confirmation. The result must be ready to publish to the connected CMS.`;

async function getOrCreateProviderSite(workspaceId: string, provider: 'wordpress' | 'webflow') {
  if (provider === 'wordpress') {
    const target = await firstWordpressSite(workspaceId);
    const existing = await repo.findSiteByExternalSiteId(workspaceId, provider, target.id);
    if (existing) return existing;
    return repo.createSite({ workspaceId, provider, ownershipMode: 'connected', name: target.name, externalSiteId: target.id, externalSiteUrl: target.url });
  }
  const target = await firstWebflowSiteWithCollection(workspaceId);
  const existing = await repo.findSiteByExternalSiteId(workspaceId, provider, target.id);
  if (existing) return existing;
  const site = await repo.createSite({ workspaceId, provider, ownershipMode: 'connected', name: target.name, externalSiteId: target.id, externalSiteUrl: target.url });
  if (!site) throw new AppError(500, 'WEBSITE_SITE_CREATE_FAILED', 'The connected Webflow site could not be registered');
  return repo.updateSiteSettings(site.workspaceId, site.id, { collectionId: target.collectionId });
}

function generationErrorMessage(error: unknown) {
  if (!(error instanceof AppError)) return error instanceof Error ? error.message : 'Automatic website generation failed';
  const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  const providerStatus = details.providerHttpStatus;
  const providerCode = details.providerCode;
  const providerMessage = details.providerMessage;
  const diagnostic = [
    typeof providerStatus === 'number' ? `HTTP ${providerStatus}` : null,
    typeof providerCode === 'string' && providerCode ? `Code: ${providerCode}` : null,
    typeof providerMessage === 'string' && providerMessage ? providerMessage : null,
  ].filter(Boolean).join(' · ');
  return diagnostic ? `${error.message} (${diagnostic})` : error.message;
}

async function processAutoGeneration(input: { workspaceId: string; userId: string; provider: 'wordpress' | 'webflow'; siteId: string; jobId: string; language?: string }) {
  try {
    await repo.updateSiteStatus(input.workspaceId, input.siteId, 'generating');
    await repo.updateJob(input.siteId, input.jobId, { status: 'planning' });
    const plan = await generateWebsitePlan({ workspaceId: input.workspaceId, userId: input.userId, prompt: DEFAULT_WEBSITE_PROMPT, provider: input.provider, ...(input.language ? { language: input.language } : {}) });
    await repo.updateJob(input.siteId, input.jobId, { status: 'preview', plan, preview: { provider: input.provider, automatic: true, pages: plan.pages.map((page) => ({ title: page.title, slug: page.slug, seoTitle: page.seoTitle, seoDescription: page.seoDescription })) } });
    await publishWebsiteJob(input.workspaceId, input.siteId, input.jobId);
    await repo.updateSiteStatus(input.workspaceId, input.siteId, 'published');
    await onboardingRepo.markPlatformConnected(input.workspaceId, input.provider);
  } catch (error) {
    await repo.updateSiteStatus(input.workspaceId, input.siteId, 'error').catch(() => undefined);
    const message = generationErrorMessage(error);
    await repo.updateJob(input.siteId, input.jobId, { status: 'failed', errorCode: error instanceof AppError ? error.code : 'WEBSITE_AUTO_GENERATION_FAILED', errorMessage: message }).catch(() => undefined);
    await onboardingRepo.archivePlatformByIntegration(input.workspaceId, input.provider, message).catch(() => undefined);
  }
}

export async function startAutomaticWebsiteGeneration(input: { workspaceId: string; userId: string; provider: 'wordpress' | 'webflow'; language?: string }) {
  try {
    const site = await getOrCreateProviderSite(input.workspaceId, input.provider);
    if (!site) throw new AppError(500, 'WEBSITE_SITE_CREATE_FAILED', 'The connected provider site could not be registered');
    const active = await repo.findActiveJob(site.id);
    if (active) return { site, job: active, reused: true };
    const job = await repo.createJob({ siteId: site.id, prompt: DEFAULT_WEBSITE_PROMPT, createdBy: input.userId });
    if (!job) throw new AppError(500, 'WEBSITE_GENERATION_JOB_CREATE_FAILED', 'The automatic website generation job could not be created');
    void processAutoGeneration({ ...input, siteId: site.id, jobId: job.id });
    return { site, job, reused: false };
  } catch (error) {
    const message = generationErrorMessage(error);
    await onboardingRepo.archivePlatformByIntegration(input.workspaceId, input.provider, message).catch(() => undefined);
    throw error;
  }
}
