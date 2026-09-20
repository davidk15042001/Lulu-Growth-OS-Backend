import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/app-error.js';

export const COMPOSIO_TOOL_CALL_PRICE_CNY = '0.500000';
export const COMPOSIO_TRIGGER_PRICE_CNY = '0.500000';

export type ComposioUsageType = 'TOOL_CALL' | 'TRIGGER';
export type ComposioUsageStatus = 'CHARGED' | 'SUCCEEDED' | 'FAILED' | 'AMBIGUOUS';

type ComposioUsageRow = {
  id: string;
  workspaceId: string;
  userId: string | null;
  usageType: ComposioUsageType;
  amountCny: string;
  toolkitSlug: string;
  toolSlug: string | null;
  triggerSlug: string | null;
  providerEventId: string | null;
  idempotencyKey: string;
  status: ComposioUsageStatus;
  providerLogId: string | null;
  errorCode: string | null;
  createdAt: string;
};

type WalletRow = {
  availableAmount: string;
  reservedAmount: string;
  paymentReservedAmount: string;
  spentAmount: string;
  reversalDebtAmount: string;
  hasReversalDebt: boolean;
  insufficientForCharge: boolean;
};

const usageSelect = `
  id,
  workspace_id AS "workspaceId",
  user_id AS "userId",
  usage_type AS "usageType",
  amount_cny AS "amountCny",
  toolkit_slug AS "toolkitSlug",
  tool_slug AS "toolSlug",
  trigger_slug AS "triggerSlug",
  provider_event_id AS "providerEventId",
  idempotency_key AS "idempotencyKey",
  status,
  provider_log_id AS "providerLogId",
  error_code AS "errorCode",
  created_at AS "createdAt"
`;

async function ensureWallet(workspaceId: string, client: PoolClient) {
  await query(
    `INSERT INTO workspace_api_wallets(workspace_id,payment_reserved_amount)
     SELECT $1,COALESCE((SELECT SUM(amount) FROM workspace_api_topups
       WHERE workspace_id=$1 AND credited_at IS NULL
         AND status IN ('CREATED','PENDING_PAYMENT','REQUIRES_CUSTOMER_ACTION')),0)
     ON CONFLICT DO NOTHING`,
    [workspaceId],
    client,
  );
}

function usagePrice(type: ComposioUsageType) {
  return type === 'TOOL_CALL' ? COMPOSIO_TOOL_CALL_PRICE_CNY : COMPOSIO_TRIGGER_PRICE_CNY;
}

function assertSameRequest(existing: ComposioUsageRow, input: ChargeComposioUsageInput) {
  const same = existing.usageType === input.usageType
    && existing.toolkitSlug === input.toolkitSlug
    && existing.toolSlug === (input.toolSlug ?? null)
    && existing.triggerSlug === (input.triggerSlug ?? null)
    && existing.providerEventId === (input.providerEventId ?? null);
  if (!same) {
    throw new AppError(409, 'COMPOSIO_IDEMPOTENCY_KEY_REUSED', 'The Composio idempotency key was already used for a different operation.');
  }
}

export type ChargeComposioUsageInput = {
  workspaceId: string;
  userId?: string | null;
  usageType: ComposioUsageType;
  toolkitSlug: string;
  toolSlug?: string;
  triggerSlug?: string;
  providerEventId?: string;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
};

export async function chargeComposioUsage(input: ChargeComposioUsageInput) {
  return withTransaction(async (client) => {
    const amount = usagePrice(input.usageType);
    const inserted = (await query<ComposioUsageRow>(
      `INSERT INTO workspace_composio_usage_ledger(
         workspace_id,user_id,usage_type,amount_cny,toolkit_slug,tool_slug,
         trigger_slug,provider_event_id,idempotency_key,metadata
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (workspace_id,idempotency_key) DO NOTHING
       RETURNING ${usageSelect}`,
      [
        input.workspaceId,
        input.userId ?? null,
        input.usageType,
        amount,
        input.toolkitSlug,
        input.toolSlug ?? null,
        input.triggerSlug ?? null,
        input.providerEventId ?? null,
        input.idempotencyKey,
        JSON.stringify(input.metadata ?? {}),
      ],
      client,
    )).rows[0];

    if (!inserted) {
      const existing = (await query<ComposioUsageRow>(
        `SELECT ${usageSelect} FROM workspace_composio_usage_ledger
         WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`,
        [input.workspaceId, input.idempotencyKey],
        client,
      )).rows[0];
      if (!existing) throw new Error('Composio usage idempotency row disappeared');
      assertSameRequest(existing, input);
      return { charged: false, idempotent: true, usage: existing, amountCny: amount };
    }

    await ensureWallet(input.workspaceId, client);
    const wallet = (await query<WalletRow>(
      `SELECT available_amount AS "availableAmount",
              reserved_amount AS "reservedAmount",
              payment_reserved_amount AS "paymentReservedAmount",
              spent_amount AS "spentAmount",
              reversal_debt_amount AS "reversalDebtAmount",
              reversal_debt_amount > 0 AS "hasReversalDebt",
              available_amount < $2::numeric AS "insufficientForCharge"
       FROM workspace_api_wallets WHERE workspace_id=$1 FOR UPDATE`,
      [input.workspaceId, amount],
      client,
    )).rows[0];
    if (!wallet) throw new Error('AI wallet could not be created');
    if (wallet.hasReversalDebt) {
      throw new AppError(409, 'AI_REVERSAL_DEBT', 'Composio execution is paused until the outstanding refund or chargeback balance is covered.');
    }
    if (wallet.insufficientForCharge) {
      throw new AppError(402, 'COMPOSIO_FUNDS_REQUIRED', 'Composio usage requires at least 0.50 CNY of available AI balance.');
    }

    const updatedWallet = (await query<WalletRow>(
      `UPDATE workspace_api_wallets
       SET available_amount=available_amount-$2::numeric,
           spent_amount=spent_amount+$2::numeric,
           version=version+1
       WHERE workspace_id=$1
       RETURNING available_amount AS "availableAmount",
                 reserved_amount AS "reservedAmount",
                 payment_reserved_amount AS "paymentReservedAmount",
                 spent_amount AS "spentAmount",
                 reversal_debt_amount AS "reversalDebtAmount"`,
      [input.workspaceId, amount],
      client,
    )).rows[0];
    if (!updatedWallet) throw new Error('AI wallet could not be debited');

    const entryType = input.usageType === 'TOOL_CALL' ? 'COMPOSIO_TOOL_CALL' : 'COMPOSIO_TRIGGER';
    await query(
      `INSERT INTO workspace_api_wallet_ledger(
         workspace_id,composio_usage_id,entry_type,amount_delta,balance_after,
         reserved_after,idempotency_key,metadata
       ) VALUES($1,$2,$3,-$4::numeric,$5,$6,$7,$8::jsonb)`,
      [
        input.workspaceId,
        inserted.id,
        entryType,
        amount,
        updatedWallet.availableAmount,
        updatedWallet.reservedAmount,
        `composio-usage:${inserted.id}`,
        JSON.stringify({
          provider: 'composio',
          usageType: input.usageType,
          toolkitSlug: input.toolkitSlug,
          ...(input.toolSlug ? { toolSlug: input.toolSlug } : {}),
          ...(input.triggerSlug ? { triggerSlug: input.triggerSlug } : {}),
          priceCny: amount,
        }),
      ],
      client,
    );

    return { charged: true, idempotent: false, usage: inserted, amountCny: amount };
  });
}

export async function finalizeComposioUsage(input: {
  workspaceId: string;
  usageId: string;
  status: Exclude<ComposioUsageStatus, 'CHARGED'>;
  providerLogId?: string | null;
  errorCode?: string | null;
}) {
  const row = (await query<ComposioUsageRow>(
    `UPDATE workspace_composio_usage_ledger
     SET status=CASE WHEN status='CHARGED' THEN $3 ELSE status END,
         provider_log_id=COALESCE($4,provider_log_id),
         error_code=COALESCE($5,error_code),
         updated_at=NOW()
     WHERE workspace_id=$1 AND id=$2
     RETURNING ${usageSelect}`,
    [input.workspaceId, input.usageId, input.status, input.providerLogId ?? null, input.errorCode ?? null],
  )).rows[0];
  if (!row) throw new Error('Composio usage ledger entry was not found');
  return row;
}

export async function getComposioUsageSummary(workspaceId: string, filters?: { from?: string | Date | undefined; to?: string | Date | undefined }) {
  const values: unknown[] = [workspaceId];
  const conditions = ['workspace_id=$1'];
  if (filters?.from) {
    values.push(filters.from);
    conditions.push(`created_at >= $${values.length}`);
  }
  if (filters?.to) {
    values.push(filters.to);
    conditions.push(`created_at <= $${values.length}`);
  }
  const row = (await query<{
    toolCalls: string;
    triggers: string;
    chargedAmountCny: string;
  }>(
    `SELECT COUNT(*) FILTER (WHERE usage_type='TOOL_CALL')::bigint AS "toolCalls",
            COUNT(*) FILTER (WHERE usage_type='TRIGGER')::bigint AS triggers,
            COALESCE(SUM(amount_cny),0)::numeric AS "chargedAmountCny"
     FROM workspace_composio_usage_ledger
     WHERE ${conditions.join(' AND ')}`,
    values,
  )).rows[0];
  return {
    toolCalls: Number(row?.toolCalls ?? 0),
    triggers: Number(row?.triggers ?? 0),
    chargedAmountCny: row?.chargedAmountCny ?? '0.000000',
    toolCallPriceCny: COMPOSIO_TOOL_CALL_PRICE_CNY,
    triggerPriceCny: COMPOSIO_TRIGGER_PRICE_CNY,
  };
}
