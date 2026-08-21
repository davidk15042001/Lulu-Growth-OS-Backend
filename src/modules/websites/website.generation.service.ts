import { env } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import * as agentRepo from '../agents/agent.repo.js';
import { getOpenAIResponsesClient } from '../ai/openai.service.js';
import { listOfferings, listPlatforms } from '../onboarding/onboarding.repo.js';
import { findWorkspaceForUser } from '../workspaces/workspace.repo.js';

export type GeneratedPage = {
  title: string;
  slug: string;
  purpose: string;
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
  initialAnalysis: Record<string, unknown> | null;
};

const WEBSITE_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    siteTitle: { type: 'string' },
    brandVoice: { type: 'string' },
    primaryLanguage: { type: 'string' },
    pages: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          slug: { type: 'string' },
          purpose: { type: 'string' },
          content: { type: 'string' },
          seoTitle: { type: 'string' },
          seoDescription: { type: 'string' },
        },
        required: ['title', 'slug', 'purpose', 'content', 'seoTitle', 'seoDescription'],
        additionalProperties: false,
      },
    },
    globalSeo: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        keywords: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'description', 'keywords'],
      additionalProperties: false,
    },
    assets: {
      type: 'array',
      items: {
        type: 'object',
        properties: { brief: { type: 'string' }, altText: { type: 'string' } },
        required: ['brief', 'altText'],
        additionalProperties: false,
      },
    },
  },
  required: ['siteTitle', 'brandVoice', 'primaryLanguage', 'pages', 'globalSeo', 'assets'],
  additionalProperties: false,
} as const;

function extractResponseText(response: unknown): string {
  if (!response || typeof response !== 'object') return '';
  const value = response as Record<string, unknown>;
  if (typeof value.output_text === 'string' && value.output_text.trim()) return value.output_text.trim();
  const choices = Array.isArray(value.choices) ? value.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue;
    const message = (choice as Record<string, unknown>).message;
    if (!message || typeof message !== 'object') continue;
    const messageValue = message as Record<string, unknown>;
    if (typeof messageValue.content === 'string' && messageValue.content.trim()) return messageValue.content.trim();
    if (typeof messageValue.reasoning_content === 'string' && messageValue.reasoning_content.trim()) return messageValue.reasoning_content.trim();
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
  return texts.join('\\n').trim();
}

function planNeedsQualityRetry(plan: WebsitePlan) {
  const forbidden = /hello world|under construction|website is being built|no verified information|example\.com|123 example street|hi@example\.com|\(123\) 456-7890/i;
  return plan.pages.some((page, index) => {
    const content = String(page.content ?? '').trim();
    return forbidden.test(content) || content.length < (index === 0 ? 700 : 260);
  });
}

function extractJson(text: string): WebsitePlan {
  const normalized = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const withoutFences = normalized.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const candidates = [withoutFences];
  const firstBrace = withoutFences.indexOf('{');
  const lastBrace = withoutFences.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(withoutFences.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as WebsitePlan;
      const validPages = Array.isArray(parsed?.pages) && parsed.pages.length > 0 && parsed.pages.every((page) => page && typeof page.title === 'string' && typeof page.slug === 'string' && typeof page.content === 'string');
      if (parsed && typeof parsed.siteTitle === 'string' && validPages) return parsed;
    } catch { /* try the next normalized candidate */ }
  }
  throw new AppError(502, 'WEBSITE_GENERATION_FAILED', 'The AI response did not contain a valid website plan');
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
      .slice(0, 100)
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
      .map((platform) => ({ name: platform.name, category: platform.category, status: platform.connectionStatus })),
    initialAnalysis: initialAnalysis?.result ?? null,
  };
}

export async function generateWebsitePlan(input: {
  workspaceId: string;
  userId: string;
  prompt: string;
  language?: string;
  provider: string;
}) {
  const context = await loadWebsiteContext(input.workspaceId, input.userId);
  const client = getOpenAIResponsesClient();
  const configuredModel = env.AI_PROVIDER === 'alibaba' ? env.DASHSCOPE_MODEL : env.AI_PROVIDER === 'groq' ? env.GROQ_MODEL : env.OPENAI_MODEL;
  const primaryModel = configuredModel;
  const request = {
    model: primaryModel,
    instructions: [
      'You are Lulu Website Architect.',
      'Generate a production-ready website plan from the verified workspace context, the completed initial business analysis and the user brief.',
      'The workspace context and completed initial analysis are the source of truth. Never invent company names, products, services, prices, certifications, locations, markets, statistics, customers, integrations or legal claims.',
      'Reuse verified facts and strategic findings from the initial analysis. Treat hypotheses as hypotheses and never convert them into factual claims.',
      'Respect all data gaps. If a fact is missing, omit it or use a neutral placeholder that clearly requires user confirmation. Do not present placeholders as facts.',
      'Use the initial analysis sections for positioning, content, SEO, GEO, AEO and website architecture whenever they are present.',
      'Do not copy example companies, contacts, phone numbers, addresses, color palettes or content from the user brief unless they are explicitly part of verified workspace data.',
      'Treat connected platform names as integration metadata only; never claim that a site was published or that a platform is available unless a provider result confirms it.',
      'Return ONLY valid JSON without markdown fences and never claim that a website was published.',
      'Create practical provider-compatible pages, content, SEO metadata and asset briefs. The content field of every page must be complete publishable semantic HTML, with a substantial homepage and structured sections on every page; never return a short summary, markdown outline, placeholder copy or construction notice. Limit the result to 8 pages.',
    ].join(' '),
    input: [{
      role: 'user',
      content: [
        `Provider target: ${input.provider}`,
        `Requested language: ${input.language ?? 'en'}`,
        `User website brief: ${input.prompt}`,
        'Verified workspace context including the shared initial analysis:',
        JSON.stringify(context, null, 2),
        'Required JSON shape:',
        '{"siteTitle":string,"brandVoice":string,"primaryLanguage":string,"pages":[{"title":string,"slug":string,"purpose":string,"content":string,"seoTitle":string,"seoDescription":string}],"globalSeo":{"title":string,"description":string,"keywords":string[]},"assets":[{"brief":string,"altText":string}]}'
      ].join('\n\n'),
    }],
    text: {
      verbosity: 'low',
      format: {
        type: 'json_schema',
        name: 'website_plan',
        strict: true,
        schema: WEBSITE_PLAN_SCHEMA,
      },
    },
    reasoning: { effort: env.AI_PROVIDER === 'alibaba' ? 'none' : env.OPENAI_REASONING_EFFORT },
    // Keep the website plan bounded across all configured providers.
    // The website plan is intentionally capped at 8 pages and compact metadata.
    max_output_tokens: 5000,
    store: false,
  };
  const instructionText = request.instructions as string;
  const userContent = (request.input as Array<{ content: string }>)[0]?.content ?? '';
  const createWebsiteResponse = () => env.AI_PROVIDER === 'alibaba'
    ? client.createChat({ model: primaryModel, messages: [{ role: 'system', content: instructionText }, { role: 'user', content: userContent }], temperature: 0, response_format: { type: 'json_object' }, max_tokens: 4500 })
    : client.create(request);
  let response: unknown;
  try {
    response = await createWebsiteResponse();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const modelUnavailable = /404|does not exist|do not have access|model/i.test(message);
    const tokenLimited = /413|TPM|tokens per minute|Requested .* reduce your message size|rate limit/i.test(message);
    if (tokenLimited) {
      response = env.AI_PROVIDER === 'alibaba'
        ? await client.createChat({ model: primaryModel, messages: [{ role: 'system', content: instructionText }, { role: 'user', content: userContent }], temperature: 0, response_format: { type: 'json_object' }, max_tokens: 3000 })
        : await client.create({ ...request, max_output_tokens: 3000 });
    } else if (modelUnavailable && primaryModel !== 'gpt-5-mini' && env.AI_PROVIDER === 'openai') {
      response = await client.create({ ...request, model: 'gpt-5-mini', max_output_tokens: 5000 });
    } else {
      throw error;
    }
  }
  let plan = extractJson(extractResponseText(response));
  if (!plan.pages?.length || !plan.siteTitle) {
    throw new AppError(502, 'WEBSITE_GENERATION_FAILED', 'The AI generated an incomplete website plan');
  }
  if (planNeedsQualityRetry(plan)) {
    const retryRequest = {
      ...request,
      instructions: `${request.instructions} Your first draft failed the quality gate. Rewrite it now with a substantial, polished homepage and useful pages. Never say the site is under construction, never say information is unverified, never use fake addresses, phone numbers or email addresses, and never return a short disclaimer. Use neutral, customer-specific value language when facts are missing.`,
      max_output_tokens: 5000,
    };
    const retryResponse = env.AI_PROVIDER === 'alibaba'
      ? await client.createChat({ model: primaryModel, messages: [{ role: 'system', content: `${instructionText} ${retryRequest.instructions as string}` }, { role: 'user', content: userContent }], temperature: 0, response_format: { type: 'json_object' }, max_tokens: 4500 })
      : await client.create(retryRequest);
    plan = extractJson(extractResponseText(retryResponse));
  }
  if (!plan.pages?.length || !plan.siteTitle || planNeedsQualityRetry(plan)) {
    throw new AppError(502, 'WEBSITE_GENERATION_QUALITY_FAILED', 'The AI generated content that did not meet the website quality requirements');
  }
  return plan;
}

export { loadWebsiteContext };
export type { WebsiteContext };
