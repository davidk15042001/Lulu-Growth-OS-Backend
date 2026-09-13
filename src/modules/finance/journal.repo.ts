import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';

export type JournalRow = {
  id: string;
  workspaceId: string;
  journalType: string;
  occurredAt: string;
  currency: string;
  totalDebitsMinor: string;
  totalCreditsMinor: string;
  referenceType: string | null;
  referenceId: string | null;
  idempotencyKey: string;
  payloadHash: string;
  metadata: Record<string, unknown>;
  actorId: string | null;
  createdAt: string;
};

export type JournalLineRow = {
  id: string;
  journalId: string;
  lineKey: string;
  accountCode: string;
  direction: 'DEBIT' | 'CREDIT';
  amountMinor: string;
  currency: string;
  referenceType: string | null;
  referenceId: string | null;
  metadata: Record<string, unknown>;
  actorId: string | null;
  createdAt: string;
};

const journalSelect = `
  id, workspace_id AS "workspaceId", journal_type AS "journalType",
  occurred_at AS "occurredAt", currency,
  total_debits_minor::text AS "totalDebitsMinor",
  total_credits_minor::text AS "totalCreditsMinor",
  reference_type AS "referenceType", reference_id AS "referenceId",
  idempotency_key AS "idempotencyKey", payload_hash AS "payloadHash",
  metadata, actor_id AS "actorId", created_at AS "createdAt"`;

const lineSelect = `
  id, entry_group_id AS "journalId", line_key AS "lineKey", account_code AS "accountCode",
  direction, amount_minor::text AS "amountMinor", currency,
  reference_type AS "referenceType", reference_id AS "referenceId",
  metadata, actor_id AS "actorId", created_at AS "createdAt"`;

export async function insertJournal(input: {
  id: string;
  workspaceId: string;
  journalType: string;
  occurredAt: string;
  currency: string;
  totalMinor: number;
  referenceType: string | null;
  referenceId: string | null;
  idempotencyKey: string;
  payloadHash: string;
  metadata: Record<string, unknown>;
  actorId: string | null;
}, client: PoolClient) {
  return (await query<JournalRow>(
    `INSERT INTO financial_journals(
       id,workspace_id,journal_type,occurred_at,currency,total_debits_minor,total_credits_minor,
       reference_type,reference_id,idempotency_key,payload_hash,metadata,actor_id
     ) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11::jsonb,$12)
     ON CONFLICT (workspace_id,idempotency_key) DO NOTHING
     RETURNING ${journalSelect}`,
    [input.id,input.workspaceId,input.journalType,input.occurredAt,input.currency,input.totalMinor,
      input.referenceType,input.referenceId,input.idempotencyKey,input.payloadHash,
      JSON.stringify(input.metadata),input.actorId], client,
  )).rows[0] ?? null;
}

export async function insertJournalLine(input: {
  workspaceId: string;
  journalId: string;
  lineKey: string;
  accountCode: string;
  direction: 'DEBIT' | 'CREDIT';
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  referenceType: string | null;
  referenceId: string | null;
  metadata: Record<string, unknown>;
  actorId: string | null;
}, client: PoolClient) {
  const row = (await query<JournalLineRow>(
    `INSERT INTO financial_ledger_entries(
       workspace_id,entry_group_id,line_key,account_code,direction,amount_minor,currency,
       reference_type,reference_id,idempotency_key,metadata,actor_id
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
     RETURNING ${lineSelect}`,
    [input.workspaceId,input.journalId,input.lineKey,input.accountCode,input.direction,
      input.amountMinor,input.currency,input.referenceType,input.referenceId,
      `${input.idempotencyKey}:${input.lineKey}`,JSON.stringify(input.metadata),input.actorId], client,
  )).rows[0];
  if (!row) throw new Error('Journal line insert did not return a row');
  return row;
}

export async function findJournalByIdempotency(workspaceId: string, idempotencyKey: string, client?: PoolClient) {
  return (await query<JournalRow>(
    `SELECT ${journalSelect} FROM financial_journals
      WHERE workspace_id=$1 AND idempotency_key=$2`,
    [workspaceId,idempotencyKey], client,
  )).rows[0] ?? null;
}

export async function getJournal(workspaceId: string, journalId: string, client?: PoolClient) {
  const journal = (await query<JournalRow>(
    `SELECT ${journalSelect} FROM financial_journals WHERE workspace_id=$1 AND id=$2`,
    [workspaceId,journalId], client,
  )).rows[0] ?? null;
  if (!journal) return null;
  const lines = (await query<JournalLineRow>(
    `SELECT ${lineSelect} FROM financial_ledger_entries
      WHERE workspace_id=$1 AND entry_group_id=$2 AND line_key IS NOT NULL
      ORDER BY line_key,id`,
    [workspaceId,journalId], client,
  )).rows;
  return { ...journal, lines };
}

export async function listJournals(workspaceId: string, filters: {
  page: number;
  limit: number;
  currency?: string | undefined;
  accountCode?: string | undefined;
  referenceType?: string | undefined;
  referenceId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}) {
  const params: unknown[] = [workspaceId];
  const where = ['j.workspace_id=$1'];
  if (filters.currency) { params.push(filters.currency); where.push(`j.currency=$${params.length}`); }
  if (filters.referenceType) { params.push(filters.referenceType); where.push(`j.reference_type=$${params.length}`); }
  if (filters.referenceId) { params.push(filters.referenceId); where.push(`j.reference_id=$${params.length}`); }
  if (filters.from) { params.push(filters.from); where.push(`j.occurred_at >= $${params.length}::timestamptz`); }
  if (filters.to) { params.push(filters.to); where.push(`j.occurred_at <= $${params.length}::timestamptz`); }
  if (filters.accountCode) {
    params.push(filters.accountCode);
    where.push(`EXISTS(SELECT 1 FROM financial_ledger_entries e WHERE e.workspace_id=j.workspace_id AND e.entry_group_id=j.id AND e.account_code=$${params.length})`);
  }
  const count = await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM financial_journals j WHERE ${where.join(' AND ')}`, params,
  );
  params.push(filters.limit,(filters.page-1)*filters.limit);
  const rows = await query<JournalRow>(
    `SELECT ${journalSelect} FROM financial_journals j WHERE ${where.join(' AND ')}
      ORDER BY j.occurred_at DESC,j.id DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
    params,
  );
  const total = Number(count.rows[0]?.total ?? 0);
  return { items: rows.rows, pagination: { page: filters.page, limit: filters.limit, total, pages: Math.ceil(total/filters.limit) } };
}

export async function getAccountBalance(workspaceId: string, accountCode: string, currency: string, asOf?: string) {
  const params: unknown[] = [workspaceId,accountCode,currency];
  const asOfSql = asOf ? (params.push(asOf), `AND j.occurred_at <= $${params.length}::timestamptz`) : '';
  const row = (await query<{ debitsMinor:string; creditsMinor:string }>(
    `SELECT
       COALESCE(SUM(e.amount_minor) FILTER(WHERE e.direction='DEBIT'),0)::text AS "debitsMinor",
       COALESCE(SUM(e.amount_minor) FILTER(WHERE e.direction='CREDIT'),0)::text AS "creditsMinor"
     FROM financial_ledger_entries e
     JOIN financial_journals j ON j.workspace_id=e.workspace_id AND j.id=e.entry_group_id
     WHERE e.workspace_id=$1 AND e.account_code=$2 AND e.currency=$3 ${asOfSql}`,
    params,
  )).rows[0] ?? { debitsMinor:'0',creditsMinor:'0' };
  const debits = BigInt(row.debitsMinor); const credits = BigInt(row.creditsMinor);
  const net = debits-credits;
  return { accountCode, currency, debitsMinor:row.debitsMinor, creditsMinor:row.creditsMinor,
    balanceDirection:net===0n?'BALANCED':net>0n?'DEBIT':'CREDIT', balanceMinor:(net<0n?-net:net).toString() };
}

export async function getTrialBalance(workspaceId: string, currency: string, asOf?: string) {
  const params: unknown[] = [workspaceId,currency];
  const asOfSql = asOf ? (params.push(asOf), `AND j.occurred_at <= $${params.length}::timestamptz`) : '';
  const rows = (await query<{accountCode:string;debitsMinor:string;creditsMinor:string}>(
    `SELECT e.account_code AS "accountCode",
       COALESCE(SUM(e.amount_minor) FILTER(WHERE e.direction='DEBIT'),0)::text AS "debitsMinor",
       COALESCE(SUM(e.amount_minor) FILTER(WHERE e.direction='CREDIT'),0)::text AS "creditsMinor"
     FROM financial_ledger_entries e
     JOIN financial_journals j ON j.workspace_id=e.workspace_id AND j.id=e.entry_group_id
     WHERE e.workspace_id=$1 AND e.currency=$2 ${asOfSql}
     GROUP BY e.account_code ORDER BY e.account_code`, params,
  )).rows;
  let totalDebits=0n,totalCredits=0n;
  const accounts=rows.map((row)=>{const debit=BigInt(row.debitsMinor);const credit=BigInt(row.creditsMinor);totalDebits+=debit;totalCredits+=credit;const net=debit-credit;return {...row,balanceDirection:net===0n?'BALANCED':net>0n?'DEBIT':'CREDIT',balanceMinor:(net<0n?-net:net).toString()};});
  return { currency, asOf:asOf??null, accounts, totals:{debitsMinor:totalDebits.toString(),creditsMinor:totalCredits.toString()},balanced:totalDebits===totalCredits };
}
