import crypto from 'node:crypto';
import OpenAI from 'openai';
import { env, hasAiProvider, hasAlibaba, hasGroq, hasOpenAI } from '../../config/env.js';
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
let groqClient: OpenAI | undefined;

function getConfiguredClient() {
  if (hasOpenAI) {
    openAIClient ??= new OpenAI({ apiKey: env.OPENAI_API_KEY });
    return openAIClient;
  }
  if (hasAlibaba) {
    alibabaClient ??= new OpenAI({ apiKey: env.DASHSCOPE_API_KEY, baseURL: env.DASHSCOPE_BASE_URL });
    return alibabaClient;
  }
  if (hasGroq) {
    groqClient ??= new OpenAI({ apiKey: env.GROQ_API_KEY, baseURL: env.GROQ_BASE_URL });
    return groqClient;
  }
  throw new AppError(503, 'AI_NOT_CONFIGURED', 'No AI provider is configured');
}

function configuredModel(requestedModel?: string | null) {
  if (requestedModel) return requestedModel;
  if (hasAlibaba) return env.DASHSCOPE_MODEL;
  if (hasGroq) return env.GROQ_MODEL;
  return env.OPENAI_MODEL;
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
  if (env.AI_PROVIDER === 'openai') request.safety_identifier = buildSafetyIdentifier(input.userId);
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

const TOKEN_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
};

function normalizeUnicodeDigits(value: string) {
  return value.replace(/[０-９٠-٩۰-۹]/g, (character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0xff10 && code <= 0xff19) return String(code - 0xff10);
    if (code >= 0x660 && code <= 0x669) return String(code - 0x660);
    if (code >= 0x6f0 && code <= 0x6f9) return String(code - 0x6f0);
    return character;
  });
}

function parseTokenTestNumber(value: string) {
  const normalized = normalizeUnicodeDigits(value.normalize('NFKC')).toLowerCase().replace(/[```*_#]/g, ' ');
  const numericMatch = normalized.match(/(?:^|[^0-9])(10|[1-9])(?:$|[^0-9])/);
  if (numericMatch) return Number(numericMatch[1]);
  for (const [word, number] of Object.entries(TOKEN_WORDS)) {
    if (new RegExp(`(?:^|[^a-z\\u4e00-\\u9fff])${word}(?:$|[^a-z\\u4e00-\\u9fff])`, 'i').test(normalized)) return number;
  }
  return null;
}

export async function generateTokenTestNumber(client: ResponsesClient = getOpenAIResponsesClient()) {
  const response = await client.create({
    model: hasAlibaba ? env.DASHSCOPE_TOKEN_TEST_MODEL : hasGroq ? env.GROQ_TOKEN_TEST_MODEL : configuredModel(),
    instructions: 'Return exactly one ASCII digit from 1 to 10 and nothing else. Valid answers are only 1, 2, 3, 4, 5, 6, 7, 8, 9, or 10. Do not explain, use words, markdown, or punctuation.',
    input: 'Generate one number between 1 and 10 to verify the configured AI token.',
    reasoning: { effort: env.AI_PROVIDER === 'alibaba' || env.AI_PROVIDER === 'groq' ? 'none' : env.OPENAI_REASONING_EFFORT },
    max_output_tokens: 32,
    store: false,
  });
  const number = parseTokenTestNumber(response.output_text);
  if (number === null || number < 1 || number > 10) {
    throw new AppError(502, 'AI_TOKEN_TEST_INVALID', 'The AI provider returned an unusable token-test response. Expected a number from 1 to 10.');
  }
  return { number, model: response.model, responseId: response.id };
}

export function isAiGenerationConfigured() {
  return hasAiProvider;
}
