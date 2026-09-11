import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/app-error.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';

export type ApiPaymentMethod = 'card' | 'alipaycn' | 'wechatpay';
export type ApiTopupStatus = 'CREATED' | 'PENDING_PAYMENT' | 'REQUIRES_CUSTOMER_ACTION' | 'SUCCEEDED' | 'CANCELLED' | 'FAILED' | 'EXPIRED' | 'REFUNDED' | 'CHARGEBACK';
type WalletRow = { workspaceId:string; currency:'CNY'; availableAmount:string; spentAmount:string; totalFundedAmount:string; version:number; createdAt:string; updatedAt:string };
export type ApiTopupRow = { id:string;workspaceId:string;createdBy:string;amount:string;currency:'CNY';paymentMethod:ApiPaymentMethod;provider:'airwallex';status:ApiTopupStatus;merchantOrderId:string;providerInvoiceId:string|null;providerPaymentIntentId:string|null;checkoutUrl:string|null;qrPayload:string|null;expiresAt:string|null;paidAt:string|null;creditedAt:string|null;providerResponse:Record<string,unknown>;errorCode:string|null;errorMessage:string|null;createdAt:string;updatedAt:string };

const walletSelect=`workspace_id AS "workspaceId",currency,available_amount AS "availableAmount",spent_amount AS "spentAmount",total_funded_amount AS "totalFundedAmount",version,created_at AS "createdAt",updated_at AS "updatedAt"`;
const topupSelect=`id,workspace_id AS "workspaceId",created_by AS "createdBy",amount,currency,payment_method AS "paymentMethod",provider,status,merchant_order_id AS "merchantOrderId",provider_invoice_id AS "providerInvoiceId",provider_payment_intent_id AS "providerPaymentIntentId",checkout_url AS "checkoutUrl",qr_payload AS "qrPayload",expires_at AS "expiresAt",paid_at AS "paidAt",credited_at AS "creditedAt",provider_response AS "providerResponse",error_code AS "errorCode",error_message AS "errorMessage",created_at AS "createdAt",updated_at AS "updatedAt"`;

function publicWallet(row:WalletRow){return {...row,availableAmount:Number(row.availableAmount),spentAmount:Number(row.spentAmount),totalFundedAmount:Number(row.totalFundedAmount),aiEnabled:Number(row.availableAmount)>0};}
export function publicApiTopup(row:ApiTopupRow){return {...row,amount:Number(row.amount)};}
async function ensureWallet(workspaceId:string,client?:PoolClient){
  await query(`INSERT INTO workspace_api_wallets(workspace_id) VALUES($1) ON CONFLICT DO NOTHING`,[workspaceId],client);
  const row=(await query<WalletRow>(`SELECT ${walletSelect} FROM workspace_api_wallets WHERE workspace_id=$1`,[workspaceId],client)).rows[0];
  if(!row) throw new Error('AI wallet could not be created'); return row;
}
export async function getApiWalletOverview(workspaceId:string){const wallet=await ensureWallet(workspaceId);const topups=await query<ApiTopupRow>(`SELECT ${topupSelect} FROM workspace_api_topups WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 25`,[workspaceId]);return {wallet:publicWallet(wallet),topups:topups.rows.map(publicApiTopup),packages:[1,1000,2500,5000,9000],currency:'CNY' as const};}
export async function assertApiWalletFunded(workspaceId:string){const wallet=await ensureWallet(workspaceId);if(Number(wallet.availableAmount)<=0) throw new AppError(402,'AI_FUNDS_REQUIRED','AI execution is paused until the AI wallet is funded.');return publicWallet(wallet);}
export async function isApiWalletMeteredWorkspace(workspaceId:string){const row=(await query<{provider:string|null;planKey:string|null}>(`SELECT provider,plan_key AS "planKey" FROM workspace_subscriptions WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 1`,[workspaceId])).rows[0];return !(row?.provider==='internal'||row?.planKey==='test');}
export async function createApiTopup(input:{workspaceId:string;userId:string;amount:number;paymentMethod:ApiPaymentMethod}){const id=crypto.randomUUID();const row=(await query<ApiTopupRow>(`INSERT INTO workspace_api_topups(id,workspace_id,created_by,amount,payment_method,merchant_order_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${topupSelect}`,[id,input.workspaceId,input.userId,input.amount.toFixed(2),input.paymentMethod,`lulu-api-${id}`])).rows[0];if(!row) throw new Error('AI top-up was not created');return row;}
export async function getApiTopup(workspaceId:string,topupId:string){return (await query<ApiTopupRow>(`SELECT ${topupSelect} FROM workspace_api_topups WHERE workspace_id=$1 AND id=$2`,[workspaceId,topupId])).rows[0]??null;}
export async function attachApiProviderPayment(input:{topupId:string;status:ApiTopupStatus;providerInvoiceId?:string|null;providerPaymentIntentId?:string|null;checkoutUrl?:string|null;qrPayload?:string|null;expiresAt?:string|null;providerResponse?:Record<string,unknown>}){const row=(await query<ApiTopupRow>(`UPDATE workspace_api_topups SET status=$2,provider_invoice_id=COALESCE($3,provider_invoice_id),provider_payment_intent_id=COALESCE($4,provider_payment_intent_id),checkout_url=COALESCE($5,checkout_url),qr_payload=COALESCE($6,qr_payload),expires_at=COALESCE($7::timestamptz,expires_at),provider_response=$8::jsonb WHERE id=$1 RETURNING ${topupSelect}`,[input.topupId,input.status,input.providerInvoiceId??null,input.providerPaymentIntentId??null,input.checkoutUrl??null,input.qrPayload??null,input.expiresAt??null,JSON.stringify(input.providerResponse??{})])).rows[0];if(!row) throw new Error('AI top-up provider payment could not be attached');return row;}
function mapStatus(value:string):ApiTopupStatus{
  const status=value.trim().toUpperCase();
  if(status.includes('CHARGEBACK'))return'CHARGEBACK';
  if(status.includes('REFUND'))return'REFUNDED';
  if(['SUCCEEDED','PAID','COMPLETED'].includes(status))return'SUCCEEDED';
  if(['CANCELLED','CANCELED'].includes(status))return'CANCELLED';
  if(status==='EXPIRED')return'EXPIRED';
  if(['FAILED','REQUIRES_PAYMENT_METHOD'].includes(status))return'FAILED';
  if(['REQUIRES_CUSTOMER_ACTION','REQUIRES_ACTION'].includes(status))return'REQUIRES_CUSTOMER_ACTION';
  return'PENDING_PAYMENT';
}

export async function applyApiProviderStatus(input:{providerPaymentIntentId?:string|null;providerInvoiceId?:string|null;providerStatus:string;paidAt?:string|null;providerResponse?:Record<string,unknown>}){
  return withTransaction(async client=>{
    const topup=(await query<ApiTopupRow>(`SELECT ${topupSelect} FROM workspace_api_topups WHERE ($1::text IS NOT NULL AND provider_payment_intent_id=$1) OR ($2::text IS NOT NULL AND provider_invoice_id=$2) FOR UPDATE`,[input.providerPaymentIntentId??null,input.providerInvoiceId??null],client)).rows[0];
    if(!topup)return null;
    const mapped=mapStatus(input.providerStatus);
    const reversal=['REFUNDED','CHARGEBACK'].includes(mapped);
    const wasReversed=['REFUNDED','CHARGEBACK'].includes(topup.status);
    const status:ApiTopupStatus=reversal?mapped:topup.creditedAt?(wasReversed?topup.status:'SUCCEEDED'):mapped;
    const newlyCredited=status==='SUCCEEDED'&&!topup.creditedAt;
    const newlyReversed=reversal&&Boolean(topup.creditedAt)&&!wasReversed;
    await query(`UPDATE workspace_api_topups SET status=$2::varchar,paid_at=CASE WHEN $2::varchar='SUCCEEDED' THEN COALESCE(paid_at,$3::timestamptz,NOW()) ELSE paid_at END,credited_at=CASE WHEN $2::varchar='SUCCEEDED' THEN COALESCE(credited_at,NOW()) ELSE credited_at END,provider_response=provider_response||$4::jsonb WHERE id=$1`,[topup.id,status,input.paidAt??null,JSON.stringify(input.providerResponse??{})],client);
    if(newlyCredited){
      await ensureWallet(topup.workspaceId,client);
      const wallet=(await query<WalletRow>(`UPDATE workspace_api_wallets SET available_amount=available_amount+$2,total_funded_amount=total_funded_amount+$2,version=version+1 WHERE workspace_id=$1 RETURNING ${walletSelect}`,[topup.workspaceId,topup.amount],client)).rows[0]!;
      await query(`INSERT INTO workspace_api_wallet_ledger(workspace_id,topup_id,entry_type,amount_delta,balance_after,idempotency_key,metadata) VALUES($1,$2,'TOPUP_CREDIT',$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,[topup.workspaceId,topup.id,topup.amount,wallet.availableAmount,`api-topup:${topup.id}:credit`,JSON.stringify({provider:'airwallex'})],client);
      await appendDomainEvent({workspaceId:topup.workspaceId,type:DOMAIN_EVENT_TYPES.API_FUNDS_FUNDED,aggregateType:'api_wallet',aggregateId:topup.workspaceId,payload:{topupId:topup.id,amount:Number(topup.amount),availableAmount:Number(wallet.availableAmount)},metadata:{actorId:topup.createdBy,source:'airwallex'},idempotencyKey:`api-topup:${topup.id}:funded`},client);
    }
    if(newlyReversed){
      const before=await ensureWallet(topup.workspaceId,client);
      const deducted=Math.min(Number(before.availableAmount),Number(topup.amount));
      const wallet=(await query<WalletRow>(`UPDATE workspace_api_wallets SET available_amount=GREATEST(0,available_amount-$2),total_funded_amount=GREATEST(0,total_funded_amount-$2),version=version+1 WHERE workspace_id=$1 RETURNING ${walletSelect}`,[topup.workspaceId,topup.amount],client)).rows[0]!;
      await query(`INSERT INTO workspace_api_wallet_ledger(workspace_id,topup_id,entry_type,amount_delta,balance_after,idempotency_key,metadata) VALUES($1,$2,'REFUND',$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,[topup.workspaceId,topup.id,(-deducted).toFixed(6),wallet.availableAmount,`api-topup:${topup.id}:reversal`,JSON.stringify({provider:'airwallex',status,originalAmount:Number(topup.amount)})],client);
    }
    return (await query<ApiTopupRow>(`SELECT ${topupSelect} FROM workspace_api_topups WHERE id=$1`,[topup.id],client)).rows[0]??null;
  });
}
export async function failApiTopup(topupId:string,code:string,message:string){await query(`UPDATE workspace_api_topups SET status='FAILED',error_code=$2,error_message=$3 WHERE id=$1 AND status IN ('CREATED','PENDING_PAYMENT','REQUIRES_CUSTOMER_ACTION')`,[topupId,code.slice(0,120),message.slice(0,2000)]);}

/** Exact, idempotent post-usage debit. A provider response cannot be billed twice. */
export async function debitApiWallet(input:{workspaceId:string;usageLedgerId:string;customerCostUsd:number;responseId:string;usdCnyRate:number}){const amount=Math.round(input.customerCostUsd*input.usdCnyRate*1_000_000)/1_000_000;if(amount<=0)return null;return withTransaction(async client=>{const key=`api-usage:${input.workspaceId}:${input.responseId}`;const prior=(await query<{id:string}>(`SELECT id FROM workspace_api_wallet_ledger WHERE idempotency_key=$1`,[key],client)).rows[0];if(prior)return{debited:false,idempotent:true,exhausted:false};await ensureWallet(input.workspaceId,client);const locked=(await query<WalletRow>(`SELECT ${walletSelect} FROM workspace_api_wallets WHERE workspace_id=$1 FOR UPDATE`,[input.workspaceId],client)).rows[0]!;const available=Number(locked.availableAmount);const charged=Math.min(available,amount);const wallet=(await query<WalletRow>(`UPDATE workspace_api_wallets SET available_amount=available_amount-$2,spent_amount=spent_amount+$2,version=version+1 WHERE workspace_id=$1 RETURNING ${walletSelect}`,[input.workspaceId,charged.toFixed(6)],client)).rows[0]!;await query(`INSERT INTO workspace_api_wallet_ledger(workspace_id,ai_usage_ledger_id,entry_type,amount_delta,balance_after,idempotency_key,usd_cost,usd_cny_rate,metadata) VALUES($1,$2,'USAGE_DEBIT',$3,$4,$5,$6,$7,$8::jsonb)`,[input.workspaceId,input.usageLedgerId,(-charged).toFixed(6),wallet.availableAmount,key,input.customerCostUsd,input.usdCnyRate,JSON.stringify({responseId:input.responseId,requestedDebit:amount,fullyCovered:charged>=amount})],client);return{debited:charged>0,idempotent:false,amount:charged,balance:Number(wallet.availableAmount),exhausted:charged<amount};});}
