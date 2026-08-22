import { AppError } from '../../utils/app-error.js';
import { firstWebflowSiteWithCollection, firstWordpressSite } from './website.provider.service.js';
import { logger } from '../../config/logger.js';
import * as repo from './website.repo.js';
import { generateWebsitePlan } from './website.generation.service.js';
import { publishWebsiteJob } from './website.publish.service.js';
import * as onboardingRepo from '../onboarding/onboarding.repo.js';
import type { WebsiteGenerationWorkItem } from './website.types.js';

export const DEFAULT_WEBSITE_PROMPT = `Create a premium, production-ready and conversion-focused website from verified Lulu workspace data. Adapt the structure, language, visual direction and calls to action to the customer's real business, audience, offers and goals. Build three to six high-value pages rather than a generic template. Use complete semantic HTML, useful SEO metadata, clear internal navigation and provider-safe presentation. Represent the most important customer journey and business functions with substantive sections, cards, process steps, FAQs and calls to action where relevant. Never invent names, prices, locations, contacts, certifications, statistics, testimonials, customers, integrations or legal claims. Omit unsupported specifics and never publish placeholders, construction notices, fake contact details or example-company content.`;

export async function resetWebsiteProviderState(workspaceId: string, provider: 'wordpress' | 'webflow') {
  await repo.deleteSitesByProvider(workspaceId, provider).catch(() => undefined);
  await onboardingRepo.removePlatformByIntegration(workspaceId, provider).catch(() => undefined);
}

export async function disconnectWebsiteProvider(workspaceId: string, provider: 'wordpress' | 'webflow') {
  await onboardingRepo.removePlatformByIntegration(workspaceId, provider).catch(() => undefined);
}

async function getOrCreateProviderSite(workspaceId: string, provider: 'wordpress' | 'webflow', selectedSiteId?: string) {
  if (selectedSiteId) {
    const selected = await repo.getSite(workspaceId, selectedSiteId);
    if (!selected || selected.provider !== provider) throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'The selected website could not be found for this provider');
    return selected;
  }
  const localSites = await repo.listSites(workspaceId);
  const localSite = localSites.find((site) => site.provider === provider && site.externalSiteId && site.status !== 'error');
  if (localSite) return localSite;
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

function shouldDisconnectProvider(error: unknown) {
  if (!(error instanceof AppError)) return false;
  if (['WEBSITE_PROVIDER_NOT_CONNECTED', 'WEBSITE_PROVIDER_TOKEN_INVALID', 'WEBSITE_PROVIDER_WRITE_SCOPE_MISSING'].includes(error.code)) return true;
  if (error.code !== 'WEBSITE_PROVIDER_REQUEST_FAILED' || !error.details || typeof error.details !== 'object') return false;
  const status = (error.details as Record<string, unknown>).providerHttpStatus;
  return status === 401 || status === 403;
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

export async function processWebsiteGenerationWorkItem(input: WebsiteGenerationWorkItem, workerId: string) {
  let heartbeatRunning = false;
  const heartbeat = async () => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    try { await repo.heartbeatJob(input.siteId, input.id, workerId); } finally { heartbeatRunning = false; }
  };
  const heartbeatTimer = setInterval(() => void heartbeat(), 15_000);
  heartbeatTimer.unref();
  try {
    if (!input.createdBy) throw new AppError(409, 'WEBSITE_GENERATION_USER_MISSING', 'The user who started this website generation no longer exists');
    await repo.updateSiteStatus(input.workspaceId, input.siteId, 'generating');
    await repo.updateJob(input.siteId, input.id, { status: 'planning' });
    const plan = await generateWebsitePlan({
      workspaceId: input.workspaceId,
      userId: input.createdBy,
      prompt: input.prompt,
      provider: input.provider,
      existingPlan: input.plan,
      ...(input.requestedLanguage ? { language: input.requestedLanguage } : {}),
      onProgress: async (progress) => {
        await repo.updateJob(input.siteId, input.id, {
          status: 'planning',
          plan: progress.plan,
          preview: {
            provider: input.provider,
            automatic: input.autoPublish,
            progress: {
              phase: 'generating_pages',
              completedPages: progress.completedPages,
              totalPages: progress.totalPages,
              currentPageTitle: progress.currentPageTitle,
            },
          },
        });
      },
    });
    await repo.updateJob(input.siteId, input.id, {
      status: 'preview',
      plan,
      preview: {
        provider: input.provider,
        automatic: input.autoPublish,
        progress: { phase: input.autoPublish ? 'publishing' : 'preview_ready', completedPages: plan.pages.length, totalPages: plan.pages.length, currentPageTitle: null },
        pages: plan.pages.map((page) => ({ title: page.title, slug: page.slug, seoTitle: page.seoTitle, seoDescription: page.seoDescription })),
      },
    });
    if (input.autoPublish) {
      await publishWebsiteJob(input.workspaceId, input.siteId, input.id);
      if (input.provider === 'wordpress' || input.provider === 'webflow') await onboardingRepo.markPlatformConnected(input.workspaceId, input.provider);
    } else {
      await repo.updateSiteStatus(input.workspaceId, input.siteId, 'preview');
    }
  } catch (error) {
    const errorDetails = error instanceof AppError && error.details && typeof error.details === 'object'
      ? error.details as Record<string, unknown>
      : undefined;
    logger.error({ jobId: input.id, siteId: input.siteId, provider: input.provider, error: error instanceof Error ? { name: error.name, message: error.message, details: errorDetails } : String(error) }, 'Website generation job failed');
    await repo.updateSiteStatus(input.workspaceId, input.siteId, 'error').catch(() => undefined);
    const message = generationErrorMessage(error);
    await repo.updateJob(input.siteId, input.id, { status: 'failed', errorCode: error instanceof AppError ? error.code : 'WEBSITE_AUTO_GENERATION_FAILED', errorMessage: message, ...(errorDetails ? { providerResult: errorDetails } : {}) }).catch(() => undefined);
    if (shouldDisconnectProvider(error) && (input.provider === 'wordpress' || input.provider === 'webflow')) await disconnectWebsiteProvider(input.workspaceId, input.provider);
  } finally {
    clearInterval(heartbeatTimer);
    await repo.releaseJob(input.siteId, input.id, workerId).catch(() => undefined);
  }
}

export async function startAutomaticWebsiteGeneration(input: { workspaceId: string; userId: string; provider: 'wordpress' | 'webflow'; siteId?: string; language?: string }) {
  try {
    const site = await getOrCreateProviderSite(input.workspaceId, input.provider, input.siteId);
    if (!site) throw new AppError(500, 'WEBSITE_SITE_CREATE_FAILED', 'The connected provider site could not be registered');
    const active = await repo.findActiveJob(site.id);
    if (active) return { site, job: active, reused: true };
    const created = await repo.createJob({
      siteId: site.id,
      prompt: DEFAULT_WEBSITE_PROMPT,
      createdBy: input.userId,
      autoPublish: true,
      ...(input.language ? { requestedLanguage: input.language } : {}),
    });
    if (!created.job) throw new AppError(500, 'WEBSITE_GENERATION_JOB_CREATE_FAILED', 'The automatic website generation job could not be created');
    return { site, job: created.job, reused: !created.created };
  } catch (error) {
    if (shouldDisconnectProvider(error)) await resetWebsiteProviderState(input.workspaceId, input.provider);
    throw error;
  }
}

export async function getActiveWebsiteGenerationJob(input: { workspaceId: string; siteId: string }) {
  const site = await repo.getSite(input.workspaceId, input.siteId);
  if (!site) throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'The selected website could not be found');
  return repo.findActiveJob(site.id);
}
