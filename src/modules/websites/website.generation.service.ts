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

function extractJson(text: string): WebsitePlan {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(cleaned) as WebsitePlan;
  } catch {
    throw new AppError(502, 'WEBSITE_GENERATION_FAILED', 'The AI response did not contain a valid website plan');
  }
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
  const response = await getOpenAIResponsesClient().create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
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
      'Create practical provider-compatible pages, content, SEO metadata and asset briefs. Limit the result to 8 pages.',
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
    max_output_tokens: 12000,
    store: false,
  });
  const plan = extractJson(response.output_text);
  if (!plan.pages?.length || !plan.siteTitle) {
    throw new AppError(502, 'WEBSITE_GENERATION_FAILED', 'The AI generated an incomplete website plan');
  }
  return plan;
}

export { loadWebsiteContext };
export type { WebsiteContext };
