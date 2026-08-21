import { AppError } from '../../utils/app-error.js';
import { firstWebflowSiteWithCollection, firstWordpressSite } from './website.provider.service.js';
import * as repo from './website.repo.js';
import { generateWebsitePlan } from './website.generation.service.js';
import { publishWebsiteJob } from './website.publish.service.js';
import * as onboardingRepo from '../onboarding/onboarding.repo.js';

export const DEFAULT_WEBSITE_PROMPT = `Create a premium, production-ready, responsive website for the connected customer business. Use the verified Lulu workspace data, the customer's active or draft offerings, uploaded business context and the completed initial AI analysis as the only source of truth for factual content. The reference brief defines the quality bar and the information architecture, but it is not a source of customer facts: adapt every section to the actual customer's industry, audience, products or services, positioning, geography, language and business goals.

Build a clear, conversion-focused information architecture with a substantial homepage, the most relevant product or service overview and detail pages, industry or use-case pages when supported by the customer data, an about or credibility page, a contact or inquiry page, and legal or policy pages only when required and clearly marked for customer confirmation. Do not create irrelevant routes merely to fill a quota. Use the analyzed positioning, target audiences, differentiators, recommended content themes, SEO/GEO/AEO findings and customer journey to decide the page order, calls to action and content hierarchy. The homepage must contain a complete semantic HTML layout with a hero section, value proposition, relevant offerings or capabilities, audience/use-case section, proof or process section when supported, and a strong contact or inquiry CTA. Each non-homepage page must contain a clear H1, useful introduction, at least two substantive sections, scannable lists or cards where appropriate, and a relevant CTA. Return publishable HTML content, not notes, outlines, instructions, empty sections or a short paragraph.

Use a professional visual system appropriate to the customer's business rather than a fixed template. Select an evidence-based color direction, typography, spacing, components, imagery briefs and tone that fit the verified brand description and industry. Use accessible responsive layouts for mobile, tablet and desktop; strong headings; scannable sections; meaningful calls to action; comparison or specification tables only when supported by real data; and forms that request only information relevant to the business. For B2B businesses, support product discovery, qualification and quote or inquiry flows. For service businesses, support trust, offer clarity, lead capture and booking or consultation flows. For commerce or product businesses, support catalog discovery and purchase-intent actions without inventing checkout, prices or availability.

Every page must have a unique SEO title, meta description, useful slug, clear purpose and factual content. Include global SEO, GEO and AEO foundations when supported by the analysis, but never keyword-stuff. Use only verified company names, brands, products, services, locations, contacts, markets, certifications, standards, prices, metrics, testimonials and legal claims. Never copy example companies, contacts, addresses, product catalogs, color palettes or claims from a reference brief into another customer's website. If information is missing, omit that fact and write useful neutral service copy without presenting assumptions as facts. Never show phrases such as “Hello World”, “under construction”, “website is being built”, “no verified information”, “example.com”, “123 Example Street” or fake contact details to visitors. Do not use visible placeholders in published page content. Do not claim that the website is connected, published, approved, certified or live. Return a practical provider-compatible plan with up to 8 of the most valuable pages and concise asset briefs for imagery or graphics. Page content must be complete publishable HTML using semantic headings, paragraphs, lists, cards and links; never return markdown-only notes or an outline. Keep the homepage around 700–1400 words and each other page around 400–1000 words when the verified context supports it; when facts are sparse, use a shorter but still structured page with neutral, non-factual value language.`;

export async function resetWebsiteProviderState(workspaceId: string, provider: 'wordpress' | 'webflow') {
  await repo.deleteSitesByProvider(workspaceId, provider).catch(() => undefined);
  await onboardingRepo.removePlatformByIntegration(workspaceId, provider).catch(() => undefined);
}

export async function disconnectWebsiteProvider(workspaceId: string, provider: 'wordpress' | 'webflow') {
  await onboardingRepo.removePlatformByIntegration(workspaceId, provider).catch(() => undefined);
}

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
    await disconnectWebsiteProvider(input.workspaceId, input.provider);
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
    await resetWebsiteProviderState(input.workspaceId, input.provider);
    throw error;
  }
}
