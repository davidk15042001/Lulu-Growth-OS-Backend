import { query } from '../../db/pool.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES, type DomainEvent } from '../../events/domain-event.types.js';
import { decimalToMinorUnits } from './money.js';
import { postBalancedJournal, type JournalLineInput } from './journal.service.js';

type InvoicePostingRow={id:string;invoiceType:string;status:string;currency:string;grandTotal:string;taxTotal:string;issuedAt:string|null};
type PaymentPostingRow={id:string;invoiceId:string;currency:string;amountMinor:string;paymentMethod:string;paymentReference:string|null;receivedAt:string;recordedBy:string|null};
let registered=false;

async function eventActorId(event:DomainEvent){const candidate=typeof event.metadata.actorId==='string'?event.metadata.actorId:null;if(!candidate)return null;return (await query<{id:string}>(`SELECT id FROM users WHERE id=$1`,[candidate])).rows[0]?.id??null;}

async function projectInvoiceIssued(event:DomainEvent,workspaceId:string,invoiceId:string){
  const invoice=(await query<InvoicePostingRow>(`SELECT id,invoice_type AS "invoiceType",status,currency,grand_total::text AS "grandTotal",tax_total::text AS "taxTotal",issued_at AS "issuedAt" FROM invoices WHERE workspace_id=$1 AND id=$2`,[workspaceId,invoiceId])).rows[0];
  if(!invoice)return {ignored:true,reason:'invoice_not_found'};
  if(invoice.invoiceType==='PROFORMA')return {ignored:true,reason:'proforma_is_not_a_receivable'};
  if(!['ISSUED','SENT','PARTIALLY_PAID','PAID','OVERDUE'].includes(invoice.status))return {ignored:true,reason:'invoice_not_issued'};
  const totalMinor=decimalToMinorUnits(invoice.grandTotal,invoice.currency);
  if(totalMinor===0)return {ignored:true,reason:'zero_value_invoice'};
  const taxMinor=Math.min(totalMinor,decimalToMinorUnits(invoice.taxTotal,invoice.currency));
  const revenueMinor=totalMinor-taxMinor;
  const lines:JournalLineInput[]=[{lineKey:'accounts-receivable',accountCode:'ACCOUNTS_RECEIVABLE',direction:'DEBIT',amountMinor:totalMinor}];
  if(revenueMinor>0)lines.push({lineKey:'sales-revenue',accountCode:'SALES_REVENUE',direction:'CREDIT',amountMinor:revenueMinor});
  if(taxMinor>0)lines.push({lineKey:'tax-payable',accountCode:'TAX_PAYABLE',direction:'CREDIT',amountMinor:taxMinor});
  const journal=await postBalancedJournal({workspaceId,journalType:'INVOICE_ISSUED',occurredAt:invoice.issuedAt??event.occurredAt,currency:invoice.currency,idempotencyKey:`invoice:${invoice.id}:issued:v1`,referenceType:'invoice',referenceId:invoice.id,actorId:await eventActorId(event),metadata:{source:'commercial-documents',operationalSubledger:true,roundingPolicy:'iso_minor_unit_half_up',taxSplit:taxMinor>0},lines});
  return {journalId:journal.id,idempotent:journal.idempotent};
}

async function projectInvoicePayment(_event:DomainEvent,workspaceId:string,paymentId:string){
  const payment=(await query<PaymentPostingRow>(`SELECT id,invoice_id AS "invoiceId",currency,amount_minor::text AS "amountMinor",payment_method AS "paymentMethod",payment_reference AS "paymentReference",received_at AS "receivedAt",recorded_by AS "recordedBy" FROM invoice_payments WHERE workspace_id=$1 AND id=$2`,[workspaceId,paymentId])).rows[0];
  if(!payment)return {ignored:true,reason:'payment_not_found'};
  const amountMinor=Number(payment.amountMinor);
  const journal=await postBalancedJournal({workspaceId,journalType:'INVOICE_PAYMENT_RECORDED',occurredAt:payment.receivedAt,currency:payment.currency,idempotencyKey:`invoice-payment:${payment.id}:recorded:v1`,referenceType:'invoice_payment',referenceId:payment.id,actorId:payment.recordedBy,metadata:{source:'commercial-documents',operationalSubledger:true,invoiceId:payment.invoiceId,paymentMethod:payment.paymentMethod,paymentReference:payment.paymentReference},lines:[{lineKey:'payment-clearing',accountCode:'PAYMENT_CLEARING',direction:'DEBIT',amountMinor},{lineKey:'accounts-receivable',accountCode:'ACCOUNTS_RECEIVABLE',direction:'CREDIT',amountMinor}]});
  return {journalId:journal.id,idempotent:journal.idempotent};
}

export async function projectInvoiceJournalEvent(event:DomainEvent){
  if(!event.workspaceId)return {ignored:true,reason:'workspace_required'};
  const invoiceId=typeof event.payload.invoiceId==='string'?event.payload.invoiceId:event.aggregateType==='invoice'?event.aggregateId:null;
  if(event.type===DOMAIN_EVENT_TYPES.INVOICE_ISSUED)return invoiceId?projectInvoiceIssued(event,event.workspaceId,invoiceId):{ignored:true,reason:'invoice_id_required'};
  if(event.type===DOMAIN_EVENT_TYPES.INVOICE_PARTIALLY_PAID||event.type===DOMAIN_EVENT_TYPES.INVOICE_PAID){const paymentId=typeof event.payload.paymentId==='string'?event.payload.paymentId:null;return paymentId?projectInvoicePayment(event,event.workspaceId,paymentId):{ignored:true,reason:'payment_id_required'};}
  return {ignored:true,reason:'unsupported_event'};
}

export function registerInvoiceJournalProjection(){if(registered)return;registered=true;registerDomainEventHandler({name:'finance.invoice-journal.v1',eventTypes:[DOMAIN_EVENT_TYPES.INVOICE_ISSUED,DOMAIN_EVENT_TYPES.INVOICE_PARTIALLY_PAID,DOMAIN_EVENT_TYPES.INVOICE_PAID],handle:projectInvoiceJournalEvent});}
