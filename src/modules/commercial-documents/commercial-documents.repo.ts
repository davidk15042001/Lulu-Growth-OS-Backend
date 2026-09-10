import { randomBytes, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { conflictError, notFoundError } from '../../utils/app-error.js';
import type { CreateInvoiceInput, CreateQuoteInput, PolicyInput, SendDocumentInput } from './commercial-documents.validator.js';

const quoteSelect = `q.id,q.workspace_id AS "workspaceId",q.factory_id AS "factoryId",q.customer_record_id AS "customerRecordId",q.company_record_id AS "companyRecordId",q.lead_record_id AS "leadRecordId",q.opportunity_record_id AS "opportunityRecordId",q.quote_number AS "quoteNumber",q.status,q.currency,q.language,q.market_code AS "marketCode",q.current_version_id AS "currentVersionId",q.source,q.creation_mode AS "creationMode",q.handling_mode AS "handlingMode",q.assigned_user_id AS "assignedUserId",q.valid_until AS "validUntil",q.accepted_at AS "acceptedAt",q.declined_at AS "declinedAt",q.expired_at AS "expiredAt",q.metadata,q.version,q.created_by AS "createdBy",q.updated_by AS "updatedBy",q.created_at AS "createdAt",q.updated_at AS "updatedAt"`;
const invoiceSelect = `i.id,i.workspace_id AS "workspaceId",i.factory_id AS "factoryId",i.customer_record_id AS "customerRecordId",i.company_record_id AS "companyRecordId",i.order_record_id AS "orderRecordId",i.quote_id AS "quoteId",i.invoice_number AS "invoiceNumber",i.invoice_type AS "invoiceType",i.status,i.currency,i.language,i.issue_date AS "issueDate",i.due_date AS "dueDate",i.subtotal,i.discount_total AS "discountTotal",i.shipping_total AS "shippingTotal",i.tax_total AS "taxTotal",i.grand_total AS "grandTotal",i.amount_paid AS "amountPaid",i.amount_due AS "amountDue",i.source,i.creation_mode AS "creationMode",i.issue_stage AS "issueStage",i.payment_reference AS "paymentReference",i.issued_at AS "issuedAt",i.sent_at AS "sentAt",i.paid_at AS "paidAt",i.cancelled_at AS "cancelledAt",i.document_status AS "documentStatus",i.document_storage_reference AS "documentStorageReference",i.document_hash AS "documentHash",i.metadata,i.version,i.created_by AS "createdBy",i.updated_by AS "updatedBy",i.created_at AS "createdAt",i.updated_at AS "updatedAt"`;

export type DocumentSellerProfile = {
  companyName: string;
  industry: string | null;
  countryRegion: string | null;
  taxId: string | null;
  address: string | null;
  legalForm: string | null;
  legalRepresentative: string | null;
  phoneNumber: string | null;
  bankAccountNumber: string | null;
  bankOpeningBank: string | null;
  bankBranch: string | null;
  bankCode: string | null;
};

const documentSellerProfileSelect = `
  w.name AS "companyName",
  w.industry,
  w.country_region AS "countryRegion",
  w.tax_id AS "taxId",
  w.address,
  w.legal_form AS "legalForm",
  w.legal_representative AS "legalRepresentative",
  w.phone_number AS "phoneNumber",
  w.bank_account_number AS "bankAccountNumber",
  w.bank_opening_bank AS "bankOpeningBank",
  w.bank_branch AS "bankBranch",
  w.bank_code AS "bankCode"
`;

function isDocumentSellerProfile(value: unknown): value is DocumentSellerProfile {
  return Boolean(value && typeof value === 'object' && typeof (value as { companyName?: unknown }).companyName === 'string');
}

async function getCurrentDocumentSellerProfile(workspaceId: string, client?: PoolClient) {
  const result = await query<DocumentSellerProfile>(
    `SELECT ${documentSellerProfileSelect} FROM workspaces w WHERE w.id=$1 AND w.deleted_at IS NULL`,
    [workspaceId],
    client,
  );
  return result.rows[0] ?? null;
}

function normalizeCurrency(value: string) { return value.trim().toUpperCase(); }
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function publicToken() { return randomBytes(32).toString('hex'); }

async function nextNumber(client: PoolClient, workspaceId: string, type: 'QUOTE' | 'INVOICE') {
  await query(`INSERT INTO workspace_document_sequences(workspace_id,document_type,next_value) VALUES($1,$2,2) ON CONFLICT DO NOTHING`, [workspaceId, type], client);
  const result = await query<{ value: string }>(`UPDATE workspace_document_sequences SET next_value=next_value+1 WHERE workspace_id=$1 AND document_type=$2 RETURNING next_value-1 AS value`, [workspaceId, type], client);
  return Number(result.rows[0]?.value ?? 1);
}

async function updateQuoteTotals(client: PoolClient, workspaceId: string, versionId: string, shippingTotal: number) {
  await query(`UPDATE quote_versions v SET subtotal=COALESCE((SELECT SUM(quantity*unit_price) FROM quote_lines l WHERE l.workspace_id=v.workspace_id AND l.quote_version_id=v.id),0), discount_total=COALESCE((SELECT SUM(discount) FROM quote_lines l WHERE l.workspace_id=v.workspace_id AND l.quote_version_id=v.id),0), tax_total=COALESCE((SELECT SUM(tax) FROM quote_lines l WHERE l.workspace_id=v.workspace_id AND l.quote_version_id=v.id),0), shipping_total=$3, grand_total=GREATEST(0,COALESCE((SELECT SUM(line_total) FROM quote_lines l WHERE l.workspace_id=v.workspace_id AND l.quote_version_id=v.id),0)+$3) WHERE v.workspace_id=$1 AND v.id=$2`, [workspaceId, versionId, shippingTotal], client);
}
async function updateInvoiceTotals(client: PoolClient, workspaceId: string, invoiceId: string, shippingTotal: number) {
  await query(`UPDATE invoices i SET subtotal=COALESCE((SELECT SUM(quantity*unit_price) FROM invoice_lines l WHERE l.workspace_id=i.workspace_id AND l.invoice_id=i.id),0), discount_total=COALESCE((SELECT SUM(discount) FROM invoice_lines l WHERE l.workspace_id=i.workspace_id AND l.invoice_id=i.id),0), tax_total=COALESCE((SELECT SUM(tax) FROM invoice_lines l WHERE l.workspace_id=i.workspace_id AND l.invoice_id=i.id),0), shipping_total=$3, grand_total=GREATEST(0,COALESCE((SELECT SUM(line_total) FROM invoice_lines l WHERE l.workspace_id=i.workspace_id AND l.invoice_id=i.id),0)+$3), amount_due=GREATEST(0,COALESCE((SELECT SUM(line_total) FROM invoice_lines l WHERE l.workspace_id=i.workspace_id AND l.invoice_id=i.id),0)+$3-i.amount_paid) WHERE i.workspace_id=$1 AND i.id=$2`, [workspaceId, invoiceId, shippingTotal], client);
}

async function audit(client: PoolClient, workspaceId: string, actorId: string | null, action: string, type: string, id: string, afterData: unknown) {
  await query(`INSERT INTO audit_log(workspace_id,actor_id,action,entity_type,entity_id,after_data) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [workspaceId, actorId, action, type, id, JSON.stringify(afterData ?? {})], client);
}

async function assertRecordType(client: PoolClient, workspaceId: string, recordId: string | null | undefined, allowedTypes: readonly string[], label: string) {
  if (!recordId) return;
  const result = await query<{ resourceType: string }>(`SELECT resource_type AS "resourceType" FROM workspace_records WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`, [workspaceId, recordId], client);
  if (!result.rows[0]) throw notFoundError(`${label} not found`);
  if (!allowedTypes.includes(result.rows[0].resourceType)) throw conflictError(`${label} has an incompatible record type`);
}

export async function getPolicy(workspaceId: string, client?: PoolClient) {
  const result = await query(`SELECT workspace_id AS "workspaceId",automatic_quote_enabled AS "automaticQuoteEnabled",automatic_quote_send_enabled AS "automaticQuoteSendEnabled",max_automatic_quote_value AS "maxAutomaticQuoteValue",automatic_discount_limit AS "automaticDiscountLimit",minimum_margin AS "minimumMargin",allowed_currencies AS "allowedCurrencies",allowed_incoterms AS "allowedIncoterms",default_quote_validity_days AS "defaultQuoteValidityDays",default_payment_terms AS "defaultPaymentTerms",invoice_creation_policy AS "invoiceCreationPolicy",invoice_auto_send_enabled AS "invoiceAutoSendEnabled",invoice_reminder_policy AS "invoiceReminderPolicy",require_approval_for_custom_terms AS "requireApprovalForCustomTerms",version,created_at AS "createdAt",updated_at AS "updatedAt" FROM commercial_policies WHERE workspace_id=$1`, [workspaceId], client);
  if (result.rows[0]) return result.rows[0];
  const created = await query(`INSERT INTO commercial_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING workspace_id AS "workspaceId",automatic_quote_enabled AS "automaticQuoteEnabled",automatic_quote_send_enabled AS "automaticQuoteSendEnabled",max_automatic_quote_value AS "maxAutomaticQuoteValue",automatic_discount_limit AS "automaticDiscountLimit",minimum_margin AS "minimumMargin",allowed_currencies AS "allowedCurrencies",allowed_incoterms AS "allowedIncoterms",default_quote_validity_days AS "defaultQuoteValidityDays",default_payment_terms AS "defaultPaymentTerms",invoice_creation_policy AS "invoiceCreationPolicy",invoice_auto_send_enabled AS "invoiceAutoSendEnabled",invoice_reminder_policy AS "invoiceReminderPolicy",require_approval_for_custom_terms AS "requireApprovalForCustomTerms",version,created_at AS "createdAt",updated_at AS "updatedAt" FROM commercial_policies WHERE workspace_id=$1`, [workspaceId], client);
  if (created.rows[0]) return created.rows[0];
  const retry = await query(`SELECT workspace_id AS "workspaceId",automatic_quote_enabled AS "automaticQuoteEnabled",automatic_quote_send_enabled AS "automaticQuoteSendEnabled",max_automatic_quote_value AS "maxAutomaticQuoteValue",automatic_discount_limit AS "automaticDiscountLimit",minimum_margin AS "minimumMargin",allowed_currencies AS "allowedCurrencies",allowed_incoterms AS "allowedIncoterms",default_quote_validity_days AS "defaultQuoteValidityDays",default_payment_terms AS "defaultPaymentTerms",invoice_creation_policy AS "invoiceCreationPolicy",invoice_auto_send_enabled AS "invoiceAutoSendEnabled",invoice_reminder_policy AS "invoiceReminderPolicy",require_approval_for_custom_terms AS "requireApprovalForCustomTerms",version,created_at AS "createdAt",updated_at AS "updatedAt" FROM commercial_policies WHERE workspace_id=$1`, [workspaceId], client);
  return retry.rows[0] ?? null;
}

export async function updatePolicy(workspaceId: string, input: PolicyInput, actorId: string) {
  const keys: Array<[keyof PolicyInput, string]> = [
    ['automaticQuoteEnabled','automatic_quote_enabled'],['automaticQuoteSendEnabled','automatic_quote_send_enabled'],['maxAutomaticQuoteValue','max_automatic_quote_value'],['automaticDiscountLimit','automatic_discount_limit'],['minimumMargin','minimum_margin'],['allowedCurrencies','allowed_currencies'],['allowedIncoterms','allowed_incoterms'],['defaultQuoteValidityDays','default_quote_validity_days'],['defaultPaymentTerms','default_payment_terms'],['invoiceCreationPolicy','invoice_creation_policy'],['invoiceAutoSendEnabled','invoice_auto_send_enabled'],['invoiceReminderPolicy','invoice_reminder_policy'],['requireApprovalForCustomTerms','require_approval_for_custom_terms'],
  ];
  return withTransaction(async (client) => {
    await query(`INSERT INTO commercial_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING`, [workspaceId], client);
    const values: unknown[] = [workspaceId]; const assignments: string[] = [];
    for (const [key, column] of keys) { if (Object.prototype.hasOwnProperty.call(input, key)) { values.push(input[key]); assignments.push(`${column}=$${values.length}${column.endsWith('_policy') ? '::jsonb' : ''}`); } }
    if (assignments.length) { await query(`UPDATE commercial_policies SET ${assignments.join(',')},version=version+1,updated_at=NOW() WHERE workspace_id=$1`, values, client); }
    const policy = await getPolicy(workspaceId, client);
    await audit(client, workspaceId, actorId, 'commercial_policy.updated', 'commercial_policy', workspaceId, policy);
    return policy;
  });
}

export async function listQuotes(workspaceId: string, filters: { page: number; limit: number; status?: string | undefined; search?: string | undefined }) {
  const params: unknown[] = [workspaceId]; const where = ['q.workspace_id=$1'];
  if (filters.status) { params.push(filters.status); where.push(`q.status=$${params.length}`); }
  if (filters.search) { params.push(`%${filters.search}%`); where.push(`(q.quote_number ILIKE $${params.length} OR q.currency ILIKE $${params.length})`); }
  const count = await query<{ total: string }>(`SELECT count(*)::text total FROM quotes q WHERE ${where.join(' AND ')}`, params);
  params.push(filters.limit, (filters.page - 1) * filters.limit);
  const rows = await query(`SELECT ${quoteSelect},v.version_number AS "currentVersion",v.subtotal,v.discount_total AS "discountTotal",v.shipping_total AS "shippingTotal",v.tax_total AS "taxTotal",v.grand_total AS "grandTotal",v.document_status AS "documentStatus" FROM quotes q LEFT JOIN quote_versions v ON v.workspace_id=q.workspace_id AND v.id=q.current_version_id WHERE ${where.join(' AND ')} ORDER BY q.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { items: rows.rows, pagination: { page: filters.page, limit: filters.limit, total: Number(count.rows[0]?.total ?? 0), pages: Math.ceil(Number(count.rows[0]?.total ?? 0) / filters.limit) } };
}

export async function getQuote(workspaceId: string, id: string) {
  const quote = await query(`SELECT ${quoteSelect} FROM quotes q WHERE q.workspace_id=$1 AND q.id=$2`, [workspaceId, id]);
  if (!quote.rows[0]) return null;
  const versions = await query(`SELECT id,workspace_id AS "workspaceId",quote_id AS "quoteId",version_number AS "versionNumber",status,currency,subtotal,discount_total AS "discountTotal",shipping_total AS "shippingTotal",tax_total AS "taxTotal",grand_total AS "grandTotal",valid_until AS "validUntil",terms_snapshot AS "termsSnapshot",commercial_policy_snapshot AS "commercialPolicySnapshot",created_by_actor_type AS "createdByActorType",created_by_actor_id AS "createdByActorId",document_status AS "documentStatus",document_storage_reference AS "documentStorageReference",document_hash AS "documentHash",created_at AS "createdAt",sent_at AS "sentAt" FROM quote_versions WHERE workspace_id=$1 AND quote_id=$2 ORDER BY version_number DESC`, [workspaceId, id]);
  const lines = await query(`SELECT id,quote_version_id AS "quoteVersionId",product_id AS "productId",variant_id AS "variantId",sku_snapshot AS "sku",product_name_snapshot AS "productName",description_snapshot AS "description",specifications_snapshot AS "specifications",quantity,quantity_unit AS "quantityUnit",unit_price AS "unitPrice",discount,tax,line_total AS "lineTotal",lead_time_snapshot AS "leadTime",moq_snapshot AS "moq",customization_notes AS "customizationNotes",price_source AS "priceSource",source_reference AS "sourceReference",sort_order AS "sortOrder" FROM quote_lines WHERE workspace_id=$1 AND quote_version_id IN (SELECT id FROM quote_versions WHERE workspace_id=$1 AND quote_id=$2) ORDER BY sort_order,id`, [workspaceId, id]);
  const deliveries = await query(`SELECT id,document_type AS "documentType",document_id AS "documentId",document_version_id AS "documentVersionId",conversation_id AS "conversationId",channel,recipient,status,provider_message_id AS "providerMessageId",failure_reason AS "failureReason",actor_type AS "actorType",actor_id AS "actorId",sent_at AS "sentAt",delivered_at AS "deliveredAt",failed_at AS "failedAt",created_at AS "createdAt" FROM document_deliveries WHERE workspace_id=$1 AND document_type='QUOTE' AND document_id=$2 ORDER BY created_at DESC`, [workspaceId, id]);
  return { quote: quote.rows[0], versions: versions.rows, lines: lines.rows, deliveries: deliveries.rows };
}

export async function createQuote(workspaceId: string, actorId: string, input: CreateQuoteInput) {
  const result = await withTransaction(async (client) => {
    await assertRecordType(client, workspaceId, input.customerRecordId, ['customers', 'ecommerce_customers', 'finance_customers'], 'Customer');
    await assertRecordType(client, workspaceId, input.companyRecordId, ['crm_companies'], 'Company');
    await assertRecordType(client, workspaceId, input.leadRecordId, ['crm_leads', 'sales_leads'], 'Lead');
    await assertRecordType(client, workspaceId, input.opportunityRecordId, ['opportunities', 'sales_opportunities', 'growth_opportunities'], 'Opportunity');
    const number = await nextNumber(client, workspaceId, 'QUOTE');
    const quoteNumber = `QUO-${new Date().getUTCFullYear()}-${String(number).padStart(6, '0')}`;
    const quote = (await query(`INSERT INTO quotes(workspace_id,factory_id,customer_record_id,company_record_id,lead_record_id,opportunity_record_id,quote_number,currency,language,market_code,source,creation_mode,handling_mode,assigned_user_id,valid_until,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING id`, [workspaceId,input.factoryId??null,input.customerRecordId??null,input.companyRecordId??null,input.leadRecordId??null,input.opportunityRecordId??null,quoteNumber,normalizeCurrency(input.currency),input.language??'en',input.marketCode??null,input.source??'workspace',input.creationMode??'MANUAL',input.handlingMode??'AUTONOMOUS',null,input.validUntil??null,actorId], client)).rows[0];
    if (!quote) throw new Error('Quote insert did not return a row');
    const version = (await query(`INSERT INTO quote_versions(workspace_id,quote_id,version_number,status,currency,valid_until,terms_snapshot,created_by_actor_type,created_by_actor_id) VALUES($1,$2,1,'DRAFT',$3,$4,$5::jsonb,'USER',$6) RETURNING id`, [workspaceId,quote.id,normalizeCurrency(input.currency),input.validUntil??null,JSON.stringify(input.terms??{}),actorId], client)).rows[0];
    if (!version) throw new Error('Quote version insert did not return a row');
    for (const [index, line] of input.lines.entries()) await query(`INSERT INTO quote_lines(workspace_id,quote_version_id,product_id,variant_id,sku_snapshot,product_name_snapshot,description_snapshot,specifications_snapshot,quantity,quantity_unit,unit_price,discount,tax,lead_time_snapshot,moq_snapshot,customization_notes,price_source,source_reference,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`, [workspaceId,version.id,line.productId??null,line.variantId??null,line.sku??null,line.productName,line.description??null,JSON.stringify(line.specifications??{}),line.quantity,line.quantityUnit??null,line.unitPrice,line.discount??0,line.tax??0,line.leadTime??null,line.moq??null,line.customizationNotes??null,line.priceSource??'MANUAL',line.sourceReference??null,line.sortOrder??index], client);
    await updateQuoteTotals(client, workspaceId, version.id, input.shippingTotal??0);
    await query(`UPDATE quotes SET current_version_id=$3 WHERE workspace_id=$1 AND id=$2`, [workspaceId,quote.id,version.id], client);
    await audit(client, workspaceId, actorId, 'quote.created', 'quote', quote.id, { quoteNumber, creationMode: input.creationMode??'MANUAL' });
    await appendDomainEvent({workspaceId,type:DOMAIN_EVENT_TYPES.QUOTE_CREATED,aggregateType:'quote',aggregateId:quote.id,payload:{quoteId:quote.id,quoteNumber,versionId:version.id},metadata:{actorId,source:'commercial-documents'},idempotencyKey:`quote:${quote.id}:created`},client);
    return quote.id as string;
  });
  return getQuote(workspaceId, result);
}

export async function createQuoteRevision(workspaceId: string, quoteId: string, actorId: string, input: CreateQuoteInput) {
  const result = await withTransaction(async (client) => {
    await assertRecordType(client, workspaceId, input.customerRecordId, ['customers', 'ecommerce_customers', 'finance_customers'], 'Customer');
    await assertRecordType(client, workspaceId, input.companyRecordId, ['crm_companies'], 'Company');
    await assertRecordType(client, workspaceId, input.leadRecordId, ['crm_leads', 'sales_leads'], 'Lead');
    await assertRecordType(client, workspaceId, input.opportunityRecordId, ['opportunities', 'sales_opportunities', 'growth_opportunities'], 'Opportunity');
    const current = (await query<{ id:string; versionNumber:number; status:string }>(`SELECT qv.id,qv.version_number AS "versionNumber",qv.status FROM quote_versions qv JOIN quotes q ON q.workspace_id=qv.workspace_id AND q.current_version_id=qv.id WHERE q.workspace_id=$1 AND q.id=$2 FOR UPDATE`, [workspaceId,quoteId], client)).rows[0];
    if (!current) throw notFoundError('Quote not found');
    if (['CANCELLED','EXPIRED'].includes(current.status)) throw conflictError('This quote cannot be revised');
    await query(`UPDATE quote_versions SET status='SUPERSEDED' WHERE workspace_id=$1 AND id=$2 AND status NOT IN ('SUPERSEDED','CANCELLED')`, [workspaceId,current.id], client);
    const next = current.versionNumber + 1;
    const version = (await query(`INSERT INTO quote_versions(workspace_id,quote_id,version_number,status,currency,valid_until,terms_snapshot,created_by_actor_type,created_by_actor_id) VALUES($1,$2,$3,'DRAFT',$4,$5,$6::jsonb,'USER',$7) RETURNING id`, [workspaceId,quoteId,next,normalizeCurrency(input.currency),input.validUntil??null,JSON.stringify(input.terms??{}),actorId],client)).rows[0];
    if (!version) throw new Error('Quote revision insert did not return a row');
    for (const [index,line] of input.lines.entries()) await query(`INSERT INTO quote_lines(workspace_id,quote_version_id,product_id,variant_id,sku_snapshot,product_name_snapshot,description_snapshot,specifications_snapshot,quantity,quantity_unit,unit_price,discount,tax,lead_time_snapshot,moq_snapshot,customization_notes,price_source,source_reference,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`, [workspaceId,version.id,line.productId??null,line.variantId??null,line.sku??null,line.productName,line.description??null,JSON.stringify(line.specifications??{}),line.quantity,line.quantityUnit??null,line.unitPrice,line.discount??0,line.tax??0,line.leadTime??null,line.moq??null,line.customizationNotes??null,line.priceSource??'MANUAL',line.sourceReference??null,line.sortOrder??index],client);
    await updateQuoteTotals(client,workspaceId,version.id,input.shippingTotal??0);
    await query(`UPDATE quotes SET current_version_id=$3,status='DRAFT',version=version+1,updated_by=$4 WHERE workspace_id=$1 AND id=$2`, [workspaceId,quoteId,version.id,actorId],client);
    await audit(client,workspaceId,actorId,'quote.version_created','quote',quoteId,{versionNumber:next});
    await appendDomainEvent({workspaceId,type:DOMAIN_EVENT_TYPES.QUOTE_VERSION_CREATED,aggregateType:'quote',aggregateId:quoteId,payload:{quoteId,versionId:version.id,versionNumber:next},metadata:{actorId,source:'commercial-documents'},idempotencyKey:`quote:${quoteId}:version:${next}`},client);
    return quoteId;
  });
  return getQuote(workspaceId,result);
}

async function createLink(client: PoolClient, workspaceId: string, documentType: 'QUOTE'|'INVOICE', documentId: string, expiresAt: string | null) {
  const token = publicToken();
  await query(`INSERT INTO commercial_document_links(workspace_id,document_type,document_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)`, [workspaceId,documentType,documentId,hash(token),expiresAt], client);
  return token;
}

export async function sendQuote(workspaceId: string, quoteId: string, actorId: string, input: SendDocumentInput) {
  return withTransaction(async (client) => {
    const row = (await query<any>(`SELECT q.*,qv.id AS version_id,qv.version_number,qv.status AS version_status,qv.document_status,qv.grand_total FROM quotes q JOIN quote_versions qv ON qv.workspace_id=q.workspace_id AND qv.id=q.current_version_id WHERE q.workspace_id=$1 AND q.id=$2 FOR UPDATE`, [workspaceId,quoteId],client)).rows[0];
    if (!row) throw notFoundError('Quote not found');
    if (!['DRAFT','READY','AWAITING_APPROVAL','SENT'].includes(row.version_status)) throw conflictError('Only a draft or approved quote can be sent');
    if (row.handling_mode === 'PROHIBITED') throw conflictError('This quote is blocked by commercial policy');
    const existingKey = input.operationKey ?? `quote:${quoteId}:version:${row.version_number}:send`;
    const prior = (await query(`SELECT result FROM commercial_document_idempotency WHERE workspace_id=$1 AND operation_key=$2`,[workspaceId,existingKey],client)).rows[0];
    if (prior?.result) return { ...(prior.result as Record<string,unknown>), idempotent: true };
    const link = await createLink(client,workspaceId,'QUOTE',quoteId,null);
    const reference = `/documents/commercial/${link}`;
    const hashValue = hash(JSON.stringify({quoteId,version:row.version_number,total:row.grand_total}));
    await query(`UPDATE quote_versions SET status='SENT',sent_at=NOW(),document_status='READY',document_storage_reference=$3,document_hash=$4 WHERE workspace_id=$1 AND id=$2`,[workspaceId,row.version_id,reference,hashValue],client);
    await query(`UPDATE quotes SET status='SENT',updated_by=$3 WHERE workspace_id=$1 AND id=$2`,[workspaceId,quoteId,actorId],client);
    let messageId: string | null = null;
    if (input.conversationId) {
      const conversation = (await query<{channelId:string;channelIdentityId:string}>(`SELECT channel_id AS "channelId",channel_identity_id AS "channelIdentityId" FROM omni_conversations WHERE workspace_id=$1 AND id=$2`,[workspaceId,input.conversationId],client)).rows[0];
      if (!conversation) throw notFoundError('Conversation not found');
      const message = (await query<{id:string}>(`INSERT INTO omni_messages(workspace_id,conversation_id,channel_id,channel_identity_id,direction,sender_type,sender_user_id,message_type,text_content,status,sent_at) VALUES($1,$2,$3,$4,'OUTBOUND','SYSTEM',$5,'SYSTEM',$6,'QUEUED',NOW()) RETURNING id`,[workspaceId,input.conversationId,conversation.channelId,conversation.channelIdentityId,actorId,`Quote ${row.quote_number} is ready: ${reference}`],client)).rows[0];
      messageId = message?.id ?? null;
    }
    const delivery = (await query<{id:string}>(`INSERT INTO document_deliveries(workspace_id,document_type,document_id,document_version_id,conversation_id,channel,recipient,message_id,actor_type,actor_id,status,sent_at) VALUES($1,'QUOTE',$2,$3,$4,$5,$6,$7,'USER',$8,'QUEUED',NOW()) RETURNING id`,[workspaceId,quoteId,row.version_id,input.conversationId,input.channel,input.recipient??null,messageId,actorId],client)).rows[0];
    const result = {quoteId,versionNumber:row.version_number,deliveryId:delivery?.id??null,documentPath:reference};
    await query(`INSERT INTO commercial_document_idempotency(workspace_id,operation_key,document_type,document_id,result) VALUES($1,$2,'DELIVERY',$3,$4::jsonb)`,[workspaceId,existingKey,quoteId,JSON.stringify(result)],client);
    await audit(client,workspaceId,actorId,'quote.sent','quote',quoteId,result);
    await appendDomainEvent({workspaceId,type:DOMAIN_EVENT_TYPES.QUOTE_SENT,aggregateType:'quote',aggregateId:quoteId,payload:result,metadata:{actorId,source:'commercial-documents'},idempotencyKey:`quote:${quoteId}:version:${row.version_number}:sent`},client);
    return result;
  });
}

export async function acceptQuote(token: string, decision: 'ACCEPTED'|'DECLINED', comment: string | null) {
  return withTransaction(async (client) => {
    const link = (await query<any>(`SELECT * FROM commercial_document_links WHERE token_hash=$1 AND document_type='QUOTE' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>NOW()) FOR UPDATE`,[hash(token)],client)).rows[0];
    if (!link) return null;
    const quote = (await query<any>(`SELECT q.*,qv.id AS version_id,qv.version_number FROM quotes q JOIN quote_versions qv ON qv.workspace_id=q.workspace_id AND qv.id=q.current_version_id WHERE q.id=$1 FOR UPDATE`,[link.document_id],client)).rows[0];
    if (!quote) return null;
    if (quote.status === 'ACCEPTED' && decision === 'ACCEPTED') return {quoteId:quote.id,status:'ACCEPTED',idempotent:true};
    const nextStatus = decision === 'ACCEPTED' ? 'ACCEPTED' : 'DECLINED';
    await query(`UPDATE quotes SET status=$2,accepted_at=CASE WHEN $2='ACCEPTED' THEN COALESCE(accepted_at,NOW()) ELSE accepted_at END,declined_at=CASE WHEN $2='DECLINED' THEN COALESCE(declined_at,NOW()) ELSE declined_at END WHERE id=$1`,[quote.id,nextStatus],client);
    await query(`UPDATE quote_versions SET status=$2 WHERE workspace_id=$1 AND id=$3`,[quote.workspace_id,nextStatus,quote.version_id],client);
    await audit(client,quote.workspace_id,null,`quote.${decision.toLowerCase()}`,'quote',quote.id,{comment});
    await appendDomainEvent({workspaceId:quote.workspace_id,type:decision==='ACCEPTED'?DOMAIN_EVENT_TYPES.QUOTE_ACCEPTED:DOMAIN_EVENT_TYPES.QUOTE_DECLINED,aggregateType:'quote',aggregateId:quote.id,payload:{quoteId:quote.id,versionNumber:quote.version_number,comment},metadata:{source:'public-document'}} ,client);
    return {quoteId:quote.id,status:nextStatus};
  });
}

export async function listInvoices(workspaceId: string, filters: { page:number; limit:number; status?:string | undefined; search?:string | undefined; dueBefore?:string | undefined }) {
  const params: unknown[]=[workspaceId]; const where=['i.workspace_id=$1'];
  if(filters.status){params.push(filters.status);where.push(`i.status=$${params.length}`);} if(filters.search){params.push(`%${filters.search}%`);where.push(`(i.invoice_number ILIKE $${params.length} OR i.currency ILIKE $${params.length})`);} if(filters.dueBefore){params.push(filters.dueBefore);where.push(`i.due_date <= $${params.length}`);}
  const count=await query<{total:string}>(`SELECT count(*)::text total FROM invoices i WHERE ${where.join(' AND ')}`,params); params.push(filters.limit,(filters.page-1)*filters.limit);
  const rows=await query(`SELECT ${invoiceSelect} FROM invoices i WHERE ${where.join(' AND ')} ORDER BY i.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,params);
  return {items:rows.rows,pagination:{page:filters.page,limit:filters.limit,total:Number(count.rows[0]?.total??0),pages:Math.ceil(Number(count.rows[0]?.total??0)/filters.limit)}};
}
export async function getDocumentSellerProfile(workspaceId: string) {
  return getCurrentDocumentSellerProfile(workspaceId);
}
export async function listAllQuotes(filters: { workspaceId?: string | undefined; status?: string | undefined; search?: string | undefined; limit?: number | undefined }) {
  const params: unknown[] = []; const where: string[] = [];
  if (filters.workspaceId) { params.push(filters.workspaceId); where.push(`q.workspace_id=$${params.length}`); }
  if (filters.status) { params.push(filters.status); where.push(`q.status=$${params.length}`); }
  if (filters.search) { params.push(`%${filters.search}%`); where.push(`(q.quote_number ILIKE $${params.length} OR q.currency ILIKE $${params.length} OR w.name ILIKE $${params.length})`); }
  params.push(Math.min(filters.limit ?? 200, 500));
  const rows = await query(`SELECT ${quoteSelect},w.name AS "workspaceName",v.version_number AS "currentVersion",v.grand_total AS "grandTotal" FROM quotes q JOIN workspaces w ON w.id=q.workspace_id LEFT JOIN quote_versions v ON v.workspace_id=q.workspace_id AND v.id=q.current_version_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY q.created_at DESC LIMIT $${params.length}`, params);
  return rows.rows;
}
export async function getInvoice(workspaceId:string,id:string){const invoice=await query<any>(`SELECT ${invoiceSelect} FROM invoices i WHERE i.workspace_id=$1 AND i.id=$2`,[workspaceId,id]);if(!invoice.rows[0])return null;const lines=await query(`SELECT id,product_id AS "productId",sku_snapshot AS "sku",product_name_snapshot AS "productName",description_snapshot AS "description",quantity,quantity_unit AS "quantityUnit",unit_price AS "unitPrice",discount,tax,line_total AS "lineTotal",sort_order AS "sortOrder" FROM invoice_lines WHERE workspace_id=$1 AND invoice_id=$2 ORDER BY sort_order,id`,[workspaceId,id]);const deliveries=await query(`SELECT id,document_type AS "documentType",document_id AS "documentId",conversation_id AS "conversationId",channel,recipient,status,provider_message_id AS "providerMessageId",failure_reason AS "failureReason",actor_type AS "actorType",actor_id AS "actorId",sent_at AS "sentAt",delivered_at AS "deliveredAt",failed_at AS "failedAt",created_at AS "createdAt" FROM document_deliveries WHERE workspace_id=$1 AND document_type='INVOICE' AND document_id=$2 ORDER BY created_at DESC`,[workspaceId,id]);const currentSellerProfile=await getCurrentDocumentSellerProfile(workspaceId);const snapshot=invoice.rows[0].metadata?.sellerProfile;return {invoice:invoice.rows[0],sellerProfile:isDocumentSellerProfile(snapshot)?snapshot:currentSellerProfile,lines:lines.rows,deliveries:deliveries.rows};}
export async function listAllInvoices(filters: { workspaceId?: string | undefined; status?: string | undefined; search?: string | undefined; limit?: number | undefined }) {
  const params: unknown[] = []; const where: string[] = [];
  if (filters.workspaceId) { params.push(filters.workspaceId); where.push(`i.workspace_id=$${params.length}`); }
  if (filters.status) { params.push(filters.status); where.push(`i.status=$${params.length}`); }
  if (filters.search) { params.push(`%${filters.search}%`); where.push(`(i.invoice_number ILIKE $${params.length} OR i.currency ILIKE $${params.length} OR w.name ILIKE $${params.length})`); }
  params.push(Math.min(filters.limit ?? 200, 500));
  const rows = await query(`SELECT ${invoiceSelect},w.name AS "workspaceName" FROM invoices i JOIN workspaces w ON w.id=i.workspace_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.created_at DESC LIMIT $${params.length}`, params);
  return rows.rows;
}

export async function createInvoice(workspaceId:string,actorId:string,input:CreateInvoiceInput){const result=await withTransaction(async(client)=>{await assertRecordType(client,workspaceId,input.customerRecordId,['customers','ecommerce_customers','finance_customers'],'Customer');await assertRecordType(client,workspaceId,input.companyRecordId,['crm_companies'],'Company');await assertRecordType(client,workspaceId,input.orderRecordId,['ecommerce_orders'],'Order');if(input.quoteId){const quote=await query(`SELECT 1 FROM quotes WHERE workspace_id=$1 AND id=$2`,[workspaceId,input.quoteId],client);if(!quote.rows[0])throw notFoundError('Quote not found');}if(input.orderRecordId){const existing=await query<{id:string}>(`SELECT id FROM invoices WHERE workspace_id=$1 AND order_record_id=$2 AND invoice_type=$3 AND status NOT IN ('CANCELLED','VOID') ORDER BY created_at DESC LIMIT 1`,[workspaceId,input.orderRecordId,input.invoiceType],client);if(existing.rows[0])return existing.rows[0].id;}const number=await nextNumber(client,workspaceId,'INVOICE');const invoiceNumber=`INV-${new Date().getUTCFullYear()}-${String(number).padStart(6,'0')}`;const invoice=(await query(`INSERT INTO invoices(workspace_id,factory_id,customer_record_id,company_record_id,order_record_id,quote_id,invoice_number,invoice_type,status,currency,language,issue_date,due_date,shipping_total,source,creation_mode,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,$10,$11,$12,$13,$14,$15,$16,$16) RETURNING id`,[workspaceId,input.factoryId??null,input.customerRecordId??null,input.companyRecordId??null,input.orderRecordId??null,input.quoteId??null,invoiceNumber,input.invoiceType,normalizeCurrency(input.currency),input.language??'en',input.issueDate??null,input.dueDate??null,input.shippingTotal??0,input.source??'workspace',input.creationMode??'MANUAL',actorId],client)).rows[0];if(!invoice)throw new Error('Invoice insert did not return a row');for(const[index,line]of input.lines.entries())await query(`INSERT INTO invoice_lines(workspace_id,invoice_id,product_id,sku_snapshot,product_name_snapshot,description_snapshot,quantity,quantity_unit,unit_price,discount,tax,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[workspaceId,invoice.id,line.productId??null,line.sku??null,line.productName,line.description??null,line.quantity,line.quantityUnit??null,line.unitPrice,line.discount??0,line.tax??0,line.sortOrder??index],client);await updateInvoiceTotals(client,workspaceId,invoice.id,input.shippingTotal??0);await audit(client,workspaceId,actorId,'invoice.created','invoice',invoice.id,{invoiceNumber,creationMode:input.creationMode??'MANUAL'});await appendDomainEvent({workspaceId,type:DOMAIN_EVENT_TYPES.INVOICE_CREATED,aggregateType:'invoice',aggregateId:invoice.id,payload:{invoiceId:invoice.id,invoiceNumber},metadata:{actorId,source:'commercial-documents'},idempotencyKey:`invoice:${invoice.id}:created`},client);return invoice.id as string;});return getInvoice(workspaceId,result);}

export async function issueInvoice(workspaceId:string,id:string,actorId:string){return withTransaction(async(client)=>{const row=(await query<any>(`SELECT * FROM invoices WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[workspaceId,id],client)).rows[0];if(!row)throw notFoundError('Invoice not found');if(!['DRAFT','READY','AWAITING_APPROVAL'].includes(row.status))throw conflictError('Only a draft or approved invoice can be issued');const lines=await query(`SELECT 1 FROM invoice_lines WHERE workspace_id=$1 AND invoice_id=$2 LIMIT 1`,[workspaceId,id],client);if(!lines.rows[0])throw conflictError('Invoice requires at least one line item');const sellerProfile=await getCurrentDocumentSellerProfile(workspaceId,client);if(!sellerProfile)throw conflictError('A company profile is required before issuing an invoice');await query(`UPDATE invoices SET status='ISSUED',issue_date=COALESCE(issue_date,CURRENT_DATE),issued_at=NOW(),amount_due=grand_total,metadata=metadata || jsonb_build_object('sellerProfile',$4::jsonb),updated_by=$3 WHERE workspace_id=$1 AND id=$2`,[workspaceId,id,actorId,JSON.stringify(sellerProfile)],client);await audit(client,workspaceId,actorId,'invoice.issued','invoice',id,{status:'ISSUED',sellerProfileCaptured:true});await appendDomainEvent({workspaceId,type:DOMAIN_EVENT_TYPES.INVOICE_ISSUED,aggregateType:'invoice',aggregateId:id,payload:{invoiceId:id},metadata:{actorId,source:'commercial-documents'},idempotencyKey:`invoice:${id}:issued`},client);return getInvoice(workspaceId,id);});}
export async function sendInvoice(workspaceId:string,id:string,actorId:string,input:SendDocumentInput){return withTransaction(async(client)=>{const row=(await query<any>(`SELECT * FROM invoices WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[workspaceId,id],client)).rows[0];if(!row)throw notFoundError('Invoice not found');if(!['ISSUED','SENT','PARTIALLY_PAID','OVERDUE'].includes(row.status))throw conflictError('Only an issued invoice can be sent');const key=input.operationKey??`invoice:${id}:send`;const prior=(await query(`SELECT result FROM commercial_document_idempotency WHERE workspace_id=$1 AND operation_key=$2`,[workspaceId,key],client)).rows[0];if(prior?.result)return {...(prior.result as Record<string,unknown>),idempotent:true};const link=await createLink(client,workspaceId,'INVOICE',id,null);const reference=`/api/v1/public/commercial-documents/${link}`;const hashValue=hash(JSON.stringify({invoiceId:id,total:row.grand_total}));await query(`UPDATE invoices SET status='SENT',document_status='READY',document_storage_reference=$3,document_hash=$4,sent_at=NOW(),updated_by=$5 WHERE workspace_id=$1 AND id=$2`,[workspaceId,id,reference,hashValue,actorId],client);const delivery=(await query<{id:string}>(`INSERT INTO document_deliveries(workspace_id,document_type,document_id,channel,recipient,actor_type,actor_id,status,sent_at) VALUES($1,'INVOICE',$2,$3,$4,'USER',$5,'QUEUED',NOW()) RETURNING id`,[workspaceId,id,input.channel,input.recipient??null,actorId],client)).rows[0];const result={invoiceId:id,deliveryId:delivery?.id??null,documentPath:reference};await query(`INSERT INTO commercial_document_idempotency(workspace_id,operation_key,document_type,document_id,result) VALUES($1,$2,'DELIVERY',$3,$4::jsonb)`,[workspaceId,key,id,JSON.stringify(result)],client);await audit(client,workspaceId,actorId,'invoice.sent','invoice',id,result);await appendDomainEvent({workspaceId,type:DOMAIN_EVENT_TYPES.INVOICE_SENT,aggregateType:'invoice',aggregateId:id,payload:result,metadata:{actorId,source:'commercial-documents'},idempotencyKey:`invoice:${id}:sent`},client);return result;});}

export async function getPublicDocument(token:string){const result=await query<any>(`SELECT l.workspace_id,l.document_type,l.document_id,${documentSellerProfileSelect},q.quote_number,q.status AS quote_status,q.currency AS quote_currency,q.language AS quote_language,qv.version_number,qv.subtotal,qv.discount_total,qv.shipping_total,qv.tax_total,qv.grand_total,qv.valid_until,qv.terms_snapshot, i.invoice_number,i.status AS invoice_status,i.currency AS invoice_currency,i.language AS invoice_language,i.issue_date,i.due_date,i.subtotal AS invoice_subtotal,i.discount_total AS invoice_discount_total,i.shipping_total AS invoice_shipping_total,i.tax_total AS invoice_tax_total,i.grand_total AS invoice_grand_total,i.amount_paid,i.amount_due,i.metadata AS invoice_metadata FROM commercial_document_links l JOIN workspaces w ON w.id=l.workspace_id LEFT JOIN quotes q ON l.document_type='QUOTE' AND q.workspace_id=l.workspace_id AND q.id=l.document_id LEFT JOIN quote_versions qv ON qv.workspace_id=q.workspace_id AND qv.id=q.current_version_id LEFT JOIN invoices i ON l.document_type='INVOICE' AND i.workspace_id=l.workspace_id AND i.id=l.document_id WHERE l.token_hash=$1 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at>NOW())`,[hash(token)]);const row=result.rows[0];if(!row)return null;const sellerProfile=isDocumentSellerProfile(row.invoice_metadata?.sellerProfile)?row.invoice_metadata.sellerProfile:{companyName:row.companyName,industry:row.industry,countryRegion:row.countryRegion,taxId:row.taxId,address:row.address,legalForm:row.legalForm,legalRepresentative:row.legalRepresentative,phoneNumber:row.phoneNumber,bankAccountNumber:row.bankAccountNumber,bankOpeningBank:row.bankOpeningBank,bankBranch:row.bankBranch,bankCode:row.bankCode};if(row.document_type==='QUOTE'){const lines=await query(`SELECT product_name_snapshot AS "productName",description_snapshot AS "description",quantity,quantity_unit AS "quantityUnit",unit_price AS "unitPrice",discount,tax,line_total AS "lineTotal" FROM quote_lines WHERE workspace_id=$1 AND quote_version_id=(SELECT current_version_id FROM quotes WHERE workspace_id=$1 AND id=$2) ORDER BY sort_order`,[row.workspace_id,row.document_id]);return {type:'QUOTE',number:row.quote_number,status:row.quote_status,currency:row.quote_currency,language:row.quote_language,versionNumber:row.version_number,validUntil:row.valid_until,subtotal:row.subtotal,discountTotal:row.discount_total,shippingTotal:row.shipping_total,taxTotal:row.tax_total,grandTotal:row.grand_total,terms:row.terms_snapshot,sellerProfile,lines:lines.rows};}const lines=await query(`SELECT product_name_snapshot AS "productName",description_snapshot AS "description",quantity,quantity_unit AS "quantityUnit",unit_price AS "unitPrice",discount,tax,line_total AS "lineTotal" FROM invoice_lines WHERE workspace_id=$1 AND invoice_id=$2 ORDER BY sort_order`,[row.workspace_id,row.document_id]);const snapshot=isDocumentSellerProfile(row.invoice_metadata?.sellerProfile)?row.invoice_metadata.sellerProfile:sellerProfile;return {type:'INVOICE',number:row.invoice_number,status:row.invoice_status,currency:row.invoice_currency,language:row.invoice_language,issueDate:row.issue_date,dueDate:row.due_date,subtotal:row.invoice_subtotal,discountTotal:row.invoice_discount_total,shippingTotal:row.invoice_shipping_total,taxTotal:row.invoice_tax_total,grandTotal:row.invoice_grand_total,amountPaid:row.amount_paid,amountDue:row.amount_due,sellerProfile:snapshot,lines:lines.rows};}
