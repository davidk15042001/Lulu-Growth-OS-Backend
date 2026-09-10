import { query } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { debitApiWallet, isApiWalletMeteredWorkspace } from '../api-wallet/api-wallet.repo.js';

export const TOKENS_PER_CREDIT = 1_000;
export const CUSTOMER_API_RATE: Rate = {
  inputPerMillionUsd: 5,
  outputPerMillionUsd: 10,
};

type UsageInput = {
  workspaceId: string;
  userId?: string | null;
  provider: string;
  model: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  responseId?: string | null;
};

type MeteredUsageInput = {
  workspaceId: string;
  userId?: string | null;
  provider: string;
  model: string;
  providerCostUsd: number;
  customerCostUsd?: number;
  responseId: string;
  metadata?: Record<string, unknown>;
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

  if (normalizedProvider === 'alibaba' && normalizedModel.includes('qwen3.7-plus')) {
    return { inputPerMillionUsd: 0.4, outputPerMillionUsd: 1.6 };
  }

  if (normalizedProvider === 'alibaba' && normalizedModel.includes('deepseek-v4-pro')) {
    return { inputPerMillionUsd: 1.65, outputPerMillionUsd: 3.301 };
  }

  if (normalizedProvider === 'alibaba' && normalizedModel.includes('deepseek-v4-flash')) {
    return { inputPerMillionUsd: 0.18, outputPerMillionUsd: 0.72 };
  }

  if (normalizedProvider === 'alibaba' && normalizedModel.includes('deepseek-v3.2')) {
    return { inputPerMillionUsd: 0.28, outputPerMillionUsd: 1.1 };
  }

  if (normalizedProvider === 'deepseek' && normalizedModel.includes('deepseek-v4-pro')) {
    return { inputPerMillionUsd: 1.32, outputPerMillionUsd: 3.96 };
  }

  if (normalizedProvider === 'deepseek' && normalizedModel.includes('deepseek-v4-flash')) {
    return { inputPerMillionUsd: 0.44, outputPerMillionUsd: 1.32 };
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
  const providerRate = rateFor(input.provider, input.model);
  const providerCostUsd = (inputTokens / 1_000_000) * providerRate.inputPerMillionUsd
    + (outputTokens / 1_000_000) * providerRate.outputPerMillionUsd;
  const customerCostUsd = (inputTokens / 1_000_000) * CUSTOMER_API_RATE.inputPerMillionUsd
    + (outputTokens / 1_000_000) * CUSTOMER_API_RATE.outputPerMillionUsd;
  const totalTokens = inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    credits: totalTokens / TOKENS_PER_CREDIT,
    providerCostUsd,
    customerCostUsd,
    rate: providerRate,
    customerRate: CUSTOMER_API_RATE,
  };
}

export async function recordUsage(input: UsageInput) {
  const calculated = calculateUsageCost(input);
  if (calculated.totalTokens === 0) return null;

  const responseId = input.responseId?.trim() || null;
  const { rows } = await query<{ id: string; createdAt: string }>(
    `INSERT INTO ai_usage_ledger (
       workspace_id, user_id, provider, model, input_tokens, output_tokens,
       provider_cost_usd, customer_cost_usd, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING id, created_at AS "createdAt"`,
    [
      input.workspaceId,
      input.userId ?? null,
      input.provider,
      input.model,
      calculated.inputTokens,
      calculated.outputTokens,
      calculated.providerCostUsd,
      calculated.customerCostUsd,
      { responseId },
    ],
  );
  if (rows[0]) {
    if (await isApiWalletMeteredWorkspace(input.workspaceId)) await debitApiWallet({ workspaceId: input.workspaceId, usageLedgerId: rows[0].id, customerCostUsd: calculated.customerCostUsd, responseId: responseId ?? rows[0].id, usdCnyRate: env.API_USD_CNY_RATE });
    return { ...calculated, id: rows[0].id, createdAt: rows[0].createdAt };
  }

  // A provider retry with the same response ID is already accounted for. Read
  // the existing append-only entry so callers get a deterministic result.
  if (responseId) {
    const existing = await query<{ id: string; createdAt: string }>(
      `SELECT id, created_at AS "createdAt"
         FROM ai_usage_ledger
        WHERE workspace_id=$1 AND metadata->>'responseId'=$2
        LIMIT 1`,
      [input.workspaceId, responseId],
    );
    if (existing.rows[0]) return { ...calculated, id: existing.rows[0].id, createdAt: existing.rows[0].createdAt };
  }
  return { ...calculated, id: null, createdAt: null };
}

/** Records non-token provider usage such as image/video generation. The same
 * append-only ledger powers weekly PAYG invoicing, while responseId makes
 * webhook retries and worker polling exactly-once for billing purposes. */
export async function recordMeteredUsage(input: MeteredUsageInput) {
  const providerCostUsd = Number.isFinite(input.providerCostUsd) && input.providerCostUsd > 0
    ? input.providerCostUsd
    : 0;
  const customerCostUsd = Number.isFinite(input.customerCostUsd) && Number(input.customerCostUsd) >= 0
    ? Number(input.customerCostUsd)
    : providerCostUsd;
  const responseId = input.responseId.trim();
  if (!responseId) throw new Error('Metered usage requires a responseId');

  const metadata = { ...(input.metadata ?? {}), responseId, metering: 'provider_cost' };
  const { rows } = await query<{ id: string; createdAt: string }>(
    `INSERT INTO ai_usage_ledger (
       workspace_id, user_id, provider, model, input_tokens, output_tokens,
       provider_cost_usd, customer_cost_usd, metadata
     ) VALUES ($1,$2,$3,$4,0,0,$5,$6,$7::jsonb)
     ON CONFLICT DO NOTHING
     RETURNING id, created_at AS "createdAt"`,
    [
      input.workspaceId,
      input.userId ?? null,
      input.provider,
      input.model,
      providerCostUsd,
      customerCostUsd,
      JSON.stringify(metadata),
    ],
  );
  if (rows[0]) {
    if (await isApiWalletMeteredWorkspace(input.workspaceId)) await debitApiWallet({ workspaceId: input.workspaceId, usageLedgerId: rows[0].id, customerCostUsd, responseId, usdCnyRate: env.API_USD_CNY_RATE });
    return { id: rows[0].id, createdAt: rows[0].createdAt, providerCostUsd, customerCostUsd };
  }

  const existing = await query<{ id: string; createdAt: string }>(
    `SELECT id, created_at AS "createdAt" FROM ai_usage_ledger
      WHERE workspace_id=$1 AND metadata->>'responseId'=$2 LIMIT 1`,
    [input.workspaceId, responseId],
  );
  return existing.rows[0]
    ? { id: existing.rows[0].id, createdAt: existing.rows[0].createdAt, providerCostUsd, customerCostUsd }
    : null;
}

export async function getWorkspaceCredits(workspaceId: string) {
  const { rows } = await query<{
    inputTokens: string;
    outputTokens: string;
    totalTokens: string;
    credits: string;
    providerCostUsd: string;
    customerCostUsd: string;
    periodStart: string;
    periodEnd: string;
  }>(
    `WITH subscription_period AS (
       SELECT
         p.current_period_start AS period_start,
         p.current_period_end AS period_end
       FROM workspace_payg_profiles p
       WHERE p.workspace_id = $1
       UNION ALL
       SELECT
         COALESCE(s.current_period_starts_at, s.created_at) AS period_start,
         COALESCE(s.current_period_ends_at, COALESCE(s.current_period_starts_at, s.created_at) + INTERVAL '1 year') AS period_end
       FROM workspace_subscriptions s
       WHERE s.workspace_id = $1
         AND NOT EXISTS (SELECT 1 FROM workspace_payg_profiles p WHERE p.workspace_id=$1)
       LIMIT 1
     )
     SELECT
       COALESCE(SUM(u.input_tokens), 0)::bigint AS "inputTokens",
       COALESCE(SUM(u.output_tokens), 0)::bigint AS "outputTokens",
       COALESCE(SUM(u.total_tokens), 0)::bigint AS "totalTokens",
       COALESCE(SUM(u.credits), 0)::numeric AS credits,
       COALESCE(SUM(u.provider_cost_usd), 0)::numeric AS "providerCostUsd",
       COALESCE(SUM(u.customer_cost_usd), 0)::numeric AS "customerCostUsd",
       COALESCE(MAX(sp.period_start), date_trunc('year', NOW())) AS "periodStart",
       COALESCE(MAX(sp.period_end), date_trunc('year', NOW()) + INTERVAL '1 year') AS "periodEnd"
     FROM subscription_period sp
     LEFT JOIN ai_usage_ledger u
       ON u.workspace_id = $1
      AND u.created_at >= sp.period_start
      AND u.created_at < sp.period_end`,
    [workspaceId],
  );

  const row = rows[0] ?? {
    inputTokens: '0', outputTokens: '0', totalTokens: '0', credits: '0',
    providerCostUsd: '0', customerCostUsd: '0',
    periodStart: new Date(new Date().getFullYear(), 0, 1).toISOString(),
    periodEnd: new Date(new Date().getFullYear() + 1, 0, 1).toISOString(),
  };
  return {
    periodStart: new Date(row.periodStart).toISOString(),
    periodEnd: new Date(row.periodEnd).toISOString(),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    totalTokens: Number(row.totalTokens),
    creditsUsed: Number(row.credits),
    providerCostUsd: Number(row.providerCostUsd),
    customerCostUsd: Number(row.customerCostUsd),
    tokensPerCredit: TOKENS_PER_CREDIT,
    customerMarkupMultiplier: null,
    model: env.AI_PROVIDER === 'deepseek' ? env.DEEPSEEK_MODEL : env.AI_PROVIDER === 'alibaba' ? env.DASHSCOPE_MODEL : env.AI_PROVIDER === 'groq' ? env.GROQ_MODEL : env.OPENAI_MODEL,
    pricing: CUSTOMER_API_RATE,
    providerPricing: rateFor(
      env.AI_PROVIDER,
      env.AI_PROVIDER === 'deepseek' ? env.DEEPSEEK_MODEL : env.AI_PROVIDER === 'alibaba' ? env.DASHSCOPE_MODEL : env.AI_PROVIDER === 'groq' ? env.GROQ_MODEL : env.OPENAI_MODEL,
    ),
  };
}
