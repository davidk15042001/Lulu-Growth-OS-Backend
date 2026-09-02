import crypto from 'node:crypto';
import OpenAI from 'openai';
import { env, hasAiProvider, hasAlibaba, hasDeepSeek, hasGroq, hasOpenAI } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../config/logger.js';
import { recordUsage } from '../usage/usage.service.js';
import { assertAiBillingAccess } from '../billing/payg-billing.repo.js';

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
  create(params: Record<string, unknown>, options?: AiRequestOptions): Promise<ResponseResult>;
  createChat(params: Record<string, unknown>, options?: AiRequestOptions): Promise<unknown>;
};

export type AiRequestOptions = {
  timeout?: number;
  maxRetries?: number;
  billing?: { workspaceId: string; userId?: string | null };
};

let openAIClient: OpenAI | undefined;
let alibabaClient: OpenAI | undefined;
let deepSeekClient: OpenAI | undefined;
let groqClient: OpenAI | undefined;

function getConfiguredClient() {
  if (hasOpenAI) {
    openAIClient ??= new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: env.AI_REQUEST_TIMEOUT_MS, maxRetries: env.AI_MAX_RETRIES });
    return openAIClient;
  }
  if (hasAlibaba) {
    alibabaClient ??= new OpenAI({ apiKey: env.DASHSCOPE_API_KEY, baseURL: env.DASHSCOPE_BASE_URL, timeout: env.AI_REQUEST_TIMEOUT_MS, maxRetries: env.AI_MAX_RETRIES });
    return alibabaClient;
  }
  if (hasDeepSeek) {
    deepSeekClient ??= new OpenAI({ apiKey: env.DEEPSEEK_API_KEY, baseURL: env.DEEPSEEK_BASE_URL, timeout: env.AI_REQUEST_TIMEOUT_MS, maxRetries: env.AI_MAX_RETRIES });
    return deepSeekClient;
  }
  if (hasGroq) {
    groqClient ??= new OpenAI({ apiKey: env.GROQ_API_KEY, baseURL: env.GROQ_BASE_URL, timeout: env.AI_REQUEST_TIMEOUT_MS, maxRetries: env.AI_MAX_RETRIES });
    return groqClient;
  }
  throw new AppError(503, 'AI_NOT_CONFIGURED', 'No AI provider is configured');
}

export function configuredModel(requestedModel?: string | null) {
  if (requestedModel) return requestedModel;
  if (hasAlibaba) return env.DASHSCOPE_MODEL;
  if (hasDeepSeek) return env.DEEPSEEK_MODEL;
  if (hasGroq) return env.GROQ_MODEL;
  return env.OPENAI_MODEL;
}

export function getOpenAIResponsesClient(): ResponsesClient {
  if (!hasAiProvider) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'No AI provider is configured');
  }
  const client = getConfiguredClient();
  const providerOptions = (options?: AiRequestOptions) => options
    ? { ...(options.timeout !== undefined ? { timeout: options.timeout } : {}), ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}) }
    : undefined;
  const recordBilledUsage = async (params: Record<string, unknown>, response: any, options?: AiRequestOptions) => {
    if (!options?.billing) return;
    const usage = response?.usage ?? {};
    const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens ?? null;
    const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens ?? null;
    try {
      await recordUsage({
        workspaceId: options.billing.workspaceId,
        userId: options.billing.userId ?? null,
        provider: env.AI_PROVIDER,
        model: String(response?.model ?? params.model ?? configuredModel()),
        inputTokens: typeof inputTokens === 'number' ? inputTokens : null,
        outputTokens: typeof outputTokens === 'number' ? outputTokens : null,
        responseId: typeof response?.id === 'string' ? response.id : null,
      });
    } catch (error) {
      logger.error({ error, workspaceId: options.billing.workspaceId, responseId: response?.id ?? null }, 'AI usage could not be recorded for PAYG billing');
    }
  };
  return {
    create: async (params, options) => {
      if (options?.billing) await assertAiBillingAccess(options.billing.workspaceId, options.billing.userId);
      const response = await client.responses.create(params as never, providerOptions(options) as never) as ResponseResult;
      await recordBilledUsage(params, response, options);
      return response;
    },
    createChat: async (params, options) => {
      if (options?.billing) await assertAiBillingAccess(options.billing.workspaceId, options.billing.userId);
      const response = await client.chat.completions.create(params as never, providerOptions(options) as never);
      await recordBilledUsage(params, response, options);
      return response;
    },
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
    workspaceId?: string;
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
  const response = await client.create(
    request,
    input.workspaceId ? { billing: { workspaceId: input.workspaceId, userId: input.userId } } : undefined,
  );

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
  return hasAiProvider;
}

export async function generateImage(input: {
  prompt: string;
  workspaceId?: string;
  userId?: string;
  size?: string;
}): Promise<{ model: string; b64Json: string | null; url: string | null }> {
  if (!env.OPENAI_API_KEY) {
    throw new AppError(503, 'IMAGE_GENERATION_NOT_CONFIGURED', 'Image generation requires an OpenAI API key (OPENAI_API_KEY)');
  }
  const imageClient = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: env.AI_REQUEST_TIMEOUT_MS, maxRetries: env.AI_MAX_RETRIES });
  const response = (await imageClient.images.generate({
    model: env.IMAGE_MODEL,
    prompt: input.prompt,
    n: 1,
    size: input.size ?? env.IMAGE_SIZE,
  } as never)) as { data?: Array<{ b64_json?: string; url?: string }>; model?: string };
  const image = response.data?.[0];
  if (!image || (!image.b64_json && !image.url)) {
    throw new AppError(502, 'IMAGE_GENERATION_EMPTY', 'The image provider returned no image');
  }
  return { model: response.model ?? env.IMAGE_MODEL, b64Json: image.b64_json ?? null, url: image.url ?? null };
}

export async function describeImage(input: {
  dataUrl: string;
  workspaceId?: string;
  userId?: string;
}): Promise<string> {
  if (!hasAiProvider) return '';
  try {
    const client = getOpenAIResponsesClient();
    const response = await client.createChat(
      {
        model: configuredModel(),
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Extract all readable text from this image and provide a concise description suitable for a business knowledge base.' },
            { type: 'image_url', image_url: { url: input.dataUrl } },
          ],
        }],
        max_tokens: 1000,
      },
      input.workspaceId ? { billing: { workspaceId: input.workspaceId, userId: input.userId ?? null } } : undefined,
    ) as { choices?: Array<{ message?: { content?: string | null } }> };
    return response.choices?.[0]?.message?.content?.trim() ?? '';
  } catch {
    return '';
  }
}

export type AssistantLoopTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: { workspaceId: string; userId: string }) => Promise<unknown>;
  action?: boolean;
};

export type AssistantPendingAction = {
  id: string;
  type: string;
  summary: string;
  payload: Record<string, unknown>;
};

export type AssistantToolCall = {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
};

export type AssistantLoopResult = {
  responseId: string;
  model: string;
  content: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  toolCalls: AssistantToolCall[];
  pendingActions: AssistantPendingAction[];
};

export async function generateAssistantResponseWithTools(
  input: {
    userId: string;
    workspaceId: string;
    context: AssistantContext;
    turns: ConversationTurn[];
    model?: string | null;
    tools: AssistantLoopTool[];
  },
  client: ResponsesClient = getOpenAIResponsesClient()
): Promise<AssistantLoopResult> {
  const model = configuredModel(input.model);
  const instructions = [
    buildAssistantInstructions(input.context),
    'Act autonomously: execute write actions directly when the user asks for them, then report back what you did and what the result was.',
    'After analysis or actions, always give a clear structured report. Use these German sections where relevant: "Was ist passiert", "Gut / Schlecht", "Erledigt", "In Umsetzung", "Nächstes Ziel".',
    'Use markdown tables for tabular data. When numeric data benefits from a chart, add a fenced code block with the language "chart" containing JSON of the form {"type":"bar","title":"...","labels":["..."],"values":[numbers]}.',
  ].join('\n');
  const toolSchemas = input.tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));

  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: instructions },
    ...input.turns.map((turn) => ({ role: turn.role, content: turn.content })),
  ];

  const toolCalls: AssistantToolCall[] = [];
  const pendingActions: AssistantPendingAction[] = [];
  let finalContent = '';
  const usage = { inputTokens: null as number | null, outputTokens: null as number | null };

  for (let step = 0; step < 4; step += 1) {
    const response = (await client.createChat(
      {
        model,
        messages,
        tools: toolSchemas,
        tool_choice: 'auto',
        max_tokens: env.OPENAI_MAX_OUTPUT_TOKENS,
      },
      { billing: { workspaceId: input.workspaceId, userId: input.userId } },
    )) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const message = response.choices?.[0]?.message;
    const content = (message?.content ?? '').trim();
    if (content) finalContent = content;
    usage.inputTokens = response.usage?.prompt_tokens ?? null;
    usage.outputTokens = response.usage?.completion_tokens ?? null;

    const calls = message?.tool_calls ?? [];
    if (calls.length === 0) break;

    messages.push({ role: 'assistant', content: content || null, tool_calls: calls });

    for (const call of calls) {
      const name = String(call.function?.name ?? '');
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(String(call.function?.arguments ?? '{}')); } catch { args = {}; }

      const tool = input.tools.find((candidate) => candidate.name === name);
      if (!tool) {
        messages.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify({ error: `Unknown tool: ${name}` }) });
        continue;
      }

      const result = await tool.handler(args, { workspaceId: input.workspaceId, userId: input.userId });
      toolCalls.push({ name, args, result });

      if (tool.action) {
        pendingActions.push(result as AssistantPendingAction);
        messages.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify({ status: 'pending_approval', actionId: (result as AssistantPendingAction).id }) });
      } else {
        messages.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(result) });
      }
    }
  }

  if (!finalContent) {
    throw new AppError(502, 'AI_EMPTY_RESPONSE', 'The AI provider returned an empty response');
  }

  return { responseId: '', model, content: finalContent, usage, toolCalls, pendingActions };
}
