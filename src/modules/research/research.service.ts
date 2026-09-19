import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { getOpenAIResponsesClient } from '../ai/openai.service.js';

const researchInputSchema = z.object({
  query: z.string().trim().min(3).max(12_000),
  context: z.string().trim().max(20_000).optional(),
  operationId: z.string().trim().min(8).max(240).optional(),
});

export type PerplexityResearchInput = z.infer<typeof researchInputSchema>;

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Runs an explicit, customer-requested deep-research operation. Normal Lulu
 * agent/text work remains on Kie.ai; Perplexity is never selected implicitly.
 * Billing and idempotency use the same AI wallet ledger as every other text
 * provider, so the operation cannot bypass customer funding controls.
 */
export async function runPerplexityResearch(workspaceId: string, userId: string, input: PerplexityResearchInput) {
  const parsed = researchInputSchema.parse(input);
  const operationId = parsed.operationId ?? crypto.randomUUID();
  const prompt = [
    'Perform a rigorous, source-grounded research brief.',
    'Separate verified facts, reasonable inferences, and open questions.',
    'Prefer primary sources and include useful citations for every material claim.',
    parsed.context ? `Additional context:\n${parsed.context}` : null,
    `Research question:\n${parsed.query}`,
  ].filter(Boolean).join('\n\n');
  const result = await getOpenAIResponsesClient().createChat({
    model: env.PERPLEXITY_RESEARCH_MODEL,
    messages: [
      { role: 'system', content: 'You are Lulu\'s Deep Research specialist. Do not invent sources or facts.' },
      { role: 'user', content: prompt },
    ],
    max_tokens: env.OPENAI_MAX_OUTPUT_TOKENS,
  }, {
    provider: 'perplexity',
    billing: {
      workspaceId,
      userId,
      operation: 'research.perplexity.deep',
      operationId,
    },
  }) as Record<string, unknown>;

  const choices = Array.isArray(result.choices) ? result.choices : [];
  const first = objectValue(choices[0]);
  const message = objectValue(first.message);
  const citations = Array.isArray(result.citations)
    ? result.citations.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  return {
    provider: 'perplexity' as const,
    model: String(result.model ?? env.PERPLEXITY_RESEARCH_MODEL),
    responseId: typeof result.id === 'string' ? result.id : null,
    text: typeof message.content === 'string' ? message.content : '',
    citations,
    usage: result.usage ?? null,
    operationId,
  };
}
