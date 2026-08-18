import { AppError } from '../../utils/app-error.js';
import { getOpenAIResponsesClient } from '../ai/openai.service.js';

export type GeneratedPage = { title: string; slug: string; purpose: string; content: string; seoTitle: string; seoDescription: string };
export type WebsitePlan = { siteTitle: string; brandVoice: string; primaryLanguage: string; pages: GeneratedPage[]; globalSeo: { title: string; description: string; keywords: string[] }; assets: { brief: string; altText: string }[] };

function extractJson(text: string): WebsitePlan {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned) as WebsitePlan; } catch { throw new AppError(502, 'WEBSITE_GENERATION_FAILED', 'The AI response did not contain a valid website plan'); }
}

export async function generateWebsitePlan(input: { prompt: string; language?: string; provider: string }) {
  const response = await getOpenAIResponsesClient().create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    instructions: 'You are Lulu Website Architect. Return ONLY valid JSON. Do not include markdown fences. Never invent external integrations or claim that a website was published. Build a practical website plan suitable for a provider API.',
    input: [{ role: 'user', content: `Create a website plan for provider ${input.provider}. Language: ${input.language ?? 'en'}. User brief: ${input.prompt}\nRequired JSON shape: {"siteTitle":string,"brandVoice":string,"primaryLanguage":string,"pages":[{"title":string,"slug":string,"purpose":string,"content":string,"seoTitle":string,"seoDescription":string}],"globalSeo":{"title":string,"description":string,"keywords":string[]},"assets":[{"brief":string,"altText":string}]}. Limit to 8 pages and keep content publication-ready.` }],
    max_output_tokens: 12000,
    store: false,
  });
  const plan = extractJson(response.output_text);
  if (!plan.pages?.length || !plan.siteTitle) throw new AppError(502, 'WEBSITE_GENERATION_FAILED', 'The AI generated an incomplete website plan');
  return plan;
}
