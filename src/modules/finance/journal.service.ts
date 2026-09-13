import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/app-error.js';
import { normalizeCurrency } from './money.js';
import * as repo from './journal.repo.js';

export type JournalLineInput = {
  lineKey: string;
  accountCode: string;
  direction: 'DEBIT' | 'CREDIT';
  amountMinor: number;
  metadata?: Record<string, unknown>;
};

export type PostJournalInput = {
  workspaceId: string;
  journalType: string;
  occurredAt: string;
  currency: string;
  idempotencyKey: string;
  lines: JournalLineInput[];
  referenceType?: string | null;
  referenceId?: string | null;
  metadata?: Record<string, unknown>;
  actorId?: string | null;
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stableValue(item)]));
  return value;
}
function payloadHash(value: unknown) { return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex'); }
function normalizedCode(value:string,label:string,max=80){const result=value.trim().toUpperCase();if(!new RegExp(`^[A-Z][A-Z0-9_.-]{1,${max-1}}$`).test(result))throw new AppError(422,'INVALID_JOURNAL_CODE',`${label} has an invalid format`);return result;}

function normalizeJournal(input: PostJournalInput) {
  const currency=normalizeCurrency(input.currency);
  const journalType=normalizedCode(input.journalType,'Journal type');
  const idempotencyKey=input.idempotencyKey.trim();
  if(idempotencyKey.length<1||idempotencyKey.length>180)throw new AppError(422,'INVALID_IDEMPOTENCY_KEY','Journal idempotency key must contain 1 to 180 characters');
  if(!Number.isFinite(Date.parse(input.occurredAt)))throw new AppError(422,'INVALID_OCCURRED_AT','Journal occurrence time must be an ISO timestamp');
  if(input.lines.length<2||input.lines.length>100)throw new AppError(422,'INVALID_JOURNAL_LINES','A journal requires between 2 and 100 lines');
  const keys=new Set<string>();let debits=0,credits=0;
  const lines=input.lines.map((line)=>{const lineKey=line.lineKey.trim();if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(lineKey))throw new AppError(422,'INVALID_JOURNAL_LINE_KEY','Journal line keys must be stable identifiers');if(keys.has(lineKey))throw new AppError(422,'DUPLICATE_JOURNAL_LINE_KEY','Journal line keys must be unique');keys.add(lineKey);if(!Number.isSafeInteger(line.amountMinor)||line.amountMinor<=0)throw new AppError(422,'INVALID_JOURNAL_AMOUNT','Journal line amounts must be positive safe integers in minor units');if(line.direction==='DEBIT'){debits+=line.amountMinor;}else if(line.direction==='CREDIT'){credits+=line.amountMinor;}else{throw new AppError(422,'INVALID_JOURNAL_DIRECTION','Journal direction must be DEBIT or CREDIT');}if(!Number.isSafeInteger(debits)||!Number.isSafeInteger(credits))throw new AppError(422,'JOURNAL_TOTAL_TOO_LARGE','Journal total exceeds the safe minor-unit limit');return {...line,lineKey,accountCode:normalizedCode(line.accountCode,'Account code'),metadata:line.metadata??{}};});
  if(debits!==credits)throw new AppError(422,'UNBALANCED_JOURNAL','Journal debits and credits must balance',{debitsMinor:debits,creditsMinor:credits});
  const normalized={...input,journalType,currency,idempotencyKey,occurredAt:new Date(input.occurredAt).toISOString(),referenceType:input.referenceType?.trim()||null,referenceId:input.referenceId?.trim()||null,metadata:input.metadata??{},actorId:input.actorId??null,lines,totalMinor:debits};
  return {...normalized,payloadHash:payloadHash(normalized)};
}

export async function postBalancedJournal(input: PostJournalInput, transactionClient?: PoolClient) {
  const normalized=normalizeJournal(input);
  const run=async(client:PoolClient)=>{
    const id=randomUUID();
    const inserted=await repo.insertJournal({id,workspaceId:normalized.workspaceId,journalType:normalized.journalType,occurredAt:normalized.occurredAt,currency:normalized.currency,totalMinor:normalized.totalMinor,referenceType:normalized.referenceType,referenceId:normalized.referenceId,idempotencyKey:normalized.idempotencyKey,payloadHash:normalized.payloadHash,metadata:normalized.metadata,actorId:normalized.actorId},client);
    if(!inserted){const existing=await repo.findJournalByIdempotency(normalized.workspaceId,normalized.idempotencyKey,client);if(!existing)throw new Error('Journal idempotency lookup failed');if(existing.payloadHash!==normalized.payloadHash)throw new AppError(409,'JOURNAL_IDEMPOTENCY_CONFLICT','The journal idempotency key was already used with a different payload');const journal=await repo.getJournal(normalized.workspaceId,existing.id,client);if(!journal)throw new Error('Existing journal could not be loaded');return {...journal,idempotent:true};}
    for(const line of normalized.lines)await repo.insertJournalLine({workspaceId:normalized.workspaceId,journalId:id,lineKey:line.lineKey,accountCode:line.accountCode,direction:line.direction,amountMinor:line.amountMinor,currency:normalized.currency,idempotencyKey:normalized.idempotencyKey,referenceType:normalized.referenceType,referenceId:normalized.referenceId,metadata:line.metadata,actorId:normalized.actorId},client);
    const journal=await repo.getJournal(normalized.workspaceId,id,client);if(!journal)throw new Error('Posted journal could not be loaded');return {...journal,idempotent:false};
  };
  return transactionClient?run(transactionClient):withTransaction(run);
}
