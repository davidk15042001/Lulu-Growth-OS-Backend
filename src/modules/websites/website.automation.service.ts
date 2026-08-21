import { AppError } from '../../utils/app-error.js';
import { firstWebflowSiteWithCollection, firstWordpressSite } from './website.provider.service.js';
import * as repo from './website.repo.js';
import { generateWebsitePlan } from './website.generation.service.js';
import { publishWebsiteJob } from './website.publish.service.js';
import * as onboardingRepo from '../onboarding/onboarding.repo.js';

const WEBSITE_GENERATION_TIMEOUT_MINUTES = 10;

export const DEFAULT_WEBSITE_PROMPT = `Create an exceptional, premium, production-ready website that feels like a top-tier digital agency delivered it. The result must be visually compelling, strategically complete, highly detailed and conversion-focused—not a basic blog, a generic template or a short information page. Use the verified Lulu workspace data, active or draft offerings, uploaded business context and completed initial AI analysis as the only source of truth for factual claims. Adapt the design, language, hierarchy and functionality to the customer's real industry, audience, positioning, geography, offers and business goals.

Design a complete information architecture with up to 8 high-value pages, using the page budget intelligently. The set should normally cover: a cinematic homepage; a detailed solutions, services or capabilities page; one or more offer/detail pages when verified offerings exist; an audience, industry or use-case page when supported; an outcomes, process or how-it-works page; an about, trust or company page; a resources, FAQ or insights page when useful; and a contact, consultation or inquiry page. Do not create irrelevant pages just to reach a quota. If there are more important functions than pages, group them into clearly labeled sections, feature grids, comparison blocks, process steps, FAQs and conversion modules on the most relevant pages so the complete product or service story is covered.

The homepage must feel epic and complete: create a strong hero with a specific value proposition and primary CTA, a supporting proof or trust area only when verified, an overview of the most important capabilities, detailed benefit cards, audience or use-case pathways, a process or experience section, a differentiated positioning section, a relevant FAQ, and a final high-intent CTA. Every other page must have a clear H1, a persuasive introduction, multiple substantive sections, scannable cards or lists, relevant supporting detail, internal links to the next step and a specific CTA. Explain important functions in detail: what they do, who they help, how they work, what outcome they support, what the customer can expect and what action to take next. Do not merely list feature names.

Create a deliberate premium visual system in the HTML: strong hierarchy, generous whitespace, editorial rhythm, clear section boundaries, responsive semantic sections, polished feature cards, CTA panels, process steps, FAQ details and accessible links. Use semantic HTML such as main, section, header, nav, article, h1-h3, p, ul/ol, a and details/summary. Include tasteful inline presentation attributes only when provider-safe; never depend on JavaScript, external CSS, unavailable fonts or assets. Provide rich image and graphic briefs in the assets array with a defined subject, composition, mood, color direction and intended section. Make the design feel distinctive to the business rather than repeating a blue generic template.

Match functionality to the verified business model. For B2B businesses, include discovery, qualification, solution comparison and inquiry flows. For service businesses, include trust, offer clarity, consultation or booking intent and qualification questions. For product or commerce businesses, include catalog discovery, use cases, specifications and purchase-intent actions without inventing checkout, pricing, stock or availability. For software or platform businesses, explain the workflow, key capabilities, integrations only when verified, roles, outcomes and onboarding path. For local businesses, include service areas and visit/contact actions only when verified. Every important customer-facing function must be represented somewhere in the page architecture or in a clearly labeled section.

Use only verified facts. Never invent names, products, services, prices, locations, contacts, certifications, awards, statistics, testimonials, customers, integrations, guarantees or legal claims. Never copy example companies or reference-site facts. If information is missing, write useful neutral benefit-oriented copy without claiming unsupported facts, and omit contact details rather than inserting placeholders. Never publish or generate phrases such as “Hello World”, “under construction”, “website is being built”, “no verified information”, “no detailed content”, “example.com”, “123 Example Street”, “hi@example.com”, fake phone numbers or visible TODO text. Do not tell visitors that information is missing; turn verified context into confident, truthful positioning and omit unsupported specifics. Do not claim the website is connected, published, approved, certified or live.

Every page needs a unique SEO title, meta description, useful lowercase slug, clear purpose and factual content. Include SEO, GEO and AEO foundations where supported without keyword stuffing. Return complete publishable semantic HTML, not Markdown, notes, outlines, instructions, short disclaimers or construction notices. Keep the homepage approximately 1200–1800 words when the verified context supports it and other pages approximately 700–1200 words; when facts are sparse, keep the page shorter but still substantial, structured and useful. The final result must look and read like a complete premium website with detailed functions, not a placeholder.`;

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
    if (shouldDisconnectProvider(error)) await disconnectWebsiteProvider(input.workspaceId, input.provider);
  }
}

export async function startAutomaticWebsiteGeneration(input: { workspaceId: string; userId: string; provider: 'wordpress' | 'webflow'; siteId?: string; language?: string }) {
  try {
    const site = await getOrCreateProviderSite(input.workspaceId, input.provider, input.siteId);
    if (!site) throw new AppError(500, 'WEBSITE_SITE_CREATE_FAILED', 'The connected provider site could not be registered');
    await repo.expireStaleActiveJobs(site.id, WEBSITE_GENERATION_TIMEOUT_MINUTES);
    const active = await repo.findActiveJob(site.id);
    if (active) return { site, job: active, reused: true };
    const job = await repo.createJob({ siteId: site.id, prompt: DEFAULT_WEBSITE_PROMPT, createdBy: input.userId });
    if (!job) throw new AppError(500, 'WEBSITE_GENERATION_JOB_CREATE_FAILED', 'The automatic website generation job could not be created');
    void processAutoGeneration({ ...input, siteId: site.id, jobId: job.id });
    return { site, job, reused: false };
  } catch (error) {
    if (shouldDisconnectProvider(error)) await resetWebsiteProviderState(input.workspaceId, input.provider);
    throw error;
  }
}

export async function getActiveWebsiteGenerationJob(input: { workspaceId: string; siteId: string }) {
  const site = await repo.getSite(input.workspaceId, input.siteId);
  if (!site) throw new AppError(404, 'WEBSITE_SITE_NOT_FOUND', 'The selected website could not be found');
  await repo.expireStaleActiveJobs(site.id, WEBSITE_GENERATION_TIMEOUT_MINUTES);
  return repo.findActiveJob(site.id);
}
