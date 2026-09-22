import { createHash } from 'node:crypto';
import { logger } from '../../config/logger.js';
import { isResourceType, type ResourceType } from '../../domain/resource-catalog.js';
import { query, withTransaction } from '../../db/pool.js';
import { AppError, notFoundError } from '../../utils/app-error.js';
import * as recordRepo from '../records/record.repo.js';
import { createAiDraft, createDraft, sendDraft } from '../email/email.service.js';
import { updateGoogleReviewReply } from '../workspace-app/workspace-app.service.js';
import { publishWebsiteJob } from '../websites/website.publish.service.js';
import { verifyDomainOwnership } from '../websites/domain-verification.service.js';
import { startContentRefresh } from '../content-generation/content-generation.service.js';
import { evaluateAgentActionPolicy } from '../agents/agent.autonomy-policy.js';
import { resolveWorkspaceEntitlements } from '../entitlements/entitlement.service.js';
import { assertWorkspaceCapability } from '../workspaces/workspace-authorization.service.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import { executeAdvertisingProviderOperation } from '../adspend/advertising.provider.service.js';
import { sendAutonomousMessage } from '../omnichannel/omnichannel.service.js';
import { assertWorkspaceProviderLaunchReady } from '../provider-control/provider.service.js';
import * as commercialDocuments from '../commercial-documents/commercial-documents.service.js';
import { createInvoiceSchema, sendDocumentSchema } from '../commercial-documents/commercial-documents.validator.js';
import { createQuoteSchema } from '../commercial-documents/commercial-documents.validator.js';
import { getWorkspaceBusinessIdentity } from '../business-identity/identity.service.js';
import * as calendarService from '../calendar/calendar.service.js';
import { createNativeEventSchema } from '../calendar/calendar.validator.js';
import * as commerceService from '../commerce/commerce.service.js';
import { adjustInventorySchema, createFulfillmentSchema, createOrderSchema, transitionFulfillmentSchema, transitionOrderSchema, updateOrderSchema } from '../commerce/commerce.validator.js';
import * as productService from '../products/product.service.js';
import { createCategorySchema, createProductSchema, updateCategorySchema, updateProductSchema } from '../products/product.validator.js';
import { generateProductImagesFromText } from '../product-images/product-image.service.js';
import * as websiteRepo from '../websites/website.repo.js';
import { requestWebsiteGenerationWorkerRun } from '../websites/website.worker.js';
import * as socialPublishingService from '../social-publishing/social-publishing.service.js';
import { createSocialContentSchema, createSocialPublicationSchema, transitionSocialPublicationSchema } from '../social-publishing/social-publishing.validator.js';
import { requestSocialPublishingWorkerRun } from '../social-publishing/social-publishing.worker.js';
import * as salesPipelineService from '../sales-pipeline/sales-pipeline.service.js';
import { SALES_PIPELINE_RESOURCE_TYPES, type SalesPipelineResourceType } from '../sales-pipeline/sales-pipeline.types.js';
import { requestCompanyIntelligence } from '../crm-company/company-intelligence.service.js';
import { syncCrmCompany, type CrmCompanySyncProvider } from '../provider-control/crm-company-sync.service.js';
import * as payoutService from '../finance/payout.service.js';
import { requestPayoutSchema } from '../finance/payout.validator.js';
import {
  assistantActionInputSchema,
  type AssistantActionInput,
  type AssistantActionStatus,
  type AssistantPendingAction,
} from './assistant-action.types.js';

type AssistantActionRow = {
  id: string;
  workspaceId: string;
  conversationId: string;
  requestedBy: string;
  type: AssistantActionInput['type'];
  summary: string;
  payload: Record<string, unknown>;
  payloadDigest: string;
  status: AssistantActionStatus;
  approvalId: string | null;
  idempotencyKey: string;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  expiresAt: string;
};

const actionSelect = `id,workspace_id AS "workspaceId",conversation_id AS "conversationId",requested_by AS "requestedBy",
  action_type AS type,summary,payload,payload_digest AS "payloadDigest",status,approval_id AS "approvalId",
  idempotency_key AS "idempotencyKey",result,error_code AS "errorCode",error_message AS "errorMessage",expires_at AS "expiresAt"`;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function digestAction(action: AssistantActionInput) {
  return createHash('sha256').update(JSON.stringify(canonical(action))).digest('hex');
}

function requiresAssistantConfirmation(type: AssistantActionInput['type']) {
  return [
    'finance.invoice.create_and_send',
    'finance.invoice.issue',
    'finance.invoice.send',
    'finance.payout.request',
    'finance.payout.submit',
    'sales.quote.send',
    'email.send_draft',
    'omnichannel.send_message',
    'website.publish_job',
    'social.content.publish',
  ].includes(type);
}

function publicAction(row: AssistantActionRow): AssistantPendingAction {
  const requiresApproval = requiresAssistantConfirmation(row.type);
  return {
    id: row.id,
    conversationId: row.conversationId,
    type: row.type,
    summary: row.summary,
    payload: row.payload,
    status: row.status,
    approvalId: row.approvalId,
    requiresApproval,
    result: row.result,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    expiresAt: row.expiresAt,
  };
}

function actionPolicy(type: AssistantActionInput['type'], autonomous: boolean) {
  return evaluateAgentActionPolicy(type, autonomous, {
    highRisk: type === 'google_reviews.reply'
      || type === 'website.publish_job'
      || type === 'finance.invoice.create_and_send'
      || type === 'finance.invoice.issue'
      || type === 'finance.invoice.send'
      || type === 'finance.payout.request'
      || type === 'finance.payout.submit'
      || type === 'email.send_draft'
      || type === 'social.content.publish',
  });
}

function textValue(value: unknown, maxLength = 400) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function emailAddresses(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const next = objectValue(item);
    const address = textValue(next.address).toLowerCase();
    if (!address) return [];
    const name = textValue(next.name) || null;
    return [{ address, ...(name ? { name } : {}) }];
  });
}

function normalizeSearch(value: string) {
  return value.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9@.]+/g, ' ').trim();
}

function recordEmails(record: { data: Record<string, unknown> }) {
  const emails = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 2 || value == null) return;
    if (typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
      emails.add(value.trim().toLowerCase());
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 20).forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value === 'object') Object.values(value as Record<string, unknown>).slice(0, 40).forEach((item) => visit(item, depth + 1));
  };
  visit(record.data, 0);
  return [...emails];
}

const invoiceCustomerResourceTypes = ['customers', 'ecommerce_customers', 'finance_customers'] as const;

async function resolveInvoiceRecipient(workspaceId: string, payload: Record<string, unknown>) {
  const requestedId = textValue(payload.customerRecordId, 120);
  const search = textValue(payload.recipientSearch || payload.recipient || payload.customerName || payload.recipientEmail, 200);
  const records = requestedId
    ? (await Promise.all(invoiceCustomerResourceTypes.map((resourceType) => recordRepo.findRecord(workspaceId, resourceType, requestedId)))).filter((record): record is NonNullable<typeof record> => Boolean(record))
    : (await Promise.all(invoiceCustomerResourceTypes.map(async (resourceType) => (await recordRepo.listRecords(workspaceId, resourceType, {
      page: 1,
      limit: 20,
      search: search || undefined,
      sort: 'updatedAt',
      order: 'desc',
    })).items))).flat();

  if (records.length === 0) {
    throw new AppError(409, requestedId ? 'INVOICE_CUSTOMER_NOT_FOUND' : 'INVOICE_CUSTOMER_REQUIRED', requestedId
      ? 'The requested customer record was not found in this workspace.'
      : 'Specify the customer name, email address, or customer record before creating the invoice.');
  }

  const normalizedQuery = normalizeSearch(search);
  const exactMatches = normalizedQuery
    ? records.filter((record) => [record.name, record.description ?? '', ...recordEmails(record)].map((value) => normalizeSearch(value)).some((value) => value === normalizedQuery))
    : records;
  const candidates = (exactMatches.length > 0 ? exactMatches : records).slice(0, 10);
  const uniqueCandidates = [...new Map(candidates.map((record) => [record.id, record])).values()];
  if (uniqueCandidates.length !== 1) {
    throw new AppError(409, 'INVOICE_CUSTOMER_AMBIGUOUS', 'More than one customer matches the requested recipient. Choose the exact customer before creating the invoice.', {
      candidates: uniqueCandidates.map((record) => ({ id: record.id, name: record.name, resourceType: record.resourceType, emails: recordEmails(record) })),
    });
  }
  const record = uniqueCandidates[0]!;
  const explicitEmail = textValue(payload.recipientEmail, 320).toLowerCase();
  const email = explicitEmail || recordEmails(record)[0] || '';
  if (!email) throw new AppError(409, 'INVOICE_RECIPIENT_EMAIL_REQUIRED', 'The customer is identified, but no recipient email is stored. Add an email address before sending the invoice.');
  return { record, email };
}

function numberValue(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim().replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function invoiceLines(payload: Record<string, unknown>, amount: number) {
  const supplied = Array.isArray(payload.lines) ? payload.lines : Array.isArray(payload.items) ? payload.items : [];
  if (supplied.length === 0) {
    return [{
      productName: textValue(payload.description || payload.productName, 300) || 'Professional services',
      description: textValue(payload.description, 5_000) || null,
      quantity: 1,
      unitPrice: amount,
      discount: 0,
      tax: 0,
      sortOrder: 0,
    }];
  }
  return supplied.slice(0, 500).map((item, index) => {
    const line = objectValue(item);
    const quantity = numberValue(line.quantity) ?? 1;
    const unitPrice = numberValue(line.unitPrice ?? line.price);
    if (quantity <= 0 || unitPrice == null || unitPrice < 0) throw new AppError(422, 'INVOICE_LINE_INVALID', 'Each invoice line needs a positive quantity and a valid unit price.');
    return {
      productName: textValue(line.productName || line.name, 300) || `Invoice item ${index + 1}`,
      description: textValue(line.description, 5_000) || null,
      quantity,
      unitPrice,
      discount: numberValue(line.discount) ?? 0,
      tax: numberValue(line.tax) ?? 0,
      sortOrder: index,
    };
  });
}

async function prepareInvoiceAction(workspaceId: string, action: AssistantActionInput): Promise<AssistantActionInput> {
  if (action.type !== 'finance.invoice.create_and_send') return action;
  const payload = objectValue(action.payload);
  const recipient = await resolveInvoiceRecipient(workspaceId, payload);
  const identity = await getWorkspaceBusinessIdentity(workspaceId);
  const currency = textValue(payload.currency, 3).toUpperCase() || identity.factory?.defaultCurrency?.toUpperCase() || '';
  if (!currency) throw new AppError(422, 'INVOICE_CURRENCY_REQUIRED', 'Specify the invoice currency or configure a workspace default currency before creating the invoice.');
  const suppliedLines = Array.isArray(payload.lines) ? payload.lines : Array.isArray(payload.items) ? payload.items : [];
  const explicitAmount = numberValue(payload.amount ?? payload.total ?? payload.value);
  const derivedAmount = suppliedLines.length > 0
    ? suppliedLines.reduce((sum, item) => {
      const line = objectValue(item);
      const quantity = numberValue(line.quantity) ?? 1;
      const unitPrice = numberValue(line.unitPrice ?? line.price) ?? 0;
      return sum + (quantity * unitPrice) - (numberValue(line.discount) ?? 0) + (numberValue(line.tax) ?? 0);
    }, 0)
    : null;
  if (explicitAmount != null && derivedAmount != null && Math.abs(explicitAmount - derivedAmount) > 0.005) {
    throw new AppError(422, 'INVOICE_AMOUNT_MISMATCH', 'The requested invoice amount does not match the supplied invoice lines.');
  }
  const amount = explicitAmount ?? derivedAmount;
  if (amount == null || amount <= 0) throw new AppError(422, 'INVOICE_AMOUNT_REQUIRED', 'Specify a positive invoice amount or at least one invoice line.');
  invoiceLines(payload, amount);
  return {
    ...action,
    payload: {
      ...payload,
      customerRecordId: recipient.record.id,
      recipientEmail: recipient.email,
      currency,
      amount,
    },
  };
}

async function assertAssistantProviderReadiness(workspaceId: string, action: AssistantPendingAction) {
  const payload = objectValue(action.payload);
  let provider: string | null = null;
  let reason = 'This assistant action requires a verified provider connection.';
  if (action.type === 'google_reviews.reply') {
    provider = 'google_business';
    reason = 'Google review replies require a verified Google Business provider.';
  } else if (action.type === 'omnichannel.send_message') {
    provider = textValue(payload.provider, 80) || null;
    reason = 'Omnichannel messages require the connected provider selected for the conversation.';
  } else if (action.type === 'advertising.create_optimization') {
    provider = textValue(payload.provider, 80) || 'google-ads';
    reason = 'Advertising actions require a verified advertising provider.';
  } else if (action.type === 'website.publish_job') {
    provider = textValue(payload.provider, 80) || 'lulu_managed_website';
    reason = 'Managed website publishing requires a verified Lulu website provider.';
  } else if (action.type === 'finance.payout.submit') {
    provider = 'airwallex';
    reason = 'Payout submission requires a verified Airwallex payout provider.';
  }
  if (provider) await assertWorkspaceProviderLaunchReady(workspaceId, provider, reason);
  else if (action.type === 'omnichannel.send_message') await assertWorkspaceProviderLaunchReady(workspaceId, null, reason);
}

function resultResourceType(type: string): ResourceType | null {
  if (type === 'crm.create_followup_task') return 'crm_tasks';
  if (type === 'sales.create_followup_task') return 'sales_tasks';
  if (type === 'advertising.create_optimization') return 'ad_optimizations';
  if (type === 'finance.create_automation') return 'finance_automations';
  if (type === 'website.publish_job') return 'marketing_publications';
  if (type === 'sales.quote.create' || type === 'sales.quote.send') return 'finance_quotes';
  if (type.startsWith('commerce.order.')) return 'ecommerce_orders';
  if (type.startsWith('commerce.product.')) return 'ecommerce_products';
  if (type === 'website.generate_content') return 'marketing_content';
  if (type === 'ecommerce.generate_product_images') return 'ecommerce_products';
  if (type.startsWith('finance.invoice.')) return 'finance_invoices';
  if (type.startsWith('finance.payout.')) return 'finance_payouts';
  if (type.startsWith('commerce.category.')) return 'ecommerce_categories';
  if (type.startsWith('commerce.fulfillment.')) return 'ecommerce_orders';
  if (type === 'commerce.inventory.adjust') return 'ecommerce_inventory';
  if (type.startsWith('social.')) return 'marketing_publications';
  return null;
}

async function createTaskRecord(workspaceId: string, userId: string, resourceType: ResourceType, action: AssistantPendingAction) {
  const payload = objectValue(action.payload);
  const item = await recordRepo.createRecord(workspaceId, resourceType, userId, {
    name: textValue(payload.title || action.summary, 240) || action.summary,
    description: textValue(payload.description || action.summary, 4000) || null,
    status: 'active',
    stage: 'prepared_by_agent',
    source: 'ai_assistant',
    externalId: action.id,
    tags: ['ai-assistant', action.type].slice(0, 12),
    data: {
      sourceAction: action.type,
      jobs: Array.isArray(payload.jobs) ? payload.jobs : [],
    },
  });
  return { resourceType, recordId: item.id, status: 'created' };
}

async function executeAssistantActionImplementation(workspaceId: string, userId: string, action: AssistantPendingAction) {
  const payload = objectValue(action.payload);

  if (action.type === 'google_reviews.reply') {
    const reviewId = textValue(payload.reviewId);
    const accountId = textValue(payload.accountId);
    const locationId = textValue(payload.locationId);
    const comment = textValue(payload.comment, 4000);
    if (!reviewId || !accountId || !locationId || !comment) {
      throw new Error('google_reviews.reply requires reviewId, accountId, locationId and comment');
    }
    await updateGoogleReviewReply(workspaceId, reviewId, { accountId, locationId, comment });
    return { status: 'updated', resourceType: 'activities' as ResourceType, recordId: null, message: 'Google review reply saved.' };
  }

  if (action.type === 'crm.company.enrich') {
    const companyId = textValue(payload.companyId || payload.recordId);
    if (!companyId) throw new AppError(422, 'CRM_COMPANY_ID_REQUIRED', 'crm.company.enrich requires companyId or recordId.');
    const queued = await requestCompanyIntelligence(workspaceId, companyId, userId);
    return { status: 'queued', resourceType: 'crm_companies' as ResourceType, recordId: companyId, message: 'Company intelligence enrichment queued.', company: queued };
  }

  if (action.type === 'crm.company.sync') {
    const companyId = textValue(payload.companyId || payload.recordId);
    const provider = textValue(payload.provider, 40).toLowerCase();
    if (!companyId || !['salesforce', 'hubspot', 'pipedrive'].includes(provider)) {
      throw new AppError(422, 'CRM_SYNC_INPUT_REQUIRED', 'crm.company.sync requires companyId and a supported CRM provider.');
    }
    const synced = await syncCrmCompany({
      workspaceId,
      companyId,
      provider: provider as CrmCompanySyncProvider,
      providerConnectionId: textValue(payload.providerConnectionId) || null,
    });
    return { status: 'synced', resourceType: 'crm_companies' as ResourceType, recordId: companyId, message: 'Company synchronized.', result: synced };
  }

  if (action.type === 'crm.transition_pipeline' || action.type === 'sales.transition_pipeline') {
    const resourceType = textValue(payload.resourceType, 80) as SalesPipelineResourceType;
    const recordId = textValue(payload.recordId);
    const targetState = textValue(payload.targetState || payload.stage || payload.status, 80);
    const expectedVersion = typeof payload.expectedVersion === 'number' && Number.isInteger(payload.expectedVersion)
      ? payload.expectedVersion
      : typeof payload.expectedVersion === 'string' && /^\d+$/.test(payload.expectedVersion.trim())
        ? Number.parseInt(payload.expectedVersion, 10)
        : undefined;
    if (!recordId || !targetState || !SALES_PIPELINE_RESOURCE_TYPES.includes(resourceType)) {
      throw new AppError(422, 'PIPELINE_TRANSITION_INPUT_REQUIRED', `${action.type} requires recordId, resourceType, and targetState.`);
    }
    const transitioned = await salesPipelineService.transitionRecord(workspaceId, resourceType, recordId, userId, {
      targetState,
      expectedVersion,
      reason: textValue(payload.reason || action.summary, 2_000) || null,
    });
    return { status: 'transitioned', resourceType: resourceType as ResourceType, recordId, message: 'Pipeline state updated.', record: transitioned };
  }

  if (action.type === 'email.create_draft') {
    const accountId = textValue(payload.accountId);
    if (!accountId) throw new Error('email.create_draft requires accountId');
    const draft = await createDraft(workspaceId, userId, {
      accountId,
      threadId: textValue(payload.threadId) || null,
      to: emailAddresses(payload.to),
      cc: emailAddresses(payload.cc),
      subject: textValue(payload.subject, 998),
      bodyText: textValue(payload.bodyText, 100_000),
      replyToProviderMessageId: textValue(payload.replyToProviderMessageId, 1000) || null,
    });
    return { status: 'drafted', resourceType: null, recordId: draft.id, message: 'Email draft created. Sending requires an explicit send action.' };
  }

  if (action.type === 'email.create_ai_draft') {
    const accountId = textValue(payload.accountId);
    const threadId = textValue(payload.threadId);
    if (!accountId || !threadId) throw new Error('email.create_ai_draft requires accountId and threadId');
    const draft = await createAiDraft(
      workspaceId,
      userId,
      threadId,
      {
        accountId,
        instruction: textValue(payload.instruction, 2000) || undefined,
        tone: textValue(payload.tone, 40) || 'professional',
        language: textValue(payload.language, 16) || 'en',
      },
      'automation',
      { generatedBy: 'ai_assistant' },
    );
    return { status: 'drafted', resourceType: null, recordId: draft.id, message: 'AI email draft created. Sending requires an explicit send action.' };
  }

  if (action.type === 'email.send_draft') {
    const draftId = textValue(payload.draftId);
    if (!draftId) throw new AppError(422, 'EMAIL_DRAFT_ID_REQUIRED', 'email.send_draft requires draftId.');
    const draft = await sendDraft(workspaceId, draftId);
    return { status: 'sent', resourceType: null, recordId: draftId, message: 'Email draft sent.', draft };
  }

  if (action.type === 'omnichannel.send_message') {
    const conversationId = textValue(payload.conversationId);
    const text = textValue(payload.text, 10_000);
    if (!conversationId || !text) throw new Error('omnichannel.send_message requires conversationId and text');
    const message = await sendAutonomousMessage(workspaceId, conversationId, userId, {
      text,
      messageType: textValue(payload.messageType, 20) || 'TEXT',
      clientMessageId: `assistant-action:${action.id}`,
      ...(textValue(payload.accountId) ? { accountId: textValue(payload.accountId) } : {}),
      ...(textValue(payload.recipientId) ? { recipientId: textValue(payload.recipientId) } : {}),
      ...(payload.recipientType === 'group' || payload.recipientType === 'channel' ? { recipientType: payload.recipientType } : {}),
    });
    return { status: 'sent', resourceType: null, recordId: message.id, message: 'Social message sent.', providerMessageId: message.providerMessageId };
  }

  if (action.type === 'sales.quote.create') {
    const customerRecordId = textValue(payload.customerRecordId);
    const currency = textValue(payload.currency, 3).toUpperCase();
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    if (!customerRecordId || !currency || lines.length === 0) throw new AppError(422, 'QUOTE_INPUT_REQUIRED', 'A quote requires customerRecordId, currency, and at least one line.');
    const quote = await commercialDocuments.createQuote(workspaceId, userId, createQuoteSchema.parse({
      customerRecordId,
      companyRecordId: textValue(payload.companyRecordId) || null,
      leadRecordId: textValue(payload.leadRecordId) || null,
      opportunityRecordId: textValue(payload.opportunityRecordId) || null,
      factoryId: textValue(payload.factoryId) || null,
      language: textValue(payload.language, 12) || 'en',
      marketCode: textValue(payload.marketCode, 20) || null,
      currency,
      validUntil: textValue(payload.validUntil, 10) || null,
      shippingTotal: payload.shippingTotal ?? 0,
      terms: objectValue(payload.terms),
      source: 'conversation',
      creationMode: 'AI_ASSISTED',
      handlingMode: 'USER_AUTHORIZATION_REQUIRED',
      conversationId: action.conversationId,
      lines,
    }));
    if (!quote?.quote?.id) throw new AppError(502, 'QUOTE_NOT_CREATED', 'The canonical quote service did not return a quote.');
    return { status: 'created', resourceType: 'finance_quotes' as ResourceType, recordId: quote.quote.id, message: `Quote ${quote.quote.quoteNumber} created.`, quote };
  }

  if (action.type === 'sales.quote.send') {
    const quoteId = textValue(payload.quoteId);
    if (!quoteId) throw new AppError(422, 'QUOTE_ID_REQUIRED', 'sales.quote.send requires quoteId.');
    const sent = await commercialDocuments.sendQuoteAutonomously(workspaceId, userId, quoteId, sendDocumentSchema.parse({
      conversationId: action.conversationId,
      channel: payload.channel === 'email' ? 'email' : 'secure_link',
      recipient: textValue(payload.recipient, 320) || null,
      operationKey: `assistant:${action.id}:quote-send`,
    }));
    return { status: 'sent', resourceType: 'finance_quotes' as ResourceType, recordId: quoteId, message: 'Quote queued for delivery.', sent };
  }

  if (action.type === 'calendar.event.create') {
    const event = await calendarService.createNativeEvent(workspaceId, userId, createNativeEventSchema.parse({
      title: textValue(payload.title, 300),
      description: textValue(payload.description, 4_000) || null,
      startAt: textValue(payload.startAt),
      endAt: textValue(payload.endAt),
      timezone: textValue(payload.timezone, 80) || 'UTC',
      location: textValue(payload.location, 500) || null,
      customerId: textValue(payload.customerId) || null,
    }));
    return { status: 'created', resourceType: null, recordId: event.id, message: 'Calendar event created.', event };
  }

  if (action.type === 'commerce.order.create') {
    const order = await commerceService.createOrder(workspaceId, {
      actorType: 'AI_AGENT', actorRef: action.id, correlationId: action.id, causationId: action.id,
    }, createOrderSchema.parse({ ...payload, source: 'conversation', idempotencyKey: `assistant:${action.id}:order-create` }));
    return { status: 'created', resourceType: 'ecommerce_orders' as ResourceType, recordId: order.order.id, message: `Order ${order.order.orderNumber} created.`, order };
  }

  if (action.type === 'commerce.order.update') {
    const orderId = textValue(payload.orderId);
    if (!orderId) throw new AppError(422, 'ORDER_ID_REQUIRED', 'commerce.order.update requires orderId.');
    const order = await commerceService.updateOrder(workspaceId, orderId, {
      actorType: 'AI_AGENT', actorRef: action.id, correlationId: action.id, causationId: action.id,
    }, updateOrderSchema.parse({ ...payload, idempotencyKey: `assistant:${action.id}:order-update` }));
    return { status: 'updated', resourceType: 'ecommerce_orders' as ResourceType, recordId: order.order.id, message: 'Order updated.', order };
  }

  if (action.type === 'commerce.order.transition') {
    const orderId = textValue(payload.orderId);
    if (!orderId) throw new AppError(422, 'ORDER_ID_REQUIRED', 'commerce.order.transition requires orderId.');
    const order = await commerceService.transitionOrder(workspaceId, orderId, {
      actorType: 'AI_AGENT', actorRef: action.id, correlationId: action.id, causationId: action.id,
    }, transitionOrderSchema.parse({ ...payload, idempotencyKey: `assistant:${action.id}:order-transition` }));
    return { status: 'transitioned', resourceType: 'ecommerce_orders' as ResourceType, recordId: order.order.id, message: 'Order status updated.', order };
  }

  if (action.type === 'commerce.product.create') {
    const product = await productService.createProduct(workspaceId, userId, createProductSchema.parse(payload));
    return { status: 'created', resourceType: 'ecommerce_products' as ResourceType, recordId: product.id, message: 'Product created.', product };
  }

  if (action.type === 'commerce.product.update') {
    const productId = textValue(payload.productId);
    if (!productId) throw new AppError(422, 'PRODUCT_ID_REQUIRED', 'commerce.product.update requires productId.');
    const product = await productService.updateProduct(workspaceId, productId, userId, updateProductSchema.parse(payload));
    return { status: 'updated', resourceType: 'ecommerce_products' as ResourceType, recordId: product.id, message: 'Product updated.', product };
  }

  if (action.type === 'commerce.category.create') {
    const category = await productService.createCategory(workspaceId, userId, createCategorySchema.parse(payload));
    return { status: 'created', resourceType: 'ecommerce_categories' as ResourceType, recordId: category.id, message: 'Product category created.', category };
  }

  if (action.type === 'commerce.category.update') {
    const categoryId = textValue(payload.categoryId);
    if (!categoryId) throw new AppError(422, 'CATEGORY_ID_REQUIRED', 'commerce.category.update requires categoryId.');
    const category = await productService.updateCategory(workspaceId, categoryId, userId, updateCategorySchema.parse(payload));
    return { status: 'updated', resourceType: 'ecommerce_categories' as ResourceType, recordId: category.id, message: 'Product category updated.', category };
  }

  if (action.type === 'commerce.inventory.adjust') {
    const level = await commerceService.adjustInventory(workspaceId, {
      actorType: 'AI_AGENT', actorRef: action.id, correlationId: action.id, causationId: action.id,
    }, adjustInventorySchema.parse({ ...payload, idempotencyKey: textValue(payload.idempotencyKey, 200) || `assistant:${action.id}:inventory-adjust` }));
    return { status: 'adjusted', resourceType: 'ecommerce_inventory' as ResourceType, recordId: level.id, message: 'Inventory adjusted.', level };
  }

  if (action.type === 'commerce.fulfillment.create') {
    const orderId = textValue(payload.orderId);
    if (!orderId) throw new AppError(422, 'ORDER_ID_REQUIRED', 'commerce.fulfillment.create requires orderId.');
    const fulfillment = await commerceService.createFulfillment(workspaceId, orderId, {
      actorType: 'AI_AGENT', actorRef: action.id, correlationId: action.id, causationId: action.id,
    }, createFulfillmentSchema.parse({ ...payload, idempotencyKey: textValue(payload.idempotencyKey, 200) || `assistant:${action.id}:fulfillment-create` }));
    return { status: 'created', resourceType: 'ecommerce_orders' as ResourceType, recordId: fulfillment.fulfillment.id, message: 'Fulfillment created.', fulfillment };
  }

  if (action.type === 'commerce.fulfillment.transition') {
    const orderId = textValue(payload.orderId);
    const fulfillmentId = textValue(payload.fulfillmentId);
    if (!orderId || !fulfillmentId) throw new AppError(422, 'FULFILLMENT_INPUT_REQUIRED', 'commerce.fulfillment.transition requires orderId and fulfillmentId.');
    const fulfillment = await commerceService.transitionFulfillment(workspaceId, orderId, fulfillmentId, {
      actorType: 'AI_AGENT', actorRef: action.id, correlationId: action.id, causationId: action.id,
    }, transitionFulfillmentSchema.parse({ ...payload, idempotencyKey: textValue(payload.idempotencyKey, 200) || `assistant:${action.id}:fulfillment-transition` }));
    return { status: 'transitioned', resourceType: 'ecommerce_orders' as ResourceType, recordId: fulfillment.fulfillment.id, message: 'Fulfillment status updated.', fulfillment };
  }

  if (action.type === 'website.generate_content') {
    const siteId = textValue(payload.siteId);
    const prompt = textValue(payload.prompt || action.summary, 8_000);
    if (!siteId || !prompt) throw new AppError(422, 'WEBSITE_CONTENT_INPUT_REQUIRED', 'website.generate_content requires siteId and prompt.');
    const site = await websiteRepo.getSite(workspaceId, siteId);
    if (!site) throw notFoundError('Website site not found');
    const created = await websiteRepo.createJob({ siteId, prompt, createdBy: userId, requestedLanguage: textValue(payload.language, 16) || 'en', autoPublish: false });
    if (!created.job) throw new AppError(502, 'WEBSITE_GENERATION_NOT_CREATED', 'Website content generation could not be queued.');
    requestWebsiteGenerationWorkerRun();
    return { status: 'queued', resourceType: 'marketing_content' as ResourceType, recordId: created.job.id, message: 'Website content generation queued.', job: created.job };
  }

  if (action.type === 'ecommerce.generate_product_images') {
    const sourceText = textValue(payload.sourceText, 20_000);
    if (!sourceText) throw new AppError(422, 'PRODUCT_IMAGE_INPUT_REQUIRED', 'ecommerce.generate_product_images requires sourceText.');
    const result = await generateProductImagesFromText(sourceText, workspaceId, userId);
    return { status: 'created', resourceType: 'ecommerce_products' as ResourceType, recordId: null, message: `${result.count} product image job(s) created.`, result };
  }

  if (action.type === 'website.domain.verify') {
    const siteId = textValue(payload.siteId);
    const domainId = textValue(payload.domainId);
    if (!siteId || !domainId) throw new AppError(422, 'WEBSITE_DOMAIN_INPUT_REQUIRED', 'website.domain.verify requires siteId and domainId.');
    const result = await verifyDomainOwnership({ workspaceId, siteId, domainId, userId });
    return { status: 'verified', resourceType: 'marketing_publications' as ResourceType, recordId: domainId, message: 'Website domain verification completed.', result };
  }

  if (action.type === 'social.content.publish') {
    const contentInput = createSocialContentSchema.parse({
      ...payload,
      status: 'READY',
      idempotencyKey: textValue(payload.idempotencyKey, 200) || `assistant:${action.id}:content`,
    });
    const contentResult = await socialPublishingService.createContent({
      workspaceId,
      actorId: userId,
      actorType: 'AI_AGENT',
      actorRef: action.id,
      contentType: contentInput.contentType,
      status: 'READY',
      message: contentInput.message,
      linkUrl: contentInput.linkUrl ?? null,
      mediaUrl: contentInput.mediaUrl ?? null,
      altText: contentInput.altText ?? null,
      metadata: { ...contentInput.metadata, sourceActionId: action.id },
      idempotencyKey: contentInput.idempotencyKey,
    });
    const publicationInput = createSocialPublicationSchema.parse({
      socialAccountId: payload.socialAccountId,
      contentId: contentResult.content.id,
      execution: 'QUEUE',
      scheduledAt: payload.scheduledAt ?? null,
      maxAttempts: payload.maxAttempts ?? 5,
      idempotencyKey: `assistant:${action.id}:publication`,
    });
    const publicationResult = await socialPublishingService.createPublication({
      workspaceId,
      actorId: userId,
      actorType: 'AI_AGENT',
      actorRef: action.id,
      socialAccountId: publicationInput.socialAccountId,
      contentId: publicationInput.contentId,
      execution: 'QUEUE',
      scheduledAt: publicationInput.scheduledAt ?? null,
      maxAttempts: publicationInput.maxAttempts,
      idempotencyKey: publicationInput.idempotencyKey,
    });
    if (['QUEUED', 'SCHEDULED'].includes(publicationResult.job.status)) requestSocialPublishingWorkerRun();
    return { status: 'queued', resourceType: 'marketing_publications' as ResourceType, recordId: publicationResult.job.id, message: 'Social publication queued.', content: contentResult.content, publication: publicationResult.job };
  }

  if (action.type === 'social.publication.retry' || action.type === 'social.publication.cancel') {
    const publicationId = textValue(payload.publicationId);
    if (!publicationId) throw new AppError(422, 'PUBLICATION_ID_REQUIRED', `${action.type} requires publicationId.`);
    const input = transitionSocialPublicationSchema.parse(payload);
    const operation = action.type === 'social.publication.retry' ? 'RETRY' as const : 'CANCEL' as const;
    const publication = await socialPublishingService.transitionPublication({
      workspaceId,
      jobId: publicationId,
      actorId: userId,
      actorType: 'AI_AGENT',
      actorRef: action.id,
      expectedVersion: input.expectedVersion,
      action: operation,
      ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
    });
    if (operation === 'RETRY') requestSocialPublishingWorkerRun();
    return { status: operation === 'RETRY' ? 'queued' : 'cancelled', resourceType: 'marketing_publications' as ResourceType, recordId: publication.id, message: operation === 'RETRY' ? 'Social publication queued for retry.' : 'Social publication cancelled.', publication };
  }

  if (action.type === 'advertising.create_optimization') {
    const provider=textValue(payload.provider,40);
    const providerAction=textValue(payload.action,20)==='pause'?'pause':'launch';
    if(provider!=='google-ads')throw new AppError(409,'AD_PROVIDER_EXECUTION_UNAVAILABLE','This action requires an executable Google Ads connection.');
    const common={provider:'google-ads' as const,customerId:textValue(payload.customerId),campaignId:textValue(payload.campaignId),...(textValue(payload.loginCustomerId)?{loginCustomerId:textValue(payload.loginCustomerId)}:{})};
    if(providerAction==='pause'){
      const result=await executeAdvertisingProviderOperation(workspaceId,{...common,action:'pause'});
      return {status:'executed',resourceType:'ad_optimizations' as ResourceType,recordId:null,message:'Google Ads campaign paused.',...result};
    }
    const amount=Number(payload.budgetAmountCny);
    const authorizationId=textValue(payload.authorizationId);
    if(!Number.isFinite(amount)||amount<=0||!authorizationId)throw new AppError(409,'AD_BUDGET_AUTHORIZATION_REQUIRED','Campaign launch requires an explicit amount and customer budget authorization.');
    const result=await executeAdvertisingProviderOperation(workspaceId,{...common,action:'launch',campaignBudgetId:textValue(payload.campaignBudgetId),accountCurrency:textValue(payload.accountCurrency),budgetAmountCny:amount,authorizationId,operationKey:`assistant:${action.id}:ad-spend`,compliance:payload.compliance && typeof payload.compliance==='object' && !Array.isArray(payload.compliance) ? payload.compliance as Record<string, unknown> : {}});
    return {status:'executed',resourceType:'ad_optimizations' as ResourceType,recordId:null,message:'Google Ads campaign launched.',...result};
  }

  if (action.type === 'website.publish_job') {
    const siteId = textValue(payload.siteId);
    const jobId = textValue(payload.jobId);
    if (!siteId || !jobId) throw new Error('website.publish_job requires siteId and jobId');
    await publishWebsiteJob(workspaceId, siteId, jobId);
    return { status: 'published', resourceType: 'marketing_publications' as ResourceType, recordId: null, message: 'Website publishing started.' };
  }

  if (action.type === 'workspace.refresh') {
    const result = await startContentRefresh(workspaceId, userId);
    return {
      status: result.reused ? 'reused' : 'started',
      resourceType: null,
      recordId: result.job.id,
      message: result.reused
        ? 'A workspace refresh is already running.'
        : 'Workspace refresh started. All pages and AI drafts will be updated.',
    };
  }

  if (action.type === 'finance.invoice.create_from_order') {
    const orderId = textValue(payload.orderId);
    if (!orderId) throw new AppError(422, 'ORDER_ID_REQUIRED', 'finance.invoice.create_from_order requires orderId.');
    const order = await commerceService.getOrder(workspaceId, orderId);
    if (!['CONFIRMED', 'PROCESSING', 'PARTIALLY_FULFILLED', 'FULFILLED'].includes(order.order.status)) {
      throw new AppError(409, 'ORDER_NOT_INVOICEABLE', 'The order must be confirmed or in fulfillment before an invoice can be created.');
    }
    const created = await commercialDocuments.createInvoice(workspaceId, userId, createInvoiceSchema.parse({
      operationKey: `assistant:${action.id}:invoice-create-from-order`,
      commerceOrderId: order.order.id,
      customerRecordId: order.order.customerRecordId,
      companyRecordId: order.order.companyRecordId,
      quoteId: order.order.quoteId,
      currency: order.order.currency,
      invoiceType: textValue(payload.invoiceType, 20) || 'STANDARD',
      issueDate: textValue(payload.issueDate, 10) || null,
      dueDate: textValue(payload.dueDate, 10) || null,
      shippingTotal: order.order.shippingTotal,
      source: 'conversation',
      creationMode: 'AI_ASSISTED',
      language: textValue(payload.language, 12) || 'en',
      conversationId: action.conversationId,
      lines: order.lines.map((line) => ({
        productId: line.productId,
        sku: line.sku ?? null,
        productName: line.productName,
        description: line.description ?? null,
        quantity: line.quantity,
        quantityUnit: line.quantityUnit ?? null,
        unitPrice: line.unitPrice,
        discount: line.discount,
        tax: line.tax,
        sortOrder: line.sortOrder,
      })),
    }), { actorType: 'AI_AGENT', actorRef: action.id, correlationId: action.id });
    if (!created?.invoice?.id) throw new AppError(502, 'INVOICE_NOT_CREATED', 'Canonical invoice creation did not return an invoice.');
    return { status: 'created', resourceType: 'finance_invoices' as ResourceType, recordId: created.invoice.id, message: `Invoice ${created.invoice.invoiceNumber} created from order.`, invoice: created };
  }

  if (action.type === 'finance.invoice.issue') {
    const invoiceId = textValue(payload.invoiceId);
    if (!invoiceId) throw new AppError(422, 'INVOICE_ID_REQUIRED', 'finance.invoice.issue requires invoiceId.');
    const issued = await commercialDocuments.issueInvoice(workspaceId, userId, invoiceId);
    return { status: 'issued', resourceType: 'finance_invoices' as ResourceType, recordId: invoiceId, message: 'Invoice issued.', invoice: issued };
  }

  if (action.type === 'finance.invoice.send') {
    const invoiceId = textValue(payload.invoiceId);
    if (!invoiceId) throw new AppError(422, 'INVOICE_ID_REQUIRED', 'finance.invoice.send requires invoiceId.');
    const sent = await commercialDocuments.sendInvoice(workspaceId, userId, invoiceId, sendDocumentSchema.parse({
      conversationId: action.conversationId,
      channel: payload.channel === 'email' ? 'email' : 'secure_link',
      recipient: textValue(payload.recipient, 320) || null,
      operationKey: `assistant:${action.id}:invoice-send`,
    }));
    return { status: 'sent', resourceType: 'finance_invoices' as ResourceType, recordId: invoiceId, message: 'Invoice queued for delivery.', sent };
  }

  if (action.type === 'finance.payout.request') {
    const payout = await payoutService.request(workspaceId, userId, requestPayoutSchema.parse({
      ...payload,
      idempotencyKey: textValue(payload.idempotencyKey, 200) || `assistant:${action.id}:payout-request`,
    }));
    if (!payout) throw new AppError(502, 'PAYOUT_NOT_CREATED', 'The payout request was not created.');
    return { status: 'requested', resourceType: 'finance_payouts' as ResourceType, recordId: payout.id, message: 'Payout requested and reserved. Submission still requires confirmation.', payout };
  }

  if (action.type === 'finance.payout.submit') {
    const payoutId = textValue(payload.payoutId);
    if (!payoutId) throw new AppError(422, 'PAYOUT_ID_REQUIRED', 'finance.payout.submit requires payoutId.');
    const payout = await payoutService.submit(workspaceId, userId, payoutId);
    if (!payout) throw new AppError(502, 'PAYOUT_NOT_SUBMITTED', 'The payout submission did not return a payout.');
    return { status: 'submitted', resourceType: 'finance_payouts' as ResourceType, recordId: payout.id, message: 'Payout submitted to the configured provider.', payout };
  }

  if (action.type === 'finance.invoice.create_and_send') {
    const recipient = await resolveInvoiceRecipient(workspaceId, payload);
    const identity = await getWorkspaceBusinessIdentity(workspaceId);
    const currency = textValue(payload.currency, 3).toUpperCase() || identity.factory?.defaultCurrency?.toUpperCase() || '';
    if (!currency) throw new AppError(422, 'INVOICE_CURRENCY_REQUIRED', 'Specify the invoice currency or configure a workspace default currency before creating the invoice.');

    const suppliedLines = Array.isArray(payload.lines) ? payload.lines : Array.isArray(payload.items) ? payload.items : [];
    const explicitAmount = numberValue(payload.amount ?? payload.total ?? payload.value);
    const derivedAmount = suppliedLines.length > 0
      ? suppliedLines.reduce((sum, item) => {
        const line = objectValue(item);
        const quantity = numberValue(line.quantity) ?? 1;
        const unitPrice = numberValue(line.unitPrice ?? line.price) ?? 0;
        return sum + (quantity * unitPrice) - (numberValue(line.discount) ?? 0) + (numberValue(line.tax) ?? 0);
      }, 0)
      : null;
    const amount = explicitAmount ?? derivedAmount;
    if (amount == null || amount <= 0) throw new AppError(422, 'INVOICE_AMOUNT_REQUIRED', 'Specify a positive invoice amount or at least one invoice line.');
    const lines = invoiceLines(payload, amount);
    const invoiceInput = createInvoiceSchema.parse({
      operationKey: `assistant:${action.id}:invoice-create`,
      customerRecordId: recipient.record.id,
      companyRecordId: textValue(payload.companyRecordId, 120) || null,
      currency,
      invoiceType: ['PROFORMA', 'COMMERCIAL', 'STANDARD', 'DEPOSIT', 'FINAL'].includes(textValue(payload.invoiceType, 20)) ? textValue(payload.invoiceType, 20) : 'STANDARD',
      dueDate: textValue(payload.dueDate, 10) || null,
      language: textValue(payload.language, 12) || 'en',
      source: 'conversation',
      creationMode: 'AI_ASSISTED',
      conversationId: null,
      lines,
    });
    const created = await commercialDocuments.createInvoice(workspaceId, userId, invoiceInput, {
      actorType: 'AI_AGENT',
      actorRef: action.id,
      correlationId: action.id,
    });
    if (!created?.invoice?.id) throw new Error('Canonical invoice creation did not return an invoice');
    const issued = await commercialDocuments.issueInvoice(workspaceId, userId, created.invoice.id);
    const channel = payload.channel === 'secure_link' ? 'secure_link' : 'email';
    const sent = await commercialDocuments.sendInvoice(workspaceId, userId, created.invoice.id, sendDocumentSchema.parse({
      conversationId: null,
      channel,
      recipient: recipient.email,
      operationKey: `assistant:${action.id}:invoice-send`,
    }));
    const sentDocument = 'deliveryId' in sent && 'documentPath' in sent ? sent : null;
    return {
      status: 'sent',
      invoiceId: created.invoice.id,
      invoiceNumber: issued?.invoice?.invoiceNumber ?? created.invoice.invoiceNumber,
      amount: issued?.invoice?.grandTotal ?? created.invoice.grandTotal,
      currency,
      recipient: { recordId: recipient.record.id, name: recipient.record.name, email: recipient.email },
      deliveryId: sentDocument?.deliveryId ?? null,
      documentPath: sentDocument?.documentPath ?? null,
      message: 'Invoice created, issued, and queued for delivery.',
    };
  }

  if (action.type === 'finance.create_automation') {
    const result = await createTaskRecord(workspaceId, userId, 'finance_automations', action);
    return {
      ...result,
      status: 'planned',
      message: 'Finance workflow prepared. Posting remains outside scope until the accounting engine is implemented.',
      executionBoundary: 'full_accounting_engine_excluded',
    };
  }

  const resourceType = resultResourceType(action.type);
  if (!resourceType || !isResourceType(resourceType)) {
    throw new Error(`Unsupported action type: ${action.type}`);
  }
  const result = await createTaskRecord(workspaceId, userId, resourceType, action);
  return { ...result, message: `${action.type} completed.` };
}

async function loadAction(workspaceId: string, actionId: string) {
  return (await query<AssistantActionRow>(
    `SELECT ${actionSelect} FROM assistant_action_requests WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, actionId],
  )).rows[0] ?? null;
}

async function executeStoredAction(row: AssistantActionRow) {
  try {
    const entitlements = await resolveWorkspaceEntitlements(row.workspaceId);
    if (!entitlements['ai.enabled'].enabled) throw new AppError(403, 'AI_ENTITLEMENT_DISABLED', 'AI access is no longer enabled for this workspace');
    await assertWorkspaceCapability({workspaceId:row.workspaceId,userId:row.requestedBy,capability:'agents.execute',actorType:'AI_AGENT'});
  } catch (error) {
    if (!(error instanceof AppError) || error.status !== 403) throw error;
    const code = error.code === 'AI_ENTITLEMENT_DISABLED' ? error.code : 'ASSISTANT_ACTION_FORBIDDEN';
    const message = code === 'AI_ENTITLEMENT_DISABLED'
      ? 'AI access is no longer enabled for this workspace.'
      : 'The requester is no longer authorized to execute this action.';
    const cancelled = (await query<AssistantActionRow>(
      `UPDATE assistant_action_requests SET status='cancelled',error_code=$2,error_message=$3,completed_at=NOW()
        WHERE id=$1 AND status IN ('pending_approval','ready') RETURNING ${actionSelect}`,
      [row.id, code, message],
    )).rows[0];
    return publicAction(cancelled ?? row);
  }
  const current = row;
  if (current.status !== 'ready') return publicAction(current);
  const claimed = (await query<AssistantActionRow>(
    `UPDATE assistant_action_requests SET status='executing',started_at=NOW(),error_code=NULL,error_message=NULL
      WHERE id=$1 AND workspace_id=$2 AND status='ready' AND expires_at>NOW() RETURNING ${actionSelect}`,
    [current.id, current.workspaceId],
  )).rows[0];
  if (!claimed) return publicAction((await loadAction(current.workspaceId, current.id))!);
  try {
    await assertAssistantProviderReadiness(claimed.workspaceId, publicAction(claimed));
    const result = await executeAssistantActionImplementation(claimed.workspaceId, claimed.requestedBy, publicAction(claimed));
    const completed = (await query<AssistantActionRow>(
      `UPDATE assistant_action_requests SET status='succeeded',result=$2::jsonb,completed_at=NOW() WHERE id=$1 AND status='executing' RETURNING ${actionSelect}`,
      [claimed.id, JSON.stringify(result)],
    )).rows[0]!;
    await recordSecurityEvent({eventType:'ADMIN_ACTION',workspaceId:claimed.workspaceId,userId:claimed.requestedBy,metadata:{action:'assistant_action_executed',targetId:claimed.id,actionType:claimed.type}});
    return publicAction(completed);
  } catch (error) {
    logger.error({ error, workspaceId: claimed.workspaceId, actionId: claimed.id, actionType: claimed.type }, 'Assistant action execution failed');
    const appError = error instanceof AppError ? error : null;
    const code = appError?.code ?? 'ASSISTANT_ACTION_EXECUTION_FAILED';
    const message = appError?.message?.slice(0, 2000) || 'The assistant action could not be completed.';
    const failed = (await query<AssistantActionRow>(
      `UPDATE assistant_action_requests SET status='failed',error_code=$2,error_message=$3,completed_at=NOW() WHERE id=$1 RETURNING ${actionSelect}`,
      [claimed.id, code, message],
    )).rows[0]!;
    throw Object.assign(new AppError(appError?.status ?? 502, code, message), { action: publicAction(failed) });
  }
}

export async function requestAssistantAction(workspaceId: string, userId: string, conversationId: string, rawAction: unknown) {
  const parsedAction = assistantActionInputSchema.parse(rawAction);
  const action = await prepareInvoiceAction(workspaceId, parsedAction);
  await assertWorkspaceCapability({workspaceId,userId,capability:'agents.execute',actorType:'USER'});
  const entitlements = await resolveWorkspaceEntitlements(workspaceId);
  if (!entitlements['ai.enabled'].enabled) throw new AppError(403, 'AI_ENTITLEMENT_DISABLED', 'AI access is not enabled for this workspace');
  const conversation = (await query<{id:string}>(
    `SELECT id FROM ai_conversations WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND archived_at IS NULL`,
    [conversationId, workspaceId, userId],
  )).rows[0];
  if (!conversation) throw notFoundError('Conversation not found');
  const digest = digestAction(action);
  const timeBucket = Math.floor(Date.now() / 300_000);
  const idempotencyKey = createHash('sha256').update(`${conversationId}:${userId}:${digest}:${timeBucket}`).digest('hex');
  const policy = actionPolicy(action.type, entitlements['ai.autonomous_agents'].enabled);
  if (policy.decision === 'forbidden') throw new AppError(403, 'ASSISTANT_ACTION_FORBIDDEN', 'This action is not allowed');
  const row = await withTransaction(async (client) => {
    // Serialize identical requests before the upsert. Agent actions execute
    // without routine per-action approvals. Paid media is separately protected
    // by both its prepaid wallet and a campaign-specific authorization.
    await query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${workspaceId}:${idempotencyKey}`], client);
    let stored = (await query<AssistantActionRow>(
      `INSERT INTO assistant_action_requests(workspace_id,conversation_id,requested_by,action_type,summary,payload,payload_digest,status,idempotency_key)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
        ON CONFLICT(workspace_id,idempotency_key) DO UPDATE SET updated_at=NOW()
        RETURNING ${actionSelect}`,
      [workspaceId, conversationId, userId, action.type, action.summary, JSON.stringify(action.payload), digest, 'ready', idempotencyKey],
      client,
    )).rows[0]!;
    return stored;
  });
  if (policy.decision === 'require_budget') throw new AppError(409, 'CUSTOMER_BUDGET_REQUIRED', 'Fund the prepaid ad-spend wallet before this action can run.');
  if (requiresAssistantConfirmation(action.type)) return publicAction(row);
  return executeStoredAction(row);
}

export async function listAssistantActions(workspaceId: string, userId: string, conversationId: string) {
  const rows = (await query<AssistantActionRow>(
    `SELECT ${actionSelect} FROM assistant_action_requests
      WHERE workspace_id=$1 AND requested_by=$2 AND conversation_id=$3 ORDER BY created_at DESC LIMIT 100`,
    [workspaceId, userId, conversationId],
  )).rows;
  return rows.map(publicAction);
}

export async function executeAssistantActionRequest(workspaceId: string, userId: string, conversationId: string, actionId: string) {
  await assertWorkspaceCapability({workspaceId,userId,capability:'agents.execute',actorType:'USER'});
  const row = (await query<AssistantActionRow>(
    `SELECT ${actionSelect} FROM assistant_action_requests WHERE id=$1 AND workspace_id=$2 AND conversation_id=$3 AND requested_by=$4`,
    [actionId, workspaceId, conversationId, userId],
  )).rows[0];
  if (!row) throw notFoundError('Assistant action not found');
  if (row.status === 'succeeded' || row.status === 'failed' || row.status === 'rejected' || row.status === 'cancelled' || row.status === 'expired') return publicAction(row);
  return executeStoredAction(row);
}

/** Cancel only work that has not crossed an external side-effect boundary. */
export async function cancelAssistantActionRequest(workspaceId: string, userId: string, conversationId: string, actionId: string) {
  await assertWorkspaceCapability({ workspaceId, userId, capability: 'agents.execute', actorType: 'USER' });
  const row = (await query<AssistantActionRow>(
    `SELECT ${actionSelect} FROM assistant_action_requests
      WHERE id=$1 AND workspace_id=$2 AND conversation_id=$3 AND requested_by=$4`,
    [actionId, workspaceId, conversationId, userId],
  )).rows[0];
  if (!row) throw notFoundError('Assistant action not found');
  if (['succeeded', 'failed', 'rejected', 'cancelled', 'expired'].includes(row.status)) return publicAction(row);
  if (row.status === 'executing') {
    throw new AppError(409, 'ASSISTANT_ACTION_EXECUTING', 'This action has already started. Its provider outcome must be reconciled before it can be cancelled.');
  }
  const cancelled = (await query<AssistantActionRow>(
    `UPDATE assistant_action_requests
        SET status='cancelled', error_code='ASSISTANT_ACTION_CANCELLED',
            error_message='Cancelled by the requesting user.', completed_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND workspace_id=$2 AND conversation_id=$3 AND requested_by=$4
        AND status IN ('ready','pending_approval')
      RETURNING ${actionSelect}`,
    [actionId, workspaceId, conversationId, userId],
  )).rows[0];
  if (!cancelled) {
    const current = await loadAction(workspaceId, actionId);
    if (!current) throw notFoundError('Assistant action not found');
    if (current.status === 'executing') {
      throw new AppError(409, 'ASSISTANT_ACTION_EXECUTING', 'This action has already started. Its provider outcome must be reconciled before it can be cancelled.');
    }
    return publicAction(current);
  }
  await recordSecurityEvent({
    eventType: 'ADMIN_ACTION',
    workspaceId,
    userId,
    metadata: { action: 'assistant_action_cancelled', targetId: actionId, actionType: cancelled.type },
  });
  return publicAction(cancelled);
}

export async function claimAndExecuteNextAssistantAction() {
  await query(
    `UPDATE assistant_action_requests
      SET status='failed',error_code='ASSISTANT_ACTION_STATE_UNCERTAIN',
          error_message='Execution was interrupted and its outcome requires review.',completed_at=NOW()
      WHERE status='executing' AND started_at<=NOW()-INTERVAL '15 minutes'`,
  );
  const row = (await query<AssistantActionRow>(
    `SELECT ${actionSelect} FROM assistant_action_requests
      WHERE status='ready'
      ORDER BY created_at ASC LIMIT 1`,
  )).rows[0];
  if (!row) return null;
  return executeStoredAction(row);
}
