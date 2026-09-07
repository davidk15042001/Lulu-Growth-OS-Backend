import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export type AppendLedgerEntryInput = {
  workspaceId: string;
  entryGroupId: string;
  accountCode: string;
  direction: LedgerDirection;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  referenceType?: string | null;
  referenceId?: string | null;
  metadata?: Record<string, unknown>;
  actorId?: string | null;
};

/**
 * Appends one immutable minor-unit entry. Duplicate retries return the
 * existing row instead of creating a second financial movement.
 */
export async function appendLedgerEntry(input: AppendLedgerEntryInput, client?: PoolClient) {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error('Ledger amount must be a positive safe integer in minor units');
  }
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Ledger currency must be an ISO-4217 code');
  const result = await query<{ id: string; createdAt: string }>(
    `INSERT INTO financial_ledger_entries (
       workspace_id, entry_group_id, account_code, direction, amount_minor,
       currency, reference_type, reference_id, idempotency_key, metadata, actor_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
     ON CONFLICT (workspace_id, idempotency_key, direction) DO NOTHING
     RETURNING id, created_at AS "createdAt"`,
    [
      input.workspaceId,
      input.entryGroupId,
      input.accountCode.trim().toUpperCase(),
      input.direction,
      input.amountMinor,
      currency,
      input.referenceType ?? null,
      input.referenceId ?? null,
      input.idempotencyKey,
      JSON.stringify(input.metadata ?? {}),
      input.actorId ?? null,
    ],
    client,
  );
  if (result.rows[0]) return result.rows[0];
  const existing = await query<{ id: string; createdAt: string }>(
    `SELECT id, created_at AS "createdAt"
       FROM financial_ledger_entries
      WHERE workspace_id=$1 AND idempotency_key=$2 AND direction=$3
      LIMIT 1`,
    [input.workspaceId, input.idempotencyKey, input.direction],
    client,
  );
  if (!existing.rows[0]) throw new Error('Ledger idempotency lookup failed');
  return existing.rows[0];
}

export async function getLedgerBalance(workspaceId: string, accountCode: string, currency: string) {
  const { rows } = await query<{ debits: string; credits: string }>(
    `SELECT
       COALESCE(SUM(amount_minor) FILTER (WHERE direction='DEBIT'), 0)::text AS debits,
       COALESCE(SUM(amount_minor) FILTER (WHERE direction='CREDIT'), 0)::text AS credits
       FROM financial_ledger_entries
      WHERE workspace_id=$1 AND account_code=$2 AND currency=$3`,
    [workspaceId, accountCode.trim().toUpperCase(), currency.trim().toUpperCase()],
  );
  const debits = BigInt(rows[0]?.debits ?? '0');
  const credits = BigInt(rows[0]?.credits ?? '0');
  return { debits, credits, net: debits - credits };
}
