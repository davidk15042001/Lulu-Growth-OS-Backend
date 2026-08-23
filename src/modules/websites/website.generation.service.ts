import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../utils/app-error.js';
import * as agentRepo from '../agents/agent.repo.js';
import { getOpenAIResponsesClient } from '../ai/openai.service.js';
import { listOfferings, listPlatforms } from '../onboarding/onboarding.repo.js';
import { findWorkspaceForUser } from '../workspaces/workspace.repo.js';

export type GeneratedSection = {
  key: string;
  title: string;
  html: string;
};

export type GeneratedPage = {
  title: string;
  slug: string;
  purpose: string;
  sections: string[];
  generatedSections: GeneratedSection[];
  content: string;
  seoTitle: string;
  seoDescription: string;
};

export type WebsiteImageAsset = { url: string; altText: string };

type ThemePalette = {
  primary: string;
  secondary: string;
  accent: string;
  ink: string;
  muted: string;
  surface: string;
  background: string;
};

type ContentCard = { title: string; description: string; cta: string };
type ContentSection = { heading: string; body: string };
type ProcessStep = { title: string; description: string };
type FaqItem = { question: string; answer: string };

type WebsiteContentProfile = {
  siteTitle: string;
  tagline: string;
  brandVoice: string;
  primaryLanguage: string;
  globalSeo: { title: string; description: string; keywords: string[] };
  home: {
    eyebrow: string;
    headline: string;
    introduction: string;
    primaryCta: string;
    secondaryCta: string;
    trustItems: string[];
    audienceHeading: string;
    audienceIntroduction: string;
    audienceCards: ContentCard[];
    servicesHeading: string;
    servicesIntroduction: string;
    highlightEyebrow: string;
    highlightTitle: string;
    highlightText: string;
    processHeading: string;
    processIntroduction: string;
    processSteps: ProcessStep[];
    faqHeading: string;
    faqs: FaqItem[];
    finalCtaTitle: string;
    finalCtaText: string;
    finalCtaLabel: string;
  };
  about: {
    title: string;
    introduction: string;
    sections: ContentSection[];
    ctaTitle: string;
    ctaText: string;
    ctaLabel: string;
  };
  services: {
    title: string;
    introduction: string;
    items: ContentCard[];
    processHeading: string;
    processSteps: ProcessStep[];
    ctaTitle: string;
    ctaText: string;
    ctaLabel: string;
  };
  contact: {
    title: string;
    introduction: string;
    preparationHeading: string;
    preparationItems: string[];
    nextStepTitle: string;
    nextStepText: string;
  };
};

export type WebsitePlan = {
  templateKey: 'lulu-standard-v1';
  siteTitle: string;
  brandVoice: string;
  primaryLanguage: string;
  palette: ThemePalette;
  contentProfile: WebsiteContentProfile;
  pages: GeneratedPage[];
  globalSeo: { title: string; description: string; keywords: string[] };
  assets: Array<{ brief: string; altText: string; url?: string }>;
};

export type WebsiteGenerationPhase = 'generating_content' | 'applying_template' | 'template_ready';

export type WebsiteGenerationProgress = {
  plan?: WebsitePlan;
  phase: WebsiteGenerationPhase;
  percent: number;
  completedPages: number;
  totalPages: number;
  currentPageTitle: string | null;
  completedSections: number;
  totalSections: number;
  currentSectionTitle: string | null;
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

const TEMPLATE_KEY = 'lulu-standard-v1' as const;
const PAGE_COUNT = 4;
const forbiddenContent = /hello world|under construction|website is being built|no verified information|example\.com|123 example street|hi@example\.com|\(123\) 456-7890|\bTODO\b|xiangjinxin/i;

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

function parseJsonObject(text: string): Record<string, unknown> {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next normalized candidate.
    }
  }
  throw new AppError(502, 'WEBSITE_CONTENT_INVALID', 'The AI response did not contain a valid structured website content profile');
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && (/timed?\s*out|timeout/i.test(error.message) || ['AbortError', 'TimeoutError', 'APIConnectionTimeoutError'].includes(error.name));
}

function errorStatus(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const status = (error as Record<string, unknown>).status;
  return typeof status === 'number' ? status : null;
}

async function createJsonCompletion(input: { system: string; user: string; maxTokens: number }) {
  const client = getOpenAIResponsesClient();
  const tokenLimit = env.AI_PROVIDER === 'openai' ? { max_completion_tokens: input.maxTokens } : { max_tokens: input.maxTokens };
  const request = {
    model: configuredModel(),
    messages: [{ role: 'system', content: input.system }, { role: 'user', content: input.user }],
    response_format: { type: 'json_object' },
    ...(env.AI_PROVIDER === 'deepseek' ? { thinking: { type: 'disabled' } } : {}),
    temperature: 0.15,
    ...tokenLimit,
  };

  for (let attempt = 0; attempt <= env.AI_MAX_RETRIES; attempt += 1) {
    try {
      logger.info({ label: 'Website structured content generation', provider: env.AI_PROVIDER, model: request.model, maxTokens: input.maxTokens, attempt: attempt + 1 }, 'Website AI request started');
      const response = await client.createChat(request, { timeout: env.AI_REQUEST_TIMEOUT_MS, maxRetries: 0 });
      const text = extractResponseText(response);
      logger.info({ label: 'Website structured content generation', responseChars: text.length, attempt: attempt + 1 }, 'Website AI response received');
      if (!text) throw new AppError(502, 'WEBSITE_AI_EMPTY_RESPONSE', 'Website content generation returned an empty AI response');
      return text;
    } catch (error) {
      const status = errorStatus(error);
      const retriable = isTimeoutError(error) || status === 408 || status === 409 || status === 429 || (status !== null && status >= 500);
      if (retriable && attempt < env.AI_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
        continue;
      }
      if (error instanceof AppError) throw error;
      if (isTimeoutError(error)) throw new AppError(504, 'WEBSITE_AI_TIMEOUT', 'Website content generation exceeded the AI time limit');
      if (status === 429) throw new AppError(429, 'WEBSITE_AI_RATE_LIMITED', 'Website content generation was rate limited by the AI provider');
      throw new AppError(502, 'WEBSITE_AI_REQUEST_FAILED', 'Website content generation failed at the AI provider', { providerStatus: status, providerMessage: error instanceof Error ? error.message : String(error) });
    }
  }
  throw new AppError(502, 'WEBSITE_AI_REQUEST_FAILED', 'Website content generation failed at the AI provider');
}

function compactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 1_500 ? `${value.slice(0, 1_500)}…` : value;
  if (depth >= 4) return Array.isArray(value) ? `[${value.length} items]` : '[nested data]';
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => compactValue(item, depth + 1));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([key, item]) => [key, compactValue(item, depth + 1)]));
  return String(value);
}

function stringValue(value: unknown, fallback = '', maxLength = 1_500) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback;
}

function stringArray(value: unknown, fallback: string[] = [], max = 8) {
  if (!Array.isArray(value)) return fallback;
  const parsed = value.map((item) => stringValue(item, '', 160)).filter(Boolean).slice(0, max);
  return parsed.length ? parsed : fallback;
}

function objectValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function objectArray(value: unknown, max = 8) {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)).slice(0, max) : [];
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}

function safeImageUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function paletteForContext(context: WebsiteContext): ThemePalette {
  const signals = `${context.workspace.industry ?? ''} ${context.workspace.businessDescription ?? ''} ${context.workspace.positioningTags.join(' ')}`.toLowerCase();
  if (/health|medical|wellness|care|clinic|pharma/.test(signals)) return { primary: '#0f766e', secondary: '#134e4a', accent: '#22c55e', ink: '#16302d', muted: '#5f7471', surface: '#ffffff', background: '#f0fdfa' };
  if (/food|restaurant|hospitality|travel|hotel/.test(signals)) return { primary: '#9a3412', secondary: '#431407', accent: '#f59e0b', ink: '#3f241b', muted: '#79645d', surface: '#ffffff', background: '#fff7ed' };
  if (/creative|design|fashion|beauty|media|art/.test(signals)) return { primary: '#7e22ce', secondary: '#3b0764', accent: '#ec4899', ink: '#2e1938', muted: '#77657e', surface: '#ffffff', background: '#faf5ff' };
  if (/finance|legal|consult|insurance|account/.test(signals)) return { primary: '#1e3a8a', secondary: '#172554', accent: '#ca8a04', ink: '#17233e', muted: '#64708a', surface: '#ffffff', background: '#f8fafc' };
  if (/technology|software|saas|digital|data|ai\b/.test(signals)) return { primary: '#1d4ed8', secondary: '#1e1b4b', accent: '#06b6d4', ink: '#172554', muted: '#65718c', surface: '#ffffff', background: '#eff6ff' };
  return { primary: '#183c65', secondary: '#303740', accent: '#e89110', ink: '#233142', muted: '#657283', surface: '#ffffff', background: '#f4f6f8' };
}

function fallbackServiceCards(context: WebsiteContext): ContentCard[] {
  const verified = context.offerings.slice(0, 6).map((offering) => ({
    title: offering.name,
    description: offering.description ?? offering.valueProposition ?? `Learn how ${offering.name} supports the requirements of your organization.`,
    cta: 'Learn more',
  }));
  if (verified.length) return verified;
  const company = context.workspace.companyName;
  return [
    { title: 'Solutions', description: context.workspace.valueProposition ?? `${company} provides solutions aligned with verified customer and business requirements.`, cta: 'Explore solutions' },
    { title: 'Expert guidance', description: context.workspace.shortBrandDescription ?? `Discuss your requirements with ${company} and identify a suitable next step.`, cta: 'Talk to us' },
    { title: 'Business support', description: context.workspace.businessDescription ?? `${company} supports customers with a clear and focused service experience.`, cta: 'Learn more' },
  ];
}

function cardsFrom(value: unknown, fallback: ContentCard[], max = 6) {
  const cards = objectArray(value, max).map((card) => ({ title: stringValue(card.title, '', 120), description: stringValue(card.description, '', 500), cta: stringValue(card.cta, 'Learn more', 80) })).filter((card) => card.title && card.description);
  return cards.length ? cards : fallback;
}

function sectionsFrom(value: unknown, fallback: ContentSection[], max = 5) {
  const sections = objectArray(value, max).map((section) => ({ heading: stringValue(section.heading, '', 140), body: stringValue(section.body, '', 900) })).filter((section) => section.heading && section.body);
  return sections.length ? sections : fallback;
}

function stepsFrom(value: unknown, fallback: ProcessStep[], max = 6) {
  const steps = objectArray(value, max).map((step) => ({ title: stringValue(step.title, '', 120), description: stringValue(step.description, '', 420) })).filter((step) => step.title && step.description);
  return steps.length ? steps : fallback;
}

function faqsFrom(value: unknown, fallback: FaqItem[]) {
  const faqs = objectArray(value, 6).map((faq) => ({ question: stringValue(faq.question, '', 180), answer: stringValue(faq.answer, '', 700) })).filter((faq) => faq.question && faq.answer);
  return faqs.length >= 2 ? faqs : fallback;
}

function templateLabels(language: string) {
  const normalized = language.trim().toLowerCase();
  if (/^(de|de[-_]|german|deutsch)/.test(normalized)) return { home: 'Startseite', solutions: 'Lösungen', services: 'Leistungen', process: 'Ablauf', trust: 'Vertrauen', companyImage: 'Unternehmensbild' };
  if (/^(zh|zh[-_]|chinese|中文|简体中文|繁體中文)/.test(normalized)) return { home: '首页', solutions: '解决方案', services: '服务', process: '流程', trust: '信任', companyImage: '企业图片' };
  return { home: 'Home', solutions: 'Solutions', services: 'Services', process: 'Process', trust: 'Trust', companyImage: 'Company image' };
}

function profileFrom(value: Record<string, unknown>, language: string, context: WebsiteContext): WebsiteContentProfile {
  const company = context.workspace.companyName;
  const home = objectValue(value.home);
  const about = objectValue(value.about);
  const services = objectValue(value.services);
  const contact = objectValue(value.contact);
  const seo = objectValue(value.globalSeo);
  const fallbackCards = fallbackServiceCards(context);
  const fallbackIntro = context.workspace.shortBrandDescription ?? context.workspace.businessDescription ?? context.workspace.valueProposition ?? `${company} helps customers move from requirements to a clear next step.`;
  const fallbackTarget = context.workspace.targetMarket ?? 'customers looking for a reliable business partner';
  const serviceCards = cardsFrom(services.items, fallbackCards);
  return {
    siteTitle: company,
    tagline: stringValue(value.tagline, fallbackIntro, 220),
    brandVoice: stringValue(value.brandVoice, 'Clear, confident and helpful', 120),
    primaryLanguage: stringValue(value.primaryLanguage, language, 20),
    globalSeo: { title: stringValue(seo.title, `${company} | ${context.workspace.industry ?? 'Business solutions'}`, 70), description: stringValue(seo.description, fallbackIntro, 170), keywords: stringArray(seo.keywords, context.workspace.positioningTags, 15) },
    home: {
      eyebrow: stringValue(home.eyebrow, context.workspace.industry ?? 'Welcome', 100),
      headline: stringValue(home.headline, context.workspace.valueProposition ?? fallbackIntro, 180),
      introduction: stringValue(home.introduction, context.workspace.businessDescription ?? fallbackIntro, 700),
      primaryCta: stringValue(home.primaryCta, 'Start a conversation', 70),
      secondaryCta: stringValue(home.secondaryCta, 'Explore our services', 70),
      trustItems: stringArray(home.trustItems, [...context.workspace.positioningTags, context.workspace.industry ?? '', context.workspace.countryRegion ?? ''].filter(Boolean), 6),
      audienceHeading: stringValue(home.audienceHeading, 'How we can help', 140),
      audienceIntroduction: stringValue(home.audienceIntroduction, `Focused support for ${fallbackTarget}.`, 500),
      audienceCards: cardsFrom(home.audienceCards, serviceCards.slice(0, 4), 4),
      servicesHeading: stringValue(home.servicesHeading, 'Solutions built around real requirements', 140),
      servicesIntroduction: stringValue(home.servicesIntroduction, context.workspace.valueProposition ?? fallbackIntro, 500),
      highlightEyebrow: stringValue(home.highlightEyebrow, 'Why choose us', 100),
      highlightTitle: stringValue(home.highlightTitle, context.workspace.valueProposition ?? `A focused partner for ${fallbackTarget}`, 180),
      highlightText: stringValue(home.highlightText, context.workspace.shortBrandDescription ?? fallbackIntro, 700),
      processHeading: stringValue(home.processHeading, 'A clear path forward', 140),
      processIntroduction: stringValue(home.processIntroduction, 'A straightforward process keeps requirements, decisions and next steps transparent.', 500),
      processSteps: stepsFrom(home.processSteps, [{ title: 'Share your requirements', description: 'Tell us what you need, who it is for and what a successful outcome should look like.' }, { title: 'Review the right approach', description: 'We organize the available information and clarify the most relevant option.' }, { title: 'Move to the next step', description: 'Continue with a concrete conversation based on confirmed requirements.' }]),
      faqHeading: stringValue(home.faqHeading, 'Frequently asked questions', 140),
      faqs: faqsFrom(home.faqs, [{ question: `What does ${company} offer?`, answer: context.workspace.businessDescription ?? fallbackIntro }, { question: `Who does ${company} work with?`, answer: `The offer is designed for ${fallbackTarget}.` }, { question: 'How do we get started?', answer: 'Share your requirements through the contact page so the right next step can be confirmed.' }]),
      finalCtaTitle: stringValue(home.finalCtaTitle, 'Ready to discuss your requirements?', 160),
      finalCtaText: stringValue(home.finalCtaText, `Start a focused conversation with ${company}.`, 500),
      finalCtaLabel: stringValue(home.finalCtaLabel, 'Contact us', 70),
    },
    about: {
      title: stringValue(about.title, `About ${company}`, 160),
      introduction: stringValue(about.introduction, fallbackIntro, 700),
      sections: sectionsFrom(about.sections, [{ heading: 'What we do', body: context.workspace.businessDescription ?? fallbackIntro }, { heading: 'Our focus', body: context.workspace.valueProposition ?? fallbackIntro }, { heading: 'Who we support', body: `Our work is focused on ${fallbackTarget}.` }]),
      ctaTitle: stringValue(about.ctaTitle, 'Let us understand your requirements', 160),
      ctaText: stringValue(about.ctaText, `Contact ${company} to discuss the right next step.`, 500),
      ctaLabel: stringValue(about.ctaLabel, 'Contact us', 70),
    },
    services: {
      title: stringValue(services.title, 'Services and solutions', 160),
      introduction: stringValue(services.introduction, context.workspace.valueProposition ?? fallbackIntro, 700),
      items: serviceCards,
      processHeading: stringValue(services.processHeading, 'How we work', 140),
      processSteps: stepsFrom(services.processSteps, [{ title: 'Understand', description: 'We begin with the verified business requirement and desired outcome.' }, { title: 'Align', description: 'The available solution is matched to the relevant audience and context.' }, { title: 'Proceed', description: 'A concrete next step is agreed without unsupported assumptions.' }]),
      ctaTitle: stringValue(services.ctaTitle, 'Find the right solution', 160),
      ctaText: stringValue(services.ctaText, 'Share your requirements and receive a focused response.', 500),
      ctaLabel: stringValue(services.ctaLabel, 'Start a conversation', 70),
    },
    contact: {
      title: stringValue(contact.title, `Contact ${company}`, 160),
      introduction: stringValue(contact.introduction, 'Share your requirements so the right person can understand the request and confirm the next step.', 700),
      preparationHeading: stringValue(contact.preparationHeading, 'Helpful information to include', 140),
      preparationItems: stringArray(contact.preparationItems, ['What you need', 'Who the requirement is for', 'Your preferred timing', 'Any relevant files or specifications'], 8),
      nextStepTitle: stringValue(contact.nextStepTitle, 'What happens next', 140),
      nextStepText: stringValue(contact.nextStepText, `${company} will review the information provided and respond through the available business contact channel.`, 600),
    },
  };
}

async function generateContentProfile(input: { provider: string; language: string; prompt: string; context: WebsiteContext; cleanRetry?: boolean }) {
  const system = [
    'You are Lulu Website Copywriter.',
    'Create only factual website copy from the verified business context.',
    'Return exactly one JSON object and never return HTML, Markdown, CSS, JavaScript or code.',
    `Write all customer-facing copy in ${input.language}.`,
    'Do not invent contacts, locations, prices, customers, testimonials, certifications, statistics, guarantees, integrations or capabilities.',
    'Use concise, professional language. Avoid generic filler and repeated sentences.',
    'Required JSON keys: tagline, brandVoice, primaryLanguage, globalSeo, home, about, services, contact.',
    'globalSeo: {title,description,keywords}.',
    'home: {eyebrow,headline,introduction,primaryCta,secondaryCta,trustItems,audienceHeading,audienceIntroduction,audienceCards:[{title,description,cta}],servicesHeading,servicesIntroduction,highlightEyebrow,highlightTitle,highlightText,processHeading,processIntroduction,processSteps:[{title,description}],faqHeading,faqs:[{question,answer}],finalCtaTitle,finalCtaText,finalCtaLabel}.',
    'about: {title,introduction,sections:[{heading,body}],ctaTitle,ctaText,ctaLabel}.',
    'services: {title,introduction,items:[{title,description,cta}],processHeading,processSteps:[{title,description}],ctaTitle,ctaText,ctaLabel}.',
    'contact: {title,introduction,preparationHeading,preparationItems,nextStepTitle,nextStepText}.',
    input.cleanRetry ? 'The previous response was invalid. Return a complete, parseable JSON object with every required key.' : '',
  ].filter(Boolean).join(' ');
  const response = await createJsonCompletion({ maxTokens: 3_400, system, user: [`Provider: ${input.provider}`, `Language: ${input.language}`, `Website goal: ${input.prompt}`, 'Verified business context:', JSON.stringify(input.context)].join('\n\n') });
  try {
    return profileFrom(parseJsonObject(response), input.language, input.context);
  } catch (error) {
    if (input.cleanRetry) throw error;
    logger.warn({ provider: input.provider }, 'Website content JSON invalid; requesting one clean structured retry');
    return generateContentProfile({ ...input, cleanRetry: true });
  }
}

function sectionTitle(eyebrow: string, title: string, introduction: string, palette: ThemePalette) {
  return `<div style="max-width:760px;margin-bottom:32px"><p style="margin:0 0 10px;color:${palette.primary};font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase">${escapeHtml(eyebrow)}</p><h2 style="margin:0 0 14px;color:${palette.ink};font-size:clamp(30px,5vw,48px);line-height:1.06">${escapeHtml(title)}</h2><p style="margin:0;color:${palette.muted};font-size:18px;line-height:1.7">${escapeHtml(introduction)}</p></div>`;
}

function button(label: string, href: string, palette: ThemePalette, secondary = false) {
  const styles = secondary ? `background:${palette.surface};border:1px solid ${palette.primary};color:${palette.primary}` : `background:${palette.accent};border:1px solid ${palette.accent};color:#17202a`;
  return `<a href="${escapeHtml(href)}" style="display:inline-flex;align-items:center;justify-content:center;padding:13px 20px;${styles};font-weight:700;text-decoration:none">${escapeHtml(label)}</a>`;
}

function imageMarkup(asset: WebsiteImageAsset | undefined, minHeight = 330) {
  const url = safeImageUrl(asset?.url);
  if (!url) return '';
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(asset?.altText || '')}" loading="lazy" style="display:block;width:100%;min-height:${minHeight}px;max-height:520px;object-fit:cover">`;
}

type RenderedSection = { key: string; title: string; html: string };
type RenderedPage = { openingHtml: string; sections: RenderedSection[]; closingHtml: string };

function renderedSection(key: string, title: string, html: string): RenderedSection {
  return { key, title, html };
}

function composePage(page: RenderedPage, sections: GeneratedSection[]) {
  return `${page.openingHtml}${sections.map((section) => section.html).join('')}${page.closingHtml}`;
}

function renderHome(profile: WebsiteContentProfile, palette: ThemePalette, images: WebsiteImageAsset[]): RenderedPage {
  const home = profile.home;
  const labels = templateLabels(profile.primaryLanguage);
  const heroImage = safeImageUrl(images[0]?.url);
  const heroBackground = heroImage ? `background-image:linear-gradient(90deg,rgba(24,32,43,.90),rgba(24,32,43,.48)),url('${escapeHtml(heroImage)}');background-position:center;background-size:cover;` : `background:linear-gradient(125deg,${palette.secondary},${palette.primary});`;
  const trust = home.trustItems.length ? `<section data-lulu-section="trust" style="display:flex;justify-content:center;gap:24px;flex-wrap:wrap;padding:16px 5%;background:${palette.background};border-bottom:1px solid #dce2e8">${home.trustItems.map((item) => `<span style="font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${palette.ink}">${escapeHtml(item)}</span>`).join('')}</section>` : '';
  const audienceCards = home.audienceCards.map((card) => `<article style="padding:26px;background:${palette.surface};border:1px solid #dce2e8"><h3 style="margin:0 0 12px;color:${palette.ink};font-size:25px">${escapeHtml(card.title)}</h3><p style="margin:0 0 16px;color:${palette.muted};line-height:1.65">${escapeHtml(card.description)}</p><a href="/services/" style="color:${palette.primary};font-weight:700;text-decoration:none">${escapeHtml(card.cta)} →</a></article>`).join('');
  const serviceCards = profile.services.items.slice(0, 6).map((card) => `<article style="padding:26px;background:${palette.background};border-left:4px solid ${palette.accent}"><h3 style="margin:0 0 12px;color:${palette.ink};font-size:24px">${escapeHtml(card.title)}</h3><p style="margin:0;color:${palette.muted};line-height:1.65">${escapeHtml(card.description)}</p></article>`).join('');
  const steps = home.processSteps.map((step, index) => `<article style="padding:22px;border-top:3px solid ${palette.accent}"><span style="display:block;margin-bottom:12px;color:${palette.primary};font-weight:800">0${index + 1}</span><h3 style="margin:0 0 10px;color:${palette.ink};font-size:23px">${escapeHtml(step.title)}</h3><p style="margin:0;color:${palette.muted};line-height:1.65">${escapeHtml(step.description)}</p></article>`).join('');
  const faqs = home.faqs.map((faq) => `<details style="padding:18px 0;border-bottom:1px solid #dce2e8"><summary style="cursor:pointer;color:${palette.ink};font-weight:700">${escapeHtml(faq.question)}</summary><p style="margin:12px 0 0;color:${palette.muted};line-height:1.7">${escapeHtml(faq.answer)}</p></details>`).join('');
  const featureImage = imageMarkup(images[1]);
  return {
    openingHtml: `<main data-lulu-template="${TEMPLATE_KEY}" style="margin:0;color:${palette.ink};font-family:Arial,sans-serif">`,
    sections: [
      renderedSection('hero', home.eyebrow, `<section data-lulu-section="hero" style="${heroBackground}color:#fff"><div style="max-width:1180px;margin:auto;padding:clamp(72px,10vw,116px) 24px"><p style="margin:0 0 14px;color:#ffd27a;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase">${escapeHtml(home.eyebrow)}</p><h1 style="max-width:850px;margin:0 0 20px;font-size:clamp(42px,7vw,76px);line-height:.98">${escapeHtml(home.headline)}</h1><p style="max-width:740px;margin:0;color:#eef2f5;font-size:20px;line-height:1.65">${escapeHtml(home.introduction)}</p><div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:30px">${button(home.primaryCta, '/contact/', palette)}${button(home.secondaryCta, '/services/', palette, true)}</div></div></section>`),
      ...(trust ? [renderedSection('trust', labels.trust, trust)] : []),
      renderedSection('audience', home.audienceHeading, `<section data-lulu-section="audience" style="padding:76px 24px;background:${palette.surface}"><div style="max-width:1180px;margin:auto">${sectionTitle(labels.solutions, home.audienceHeading, home.audienceIntroduction, palette)}<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px">${audienceCards}</div></div></section>`),
      renderedSection('services', home.servicesHeading, `<section data-lulu-section="services" style="padding:76px 24px;background:${palette.background}"><div style="max-width:1180px;margin:auto">${sectionTitle(labels.services, home.servicesHeading, home.servicesIntroduction, palette)}<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px">${serviceCards}</div></div></section>`),
      renderedSection('differentiator', home.highlightTitle, `<section data-lulu-section="differentiator" style="padding:76px 24px;background:${palette.secondary};color:#fff"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:46px;align-items:center;max-width:1180px;margin:auto"><div><p style="margin:0 0 10px;color:#ffd27a;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase">${escapeHtml(home.highlightEyebrow)}</p><h2 style="margin:0 0 18px;color:#fff;font-size:clamp(32px,5vw,52px);line-height:1.05">${escapeHtml(home.highlightTitle)}</h2><p style="margin:0;color:#dbe3ea;font-size:18px;line-height:1.75">${escapeHtml(home.highlightText)}</p></div>${featureImage}</div></section>`),
      renderedSection('process', home.processHeading, `<section data-lulu-section="process" style="padding:76px 24px;background:${palette.surface}"><div style="max-width:1180px;margin:auto">${sectionTitle(labels.process, home.processHeading, home.processIntroduction, palette)}<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px">${steps}</div></div></section>`),
      renderedSection('faq', home.faqHeading, `<section data-lulu-section="faq" style="padding:76px 24px;background:${palette.background}"><div style="max-width:900px;margin:auto"><h2 style="margin:0 0 24px;color:${palette.ink};font-size:clamp(32px,5vw,48px)">${escapeHtml(home.faqHeading)}</h2>${faqs}</div></section>`),
      renderedSection('call-to-action', home.finalCtaTitle, `<section data-lulu-section="call-to-action" id="contact" style="padding:70px 24px;background:${palette.primary};color:#fff"><div style="max-width:900px;margin:auto;text-align:center"><h2 style="margin:0 0 16px;color:#fff;font-size:clamp(34px,5vw,52px)">${escapeHtml(home.finalCtaTitle)}</h2><p style="margin:0 auto 26px;max-width:700px;color:#eef2f5;font-size:18px;line-height:1.7">${escapeHtml(home.finalCtaText)}</p>${button(home.finalCtaLabel, '/contact/', palette)}</div></section>`),
    ],
    closingHtml: '</main>',
  };
}

function renderStandardPage(input: { eyebrow: string; title: string; introduction: string; sections: RenderedSection[]; palette: ThemePalette; image?: WebsiteImageAsset; imageTitle?: string }): RenderedPage {
  const image = imageMarkup(input.image, 260);
  return {
    openingHtml: `<main data-lulu-template="${TEMPLATE_KEY}" style="margin:0;color:${input.palette.ink};font-family:Arial,sans-serif">`,
    sections: [
      renderedSection('introduction', input.title, `<header data-lulu-section="introduction" style="padding:70px 24px;background:linear-gradient(125deg,${input.palette.secondary},${input.palette.primary});color:#fff"><div style="max-width:1000px;margin:auto"><p style="margin:0 0 12px;color:#ffd27a;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase">${escapeHtml(input.eyebrow)}</p><h1 style="margin:0 0 18px;color:#fff;font-size:clamp(42px,7vw,68px);line-height:1">${escapeHtml(input.title)}</h1><p style="max-width:760px;margin:0;color:#eef2f5;font-size:19px;line-height:1.7">${escapeHtml(input.introduction)}</p></div></header>`),
      ...(image ? [renderedSection('company-image', input.imageTitle ?? 'Company image', `<section data-lulu-section="company-image" style="max-width:1180px;margin:0 auto;padding:46px 24px 0">${image}</section>`)] : []),
      ...input.sections,
    ],
    closingHtml: '</main>',
  };
}

function renderAbout(profile: WebsiteContentProfile, palette: ThemePalette, image?: WebsiteImageAsset) {
  const sections = profile.about.sections.map((section, index) => renderedSection(`about-${index + 1}`, section.heading, `<section data-lulu-section="about-${index + 1}" style="padding:32px 24px"><div style="max-width:1180px;margin:auto;padding:28px;background:${palette.background};border-top:4px solid ${palette.primary}"><h2 style="margin:0 0 14px;color:${palette.ink};font-size:30px">${escapeHtml(section.heading)}</h2><p style="margin:0;color:${palette.muted};line-height:1.75">${escapeHtml(section.body)}</p></div></section>`));
  sections.push(renderedSection('call-to-action', profile.about.ctaTitle, `<section data-lulu-section="call-to-action" style="padding:50px 24px"><div style="max-width:1180px;margin:auto;padding:42px;background:${palette.primary};color:#fff"><h2 style="margin:0 0 14px;color:#fff;font-size:34px">${escapeHtml(profile.about.ctaTitle)}</h2><p style="margin:0 0 22px;color:#eef2f5;line-height:1.7">${escapeHtml(profile.about.ctaText)}</p>${button(profile.about.ctaLabel, '/contact/', palette)}</div></section>`));
  return renderStandardPage({ eyebrow: profile.siteTitle, title: profile.about.title, introduction: profile.about.introduction, sections, palette, imageTitle: templateLabels(profile.primaryLanguage).companyImage, ...(image ? { image } : {}) });
}

function renderServices(profile: WebsiteContentProfile, palette: ThemePalette, image?: WebsiteImageAsset) {
  const cards = profile.services.items.map((item) => `<article style="padding:28px;background:${palette.surface};border:1px solid #dce2e8"><h2 style="margin:0 0 14px;color:${palette.ink};font-size:29px">${escapeHtml(item.title)}</h2><p style="margin:0;color:${palette.muted};line-height:1.7">${escapeHtml(item.description)}</p></article>`).join('');
  const steps = profile.services.processSteps.map((step, index) => `<li style="display:grid;grid-template-columns:44px 1fr;gap:14px;padding:20px 0;border-bottom:1px solid #dce2e8"><strong style="color:${palette.primary}">0${index + 1}</strong><div><h3 style="margin:0 0 8px;color:${palette.ink};font-size:23px">${escapeHtml(step.title)}</h3><p style="margin:0;color:${palette.muted};line-height:1.65">${escapeHtml(step.description)}</p></div></li>`).join('');
  const sections = [
    renderedSection('services', profile.services.title, `<section data-lulu-section="services" style="padding:70px 24px"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:18px;max-width:1180px;margin:auto">${cards}</div></section>`),
    renderedSection('process', profile.services.processHeading, `<section data-lulu-section="process" style="padding:56px 24px"><div style="max-width:1180px;margin:auto;padding:38px;background:${palette.background}"><h2 style="margin:0 0 18px;color:${palette.ink};font-size:36px">${escapeHtml(profile.services.processHeading)}</h2><ol style="list-style:none;margin:0;padding:0">${steps}</ol></div></section>`),
    renderedSection('call-to-action', profile.services.ctaTitle, `<section data-lulu-section="call-to-action" style="padding:50px 24px"><div style="max-width:1180px;margin:auto;padding:42px;background:${palette.primary};color:#fff"><h2 style="margin:0 0 14px;color:#fff;font-size:34px">${escapeHtml(profile.services.ctaTitle)}</h2><p style="margin:0 0 22px;color:#eef2f5;line-height:1.7">${escapeHtml(profile.services.ctaText)}</p>${button(profile.services.ctaLabel, '/contact/', palette)}</div></section>`),
  ];
  return renderStandardPage({ eyebrow: templateLabels(profile.primaryLanguage).services, title: profile.services.title, introduction: profile.services.introduction, sections, palette, imageTitle: templateLabels(profile.primaryLanguage).companyImage, ...(image ? { image } : {}) });
}

function renderContact(profile: WebsiteContentProfile, palette: ThemePalette) {
  const items = profile.contact.preparationItems.map((item) => `<li style="padding:12px 0;border-bottom:1px solid #dce2e8;color:${palette.ink}">${escapeHtml(item)}</li>`).join('');
  const sections = [
    renderedSection('preparation', profile.contact.preparationHeading, `<section data-lulu-section="preparation" style="padding:70px 24px 28px"><div style="max-width:1180px;margin:auto;padding:30px;background:${palette.background}"><h2 style="margin:0 0 16px;color:${palette.ink};font-size:32px">${escapeHtml(profile.contact.preparationHeading)}</h2><ul style="list-style:none;margin:0;padding:0">${items}</ul></div></section>`),
    renderedSection('next-step', profile.contact.nextStepTitle, `<section data-lulu-section="next-step" style="padding:28px 24px 70px"><div style="max-width:1180px;margin:auto;padding:30px;background:${palette.secondary};color:#fff"><h2 style="margin:0 0 16px;color:#fff;font-size:32px">${escapeHtml(profile.contact.nextStepTitle)}</h2><p style="margin:0;color:#e5eaf0;font-size:17px;line-height:1.75">${escapeHtml(profile.contact.nextStepText)}</p></div></section>`),
  ];
  return renderStandardPage({ eyebrow: profile.siteTitle, title: profile.contact.title, introduction: profile.contact.introduction, sections, palette });
}

function pageDefinitions(profile: WebsiteContentProfile) {
  const labels = templateLabels(profile.primaryLanguage);
  return [
    { title: labels.home, slug: 'home', purpose: 'Introduce the company and guide visitors to the most relevant next step.', sections: ['Hero', 'Trust', 'Audience', labels.services, 'Differentiator', labels.process, 'FAQ', 'Call to action'], seoTitle: profile.globalSeo.title, seoDescription: profile.globalSeo.description },
    { title: profile.about.title, slug: 'about', purpose: 'Explain the verified company positioning and focus.', sections: profile.about.sections.map((section) => section.heading), seoTitle: `${profile.about.title} | ${profile.siteTitle}`.slice(0, 70), seoDescription: profile.about.introduction.slice(0, 170) },
    { title: profile.services.title, slug: 'services', purpose: 'Present verified offers and the customer journey.', sections: ['Services', profile.services.processHeading, profile.services.ctaTitle], seoTitle: `${profile.services.title} | ${profile.siteTitle}`.slice(0, 70), seoDescription: profile.services.introduction.slice(0, 170) },
    { title: profile.contact.title, slug: 'contact', purpose: 'Help qualified visitors prepare and start a business conversation.', sections: [profile.contact.preparationHeading, profile.contact.nextStepTitle], seoTitle: `${profile.contact.title} | ${profile.siteTitle}`.slice(0, 70), seoDescription: profile.contact.introduction.slice(0, 170) },
  ];
}

function renderPage(index: number, profile: WebsiteContentProfile, palette: ThemePalette, images: WebsiteImageAsset[]): RenderedPage {
  if (index === 0) return renderHome(profile, palette, images);
  if (index === 1) return renderAbout(profile, palette, images[2] ?? images[1]);
  if (index === 2) return renderServices(profile, palette, images[3] ?? images[2]);
  return renderContact(profile, palette);
}

function pageHasPublishableContent(page: GeneratedPage, index: number) {
  const content = String(page.content ?? '').trim();
  const minimumLength = index === 0 ? 2_000 : 800;
  return content.length >= minimumLength && /<main\b/i.test(content) && /<h1\b/i.test(content) && content.includes(`data-lulu-template="${TEMPLATE_KEY}"`) && !forbiddenContent.test(content);
}

export function isCompleteWebsitePlan(value: unknown): value is WebsitePlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as WebsitePlan;
  return plan.templateKey === TEMPLATE_KEY && typeof plan.siteTitle === 'string' && Array.isArray(plan.pages) && plan.pages.length === PAGE_COUNT && plan.pages.every(pageHasPublishableContent);
}

async function loadWebsiteContext(workspaceId: string, userId: string): Promise<WebsiteContext> {
  const workspace = await findWorkspaceForUser(workspaceId, userId);
  if (!workspace) throw new AppError(404, 'WEBSITE_WORKSPACE_NOT_FOUND', 'The workspace context was not found');
  const [offerings, platforms, initialAnalysis] = await Promise.all([listOfferings(workspaceId), listPlatforms(workspaceId), agentRepo.getLatestCompletedInitialAnalysis(workspaceId)]);
  return {
    workspace: { companyName: workspace.companyName, industry: workspace.industry, companySize: workspace.companySize, countryRegion: workspace.countryRegion, businessDescription: workspace.businessDescription, valueProposition: workspace.valueProposition, targetMarket: workspace.targetMarket, shortBrandDescription: workspace.shortBrandDescription, positioningTags: workspace.positioningTags ?? [] },
    offerings: offerings.filter((offering) => offering.status === 'active' || offering.status === 'draft').slice(0, 24).map((offering) => ({ name: offering.name, type: offering.offeringType, category: offering.category, description: offering.description, targetCustomer: offering.targetCustomer, valueProposition: offering.valueProposition, status: offering.status })),
    connectedPlatforms: platforms.filter((platform) => platform.connectionStatus === 'connected' || platform.connectionStatus === 'active').slice(0, 20).map((platform) => ({ name: platform.name, category: platform.category, status: platform.connectionStatus })),
    initialAnalysis: compactValue(initialAnalysis?.result ?? null),
  };
}

function existingTemplatePlan(value: Record<string, unknown> | undefined, language: string, context: WebsiteContext, images: WebsiteImageAsset[]) {
  if (!value || value.templateKey !== TEMPLATE_KEY) return null;
  const storedProfile = objectValue(value.contentProfile);
  if (!Object.keys(storedProfile).length) return null;
  const profile = profileFrom(storedProfile, language, context);
  const palette = paletteForContext(context);
  const definitions = pageDefinitions(profile);
  const storedPages = Array.isArray(value.pages) ? value.pages : [];
  const pages = definitions.map((definition, index) => {
    const existing = storedPages.find((page) => objectValue(page).slug === definition.slug);
    const existingPage = objectValue(existing);
    const content = stringValue(existingPage.content);
    const rendered = renderPage(index, profile, palette, images);
    const complete = pageHasPublishableContent({ ...definition, generatedSections: [], content } as GeneratedPage, index);
    const storedSectionKeys = new Set(
      (Array.isArray(existingPage.generatedSections) ? existingPage.generatedSections : [])
        .map((section) => stringValue(objectValue(section).key))
        .filter(Boolean),
    );
    const generatedSections = rendered.sections
      .filter((section) => complete || storedSectionKeys.has(section.key))
      .map((section) => ({ ...section }));
    return {
      ...definition,
      sections: rendered.sections.map((section) => section.title),
      generatedSections,
      content: complete ? content : composePage(rendered, generatedSections),
    };
  });
  return { templateKey: TEMPLATE_KEY, siteTitle: profile.siteTitle, brandVoice: profile.brandVoice, primaryLanguage: profile.primaryLanguage, palette, contentProfile: profile, pages, globalSeo: profile.globalSeo, assets: images.map((asset, index) => ({ brief: `Existing WordPress media image ${index + 1}`, altText: asset.altText, url: asset.url })) } satisfies WebsitePlan;
}

export async function generateWebsitePlan(input: {
  workspaceId: string;
  userId: string;
  prompt: string;
  language?: string;
  provider: string;
  existingPlan?: Record<string, unknown>;
  imageAssets?: WebsiteImageAsset[];
  onProgress?: (progress: WebsiteGenerationProgress) => Promise<void>;
}) {
  const context = await loadWebsiteContext(input.workspaceId, input.userId);
  const language = input.language?.trim() || 'en';
  const images = (input.imageAssets ?? []).filter((asset) => safeImageUrl(asset.url)).slice(0, 8);
  let plan = existingTemplatePlan(input.existingPlan, language, context, images);
  if (!plan) {
    await input.onProgress?.({ phase: 'generating_content', percent: 15, completedPages: 0, totalPages: PAGE_COUNT, currentPageTitle: null, completedSections: 0, totalSections: 0, currentSectionTitle: null });
    const profile = await generateContentProfile({ provider: input.provider, language, prompt: input.prompt, context });
    plan = { templateKey: TEMPLATE_KEY, siteTitle: profile.siteTitle, brandVoice: profile.brandVoice, primaryLanguage: profile.primaryLanguage, palette: paletteForContext(context), contentProfile: profile, pages: pageDefinitions(profile).map((definition) => ({ ...definition, generatedSections: [], content: '' })), globalSeo: profile.globalSeo, assets: images.map((asset, index) => ({ brief: `Existing WordPress media image ${index + 1}`, altText: asset.altText, url: asset.url })) };
  }
  if (!plan) throw new AppError(500, 'WEBSITE_PLAN_MISSING', 'The website plan could not be initialized');
  const planProfile = plan.contentProfile;
  const planPalette = plan.palette;
  const renderedPages = plan.pages.map((_, index) => renderPage(index, planProfile, planPalette, images));
  plan = {
    ...plan,
    pages: plan.pages.map((page, index) => ({
      ...page,
      sections: renderedPages[index]!.sections.map((section) => section.title),
      generatedSections: Array.isArray(page.generatedSections) ? page.generatedSections : [],
    })),
  };
  const totalSections = renderedPages.reduce((total, page) => total + page.sections.length, 0);
  let completedSections = plan.pages.reduce((total, page) => total + page.generatedSections.length, 0);
  let completedPages = plan.pages.filter(pageHasPublishableContent).length;
  for (let index = 0; index < plan.pages.length; index += 1) {
    if (pageHasPublishableContent(plan.pages[index]!, index)) continue;
    const renderedPage = renderedPages[index]!;
    const completedKeys = new Set(plan.pages[index]!.generatedSections.map((section) => section.key));
    for (const section of renderedPage.sections) {
      if (completedKeys.has(section.key)) continue;
      await input.onProgress?.({ plan, phase: 'applying_template', percent: Math.round(20 + (completedSections / totalSections) * 32), completedPages, totalPages: plan.pages.length, currentPageTitle: plan.pages[index]?.title ?? null, completedSections, totalSections, currentSectionTitle: section.title });
      const generatedSections: GeneratedSection[] = [...plan.pages[index]!.generatedSections, { ...section }];
      const content = composePage(renderedPage, generatedSections);
      plan = { ...plan, pages: plan.pages.map((page, pageIndex) => pageIndex === index ? { ...page, generatedSections, content } : page) };
      completedKeys.add(section.key);
      completedSections += 1;
      if (generatedSections.length === renderedPage.sections.length && pageHasPublishableContent(plan.pages[index]!, index)) completedPages += 1;
      await input.onProgress?.({ plan, phase: 'applying_template', percent: Math.round(20 + (completedSections / totalSections) * 32), completedPages, totalPages: plan.pages.length, currentPageTitle: plan.pages[index]?.title ?? null, completedSections, totalSections, currentSectionTitle: renderedPage.sections.find((candidate) => !completedKeys.has(candidate.key))?.title ?? null });
    }
  }
  if (!isCompleteWebsitePlan(plan)) throw new AppError(502, 'WEBSITE_TEMPLATE_RENDER_FAILED', 'The standard website template could not be rendered with the generated content');
  await input.onProgress?.({ plan, phase: 'template_ready', percent: 52, completedPages: plan.pages.length, totalPages: plan.pages.length, currentPageTitle: null, completedSections: totalSections, totalSections, currentSectionTitle: null });
  return plan;
}
