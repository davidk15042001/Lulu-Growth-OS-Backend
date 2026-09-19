import crypto from 'node:crypto';
import OpenAI from 'openai';
import type { AssistantPendingAction } from './assistant-action.types.js';
import { env, hasAiProvider, hasAlibaba, hasGroq, hasKie, hasOpenAI, hasPerplexity } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import { logger } from '../../config/logger.js';
import { CUSTOMER_API_RATE, recordUsage } from '../usage/usage.service.js';
import {
  fingerprintAiRequest,
  markAiSpendAmbiguous,
  markAiSpendSubmitted,
  markAiSpendSubmitting,
  releaseAiSpend,
  reserveAiSpend,
} from '../api-wallet/ai-spend-reservation.repo.js';
import type { AiFundingMode } from '../api-wallet/ai-funding-policy.js';

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
  /** Explicit provider override for a specialised, user-requested operation. */
  provider?: AiProviderName;
  billing?: {
    workspaceId: string;
    userId?: string | null;
    /** Stable business-operation identity. Worker retries must reuse it. */
    operationId?: string;
    operation?: string;
  };
};

let openAIClient: OpenAI | undefined;
let alibabaClient: OpenAI | undefined;
let groqClient: OpenAI | undefined;
let kieClient: OpenAI | undefined;
let perplexityClient: OpenAI | undefined;

export type AiProviderName = 'openai' | 'alibaba' | 'groq' | 'kie' | 'perplexity';

type ProviderCircuitState = {
  failures: number;
  blockedUntil: number;
  lastError: string | null;
  lastFailureStatus: number | null;
  lastFailureCategory: AiProviderFailureCategory;
  lastFailureAt: number;
};

export type AiProviderFailureCategory =
  | 'authentication'
  | 'insufficient_balance'
  | 'model_unavailable'
  | 'rate_limited'
  | 'timeout'
  | 'upstream'
  | 'network'
  | 'request'
  | 'unknown';

const providerCircuits = new Map<AiProviderName, ProviderCircuitState>();

function providerConfigured(provider: AiProviderName) {
  if (provider === 'openai') return hasOpenAI;
  if (provider === 'alibaba') return hasAlibaba;
  if (provider === 'groq') return hasGroq;
  if (provider === 'kie') return hasKie;
  return hasPerplexity;
}

function configuredProviders() {
  const allowed = new Set<AiProviderName>(['openai', 'alibaba', 'groq', 'kie', 'perplexity']);
  const fallback = env.AI_PROVIDER_FALLBACK_ORDER
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is AiProviderName => allowed.has(value as AiProviderName));
  // Do not silently route text/agent work through a premium media provider.
  // Fallbacks must be explicit in deployment configuration so billing and
  // provider selection remain predictable.
  return Array.from(new Set<AiProviderName>([env.AI_PROVIDER, ...fallback])).filter(providerConfigured);
}

function getProviderClient(provider: AiProviderName) {
  if (provider === 'openai' && hasOpenAI) {
    openAIClient ??= new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: env.AI_REQUEST_TIMEOUT_MS, maxRetries: env.AI_MAX_RETRIES });
    return openAIClient;
  }
  if (provider === 'alibaba' && hasAlibaba) {
    alibabaClient ??= new OpenAI({ apiKey: env.DASHSCOPE_API_KEY, baseURL: env.DASHSCOPE_BASE_URL, timeout: env.AI_REQUEST_TIMEOUT_MS, maxRetries: env.AI_MAX_RETRIES });
    return alibabaClient;
  }
  if (provider === 'groq' && hasGroq) {
    groqClient ??= new OpenAI({ apiKey: env.GROQ_API_KEY, baseURL: env.GROQ_BASE_URL, timeout: env.AI_REQUEST_TIMEOUT_MS, maxRetries: env.AI_MAX_RETRIES });
    return groqClient;
  }
  if (provider === 'kie' && hasKie) {
    const compatiblePath=env.KIE_QUALITY_MODEL_PATH.replace(/\/chat\/completions$/,'');
    const baseURL=new URL(compatiblePath,`${env.KIE_BASE_URL.replace(/\/$/,'')}/`).toString().replace(/\/$/,'');
    kieClient ??= new OpenAI({apiKey:env.KIE_API_KEY,baseURL,timeout:env.AI_REQUEST_TIMEOUT_MS,maxRetries:env.AI_MAX_RETRIES});
    return kieClient;
  }
  if (provider === 'perplexity' && hasPerplexity) {
    perplexityClient ??= new OpenAI({ apiKey: env.PERPLEXITY_API_KEY, baseURL: env.PERPLEXITY_BASE_URL, timeout: env.AI_REQUEST_TIMEOUT_MS, maxRetries: env.AI_MAX_RETRIES });
    return perplexityClient;
  }
  throw new AppError(503, 'AI_PROVIDER_NOT_CONFIGURED', `AI provider ${provider} is not configured`);
}

function modelForProvider(provider: AiProviderName) {
  if (provider === 'openai') return env.OPENAI_MODEL;
  if (provider === 'alibaba') return env.DASHSCOPE_MODEL;
  if (provider === 'groq') return env.GROQ_MODEL;
  if (provider === 'kie') return env.KIE_QUALITY_MODEL;
  return env.PERPLEXITY_MODEL;
}

function providerErrorStatus(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  const value = candidate.status ?? candidate.statusCode;
  return typeof value === 'number' ? value : typeof value === 'string' ? Number(value) || null : null;
}

export function isAiProviderFailoverError(error: unknown) {
  const status = providerErrorStatus(error);
  if (
    status === 400
    || status === 401
    || status === 402
    || status === 403
    || status === 404
    || status === 408
    || status === 409
    || status === 422
    || status === 429
    || (status !== null && status >= 500)
  ) return true;
  if (!error || typeof error !== 'object') return false;
  const candidate=error as {code?:unknown;name?:unknown};
  const code = String(candidate.code ?? candidate.name ?? '').replaceAll(/[^A-Z0-9]/gi,'_').toUpperCase();
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'API_CONNECTION_ERROR', 'APICONNECTIONERROR'].includes(code);
}

export function classifyAiProviderFailure(error: unknown): AiProviderFailureCategory {
  const status = providerErrorStatus(error);
  if (status === 401 || status === 403) return 'authentication';
  if (status === 402) return 'insufficient_balance';
  if (status === 404 || status === 409) return 'model_unavailable';
  if (status === 429) return 'rate_limited';
  if (status === 408) return 'timeout';
  if (status !== null && status >= 500) return 'upstream';
  if (status === 400 || status === 422) return 'request';
  if (!error || typeof error !== 'object') return 'unknown';
  const candidate = error as { code?: unknown; name?: unknown };
  const code = String(candidate.code ?? candidate.name ?? '').replaceAll(/[^A-Z0-9]/gi, '_').toUpperCase();
  if (code === 'ETIMEDOUT') return 'timeout';
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'API_CONNECTION_ERROR', 'APICONNECTIONERROR'].includes(code)) return 'network';
  return 'unknown';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

function circuitIsOpen(provider: AiProviderName) {
  return (providerCircuits.get(provider)?.blockedUntil ?? 0) > Date.now();
}

function providerHasBlockingFailure(provider: AiProviderName) {
  const category = providerCircuits.get(provider)?.lastFailureCategory;
  return category === 'authentication' || category === 'insufficient_balance' || category === 'model_unavailable';
}

function markProviderFailure(provider: AiProviderName, error: unknown) {
  const prior = providerCircuits.get(provider) ?? {
    failures: 0,
    blockedUntil: 0,
    lastError: null,
    lastFailureStatus: null,
    lastFailureCategory: 'unknown' as const,
    lastFailureAt: 0,
  };
  const failures = prior.failures + 1;
  const status = providerErrorStatus(error);
  const immediate = status === 401 || status === 402 || status === 403 || status === 404;
  providerCircuits.set(provider, {
    failures,
    blockedUntil: immediate || failures >= 2 ? Date.now() + env.AI_CIRCUIT_BREAKER_COOLDOWN_MS : 0,
    lastError: errorMessage(error),
    lastFailureStatus: status,
    lastFailureCategory: classifyAiProviderFailure(error),
    lastFailureAt: Date.now(),
  });
}

function markProviderSuccess(provider: AiProviderName) {
  providerCircuits.delete(provider);
}

function responsesInputToMessages(params: Record<string, unknown>) {
  const messages: Array<Record<string, unknown>> = [];
  if (typeof params.instructions === 'string' && params.instructions.trim()) {
    messages.push({ role: 'system', content: params.instructions });
  }
  if (Array.isArray(params.input)) {
    messages.push(...params.input.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)));
  } else if (typeof params.input === 'string') {
    messages.push({ role: 'user', content: params.input });
  }
  return messages;
}

function chatParamsForProvider(params:Record<string,unknown>,provider:AiProviderName,model:string){
  const next:Record<string,unknown>={...params,model};
  if(provider==='openai'){
    delete next.thinking;
    if(model.startsWith('gpt-5')&&typeof next.max_tokens==='number'&&next.max_completion_tokens===undefined){
      next.max_completion_tokens=next.max_tokens;
      delete next.max_tokens;
    }
    return next;
  }
  delete next.safety_identifier;
  delete next.reasoning;
  delete next.reasoning_effort;
  delete next.thinking;
  if(typeof next.max_completion_tokens==='number'&&next.max_tokens===undefined)next.max_tokens=next.max_completion_tokens;
  delete next.max_completion_tokens;
  return next;
}

async function executeWithFailover<T>(operation: (provider: AiProviderName, client: OpenAI) => Promise<T>) {
  const providers = configuredProviders();
  if (providers.length === 0) throw new AppError(503, 'AI_NOT_CONFIGURED', 'No AI provider is configured');
  const eligible = providers.filter((provider) => !circuitIsOpen(provider));
  if(eligible.length===0)throw new AppError(503,'AI_PROVIDER_CIRCUITS_OPEN','All configured AI providers are cooling down after transient failures.',{providers:getAiProviderHealth().filter(provider=>provider.configured)});
  const attempts = eligible;
  const failures: Array<{ provider: AiProviderName; status: number | null; message: string }> = [];
  for (const provider of attempts) {
    try {
      const result = await operation(provider, getProviderClient(provider));
      markProviderSuccess(provider);
      return { provider, result };
    } catch (error) {
      failures.push({ provider, status: providerErrorStatus(error), message: errorMessage(error) });
      const failOver=isAiProviderFailoverError(error);
      if(failOver)markProviderFailure(provider,error);
      logger.warn({ provider, status: providerErrorStatus(error), error }, 'AI provider request failed');
      if (!failOver) throw error;
    }
  }
  throw new AppError(503, 'AI_PROVIDERS_UNAVAILABLE', 'All configured AI providers are temporarily unavailable', { failures });
}

export function configuredModel(requestedModel?: string | null) {
  if (requestedModel) return requestedModel;
  return modelForProvider(env.AI_PROVIDER);
}

export function getAiProviderHealth() {
  return (['openai', 'alibaba', 'groq', 'kie', 'perplexity'] as const).map((provider) => {
    const state = providerCircuits.get(provider);
    const operational = providerConfigured(provider) && !circuitIsOpen(provider) && !providerHasBlockingFailure(provider);
    return {
      provider,
      primary: provider === env.AI_PROVIDER,
      configured: providerConfigured(provider),
      available: operational,
      operational,
      circuitOpenUntil: state?.blockedUntil ? new Date(state.blockedUntil).toISOString() : null,
      consecutiveFailures: state?.failures ?? 0,
      lastFailureStatus: state?.lastFailureStatus ?? null,
      lastFailureCategory: state?.lastFailureCategory ?? null,
      lastFailureAt: state?.lastFailureAt ? new Date(state.lastFailureAt).toISOString() : null,
      lastError: state?.lastError ?? null,
    };
  });
}

/**
 * Performs one minimal completion at process start. Listing models proves that
 * a key exists, but does not prove that the account can actually execute a
 * billed request. Failures populate the same circuit state used by readiness
 * and normal failover, so production can never advertise a known-broken AI
 * runtime as ready.
 */
export async function probeAiRuntime() {
  const { provider } = await executeWithFailover((candidate, client) => client.chat.completions.create({
    model: modelForProvider(candidate),
    messages: [{ role: 'user', content: 'Reply only: OK' }],
    max_tokens: 2,
  } as never, { timeout: 10_000, maxRetries: 0 } as never));
  return { provider, operational: true };
}

function boundedOutputLimit(params: Record<string, unknown>, kind: 'responses' | 'chat') {
  const requested = kind === 'responses'
    ? params.max_output_tokens
    : params.max_completion_tokens ?? params.max_tokens;
  const numeric = typeof requested === 'number' && Number.isFinite(requested) ? Math.floor(requested) : env.OPENAI_MAX_OUTPUT_TOKENS;
  return Math.max(1, Math.min(env.OPENAI_MAX_OUTPUT_TOKENS, numeric));
}

function boundedAiParams(params: Record<string, unknown>, kind: 'responses' | 'chat'): {
  params: Record<string, unknown>;
  maximumOutputTokens: number;
} {
  const maximumOutputTokens = boundedOutputLimit(params, kind);
  if (kind === 'responses') return { params: { ...params, max_output_tokens: maximumOutputTokens }, maximumOutputTokens };
  if (params.max_completion_tokens !== undefined) {
    return { params: { ...params, max_completion_tokens: maximumOutputTokens, max_tokens: undefined }, maximumOutputTokens };
  }
  return { params: { ...params, max_tokens: maximumOutputTokens }, maximumOutputTokens };
}

function reservationEstimate(params: Record<string, unknown>, maximumOutputTokens: number) {
  // A BPE token cannot contain less than one source byte. Counting every UTF-8
  // byte as a token plus framing headroom is intentionally conservative and is
  // independent of whichever configured provider ultimately serves the call.
  const maximumInputTokens = Buffer.byteLength(JSON.stringify(params), 'utf8') + 2_048;
  const maximumCustomerCostUsd = (
    maximumInputTokens * CUSTOMER_API_RATE.inputPerMillionUsd
    + maximumOutputTokens * CUSTOMER_API_RATE.outputPerMillionUsd
  ) / 1_000_000;
  return { maximumInputTokens, maximumOutputTokens, maximumCustomerCostUsd };
}

function reservationKey(options: AiRequestOptions, operation: string) {
  const identity = options.billing?.operationId?.trim() || crypto.randomUUID();
  const digest = crypto.createHash('sha256').update(identity).digest('hex');
  return `ai:${operation.slice(0, 80)}:${digest}`;
}

function definitiveProviderRejection(error: unknown) {
  return ['authentication', 'insufficient_balance', 'model_unavailable', 'rate_limited', 'request']
    .includes(classifyAiProviderFailure(error));
}

export function getOpenAIResponsesClient(): ResponsesClient {
  if (!hasAiProvider) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'No AI provider is configured');
  }
  const providerOptions = (options?: AiRequestOptions, prepaid = false) => options
    ? {
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(prepaid ? { maxRetries: 0 } : options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
      }
    : prepaid ? { maxRetries: 0 } : undefined;

  const recordBilledUsage = async (
    provider: AiProviderName,
    params: Record<string, unknown>,
    response: any,
    options?: AiRequestOptions,
    reservationId?: string | null,
    fundingMode?: AiFundingMode,
  ) => {
    if (!options?.billing) return null;
    const usage = response?.usage ?? {};
    const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens ?? null;
    const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens ?? null;
    const responseId = typeof response?.id === 'string' && response.id.trim() ? response.id.trim() : null;
    if (reservationId && (!responseId || (!Number.isFinite(inputTokens) && !Number.isFinite(outputTokens)))) {
      throw new AppError(503, 'AI_USAGE_PENDING', 'The provider response cannot yet be reconciled to exact prepaid usage.');
    }
    return recordUsage({
      workspaceId: options.billing.workspaceId,
      userId: options.billing.userId ?? null,
      provider,
      model: String(response?.model ?? params.model ?? configuredModel()),
      inputTokens: typeof inputTokens === 'number' ? inputTokens : null,
      outputTokens: typeof outputTokens === 'number' ? outputTokens : null,
      responseId,
      reservationId: reservationId ?? null,
      ...(fundingMode ? { fundingMode } : {}),
    });
  };

  const execute = async (
    kind: 'responses' | 'chat',
    rawParams: Record<string, unknown>,
    options?: AiRequestOptions,
  ): Promise<any> => {
    const bounded = boundedAiParams(rawParams, kind);
    const requestedProvider = options?.provider;
    if (requestedProvider && !providerConfigured(requestedProvider)) {
      throw new AppError(503, 'AI_PROVIDER_NOT_CONFIGURED', `AI provider ${requestedProvider} is not configured`);
    }
    const attemptedModel = String(bounded.params.model ?? (requestedProvider ? modelForProvider(requestedProvider) : configuredModel()));
    const providers = (requestedProvider ? [requestedProvider] : configuredProviders()).filter((provider) => !circuitIsOpen(provider));
    if (!providers.length) {
      throw new AppError(503, 'AI_PROVIDER_CIRCUITS_OPEN', 'All configured AI providers are unavailable or cooling down.');
    }

    const callProvider = async (provider: AiProviderName, prepaid: boolean) => {
      const client = getProviderClient(provider);
      const model = provider === env.AI_PROVIDER ? attemptedModel : modelForProvider(provider);
      if (kind === 'responses') {
        const providerParams = { ...bounded.params, model };
        if (provider === 'openai') {
          return client.responses.create(providerParams as never, providerOptions(options, prepaid) as never) as Promise<ResponseResult>;
        }
        const chat = await client.chat.completions.create({
          model,
          messages: responsesInputToMessages(providerParams),
          max_tokens: bounded.maximumOutputTokens,
        } as never, providerOptions(options, prepaid) as never) as any;
        return {
          id: String(chat.id ?? ''),
          model: String(chat.model ?? model),
          output_text: String(chat.choices?.[0]?.message?.content ?? ''),
          usage: { input_tokens: chat.usage?.prompt_tokens, output_tokens: chat.usage?.completion_tokens },
        } satisfies ResponseResult;
      }
      return client.chat.completions.create(
        chatParamsForProvider(bounded.params, provider, model) as never,
        providerOptions(options, prepaid) as never,
      );
    };

    if (!options?.billing) {
      if (requestedProvider) {
        const result = await callProvider(requestedProvider, false);
        markProviderSuccess(requestedProvider);
        return { provider: requestedProvider, response: result, params: bounded.params };
      }
      const { provider, result } = await executeWithFailover((candidate) => callProvider(candidate, false));
      return { provider, response: result, params: bounded.params };
    }

    const operation = options.billing.operation?.trim() || (kind === 'responses' ? 'responses.create' : 'chat.completions.create');
    const estimate = reservationEstimate(bounded.params, bounded.maximumOutputTokens);
    const selectedProvider = providers[0]!;
    const selectedModel = selectedProvider === env.AI_PROVIDER || requestedProvider ? attemptedModel : modelForProvider(selectedProvider);
    const requestKey = reservationKey(options, operation);
    const reserved = await reserveAiSpend({
      workspaceId: options.billing.workspaceId,
      userId: options.billing.userId ?? null,
      requestKey,
      requestFingerprint: fingerprintAiRequest({ kind, operation, params: bounded.params }),
      operation,
      maximumCustomerCostUsd: estimate.maximumCustomerCostUsd,
      usdCnyRate: env.API_USD_CNY_RATE,
      pricingSnapshot: { ...estimate, customerRate: CUSTOMER_API_RATE, method: 'utf8-byte-upper-bound-v1' },
      provider: selectedProvider,
      model: selectedModel,
    });

    if (reserved.funding.mode === 'PLATFORM_FUNDED') {
      if (requestedProvider) {
        const result = await callProvider(requestedProvider, false);
        await recordBilledUsage(requestedProvider, bounded.params, result, options, null, 'PLATFORM_FUNDED');
        return { provider: requestedProvider, response: result, params: bounded.params };
      }
      const { provider, result } = await executeWithFailover((candidate) => callProvider(candidate, false));
      await recordBilledUsage(provider, bounded.params, result, options, null, 'PLATFORM_FUNDED');
      return { provider, response: result, params: bounded.params };
    }

    const reservation = reserved.reservation;
    if (!reservation) throw new AppError(500, 'AI_RESERVATION_MISSING', 'Customer-funded AI execution requires a durable wallet reservation.');
    if (reservation.status !== 'RESERVED') {
      throw new AppError(409, 'AI_REQUEST_RECOVERY_REQUIRED', 'This AI operation already has an unresolved or completed provider submission.', {
        reservationId: reservation.id,
        status: reservation.status,
      });
    }
    const submitting = await markAiSpendSubmitting(options.billing.workspaceId, reservation.id);
    if (!submitting) throw new AppError(409, 'AI_REQUEST_RECOVERY_REQUIRED', 'The AI operation is already being processed.');

    let response: any;
    try {
      response = await callProvider(selectedProvider, true);
      markProviderSuccess(selectedProvider);
    } catch (error) {
      markProviderFailure(selectedProvider, error);
      if (definitiveProviderRejection(error)) {
        await releaseAiSpend({ workspaceId: options.billing.workspaceId, reservationId: reservation.id,
          disposition: 'DEFINITIVE_REJECTION', reason: `provider_rejected:${classifyAiProviderFailure(error)}` })
          .catch((releaseError) => logger.error({ releaseError, reservationId: reservation.id }, 'AI reservation release failed after definitive provider rejection'));
      } else {
        await markAiSpendAmbiguous(options.billing.workspaceId, reservation.id, `provider_outcome_unknown:${classifyAiProviderFailure(error)}`)
          .catch((markError) => logger.error({ markError, reservationId: reservation.id }, 'AI reservation ambiguity could not be persisted'));
      }
      throw error;
    }

    const providerRequestId = typeof response?.id === 'string' ? response.id.trim() : '';
    if (!providerRequestId) {
      await markAiSpendAmbiguous(options.billing.workspaceId, reservation.id, 'provider_response_id_missing');
      throw new AppError(503, 'AI_PROVIDER_RESULT_UNRECONCILABLE', 'The AI provider result did not contain a durable response identifier.');
    }
    try {
      const submitted = await markAiSpendSubmitted({
        workspaceId: options.billing.workspaceId,
        reservationId: reservation.id,
        provider: selectedProvider,
        model: String(response?.model ?? selectedModel),
        providerRequestId,
      });
      if (!submitted) {
        throw new AppError(409, 'AI_PROVIDER_RESULT_CONFLICT', 'The provider result conflicts with the durable AI reservation.');
      }
    } catch (error) {
      await markAiSpendAmbiguous(options.billing.workspaceId, reservation.id, `provider_result_persistence_pending:${errorMessage(error)}`)
        .catch((markError) => logger.error({ markError, reservationId: reservation.id }, 'AI reservation ambiguity could not be persisted'));
      throw error;
    }
    try {
      await recordBilledUsage(selectedProvider, bounded.params, response, options, reservation.id, 'CUSTOMER_PREPAID');
    } catch (error) {
      await markAiSpendAmbiguous(options.billing.workspaceId, reservation.id, `usage_settlement_pending:${errorMessage(error)}`)
        .catch((markError) => logger.error({ markError, reservationId: reservation.id }, 'AI usage settlement ambiguity could not be persisted'));
      throw error;
    }
    return { provider: selectedProvider, response, params: bounded.params };
  };

  return {
    create: async (params, options) => (await execute('responses', params, options)).response as ResponseResult,
    createChat: async (params, options) => (await execute('chat', params, options)).response,
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
    'Execute permitted actions autonomously. Paid media requires both prepaid funds and an active customer authorization for the exact provider account, campaign, currency, period and amount.',
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

export type { AssistantPendingAction } from './assistant-action.types.js';

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
  const loopOperationId = crypto.randomUUID();
  const model = configuredModel(input.model);
  const instructions = [
    buildAssistantInstructions(input.context),
    'Act within the backend policy: request write actions only when the user explicitly asks. Agent actions do not wait for routine human approval; paid media can execute only against funded budget and a campaign-specific customer authorization. Draft actions create drafts and never imply that a message was sent. Never claim success before the tool result confirms it.',
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
      { billing: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        operation: 'assistant.tool-loop',
        operationId: `${loopOperationId}:step:${step}`,
      } },
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
        const actionResult = result as Partial<AssistantPendingAction>;
        if (actionResult.id && ['pending_approval', 'ready', 'executing'].includes(String(actionResult.status))) {
          pendingActions.push(actionResult as AssistantPendingAction);
        }
        messages.push({ role: 'tool', tool_call_id: call.id, name, content: JSON.stringify(result) });
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
