import crypto from 'node:crypto';
import OpenAI from 'openai';
import { env, hasOpenAI } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';

export type ConversationTurn = {
  role: 'user' | 'assistant';
  content: string;
};

export type AssistantContext = {
  company: {
    name: string;
    industry: string | null;
    businessDescription: string | null;
    valueProposition: string | null;
    targetMarket: string | null;
  };
  preferences: {
    priorities: string[];
    communicationStyle: string;
    insightDetail: string;
    responseLanguage: string;
    actionLevel: string;
  } | null;
};

type ResponseResult = {
  id: string;
  model: string;
  output_text: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  } | null;
};

export type ResponsesClient = {
  create(params: Record<string, unknown>): Promise<ResponseResult>;
};

let openAIClient: OpenAI | undefined;

export function getOpenAIResponsesClient(): ResponsesClient {
  if (!hasOpenAI) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'OPENAI_API_KEY is not configured');
  }
  openAIClient ??= new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return {
    create: (params) => openAIClient!.responses.create(params as never) as Promise<ResponseResult>,
  };
}

export function buildSafetyIdentifier(userId: string) {
  return crypto.createHmac('sha256', env.JWT_SECRET).update(userId).digest('hex');
}

export function buildAssistantInstructions(context: AssistantContext) {
  const companyContext = JSON.stringify(context.company);
  const preferenceContext = JSON.stringify(context.preferences);

  return [
    'You are Lulu AI, the business operating assistant inside Lulu Growth OS.',
    'Give clear, practical answers grounded in the supplied company context.',
    'Never claim that an external action was executed unless a verified tool result explicitly confirms it.',
    'Respect the configured AI action level and approval boundaries.',
    'Clearly distinguish observed data, inference, and recommendation.',
    `Company context: ${companyContext}`,
    `AI preferences: ${preferenceContext}`,
  ].join('\n');
}

export async function generateAssistantResponse(
  input: {
    userId: string;
    context: AssistantContext;
    turns: ConversationTurn[];
    model?: string | null;
  },
  client: ResponsesClient = getOpenAIResponsesClient()
) {
  const response = await client.create({
    model: input.model || env.OPENAI_MODEL,
    instructions: buildAssistantInstructions(input.context),
    input: input.turns.map((turn) => ({ role: turn.role, content: turn.content })),
    reasoning: { effort: env.OPENAI_REASONING_EFFORT },
    max_output_tokens: env.OPENAI_MAX_OUTPUT_TOKENS,
    safety_identifier: buildSafetyIdentifier(input.userId),
    store: false,
  });

  const content = response.output_text.trim();
  if (!content) {
    throw new AppError(502, 'AI_EMPTY_RESPONSE', 'The AI provider returned an empty response');
  }

  return {
    responseId: response.id,
    model: response.model,
    content,
    usage: {
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
    },
  };
}

export function isAiGenerationConfigured() {
  return hasOpenAI;
}
