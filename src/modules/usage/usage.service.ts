import { query } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { debitApiWallet } from '../api-wallet/api-wallet.repo.js';
import { resolveAiFundingMode, type AiFundingMode } from '../api-wallet/ai-funding-policy.js';
import { settleAiSpend } from '../api-wallet/ai-spend-reservation.repo.js';
import { AppError } from '../../utils/app-error.js';

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
  providerRequestId?: string | null;
  reservationId?: string | null;
  /** Funding decision captured before the provider request was submitted. */
  fundingMode?: AiFundingMode;
};

type MeteredUsageInput = {
  workspaceId: string;
  userId?: string | null;
  provider: string;
  model: string;
  providerCostUsd: number;
  customerCostUsd?: number;
  responseId: string;
  providerRequestId?: string | null;
  metadata?: Record<string, unknown>;
  reservationId?: string | null;
  /** Funding decision captured before the provider request was submitted. */
  fundingMode?: AiFundingMode;
};

type Rate = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
};

type PersistedUsage = {
  id: string;
  workspaceId: string;
  customerCostUsd: string;
  responseId: string | null;
  providerRequestId: string | null;
  reservationId: string | null;
  userId: string | null;
  provider: string;
  model: string;
  fundingMode: AiFundingMode | null;
  createdAt: string;
};

type ExistingUsage = Pick<PersistedUsage,
  'id' | 'createdAt' | 'customerCostUsd' | 'responseId' | 'providerRequestId' | 'reservationId' | 'provider' | 'model' | 'fundingMode'>;

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

async function settlePrepaidUsage(input: {
  id: string;
  workspaceId: string;
  customerCostUsd: number;
  responseId: string;
  providerRequestId?: string | null;
  reservationId?: string | null;
  userId?: string | null;
  provider: string;
  model: string;
  fundingMode?: AiFundingMode;
}) {
  // A durable reservation is the authoritative funding snapshot. Never strand
  // an existing customer hold because a plan/admin flag changed after submit.
  if (input.reservationId) {
    return settleAiSpend({
      workspaceId: input.workspaceId,
      reservationId: input.reservationId,
      usageLedgerId: input.id,
      provider: input.provider,
      model: input.model,
      providerRequestId: input.providerRequestId?.trim() || input.responseId,
      actualCustomerCostUsd: input.customerCostUsd,
    });
  }
  const fundingMode = input.fundingMode
    ?? (await resolveAiFundingMode(input.workspaceId, input.userId)).mode;
  if (fundingMode === 'PLATFORM_FUNDED') return null;
  return debitApiWallet({
    workspaceId: input.workspaceId,
    usageLedgerId: input.id,
    customerCostUsd: input.customerCostUsd,
    responseId: input.responseId,
    usdCnyRate: env.API_USD_CNY_RATE,
  });
}

function assertUsageReplayMatches(existing: ExistingUsage, input: {
  provider: string;
  model: string;
  customerCostUsd: number;
  responseId: string;
  providerRequestId?: string | null;
  reservationId?: string | null;
  fundingMode?: AiFundingMode;
}) {
  const sameCost = Number(existing.customerCostUsd).toFixed(8) === Number(input.customerCostUsd).toFixed(8);
  const sameFunding = input.fundingMode === undefined || existing.fundingMode === input.fundingMode;
  const expectedProviderRequestId = input.providerRequestId?.trim() || input.responseId;
  const persistedProviderRequestId = existing.providerRequestId ?? existing.responseId;
  if (existing.provider !== input.provider || existing.model !== input.model || !sameCost
    || existing.responseId !== input.responseId
    || persistedProviderRequestId !== expectedProviderRequestId
    || existing.reservationId !== (input.reservationId ?? null) || !sameFunding) {
    throw new AppError(409, 'AI_USAGE_IDEMPOTENCY_MISMATCH', 'The provider response ID is already linked to different AI usage.');
  }
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
  if (calculated.totalTokens === 0) {
    if (input.reservationId) {
      throw new AppError(409, 'AI_USAGE_EVIDENCE_MISSING', 'Reserved AI usage requires non-zero provider token evidence before settlement.');
    }
    return null;
  }

  const responseId = input.responseId?.trim() || null;
  const providerRequestId = input.providerRequestId?.trim() || responseId;
  const { rows } = await query<{ id: string; createdAt: string }>(
    `INSERT INTO ai_usage_ledger (
       workspace_id, user_id, provider, model, input_tokens, output_tokens,
       provider_cost_usd, customer_cost_usd, metadata, reservation_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      { responseId, providerRequestId, ...(input.fundingMode ? { fundingMode: input.fundingMode } : {}) },
      input.reservationId ?? null,
    ],
  );
  if (rows[0]) {
    await settlePrepaidUsage({ id: rows[0].id, workspaceId: input.workspaceId, userId: input.userId ?? null,
      provider: input.provider, model: input.model, customerCostUsd: calculated.customerCostUsd,
      responseId: responseId ?? rows[0].id, reservationId: input.reservationId ?? null,
      providerRequestId,
      ...(input.fundingMode ? { fundingMode: input.fundingMode } : {}) });
    return { ...calculated, id: rows[0].id, createdAt: rows[0].createdAt };
  }

  // A provider retry with the same response ID is already accounted for. Read
  // the existing append-only entry so callers get a deterministic result.
  if (responseId) {
    const existing = await query<ExistingUsage>(
      `SELECT id,created_at AS "createdAt",provider,model,
              customer_cost_usd AS "customerCostUsd",reservation_id AS "reservationId",
              NULLIF(metadata->>'responseId','') AS "responseId",
              NULLIF(metadata->>'providerRequestId','') AS "providerRequestId",
              NULLIF(metadata->>'fundingMode','') AS "fundingMode"
       FROM ai_usage_ledger
        WHERE workspace_id=$1
          AND (metadata->>'responseId'=$2 OR reservation_id=$3::uuid)
        ORDER BY CASE WHEN metadata->>'responseId'=$2 THEN 0 ELSE 1 END
        LIMIT 1`,
      [input.workspaceId, responseId, input.reservationId ?? null],
    );
    if (existing.rows[0]) {
      assertUsageReplayMatches(existing.rows[0], {
        provider: input.provider,
        model: input.model,
        customerCostUsd: calculated.customerCostUsd,
        responseId,
        providerRequestId,
        reservationId: input.reservationId ?? null,
        ...(input.fundingMode ? { fundingMode: input.fundingMode } : {}),
      });
      // Repair a prior usage-insert/wallet-settlement gap on retry.
      await settlePrepaidUsage({ id: existing.rows[0].id, workspaceId: input.workspaceId, userId: input.userId ?? null,
        provider: input.provider, model: input.model, customerCostUsd: calculated.customerCostUsd,
        responseId, reservationId: input.reservationId ?? null,
        providerRequestId,
        ...(input.fundingMode ? { fundingMode: input.fundingMode } : {}) });
      return { ...calculated, id: existing.rows[0].id, createdAt: existing.rows[0].createdAt };
    }
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
  const providerRequestId = input.providerRequestId?.trim() || responseId;

  const metadata = {
    ...(input.metadata ?? {}),
    responseId,
    providerRequestId,
    metering: 'provider_cost',
    ...(input.fundingMode ? { fundingMode: input.fundingMode } : {}),
  };
  const { rows } = await query<{ id: string; createdAt: string }>(
    `INSERT INTO ai_usage_ledger (
       workspace_id, user_id, provider, model, input_tokens, output_tokens,
       provider_cost_usd, customer_cost_usd, metadata, reservation_id
     ) VALUES ($1,$2,$3,$4,0,0,$5,$6,$7::jsonb,$8)
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
      input.reservationId ?? null,
    ],
  );
  if (rows[0]) {
    await settlePrepaidUsage({ id: rows[0].id, workspaceId: input.workspaceId, userId: input.userId ?? null,
      provider: input.provider, model: input.model, customerCostUsd, responseId,
      providerRequestId,
      reservationId: input.reservationId ?? null,
      ...(input.fundingMode ? { fundingMode: input.fundingMode } : {}) });
    return { id: rows[0].id, createdAt: rows[0].createdAt, providerCostUsd, customerCostUsd };
  }

  const existing = await query<ExistingUsage>(
    `SELECT id,created_at AS "createdAt",provider,model,
            customer_cost_usd AS "customerCostUsd",reservation_id AS "reservationId",
            NULLIF(metadata->>'responseId','') AS "responseId",
            NULLIF(metadata->>'providerRequestId','') AS "providerRequestId",
            NULLIF(metadata->>'fundingMode','') AS "fundingMode"
       FROM ai_usage_ledger
      WHERE workspace_id=$1
        AND (metadata->>'responseId'=$2 OR reservation_id=$3::uuid)
      ORDER BY CASE WHEN metadata->>'responseId'=$2 THEN 0 ELSE 1 END
      LIMIT 1`,
    [input.workspaceId, responseId, input.reservationId ?? null],
  );
  if (!existing.rows[0]) return null;
  assertUsageReplayMatches(existing.rows[0], {
    provider: input.provider,
    model: input.model,
    customerCostUsd,
    responseId,
    providerRequestId,
    reservationId: input.reservationId ?? null,
    ...(input.fundingMode ? { fundingMode: input.fundingMode } : {}),
  });
  await settlePrepaidUsage({ id: existing.rows[0].id, workspaceId: input.workspaceId, userId: input.userId ?? null,
    provider: input.provider, model: input.model, customerCostUsd, responseId,
    providerRequestId,
    reservationId: input.reservationId ?? null,
    ...(input.fundingMode ? { fundingMode: input.fundingMode } : {}) });
  return { id: existing.rows[0].id, createdAt: existing.rows[0].createdAt, providerCostUsd, customerCostUsd };
}

/** Repairs the durable gap between immutable provider usage and its prepaid
 * wallet entry. Wallet debit idempotency makes this scan safe to replay. */
export async function reconcileUnsettledApiUsage(limit = 250) {
  const boundedLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
  const candidates = await query<PersistedUsage>(
    `SELECT u.id,u.workspace_id AS "workspaceId",u.customer_cost_usd AS "customerCostUsd",
            NULLIF(u.metadata->>'responseId','') AS "responseId",u.reservation_id AS "reservationId",
            u.user_id AS "userId",u.provider,u.model,
            NULLIF(u.metadata->>'providerRequestId','') AS "providerRequestId",
            NULLIF(u.metadata->>'fundingMode','') AS "fundingMode",u.created_at AS "createdAt"
       FROM ai_usage_ledger u
       JOIN workspace_api_wallets w
         ON w.workspace_id=u.workspace_id AND u.created_at>=w.created_at
       LEFT JOIN workspace_api_wallet_ledger wl
         ON wl.ai_usage_ledger_id=u.id AND wl.entry_type='USAGE_DEBIT'
       LEFT JOIN LATERAL (
         SELECT provider,plan_key,status,trial_ends_at,current_period_ends_at
           FROM workspace_subscriptions s
          WHERE s.workspace_id=u.workspace_id
          ORDER BY s.updated_at DESC
          LIMIT 1
       ) subscription ON TRUE
      WHERE wl.id IS NULL
        AND u.reservation_id IS NULL
        AND u.customer_cost_usd>0
        AND (
          u.metadata->>'fundingMode'='CUSTOMER_PREPAID'
          OR (
            u.metadata->>'fundingMode' IS NULL
            AND NOT COALESCE(
              (subscription.provider='internal' OR subscription.plan_key='test')
              AND (
                (subscription.status='active' AND (subscription.current_period_ends_at IS NULL OR subscription.current_period_ends_at>NOW()))
                OR
                (subscription.status='trialing'
                  AND (subscription.trial_ends_at IS NULL OR subscription.trial_ends_at>NOW())
                  AND (subscription.current_period_ends_at IS NULL OR subscription.current_period_ends_at>NOW()))
              ),
              FALSE
            )
          )
        )
      ORDER BY u.created_at,u.id
      LIMIT $1`,
    [boundedLimit],
  );
  let settled = 0;
  for (const usage of candidates.rows) {
    await settlePrepaidUsage({
      id: usage.id,
      workspaceId: usage.workspaceId,
      userId: usage.userId,
      provider: usage.provider,
      model: usage.model,
      customerCostUsd: Number(usage.customerCostUsd),
      responseId: usage.responseId ?? usage.id,
      providerRequestId: usage.providerRequestId ?? usage.responseId ?? usage.id,
      reservationId: null,
      ...(usage.fundingMode ? { fundingMode: usage.fundingMode } : {}),
    });
    settled += 1;
  }
  return { scanned: candidates.rows.length, settled };
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
    model: env.AI_PROVIDER === 'deepseek' ? env.DEEPSEEK_MODEL : env.AI_PROVIDER === 'alibaba' ? env.DASHSCOPE_MODEL : env.AI_PROVIDER === 'groq' ? env.GROQ_MODEL : env.AI_PROVIDER === 'kie' ? env.KIE_QUALITY_MODEL : env.OPENAI_MODEL,
    pricing: CUSTOMER_API_RATE,
    providerPricing: rateFor(
      env.AI_PROVIDER,
      env.AI_PROVIDER === 'deepseek' ? env.DEEPSEEK_MODEL : env.AI_PROVIDER === 'alibaba' ? env.DASHSCOPE_MODEL : env.AI_PROVIDER === 'groq' ? env.GROQ_MODEL : env.AI_PROVIDER === 'kie' ? env.KIE_QUALITY_MODEL : env.OPENAI_MODEL,
    ),
  };
}
