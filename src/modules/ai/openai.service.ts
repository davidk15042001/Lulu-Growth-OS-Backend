import crypto from 'node:crypto';
import OpenAI from 'openai';
import { env, hasAiProvider, hasAlibaba, hasOpenAI } from '../../config/env.js';
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
let alibabaClient: OpenAI | undefined;

function getConfiguredClient() {
  if (hasOpenAI) {
    openAIClient ??= new OpenAI({ apiKey: env.OPENAI_API_KEY });
    return openAIClient;
  }
  if (hasAlibaba) {
    alibabaClient ??= new OpenAI({ apiKey: env.DASHSCOPE_API_KEY, baseURL: env.DASHSCOPE_BASE_URL });
    return alibabaClient;
  }
  throw new AppError(503, 'AI_NOT_CONFIGURED', 'No AI provider is configured');
}

function configuredModel(requestedModel?: string | null) {
  return requestedModel || (hasAlibaba ? env.DASHSCOPE_MODEL : env.OPENAI_MODEL);
}

export function getOpenAIResponsesClient(): ResponsesClient {
  if (!hasAiProvider) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'No AI provider is configured');
  }
  const client = getConfiguredClient();
  return {
    create: (params) => client.responses.create(params as never) as Promise<ResponseResult>,
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
  const request: Record<string, unknown> = {
    model: configuredModel(input.model),
    instructions: buildAssistantInstructions(input.context),
    input: input.turns.map((turn) => ({ role: turn.role, content: turn.content })),
    reasoning: { effort: env.OPENAI_REASONING_EFFORT },
    max_output_tokens: env.OPENAI_MAX_OUTPUT_TOKENS,
    store: false,
  };
  if (hasOpenAI) request.safety_identifier = buildSafetyIdentifier(input.userId);
  const response = await client.create(request);

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

export async function generateTokenTestNumber(client: ResponsesClient = getOpenAIResponsesClient()) {
  const response = await client.create({
    model: configuredModel(),
    instructions: 'Return exactly one integer from 1 to 10 and nothing else. Do not explain your answer.',
    input: 'Generate one number between 1 and 10 to verify the configured ChatGPT token.',
    reasoning: { effort: env.OPENAI_REASONING_EFFORT },
    max_output_tokens: 32,
    store: false,
  });
  const match = response.output_text.match(/\b(10|[1-9])\b/);
  if (!match) throw new AppError(502, 'AI_TOKEN_TEST_INVALID', 'The AI provider did not return a number from 1 to 10');
  return { number: Number(match[1]), model: response.model, responseId: response.id };
}

export function isAiGenerationConfigured() {
  return hasAiProvider;
}
