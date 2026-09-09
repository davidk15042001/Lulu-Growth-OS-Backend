import { assertWorkspaceCapability } from '../workspaces/workspace-authorization.service.js';
import { AppError, notFoundError } from '../../utils/app-error.js';
import * as repo from './commercial-documents.repo.js';
import type { CreateInvoiceInput, CreateQuoteInput, PolicyInput, SendDocumentInput } from './commercial-documents.validator.js';

type DocumentCapability = 'quotes.read'|'quotes.create'|'quotes.update'|'quotes.send'|'quotes.approve'|'invoices.read'|'invoices.create'|'invoices.issue'|'invoices.send'|'invoices.cancel'|'commercial_policy.read'|'commercial_policy.manage';

async function authorize(workspaceId: string, userId: string, capability: DocumentCapability) {
  return assertWorkspaceCapability({ workspaceId, userId, capability });
}

function estimate(lines: CreateQuoteInput['lines'], shipping = 0) {
  return lines.reduce((sum, line) => sum + (line.quantity * line.unitPrice) - (line.discount ?? 0) + (line.tax ?? 0), shipping);
}

async function enforceQuotePolicy(workspaceId: string, input: CreateQuoteInput) {
  if (input.creationMode !== 'AUTOMATIC' && input.creationMode !== 'AI_ASSISTED') return;
  const policy = await repo.getPolicy(workspaceId);
  if (!policy) throw new AppError(409, 'COMMERCIAL_POLICY_MISSING', 'A commercial policy must be configured before automatic quotes can be created');
  if (input.creationMode === 'AUTOMATIC' && !policy.automaticQuoteEnabled) throw new AppError(403, 'AUTOMATIC_QUOTE_DISABLED', 'Automatic quote creation is disabled for this workspace');
  const total = estimate(input.lines, input.shippingTotal ?? 0);
  if (policy.maxAutomaticQuoteValue != null && total > Number(policy.maxAutomaticQuoteValue)) throw new AppError(409, 'QUOTE_APPROVAL_REQUIRED', 'This quote exceeds the automatic value limit', { total, maxAutomaticQuoteValue: policy.maxAutomaticQuoteValue });
  const discount = input.lines.reduce((sum, line) => sum + (line.discount ?? 0), 0);
  const subtotal = input.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  if (subtotal > 0 && policy.automaticDiscountLimit != null && (discount / subtotal) * 100 > Number(policy.automaticDiscountLimit)) throw new AppError(409, 'QUOTE_APPROVAL_REQUIRED', 'This quote exceeds the automatic discount limit');
}

export async function listQuotes(workspaceId: string, userId: string, filters: Parameters<typeof repo.listQuotes>[1]) { await authorize(workspaceId,userId,'quotes.read'); return repo.listQuotes(workspaceId,filters); }
export async function getQuote(workspaceId: string, userId: string, id: string) { await authorize(workspaceId,userId,'quotes.read'); const result=await repo.getQuote(workspaceId,id);if(!result)throw notFoundError('Quote not found');return result; }
export async function createQuote(workspaceId: string,userId:string,input:CreateQuoteInput){await authorize(workspaceId,userId,'quotes.create');await enforceQuotePolicy(workspaceId,input);if(!input.customerRecordId)throw new AppError(422,'QUOTE_CUSTOMER_REQUIRED','A customer record is required for a quote');return repo.createQuote(workspaceId,userId,input);}
export async function reviseQuote(workspaceId:string,userId:string,id:string,input:CreateQuoteInput){await authorize(workspaceId,userId,'quotes.update');await enforceQuotePolicy(workspaceId,input);return repo.createQuoteRevision(workspaceId,id,userId,input);}
export async function sendQuote(workspaceId:string,userId:string,id:string,input:SendDocumentInput){await authorize(workspaceId,userId,'quotes.send');return repo.sendQuote(workspaceId,id,userId,input);}
export async function listInvoices(workspaceId:string,userId:string,filters:Parameters<typeof repo.listInvoices>[1]){await authorize(workspaceId,userId,'invoices.read');return repo.listInvoices(workspaceId,filters);}
export async function getDocumentSellerProfile(workspaceId:string,userId:string){await authorize(workspaceId,userId,'invoices.read');const profile=await repo.getDocumentSellerProfile(workspaceId);if(!profile)throw notFoundError('Company profile not found');return profile;}
export async function getInvoice(workspaceId:string,userId:string,id:string){await authorize(workspaceId,userId,'invoices.read');const result=await repo.getInvoice(workspaceId,id);if(!result)throw notFoundError('Invoice not found');return result;}
export async function createInvoice(workspaceId:string,userId:string,input:CreateInvoiceInput){await authorize(workspaceId,userId,'invoices.create');if(!input.customerRecordId)throw new AppError(422,'INVOICE_CUSTOMER_REQUIRED','A customer record is required for an invoice');return repo.createInvoice(workspaceId,userId,input);}
export async function issueInvoice(workspaceId:string,userId:string,id:string){await authorize(workspaceId,userId,'invoices.issue');return repo.issueInvoice(workspaceId,id,userId);}
export async function sendInvoice(workspaceId:string,userId:string,id:string,input:SendDocumentInput){await authorize(workspaceId,userId,'invoices.send');const result=await repo.sendInvoice(workspaceId,id,userId,input);if(!('documentPath' in result))return result;return {...result,documentPath:result.documentPath.replace('/api/v1/public/commercial-documents/','/documents/commercial/')};}
export async function getPolicy(workspaceId:string,userId:string){await authorize(workspaceId,userId,'commercial_policy.read');return repo.getPolicy(workspaceId);}
export async function updatePolicy(workspaceId:string,userId:string,input:PolicyInput){await authorize(workspaceId,userId,'commercial_policy.manage');return repo.updatePolicy(workspaceId,input,userId);}
export async function publicDocument(token:string){return repo.getPublicDocument(token);}
export async function acceptPublicQuote(token:string,decision:'ACCEPTED'|'DECLINED',comment:string|null){const result=await repo.acceptQuote(token,decision,comment);if(!result)throw notFoundError('Quote link not found or expired');return result;}
