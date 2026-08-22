import { env } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../config/logger.js';
import * as agentRepo from '../agents/agent.repo.js';
import { getOpenAIResponsesClient } from '../ai/openai.service.js';
import { listOfferings, listPlatforms } from '../onboarding/onboarding.repo.js';
import { findWorkspaceForUser } from '../workspaces/workspace.repo.js';

export type GeneratedPage = {
  title: string;
  slug: string;
  purpose: string;
  sections: string[];
  content: string;
  seoTitle: string;
  seoDescription: string;
};

export type WebsitePlan = {
  siteTitle: string;
  brandVoice: string;
  primaryLanguage: string;
  pages: GeneratedPage[];
  globalSeo: { title: string; description: string; keywords: string[] };
  assets: { brief: string; altText: string }[];
};

export type WebsiteGenerationProgress = {
  plan: WebsitePlan;
  completedPages: number;
  totalPages: number;
  currentPageTitle: string | null;
};

type WebsiteContext = {
  workspace: {
    companyName: string;
    industry: string | null;
    companySize: string | null;
    countryRegion: string | null;
    businessDescription: string | null;
    valueProposition: string | null;
    targetMarket: string | null;
    shortBrandDescription: string | null;
    positioningTags: string[];
  };
  offerings: Array<{
    name: string;
    type: string;
    category: string | null;
    description: string | null;
    targetCustomer: string | null;
    valueProposition: string | null;
    status: string;
  }>;
  connectedPlatforms: Array<{ name: string; category: string; status: string }>;
  initialAnalysis: unknown;
};

const forbiddenContent = /hello world|under construction|website is being built|no verified information|example\.com|123 example street|hi@example\.com|\(123\) 456-7890|\bTODO\b/i;

function configuredModel() {
  if (env.AI_PROVIDER === 'alibaba') return env.DASHSCOPE_MODEL;
  if (env.AI_PROVIDER === 'deepseek') return env.DEEPSEEK_MODEL;
  if (env.AI_PROVIDER === 'groq') return env.GROQ_MODEL;
  return env.OPENAI_MODEL;
}

function extractResponseText(response: unknown): string {
  if (!response || typeof response !== 'object') return '';
  const value = response as Record<string, unknown>;
  if (typeof value.output_text === 'string' && value.output_text.trim()) return value.output_text.trim();
  const choices = Array.isArray(value.choices) ? value.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    const message = (choice as Record<string, unknown>).message;
    if (!message || typeof message !== 'object') continue;
    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string' && content.trim()) return content.trim();
  }
  const output = Array.isArray(value.output) ? value.output : [];
  const texts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const itemValue = item as Record<string, unknown>;
    if (typeof itemValue.text === 'string') texts.push(itemValue.text);
    const content = Array.isArray(itemValue.content) ? itemValue.content : [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const partValue = part as Record<string, unknown>;
      if (typeof partValue.text === 'string') texts.push(partValue.text);
      if (partValue.text && typeof partValue.text === 'object' && typeof (partValue.text as Record<string, unknown>).value === 'string') texts.push((partValue.text as Record<string, unknown>).value as string);
    }
  }
  return texts.join('\n').trim();
}

function jsonCandidates(text: string) {
  const normalized = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const withoutFences = normalized.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const candidates = [withoutFences];
  const firstBrace = withoutFences.indexOf('{');
  const lastBrace = withoutFences.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(withoutFences.slice(firstBrace, lastBrace + 1));
  return candidates;
}

function parseJsonObject(text: string, code: string, message: string): Record<string, unknown> {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next normalized candidate.
    }
  }
  throw new AppError(502, code, message);
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && (/timed?\s*out|timeout/i.test(error.message) || ['AbortError', 'TimeoutError', 'APIConnectionTimeoutError'].includes(error.name));
}

function errorStatus(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const status = (error as Record<string, unknown>).status;
  return typeof status === 'number' ? status : null;
}

async function createJsonCompletion(input: { label: string; system: string; user: string; maxTokens: number }) {
  const client = getOpenAIResponsesClient();
  const tokenLimit = env.AI_PROVIDER === 'openai'
    ? { max_completion_tokens: input.maxTokens }
    : { max_tokens: input.maxTokens };
  const request = {
    model: configuredModel(),
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ],
    response_format: { type: 'json_object' },
    ...(env.AI_PROVIDER === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
    temperature: 0.2,
    ...tokenLimit,
  };

  for (let attempt = 0; attempt <= env.AI_MAX_RETRIES; attempt += 1) {
    try {
      logger.info({ label: input.label, provider: env.AI_PROVIDER, model: request.model, maxTokens: input.maxTokens, attempt: attempt + 1 }, 'Website AI request started');
      const response = await client.createChat(request, { timeout: env.AI_REQUEST_TIMEOUT_MS, maxRetries: 0 });
      const text = extractResponseText(response);
      logger.info({ label: input.label, responseChars: text.length, attempt: attempt + 1 }, 'Website AI response received');
      if (!text) throw new AppError(502, 'WEBSITE_AI_EMPTY_RESPONSE', `${input.label} returned an empty AI response`);
      return text;
    } catch (error) {
      const status = errorStatus(error);
      const retriable = isTimeoutError(error) || status === 408 || status === 409 || status === 429 || (status !== null && status >= 500);
      if (retriable && attempt < env.AI_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
        continue;
      }
      if (error instanceof AppError) throw error;
      if (isTimeoutError(error)) throw new AppError(504, 'WEBSITE_AI_TIMEOUT', `${input.label} exceeded the AI time limit`);
      if (status === 429) throw new AppError(429, 'WEBSITE_AI_RATE_LIMITED', `${input.label} was rate limited by the AI provider`);
      throw new AppError(502, 'WEBSITE_AI_REQUEST_FAILED', `${input.label} failed at the AI provider`, { providerStatus: status, providerMessage: error instanceof Error ? error.message : String(error) });
    }
  }
  throw new AppError(502, 'WEBSITE_AI_REQUEST_FAILED', `${input.label} failed at the AI provider`);
}

function compactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  if (depth >= 4) return Array.isArray(value) ? `[${value.length} items]` : '[nested data]';
  if (Array.isArray(value)) return value.slice(0, 15).map((item) => compactValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 35).map(([key, item]) => [key, compactValue(item, depth + 1)]));
  }
  return String(value);
}

function slugify(value: string, fallback: string) {
  const slug = value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return slug || fallback;
}

function stringValue(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function stringArray(value: unknown, fallback: string[] = []) {
  return Array.isArray(value) ? value.map((item) => stringValue(item)).filter(Boolean).slice(0, 12) : fallback;
}

function architectureFrom(value: Record<string, unknown>, requestedLanguage: string): WebsitePlan {
  const rawPages = Array.isArray(value.pages) ? value.pages.slice(0, 6) : [];
  if (!rawPages.length) throw new AppError(502, 'WEBSITE_ARCHITECTURE_INVALID', 'The AI response did not contain a usable website architecture');
  const usedSlugs = new Set<string>();
  const pages = rawPages.map((rawPage, index) => {
    const page = rawPage && typeof rawPage === 'object' ? rawPage as Record<string, unknown> : {};
    const title = stringValue(page.title, index === 0 ? 'Home' : `Page ${index + 1}`);
    let slug = slugify(stringValue(page.slug, title), index === 0 ? 'home' : `page-${index + 1}`);
    if (usedSlugs.has(slug)) slug = `${slug}-${index + 1}`;
    usedSlugs.add(slug);
    return {
      title,
      slug,
      purpose: stringValue(page.purpose, `Explain ${title} and guide visitors to the next relevant action.`),
      sections: stringArray(page.sections, ['Introduction', 'Key benefits', 'How it works', 'Next step']),
      content: stringValue(page.content),
      seoTitle: stringValue(page.seoTitle, title).slice(0, 70),
      seoDescription: stringValue(page.seoDescription, `Learn more about ${title}.`).slice(0, 170),
    };
  });
  const rawSeo = value.globalSeo && typeof value.globalSeo === 'object' ? value.globalSeo as Record<string, unknown> : {};
  const assets = Array.isArray(value.assets) ? value.assets.slice(0, 12).map((rawAsset) => {
    const asset = rawAsset && typeof rawAsset === 'object' ? rawAsset as Record<string, unknown> : {};
    return { brief: stringValue(asset.brief), altText: stringValue(asset.altText) };
  }).filter((asset) => asset.brief && asset.altText) : [];
  return {
    siteTitle: stringValue(value.siteTitle, pages[0]!.title),
    brandVoice: stringValue(value.brandVoice, 'Clear, confident and helpful'),
    primaryLanguage: stringValue(value.primaryLanguage, requestedLanguage),
    pages,
    globalSeo: {
      title: stringValue(rawSeo.title, stringValue(value.siteTitle, pages[0]!.title)).slice(0, 70),
      description: stringValue(rawSeo.description, pages[0]!.seoDescription).slice(0, 170),
      keywords: stringArray(rawSeo.keywords).slice(0, 20),
    },
    assets,
  };
}

function pageHasPublishableContent(page: GeneratedPage, index: number) {
  const content = String(page.content ?? '').trim();
  const minimumLength = index === 0 ? 1_200 : 650;
  return content.length >= minimumLength && /<(main|section|article|header)\b/i.test(content) && /<h1\b/i.test(content) && !forbiddenContent.test(content);
}

export function isCompleteWebsitePlan(value: unknown): value is WebsitePlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as WebsitePlan;
  return typeof plan.siteTitle === 'string' && Array.isArray(plan.pages) && plan.pages.length > 0 && plan.pages.every(pageHasPublishableContent);
}

async function loadWebsiteContext(workspaceId: string, userId: string): Promise<WebsiteContext> {
  const workspace = await findWorkspaceForUser(workspaceId, userId);
  if (!workspace) throw new AppError(404, 'WEBSITE_WORKSPACE_NOT_FOUND', 'The workspace context was not found');
  const [offerings, platforms, initialAnalysis] = await Promise.all([
    listOfferings(workspaceId),
    listPlatforms(workspaceId),
    agentRepo.getLatestCompletedInitialAnalysis(workspaceId),
  ]);
  return {
    workspace: {
      companyName: workspace.companyName,
      industry: workspace.industry,
      companySize: workspace.companySize,
      countryRegion: workspace.countryRegion,
      businessDescription: workspace.businessDescription,
      valueProposition: workspace.valueProposition,
      targetMarket: workspace.targetMarket,
      shortBrandDescription: workspace.shortBrandDescription,
      positioningTags: workspace.positioningTags ?? [],
    },
    offerings: offerings
      .filter((offering) => offering.status === 'active' || offering.status === 'draft')
      .slice(0, 30)
      .map((offering) => ({
        name: offering.name,
        type: offering.offeringType,
        category: offering.category,
        description: offering.description,
        targetCustomer: offering.targetCustomer,
        valueProposition: offering.valueProposition,
        status: offering.status,
      })),
    connectedPlatforms: platforms
      .filter((platform) => platform.connectionStatus === 'connected' || platform.connectionStatus === 'active')
      .slice(0, 30)
      .map((platform) => ({ name: platform.name, category: platform.category, status: platform.connectionStatus })),
    initialAnalysis: compactValue(initialAnalysis?.result ?? null),
  };
}

async function generateArchitecture(input: { provider: string; language: string; prompt: string; context: WebsiteContext }) {
  const response = await createJsonCompletion({
    label: 'Website architecture generation',
    maxTokens: 1_600,
    system: [
      'You are Lulu Website Architect.',
      'Design a factual, conversion-focused website architecture from verified business context.',
      'Return only one JSON object. Never write page HTML in this step.',
      'Create between 3 and 6 useful pages. Do not invent facts, contacts, prices, customers, testimonials, statistics or certifications.',
      'Required JSON: {siteTitle,brandVoice,primaryLanguage,pages:[{title,slug,purpose,sections,seoTitle,seoDescription}],globalSeo:{title,description,keywords},assets:[{brief,altText}]}.',
    ].join(' '),
    user: [
      `Provider: ${input.provider}`,
      `Language: ${input.language}`,
      `Website brief: ${input.prompt}`,
      'Verified context:',
      JSON.stringify(input.context),
    ].join('\n\n'),
  });
  return architectureFrom(parseJsonObject(response, 'WEBSITE_ARCHITECTURE_INVALID', 'The AI response did not contain a valid website architecture'), input.language);
}

async function generatePageContent(input: { plan: WebsitePlan; page: GeneratedPage; pageIndex: number; context: WebsiteContext; provider: string; language: string; qualityRetry: boolean }) {
  const homepage = input.pageIndex === 0;
  const response = await createJsonCompletion({
    label: `Website page generation: ${input.page.title}`,
    maxTokens: homepage ? 2_200 : 1_700,
    system: [
      'You are Lulu Website Copywriter and HTML Designer.',
      'Return only a JSON object with one key named content.',
      'The content value must be complete, responsive, semantic, provider-safe HTML for exactly one page.',
      `Write in ${input.language}.`,
      homepage ? 'Target roughly 800 to 1200 words with a strong hero, benefits, process, useful detail, FAQ when relevant and a final CTA.' : 'Target roughly 450 to 750 words with a clear H1, multiple substantive sections, useful detail, internal next steps and a specific CTA.',
      'Use main, section, header, article, h1-h3, p, ul or ol, a and details or summary where appropriate.',
      'Do not use JavaScript, external CSS, fake contact details, unsupported claims, placeholders, construction notices or Markdown.',
      'Only use facts present in the verified context. When facts are missing, use neutral benefit-oriented language and omit unsupported specifics.',
      input.qualityRetry ? 'The previous draft failed quality validation. Make this version more substantial and ensure it contains semantic HTML, one H1 and no placeholders.' : '',
    ].filter(Boolean).join(' '),
    user: [
      `Provider: ${input.provider}`,
      `Website title: ${input.plan.siteTitle}`,
      `Brand voice: ${input.plan.brandVoice}`,
      `Page specification: ${JSON.stringify({ title: input.page.title, slug: input.page.slug, purpose: input.page.purpose, sections: input.page.sections, seoTitle: input.page.seoTitle, seoDescription: input.page.seoDescription })}`,
      `Other pages for internal linking: ${JSON.stringify(input.plan.pages.map((page) => ({ title: page.title, slug: page.slug })))}`,
      `Verified context: ${JSON.stringify(input.context)}`,
    ].join('\n\n'),
  });
  try {
    const content = stringValue(parseJsonObject(response, 'WEBSITE_PAGE_INVALID', `The AI response for ${input.page.title} was not valid JSON`).content);
    return { ...input.page, content };
  } catch (error) {
    if (input.qualityRetry) throw error;
    logger.warn({ pageTitle: input.page.title }, 'Website page JSON invalid; requesting a clean JSON retry');
    return generatePageContent({ ...input, qualityRetry: true });
  }
}

export async function generateWebsitePlan(input: {
  workspaceId: string;
  userId: string;
  prompt: string;
  language?: string;
  provider: string;
  existingPlan?: Record<string, unknown>;
  onProgress?: (progress: WebsiteGenerationProgress) => Promise<void>;
}) {
  const context = await loadWebsiteContext(input.workspaceId, input.userId);
  const language = input.language?.trim() || 'en';
  let plan: WebsitePlan;
  try {
    plan = architectureFrom(input.existingPlan ?? {}, language);
  } catch {
    plan = await generateArchitecture({ provider: input.provider, language, prompt: input.prompt, context });
  }

  let completedPages = plan.pages.filter((page, index) => pageHasPublishableContent(page, index)).length;
  const firstIncompletePage = plan.pages.findIndex((page, index) => !pageHasPublishableContent(page, index));
  await input.onProgress?.({ plan, completedPages, totalPages: plan.pages.length, currentPageTitle: firstIncompletePage >= 0 ? plan.pages[firstIncompletePage]?.title ?? null : null });

  for (let index = 0; index < plan.pages.length; index += 1) {
    if (pageHasPublishableContent(plan.pages[index]!, index)) continue;
    await input.onProgress?.({ plan, completedPages, totalPages: plan.pages.length, currentPageTitle: plan.pages[index]?.title ?? null });
    logger.info({ pageIndex: index, pageTitle: plan.pages[index]?.title ?? null, completedPages, totalPages: plan.pages.length }, 'Website page generation started');
    let generated = await generatePageContent({ plan, page: plan.pages[index]!, pageIndex: index, context, provider: input.provider, language, qualityRetry: false });
    if (!pageHasPublishableContent(generated, index)) {
      generated = await generatePageContent({ plan, page: generated, pageIndex: index, context, provider: input.provider, language, qualityRetry: true });
    }
    if (!pageHasPublishableContent(generated, index)) {
      throw new AppError(502, 'WEBSITE_GENERATION_QUALITY_FAILED', `The generated page ${generated.title} did not meet the website quality requirements`);
    }
    plan = { ...plan, pages: plan.pages.map((page, pageIndex) => pageIndex === index ? generated : page) };
    logger.info({ pageIndex: index, pageTitle: generated.title, completedPages: completedPages + 1, totalPages: plan.pages.length }, 'Website page generation completed');
    completedPages += 1;
    const nextIncompletePage = plan.pages.findIndex((page, pageIndex) => !pageHasPublishableContent(page, pageIndex));
    await input.onProgress?.({ plan, completedPages, totalPages: plan.pages.length, currentPageTitle: nextIncompletePage >= 0 ? plan.pages[nextIncompletePage]?.title ?? null : null });
  }

  if (!isCompleteWebsitePlan(plan)) throw new AppError(502, 'WEBSITE_GENERATION_QUALITY_FAILED', 'The generated website did not meet the website quality requirements');
  return plan;
}

export { loadWebsiteContext };
export type { WebsiteContext };
