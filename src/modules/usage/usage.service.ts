import { query } from '../../db/pool.js';
import { env } from '../../config/env.js';

export const TOKENS_PER_CREDIT = 1_000;
export const CUSTOMER_MARKUP_MULTIPLIER = 3;

type UsageInput = {
  workspaceId: string;
  userId: string;
  provider: string;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  responseId?: string | null;
};

type Rate = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
};

const DEFAULT_RATE: Rate = { inputPerMillionUsd: 0, outputPerMillionUsd: 0 };

function rateFor(provider: string, model: string): Rate {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModel = model.toLowerCase();

  if (normalizedProvider === 'alibaba' && normalizedModel.includes('qwen3.8-max')) {
    return { inputPerMillionUsd: 2, outputPerMillionUsd: 6 };
  }

  // The ledger remains complete for other providers. Their rates can be added
  // as explicit configuration later without changing the accounting schema.
  return DEFAULT_RATE;
}

function nonNegativeInteger(value: number | null | undefined) {
  return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : 0;
}

export function calculateUsageCost(input: Pick<UsageInput, 'provider' | 'model' | 'inputTokens' | 'outputTokens'>) {
  const inputTokens = nonNegativeInteger(input.inputTokens);
  const outputTokens = nonNegativeInteger(input.outputTokens);
  const rate = rateFor(input.provider, input.model);
  const providerCostUsd = (inputTokens / 1_000_000) * rate.inputPerMillionUsd
    + (outputTokens / 1_000_000) * rate.outputPerMillionUsd;
  const customerCostUsd = providerCostUsd * CUSTOMER_MARKUP_MULTIPLIER;
  const totalTokens = inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    credits: totalTokens / TOKENS_PER_CREDIT,
    providerCostUsd,
    customerCostUsd,
    rate,
  };
}

export async function recordUsage(input: UsageInput) {
  const calculated = calculateUsageCost(input);
  if (calculated.totalTokens === 0) return null;

  const { rows } = await query(
    `INSERT INTO ai_usage_ledger (
       workspace_id, user_id, provider, model, input_tokens, output_tokens,
       provider_cost_usd, customer_cost_usd, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, created_at AS "createdAt"`,
    [
      input.workspaceId,
      input.userId,
      input.provider,
      input.model,
      calculated.inputTokens,
      calculated.outputTokens,
      calculated.providerCostUsd,
      calculated.customerCostUsd,
      { responseId: input.responseId ?? null },
    ],
  );

  return { ...calculated, id: rows[0]?.id ?? null, createdAt: rows[0]?.createdAt ?? null };
}

export async function getWorkspaceCredits(workspaceId: string) {
  const { rows } = await query<{
    inputTokens: string;
    outputTokens: string;
    totalTokens: string;
    credits: string;
    providerCostUsd: string;
    customerCostUsd: string;
  }>(
    `SELECT
       COALESCE(SUM(input_tokens), 0)::bigint AS "inputTokens",
       COALESCE(SUM(output_tokens), 0)::bigint AS "outputTokens",
       COALESCE(SUM(total_tokens), 0)::bigint AS "totalTokens",
       COALESCE(SUM(credits), 0)::numeric AS credits,
       COALESCE(SUM(provider_cost_usd), 0)::numeric AS "providerCostUsd",
       COALESCE(SUM(customer_cost_usd), 0)::numeric AS "customerCostUsd"
     FROM ai_usage_ledger
     WHERE workspace_id = $1
       AND created_at >= date_trunc('month', NOW())
       AND created_at < date_trunc('month', NOW()) + INTERVAL '1 month'`,
    [workspaceId],
  );

  const row = rows[0] ?? {
    inputTokens: '0', outputTokens: '0', totalTokens: '0', credits: '0',
    providerCostUsd: '0', customerCostUsd: '0',
  };
  return {
    period: new Date().toISOString().slice(0, 7),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    totalTokens: Number(row.totalTokens),
    creditsUsed: Number(row.credits),
    providerCostUsd: Number(row.providerCostUsd),
    customerCostUsd: Number(row.customerCostUsd),
    tokensPerCredit: TOKENS_PER_CREDIT,
    customerMarkupMultiplier: CUSTOMER_MARKUP_MULTIPLIER,
    model: env.DASHSCOPE_MODEL,
    pricing: {
      inputPerMillionUsd: rateFor('alibaba', 'qwen3.8-max').inputPerMillionUsd,
      outputPerMillionUsd: rateFor('alibaba', 'qwen3.8-max').outputPerMillionUsd,
    },
  };
}
