import { logger } from '../../config/logger.js';
import { executeAuthorizedAgentPacket } from './agent.authorization.js';
import type { ResourceType } from '../../domain/resource-catalog.js';
import * as recordRepo from '../records/record.repo.js';
import { createAiDraft, createDraft, sendAutonomousDraft } from '../email/email.service.js';
import { updateGoogleReviewReply } from '../workspace-app/workspace-app.service.js';
import { publishWebsiteJob } from '../websites/website.publish.service.js';
import { verifyDomainOwnership } from '../websites/domain-verification.service.js';
import * as websiteRepo from '../websites/website.repo.js';
import { requestWebsiteGenerationWorkerRun } from '../websites/website.worker.js';
import { generateProductImagesFromText } from '../product-images/product-image.service.js';
import {
  normalizeAgentExecutionCommands,
  type AgentExecutionCommand,
} from './agent.execution-command.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES, type DomainEvent } from '../../events/domain-event.types.js';
import { executeAdvertisingProviderOperation } from '../adspend/advertising.provider.service.js';
import { sendAutonomousMessage } from '../omnichannel/omnichannel.service.js';
import * as commerceService from '../commerce/commerce.service.js';
import {
  adjustInventorySchema,
  createFulfillmentSchema,
  createOrderSchema,
  transitionFulfillmentSchema,
  transitionOrderSchema,
  updateOrderSchema,
} from '../commerce/commerce.validator.js';
import * as socialPublishingService from '../social-publishing/social-publishing.service.js';
import * as calendarService from '../calendar/calendar.service.js';
import * as productService from '../products/product.service.js';
import {
  createSocialContentSchema,
  createSocialPublicationSchema,
  transitionSocialPublicationSchema,
} from '../social-publishing/social-publishing.validator.js';
import { requestSocialPublishingWorkerRun } from '../social-publishing/social-publishing.worker.js';
import * as commercialDocumentService from '../commercial-documents/commercial-documents.service.js';
import { createInvoiceSchema, createQuoteSchema, sendDocumentSchema } from '../commercial-documents/commercial-documents.validator.js';
import { createNativeEventSchema } from '../calendar/calendar.validator.js';
import { createCategorySchema, createProductSchema, updateCategorySchema, updateProductSchema } from '../products/product.validator.js';
import { createRuntimeWorkerMonitor } from '../../operations/worker-liveness.js';
import * as salesPipelineService from '../sales-pipeline/sales-pipeline.service.js';
import { SALES_PIPELINE_RESOURCE_TYPES, type SalesPipelineResourceType } from '../sales-pipeline/sales-pipeline.types.js';
import { requestCompanyIntelligence } from '../crm-company/company-intelligence.service.js';
import { syncCrmCompany, type CrmCompanySyncProvider } from '../provider-control/crm-company-sync.service.js';

const intervalMs = 30 * 1000;
const batchSize = 20;
let timer: NodeJS.Timeout | undefined;
let activeCycle: Promise<void> | null = null;
let stopping = false;
const activeEventTasks = new Set<Promise<unknown>>();

function trackAgentExecutionEvent<T>(operation: () => Promise<T>): Promise<T> | null {
  if (stopping) return null;
  const task = operation();
  activeEventTasks.add(task);
  task.then(
    () => activeEventTasks.delete(task),
    (error: unknown) => {
      activeEventTasks.delete(task);
      runtimeMonitor.failed(error);
    },
  );
  return task;
}
const runtimeMonitor = createRuntimeWorkerMonitor('agent-execution', { required: true, staleAfterMs: 120_000 });

function textValue(value: unknown, maxLength = 400) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function executionSummary(record: recordRepo.WorkspaceRecord) {
  const data = record.data ?? {};
  const targetSystem = textValue(data.targetSystem) || 'ai';
  const pageLabel = textValue(data.pageLabel) || record.name;
  const jobs = stringList(data.jobs).slice(0, 4);
  const constraints = stringList(data.approvalGates).slice(0, 4);
  const fragments = [
    `Execution packet processed for ${pageLabel}.`,
    `Target system: ${targetSystem}.`,
    jobs.length > 0 ? `Jobs: ${jobs.join(', ')}.` : 'Jobs: no explicit jobs attached.',
    constraints.length > 0 ? `Operating constraints respected: ${constraints.join(', ')}.` : 'Operating constraints: none attached.',
  ];
  return fragments.join(' ');
}

function objectValue(value: unknown) {
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

function numberValue(value: unknown, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function resolveDomainArtifactType(targetSystem: string): ResourceType | null {
  return targetSystem ? 'ai_tasks' : null;
}

function resolveCommandResultResourceType(command: AgentExecutionCommand): ResourceType {
  if (command.type === 'crm.create_followup_task') return 'crm_tasks';
  if (command.type === 'sales.create_followup_task') return 'sales_tasks';
  if (command.type === 'sales.quote.create') return 'finance_quotes';
  if (command.type === 'sales.quote.send') return 'finance_quotes';
  if (command.type === 'finance.invoice.create_from_order') return 'finance_invoices';
  if (command.type === 'finance.invoice.issue' || command.type === 'finance.invoice.send') return 'finance_invoices';
  if (command.type === 'finance.create_automation') return 'finance_automations';
  if (command.type === 'commerce.product.create' || command.type === 'commerce.product.update') return 'ecommerce_products';
  if (command.type === 'commerce.category.create' || command.type === 'commerce.category.update') return 'ecommerce_categories';
  return 'activities';
}

async function createExecutionArtifacts(record: recordRepo.WorkspaceRecord, executionStatus: 'planned' | 'executed' = 'executed') {
  const data = record.data ?? {};
  const targetSystem = textValue(data.targetSystem) || 'ai';
  const targetModule = textValue(data.targetModule) || 'general';
  const pageLabel = textValue(data.pageLabel) || record.name;
  const summary = executionSummary(record);
  const existingArtifacts = await recordRepo.listExecutionArtifactsBySourceRecordId(record.workspaceId, record.id);
  const existingActivity = existingArtifacts.find((entry) => entry.resourceType === 'activities') ?? null;
  const artifactType = resolveDomainArtifactType(targetSystem);
  const existingArtifact = artifactType
    ? existingArtifacts.find((entry) => entry.resourceType === artifactType) ?? null
    : null;
  const baseData = {
    sourceActionRecordId: record.id,
    sourceActionResourceType: record.resourceType,
    sourcePageId: textValue(data.pageId) || null,
    sourcePageLabel: pageLabel,
    targetSystem,
    targetModule,
    executionMode: textValue(data.executionMode) || 'analysis_only',
    executionStatus,
    policyDecision: textValue(data.policyDecision) || 'allow',
    commandTypes: stringList(data.commandTypes),
    jobs: stringList(data.jobs),
    approvalGates: stringList(data.approvalGates),
    executionSummary: summary,
    generatedByExecutor: true,
    generatedAt: new Date().toISOString(),
  };

  const activity = existingActivity ?? await recordRepo.createRecord(record.workspaceId, 'activities', record.createdBy, {
    name: `${pageLabel} execution activity`,
    description: summary,
    status: 'completed',
    stage: 'executed',
    source: 'agent_executor',
    tags: ['agent-executor', targetSystem, targetModule].filter(Boolean),
    data: baseData,
  });

  if (!artifactType) {
    return { activity, artifact: null };
  }

  const artifact = existingArtifact ?? await recordRepo.createRecord(record.workspaceId, artifactType, record.createdBy, {
    name: `${pageLabel} execution result`,
    description: textValue(record.description) || summary,
    status: 'active',
    stage: 'prepared_by_agent',
    source: 'agent_executor',
    tags: ['agent-generated', targetSystem, targetModule, pageLabel.toLowerCase().replace(/\s+/g, '-')].slice(0, 12),
    data: baseData,
  });
  return { activity, artifact };
}

async function persistCommandExecutionResult(
  record: recordRepo.WorkspaceRecord,
  command: AgentExecutionCommand,
  result: Record<string, unknown>,
  lifecycle: 'completed' | 'waiting_for_provider' | 'provider_failed' = 'completed',
) {
  const existing = await recordRepo.findExecutionResultByCommandIdempotencyKey(record.workspaceId, command.idempotencyKey);
  if (existing) return existing;
  const resourceType = resolveCommandResultResourceType(command);
  return recordRepo.createRecord(record.workspaceId, resourceType, record.createdBy, {
    parentId: record.id,
    name: `${command.type} result`,
    description: command.summary,
    status: lifecycle === 'provider_failed' ? 'failed' : lifecycle === 'completed' ? 'completed' : 'active',
    stage: lifecycle,
    source: 'agent_executor_command',
    tags: ['agent-executor-command', command.targetSystem, command.type].slice(0, 12),
    externalId: command.idempotencyKey,
    data: {
      sourceActionRecordId: record.id,
      commandIdempotencyKey: command.idempotencyKey,
      commandType: command.type,
      commandTargetSystem: command.targetSystem,
      commandProvider: command.provider,
      commandPayload: command.payload,
      commandResult: result,
      executedAt: lifecycle === 'completed' ? new Date().toISOString() : null,
      providerQueuedAt: lifecycle === 'waiting_for_provider' ? new Date().toISOString() : null,
    },
  });
}

async function executeAgentCommand(record: recordRepo.WorkspaceRecord, command: AgentExecutionCommand) {
  const existing = await recordRepo.findExecutionResultByCommandIdempotencyKey(record.workspaceId, command.idempotencyKey);
  if (existing) {
    const executionState = existing.stage === 'waiting_for_provider'
      ? 'waiting_for_provider' as const
      : existing.status === 'failed' || existing.stage === 'provider_failed'
        ? 'provider_failed' as const
        : 'completed' as const;
    return {
      type: command.type,
      targetEntityId: command.targetEntityId,
      provider: command.provider,
      reused: true,
      resultRecordId: existing.id,
      executionState,
      result: existing.data?.commandResult ?? { status: 'reused' },
    };
  }
  const payload = objectValue(command.payload);
  const actorUserId = record.createdBy ?? 'system';

  // A page without a domain-specific command must never look like it caused
  // an external mutation. Keep the fallback useful and idempotent by storing
  // an explicit planning artifact that can later be mapped to a canonical
  // service, while making the execution boundary visible to the Office and
  // Workspace surfaces.
  if (command.type === 'record.create_artifact') {
    const stored = await persistCommandExecutionResult(record, command, {
      status: 'planned',
      executionBoundary: 'planning_artifact_only',
      sideEffectsApplied: false,
      canonicalActionRegistered: false,
      actionResourceType: textValue(payload.actionResourceType, 120) || record.resourceType,
      pageId: textValue(payload.pageId, 120) || null,
      pageLabel: textValue(payload.pageLabel, 240) || record.name,
      goal: textValue(payload.goal, 4_000) || command.summary,
      jobs: Array.isArray(payload.jobs) ? payload.jobs : [],
      nextStep: 'Map this responsibility to a canonical domain command before enabling external execution.',
    });
    return {
      type: command.type,
      targetEntityId: stored.id,
      provider: command.provider,
      resultRecordId: stored.id,
      result: {
        status: 'planned',
        executionBoundary: 'planning_artifact_only',
        sideEffectsApplied: false,
        canonicalActionRegistered: false,
      },
    };
  }

  if (command.type === 'crm.company.enrich') {
    const companyId = textValue(payload.companyId || payload.recordId || command.targetEntityId);
    if (!companyId) throw new Error('crm.company.enrich requires companyId or recordId');
    if (!record.createdBy) throw new Error('crm.company.enrich requires an originating workspace user');
    const queued = await requestCompanyIntelligence(record.workspaceId, companyId, record.createdBy);
    const stored = await persistCommandExecutionResult(record, command, {
      status: 'queued',
      companyId,
      enrichmentStatus: (queued.data?.enrichment as Record<string, unknown> | undefined)?.status ?? 'queued',
    });
    return {
      type: command.type,
      targetEntityId: companyId,
      provider: command.provider,
      resultRecordId: stored.id,
      result: { status: 'queued', companyId, company: queued },
    };
  }

  if (command.type === 'crm.company.sync') {
    const companyId = textValue(payload.companyId || payload.recordId || command.targetEntityId);
    const provider = textValue(payload.provider || command.provider).toLowerCase();
    const providerConnectionId = textValue(payload.providerConnectionId);
    if (!companyId || !['salesforce', 'hubspot', 'pipedrive'].includes(provider)) {
      throw new Error('crm.company.sync requires companyId and a supported CRM provider');
    }
    const synced = await syncCrmCompany({
      workspaceId: record.workspaceId,
      companyId,
      provider: provider as CrmCompanySyncProvider,
      providerConnectionId: providerConnectionId || null,
    });
    const stored = await persistCommandExecutionResult(record, command, synced);
    return {
      type: command.type,
      targetEntityId: companyId,
      provider: command.provider,
      resultRecordId: stored.id,
      result: synced,
    };
  }

  if (command.type === 'google_reviews.reply') {
    const reviewId = textValue(payload.reviewId || command.targetEntityId);
    const accountId = textValue(payload.accountId);
    const locationId = textValue(payload.locationId);
    const comment = textValue(payload.comment, 4000);
    if (!reviewId || !accountId || !locationId || !comment) {
      throw new Error('google_reviews.reply requires reviewId, accountId, locationId, and comment');
    }
    const reviewResult = await updateGoogleReviewReply(record.workspaceId, reviewId, { accountId, locationId, comment });
    const commandResult = {
      reviewId,
      locationId,
      status: 'updated',
    };
    const stored = await persistCommandExecutionResult(record, command, commandResult);
    return {
      type: command.type,
      targetEntityId: reviewId,
      provider: command.provider,
      resultRecordId: stored.id,
      result: reviewResult,
    };
  }

  if (command.type === 'crm.create_followup_task' || command.type === 'sales.create_followup_task') {
    const resourceType = command.type === 'crm.create_followup_task' ? 'crm_tasks' : 'sales_tasks';
    const item = await persistCommandExecutionResult(record, command, {
      taskTitle: textValue(payload.title || command.summary, 240),
      taskDescription: textValue(payload.description || command.summary, 4000),
      jobs: Array.isArray(payload.jobs) ? payload.jobs : [],
      status: 'created',
    });
    return {
      type: command.type,
      targetEntityId: item.id,
      provider: command.provider,
      resultRecordId: item.id,
      result: { status: 'created', resourceType },
    };
  }

  if (command.type === 'crm.transition_pipeline' || command.type === 'sales.transition_pipeline') {
    const resourceType = textValue(payload.resourceType || command.targetEntityType, 80) as SalesPipelineResourceType;
    const recordId = textValue(payload.recordId || command.targetEntityId, 80);
    const targetState = textValue(payload.targetState || payload.stage || payload.status, 80);
    const expectedVersion = typeof payload.expectedVersion === 'number' && Number.isInteger(payload.expectedVersion)
      ? payload.expectedVersion
      : typeof payload.expectedVersion === 'string' && /^\d+$/.test(payload.expectedVersion.trim())
        ? Number.parseInt(payload.expectedVersion, 10)
        : undefined;
    if (!recordId || !targetState || !SALES_PIPELINE_RESOURCE_TYPES.includes(resourceType)) {
      throw new Error(`${command.type} requires recordId, resourceType, and targetState`);
    }
    const transitioned = await salesPipelineService.transitionRecord(record.workspaceId, resourceType, recordId, actorUserId, {
      targetState,
      expectedVersion,
      reason: textValue(payload.reason || command.summary, 2_000) || null,
    });
    const stored = await persistCommandExecutionResult(record, command, {
      status: 'transitioned',
      resourceType,
      recordId,
      state: transitioned.pipeline.state,
      stateVersion: transitioned.pipeline.stateVersion,
      recordVersion: transitioned.version,
    });
    return {
      type: command.type,
      targetEntityId: recordId,
      provider: command.provider,
      resultRecordId: stored.id,
      result: { status: 'transitioned', resourceType, record: transitioned },
    };
  }

  if (command.type === 'sales.quote.create') {
    const customerRecordId = textValue(payload.customerRecordId);
    const currency = textValue(payload.currency, 3).toUpperCase();
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    if (!customerRecordId || !currency || lines.length === 0) {
      throw new Error('sales.quote.create requires customerRecordId, currency, and at least one line');
    }
    const quoteInput = createQuoteSchema.parse({
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
      source: 'api',
      creationMode: 'AUTOMATIC',
      handlingMode: 'AUTONOMOUS',
      conversationId: textValue(payload.conversationId) || null,
      lines,
    });
    const quote = await commercialDocumentService.createQuote(record.workspaceId, actorUserId, quoteInput);
    const quoteId = quote?.quote?.id;
    if (!quoteId) throw new Error('Canonical quote creation did not return a quote');
    const stored = await persistCommandExecutionResult(record, command, {
      quoteId,
      quoteNumber: quote.quote.quoteNumber,
      status: quote.quote.status,
    });
    return { type: command.type, targetEntityId: quoteId, provider: command.provider, resultRecordId: stored.id, result: quote };
  }

  if (command.type === 'sales.quote.send') {
    const quoteId = textValue(payload.quoteId || command.targetEntityId);
    if (!quoteId) throw new Error('sales.quote.send requires quoteId');
    const sendInput = sendDocumentSchema.parse({
      conversationId: textValue(payload.conversationId) || null,
      channel: textValue(payload.channel, 32) || 'secure_link',
      recipient: textValue(payload.recipient, 320) || null,
      operationKey: textValue(payload.operationKey, 200) || `agent:${command.idempotencyKey}:quote-send`,
    });
    const sent = await commercialDocumentService.sendQuoteAutonomously(record.workspaceId, actorUserId, quoteId, sendInput);
    const sentResult = objectValue(sent);
    const stored = await persistCommandExecutionResult(record, command, {
      quoteId,
      status: 'sent',
      deliveryId: sentResult.deliveryId ?? null,
      documentPath: sentResult.documentPath ?? null,
    });
    return { type: command.type, targetEntityId: quoteId, provider: command.provider, resultRecordId: stored.id, result: sent };
  }

  if (command.type === 'advertising.create_optimization') {
    const provider=textValue(command.provider||payload.provider,40);
    const action=textValue(payload.action,20)==='pause'?'pause':'launch';
    if(provider!=='google-ads')throw new Error('advertising.create_optimization requires the executable google-ads provider');
    if(action==='pause'){
      const result=await executeAdvertisingProviderOperation(record.workspaceId,{provider:'google-ads',action:'pause',customerId:textValue(payload.customerId),campaignId:textValue(payload.campaignId),...(textValue(payload.loginCustomerId)?{loginCustomerId:textValue(payload.loginCustomerId)}:{})});
      const item=await persistCommandExecutionResult(record,command,{status:'executed',...result});
      return {type:command.type,targetEntityId:command.targetEntityId,provider,resultRecordId:item.id,result};
    }
    const amount=numberValue(payload.budgetAmountCny);
    const authorizationId=textValue(payload.authorizationId);
    if(amount<=0||!authorizationId)throw new Error('advertising.create_optimization launch requires an explicit budgetAmountCny and customer authorizationId');
    const result=await executeAdvertisingProviderOperation(record.workspaceId,{provider:'google-ads',action:'launch',customerId:textValue(payload.customerId),campaignId:textValue(payload.campaignId),campaignBudgetId:textValue(payload.campaignBudgetId),accountCurrency:textValue(payload.accountCurrency),budgetAmountCny:amount,authorizationId,operationKey:`agent:${command.idempotencyKey}:ad-spend`,...(textValue(payload.loginCustomerId)?{loginCustomerId:textValue(payload.loginCustomerId)}:{})});
    const item=await persistCommandExecutionResult(record,command,{status:'executed',...result});
    return {type:command.type,targetEntityId:command.targetEntityId,provider,resultRecordId:item.id,result};
  }

  if (command.type === 'finance.invoice.create_from_order') {
    const orderId = textValue(payload.orderId || command.targetEntityId);
    if (!orderId) throw new Error('finance.invoice.create_from_order requires orderId');
    const order = await commerceService.getOrder(record.workspaceId, orderId);
    if (!['CONFIRMED', 'PROCESSING', 'PARTIALLY_FULFILLED', 'FULFILLED'].includes(order.order.status)) {
      throw new Error('finance.invoice.create_from_order requires a confirmed or fulfilling canonical order');
    }
    const invoiceInput = createInvoiceSchema.parse({
      operationKey: `agent:${command.idempotencyKey}:invoice-create`,
      commerceOrderId: order.order.id,
      customerRecordId: order.order.customerRecordId,
      companyRecordId: order.order.companyRecordId,
      quoteId: order.order.quoteId,
      currency: order.order.currency,
      invoiceType: payload.invoiceType ?? 'STANDARD',
      issueDate: payload.issueDate ?? null,
      dueDate: payload.dueDate ?? null,
      shippingTotal: order.order.shippingTotal,
      source: 'api',
      creationMode: 'AUTOMATIC',
      language: payload.language ?? 'en',
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
    });
    const invoice = await commercialDocumentService.createInvoice(record.workspaceId, actorUserId, invoiceInput, {
      actorType: 'AI_AGENT',
      actorRef: record.id,
      sourceActionRecordId: record.id,
      correlationId: command.idempotencyKey,
      causationId: record.id,
    });
    if (!invoice?.invoice?.id) throw new Error('Canonical invoice creation did not return an invoice');
    const stored = await persistCommandExecutionResult(record, command, {
      orderId,
      invoiceId: invoice.invoice.id,
      invoiceNumber: invoice.invoice.invoiceNumber,
      status: invoice.invoice.status,
    });
    return { type: command.type, targetEntityId: invoice.invoice.id, provider: command.provider, resultRecordId: stored.id, result: invoice };
  }

  if (command.type === 'finance.invoice.issue') {
    const invoiceId = textValue(payload.invoiceId || command.targetEntityId);
    if (!invoiceId) throw new Error('finance.invoice.issue requires invoiceId');
    const issued = await commercialDocumentService.issueInvoice(record.workspaceId, actorUserId, invoiceId);
    const stored = await persistCommandExecutionResult(record, command, {
      invoiceId,
      status: objectValue(issued).status ?? 'issued',
    });
    return { type: command.type, targetEntityId: invoiceId, provider: command.provider, resultRecordId: stored.id, result: issued };
  }

  if (command.type === 'finance.invoice.send') {
    const invoiceId = textValue(payload.invoiceId || command.targetEntityId);
    if (!invoiceId) throw new Error('finance.invoice.send requires invoiceId');
    const sendInput = sendDocumentSchema.parse({
      conversationId: textValue(payload.conversationId) || null,
      channel: textValue(payload.channel, 32) || 'secure_link',
      recipient: textValue(payload.recipient, 320) || null,
      operationKey: textValue(payload.operationKey, 200) || `agent:${command.idempotencyKey}:invoice-send`,
    });
    const sent = await commercialDocumentService.sendInvoiceAutonomously(record.workspaceId, actorUserId, invoiceId, sendInput);
    const sentResult = objectValue(sent);
    const stored = await persistCommandExecutionResult(record, command, {
      invoiceId,
      status: 'sent',
      deliveryId: sentResult.deliveryId ?? null,
      documentPath: sentResult.documentPath ?? null,
    });
    return { type: command.type, targetEntityId: invoiceId, provider: command.provider, resultRecordId: stored.id, result: sent };
  }

  if (command.type === 'finance.create_automation') {
    const resourceType = 'finance_automations';
    const item = await persistCommandExecutionResult(record, command, {
      title: textValue(payload.title || command.summary, 240),
      description: textValue(payload.description || command.summary, 4000),
      jobs: Array.isArray(payload.jobs) ? payload.jobs : [],
      status: 'planned',
      executionBoundary: 'planning_artifact_only',
      canonicalFinanceAvailable: true,
    });
    return {
      type: command.type,
      targetEntityId: item.id,
      provider: command.provider,
      resultRecordId: item.id,
      result: { status: 'planned', resourceType, executionBoundary: 'planning_artifact_only', canonicalFinanceAvailable: true },
    };
  }

  if (command.type === 'email.create_draft') {
    const accountId = textValue(payload.accountId);
    if (!accountId) throw new Error('email.create_draft requires accountId');
    const draft = await createDraft(record.workspaceId, actorUserId, {
      accountId,
      threadId: textValue(payload.threadId) || null,
      to: emailAddresses(payload.to),
      cc: emailAddresses(payload.cc),
      subject: textValue(payload.subject, 998),
      bodyText: textValue(payload.bodyText, 100_000),
      replyToProviderMessageId: textValue(payload.replyToProviderMessageId, 1000) || null,
    }, 'automation', { sourceActionRecordId: record.id, generatedBy: 'agent_executor' });
    const stored = await persistCommandExecutionResult(record, command, {
      draftId: draft.id,
      threadId: draft.threadId,
      status: 'drafted',
      source: draft.source,
    });
    return {
      type: command.type,
      targetEntityId: draft.id,
      provider: command.provider,
      resultRecordId: stored.id,
      result: { draftId: draft.id, threadId: draft.threadId, status: 'drafted', source: draft.source },
    };
  }

  if (command.type === 'email.create_ai_draft') {
    const accountId = textValue(payload.accountId);
    const threadId = textValue(payload.threadId || command.targetEntityId);
    if (!accountId || !threadId) throw new Error('email.create_ai_draft requires accountId and threadId');
    const draft = await createAiDraft(
      record.workspaceId,
      actorUserId,
      threadId,
      {
        accountId,
        instruction: textValue(payload.instruction, 2000) || undefined,
        tone: textValue(payload.tone, 40) || 'professional',
        language: textValue(payload.language, 16) || 'en',
      },
      'automation',
      { sourceActionRecordId: record.id, generatedBy: 'agent_executor' },
    );
    const stored = await persistCommandExecutionResult(record, command, {
      draftId: draft.id,
      threadId: draft.threadId,
      status: 'drafted',
      source: draft.source,
    });
    return {
      type: command.type,
      targetEntityId: draft.id,
      provider: command.provider,
      resultRecordId: stored.id,
      result: { draftId: draft.id, threadId: draft.threadId, status: 'drafted', source: draft.source },
    };
  }

  if (command.type === 'email.send_draft') {
    const draftId = textValue(payload.draftId || command.targetEntityId);
    if (!draftId) throw new Error('email.send_draft requires draftId');
    const draft = await sendAutonomousDraft(record.workspaceId, draftId);
    const stored = await persistCommandExecutionResult(record, command, {
      draftId,
      status: 'sent',
      providerMessageId: draft && typeof draft === 'object' && 'providerMessageId' in draft ? (draft as { providerMessageId?: string | null }).providerMessageId ?? null : null,
    });
    return {
      type: command.type,
      targetEntityId: draftId,
      provider: command.provider,
      resultRecordId: stored.id,
      result: { draftId, status: 'sent' },
    };
  }

  if (command.type === 'omnichannel.send_message') {
    const conversationId = textValue(payload.conversationId || command.targetEntityId);
    const text = textValue(payload.text, 10_000);
    if (!conversationId || !text) throw new Error('omnichannel.send_message requires conversationId and text');
    const message = await sendAutonomousMessage(record.workspaceId, conversationId, actorUserId, {
      text,
      messageType: textValue(payload.messageType, 20) || 'TEXT',
      clientMessageId: `agent-command:${command.idempotencyKey}`,
      ...(textValue(payload.accountId) ? { accountId: textValue(payload.accountId) } : {}),
      ...(textValue(payload.recipientId) ? { recipientId: textValue(payload.recipientId) } : {}),
      ...(payload.recipientType === 'group' || payload.recipientType === 'channel' ? { recipientType: payload.recipientType } : {}),
    });
    const stored = await persistCommandExecutionResult(record, command, { messageId: message.id, providerMessageId: message.providerMessageId, status: 'sent' });
    return { type: command.type, targetEntityId: message.id, provider: command.provider, resultRecordId: stored.id, result: { status: 'sent', messageId: message.id, providerMessageId: message.providerMessageId } };
  }

  if (command.type === 'calendar.event.create') {
    const input = createNativeEventSchema.parse({
      title: payload.title,
      description: payload.description ?? null,
      startAt: payload.startAt,
      endAt: payload.endAt,
      timezone: payload.timezone ?? 'UTC',
      location: payload.location ?? null,
      customerId: payload.customerId,
    });
    const event = await calendarService.createNativeEvent(record.workspaceId, record.createdBy ?? null, input);
    const stored = await persistCommandExecutionResult(record, command, {
      eventId: event.id,
      status: event.status,
      startAt: event.startAt,
      endAt: event.endAt,
      customerId: event.customerId,
    });
    return {
      type: command.type,
      targetEntityId: event.id,
      provider: command.provider,
      resultRecordId: stored.id,
      result: event,
    };
  }

  if (command.type === 'website.domain.verify') {
    const siteId = textValue(payload.siteId);
    const domainId = textValue(payload.domainId || command.targetEntityId);
    if (!siteId || !domainId) throw new Error('website.domain.verify requires siteId and domainId');
    if (!record.createdBy) throw new Error('website.domain.verify requires an originating workspace user');
    const result = await verifyDomainOwnership({ workspaceId: record.workspaceId, siteId, domainId, userId: record.createdBy });
    const stored = await persistCommandExecutionResult(record, command, {
      status: 'verified',
      siteId,
      domainId,
      domainStatus: result?.domains.find((domain) => domain.id === domainId)?.status ?? null,
    });
    return {
      type: command.type,
      targetEntityId: domainId,
      provider: command.provider,
      resultRecordId: stored.id,
      result,
    };
  }

  if (command.type === 'website.publish_job') {
    const siteId = textValue(payload.siteId);
    const jobId = textValue(payload.jobId || command.targetEntityId);
    if (!siteId || !jobId) throw new Error('website.publish_job requires siteId and jobId');
    const result = await publishWebsiteJob(record.workspaceId, siteId, jobId);
    const stored = await persistCommandExecutionResult(record, command, {
      siteId,
      jobId,
      status: 'published',
    });
    return {
      type: command.type,
      targetEntityId: jobId,
      provider: command.provider,
      resultRecordId: stored.id,
      result,
    };
  }

  if (command.type === 'website.generate_content') {
    const siteId = textValue(payload.siteId || command.targetEntityId);
    const prompt = textValue(payload.prompt || command.summary, 8_000);
    const requestedLanguage = textValue(payload.requestedLanguage, 16) || 'en';
    if (!siteId || !prompt) throw new Error('website.generate_content requires siteId and prompt');
    if (!record.createdBy) throw new Error('website.generate_content requires an originating workspace user');
    const site = await websiteRepo.getSite(record.workspaceId, siteId);
    if (!site) throw new Error('Website site was not found for website.generate_content');
    const created = await websiteRepo.createJob({
      siteId,
      prompt,
      createdBy: record.createdBy,
      requestedLanguage,
      // Generation and publication are separate canonical actions. Never let
      // model-supplied payload data silently turn a content refresh into a
      // publish operation.
      autoPublish: false,
    });
    if (!created.job) throw new Error('Canonical website generation job could not be created');
    requestWebsiteGenerationWorkerRun();
    const stored = await persistCommandExecutionResult(record, command, {
      siteId,
      jobId: created.job.id,
      status: created.job.status,
      created: created.created,
      autoPublish: created.job.autoPublish,
    });
    return {
      type: command.type,
      targetEntityId: created.job.id,
      provider: command.provider,
      resultRecordId: stored.id,
      result: { status: 'queued', siteId, job: created.job, created: created.created },
    };
  }

  if (command.type === 'ecommerce.generate_product_images') {
    const sourceText = textValue(payload.sourceText, 20_000);
    if (!sourceText) throw new Error('ecommerce.generate_product_images requires sourceText');
    const result = await generateProductImagesFromText(sourceText, record.workspaceId, actorUserId);
    const stored = await persistCommandExecutionResult(record, command, {
      count: result.count,
      sync: result.sync,
      productRecordIds: result.records.map((item) => item.id),
    });
    return {
      type: command.type,
      targetEntityId: null,
      provider: command.provider,
      resultRecordId: stored.id,
      result: { count: result.count, sync: result.sync },
    };
  }

  const commerceActor = {
    actorType: 'AI_AGENT' as const,
    actorRef: record.id,
    correlationId: command.idempotencyKey,
    causationId: record.id,
  };

  if (command.type === 'commerce.order.create') {
    const input = createOrderSchema.parse({ ...payload, idempotencyKey: command.idempotencyKey });
    const order = await commerceService.createOrder(record.workspaceId, commerceActor, input);
    const stored = await persistCommandExecutionResult(record, command, {
      orderId: order.order.id,
      orderNumber: order.order.orderNumber,
      status: order.order.status,
      version: order.order.version,
    });
    return { type: command.type, targetEntityId: order.order.id, provider: command.provider, resultRecordId: stored.id, result: order };
  }

  if (command.type === 'commerce.product.create') {
    const product = await productService.createProduct(
      record.workspaceId,
      record.createdBy ?? null,
      createProductSchema.parse(payload),
    );
    const stored = await persistCommandExecutionResult(record, command, {
      productId: product.id,
      name: product.name,
      status: product.status,
    });
    return { type: command.type, targetEntityId: product.id, provider: command.provider, resultRecordId: stored.id, result: product };
  }

  if (command.type === 'commerce.product.update') {
    const productId = textValue(payload.productId || command.targetEntityId);
    if (!productId) throw new Error('commerce.product.update requires productId');
    const product = await productService.updateProduct(
      record.workspaceId,
      productId,
      record.createdBy ?? null,
      updateProductSchema.parse(payload),
    );
    const stored = await persistCommandExecutionResult(record, command, {
      productId: product.id,
      name: product.name,
      status: product.status,
      version: product.version,
    });
    return { type: command.type, targetEntityId: product.id, provider: command.provider, resultRecordId: stored.id, result: product };
  }

  if (command.type === 'commerce.category.create') {
    const category = await productService.createCategory(
      record.workspaceId,
      record.createdBy ?? actorUserId,
      createCategorySchema.parse(payload),
    );
    const stored = await persistCommandExecutionResult(record, command, {
      categoryId: category.id,
      name: category.name,
      slug: category.slug,
      status: category.status,
    });
    return { type: command.type, targetEntityId: category.id, provider: command.provider, resultRecordId: stored.id, result: category };
  }

  if (command.type === 'commerce.category.update') {
    const categoryId = textValue(payload.categoryId || command.targetEntityId);
    if (!categoryId) throw new Error('commerce.category.update requires categoryId');
    const category = await productService.updateCategory(
      record.workspaceId,
      categoryId,
      record.createdBy ?? actorUserId,
      updateCategorySchema.parse(payload),
    );
    const stored = await persistCommandExecutionResult(record, command, {
      categoryId: category.id,
      name: category.name,
      slug: category.slug,
      status: category.status,
    });
    return { type: command.type, targetEntityId: category.id, provider: command.provider, resultRecordId: stored.id, result: category };
  }

  if (command.type === 'commerce.order.update') {
    const orderId = textValue(payload.orderId || command.targetEntityId);
    if (!orderId) throw new Error('commerce.order.update requires orderId');
    const input = updateOrderSchema.parse({ ...payload, idempotencyKey: command.idempotencyKey });
    const order = await commerceService.updateOrder(record.workspaceId, orderId, commerceActor, input);
    const stored = await persistCommandExecutionResult(record, command, {
      orderId: order.order.id,
      status: order.order.status,
      version: order.order.version,
    });
    return { type: command.type, targetEntityId: order.order.id, provider: command.provider, resultRecordId: stored.id, result: order };
  }

  if (command.type === 'commerce.order.transition') {
    const orderId = textValue(payload.orderId || command.targetEntityId);
    if (!orderId) throw new Error('commerce.order.transition requires orderId');
    const input = transitionOrderSchema.parse({ ...payload, idempotencyKey: command.idempotencyKey });
    const order = await commerceService.transitionOrder(record.workspaceId, orderId, commerceActor, input);
    const stored = await persistCommandExecutionResult(record, command, {
      orderId: order.order.id,
      status: order.order.status,
      version: order.order.version,
    });
    return { type: command.type, targetEntityId: order.order.id, provider: command.provider, resultRecordId: stored.id, result: order };
  }

  if (command.type === 'commerce.inventory.adjust') {
    const input = adjustInventorySchema.parse({ ...payload, idempotencyKey: command.idempotencyKey });
    const level = await commerceService.adjustInventory(record.workspaceId, commerceActor, input);
    const stored = await persistCommandExecutionResult(record, command, {
      inventoryLevelId: level.id,
      available: level.available,
      version: level.version,
    });
    return { type: command.type, targetEntityId: level.id, provider: command.provider, resultRecordId: stored.id, result: level };
  }

  if (command.type === 'commerce.fulfillment.create') {
    const orderId = textValue(payload.orderId || command.targetEntityId);
    if (!orderId) throw new Error('commerce.fulfillment.create requires orderId');
    const input = createFulfillmentSchema.parse({ ...payload, idempotencyKey: command.idempotencyKey });
    const fulfillment = await commerceService.createFulfillment(record.workspaceId, orderId, commerceActor, input);
    const stored = await persistCommandExecutionResult(record, command, {
      orderId,
      fulfillmentId: fulfillment.fulfillment.id,
      status: fulfillment.fulfillment.status,
      version: fulfillment.fulfillment.version,
    });
    return { type: command.type, targetEntityId: fulfillment.fulfillment.id, provider: command.provider, resultRecordId: stored.id, result: fulfillment };
  }

  if (command.type === 'commerce.fulfillment.transition') {
    const orderId = textValue(payload.orderId);
    const fulfillmentId = textValue(payload.fulfillmentId || command.targetEntityId);
    if (!orderId || !fulfillmentId) throw new Error('commerce.fulfillment.transition requires orderId and fulfillmentId');
    const input = transitionFulfillmentSchema.parse({ ...payload, idempotencyKey: command.idempotencyKey });
    const fulfillment = await commerceService.transitionFulfillment(
      record.workspaceId,
      orderId,
      fulfillmentId,
      commerceActor,
      input,
    );
    const stored = await persistCommandExecutionResult(record, command, {
      orderId,
      fulfillmentId: fulfillment.fulfillment.id,
      status: fulfillment.fulfillment.status,
      version: fulfillment.fulfillment.version,
    });
    return { type: command.type, targetEntityId: fulfillment.fulfillment.id, provider: command.provider, resultRecordId: stored.id, result: fulfillment };
  }

  if (command.type === 'social.content.publish') {
    const contentInput = createSocialContentSchema.parse({
      ...payload,
      status: 'READY',
      idempotencyKey: `${command.idempotencyKey}:content`,
    });
    const contentResult = await socialPublishingService.createContent({
      workspaceId: record.workspaceId,
      actorId: actorUserId,
      actorType: 'AI_AGENT',
      actorRef: record.id,
      contentType: contentInput.contentType,
      status: 'READY',
      message: contentInput.message,
      linkUrl: contentInput.linkUrl ?? null,
      mediaUrl: contentInput.mediaUrl ?? null,
      altText: contentInput.altText ?? null,
      metadata: { ...contentInput.metadata, sourceActionRecordId: record.id },
      idempotencyKey: contentInput.idempotencyKey,
    });
    const publicationInput = createSocialPublicationSchema.parse({
      socialAccountId: payload.socialAccountId,
      contentId: contentResult.content.id,
      execution: 'QUEUE',
      scheduledAt: payload.scheduledAt ?? null,
      maxAttempts: payload.maxAttempts ?? 5,
      idempotencyKey: `${command.idempotencyKey}:publication`,
    });
    const publicationResult = await socialPublishingService.createPublication({
      workspaceId: record.workspaceId,
      actorId: actorUserId,
      actorType: 'AI_AGENT',
      actorRef: record.id,
      socialAccountId: publicationInput.socialAccountId,
      contentId: publicationInput.contentId,
      execution: 'QUEUE',
      scheduledAt: publicationInput.scheduledAt ?? null,
      maxAttempts: publicationInput.maxAttempts,
      idempotencyKey: publicationInput.idempotencyKey,
    });
    if (['QUEUED', 'SCHEDULED'].includes(publicationResult.job.status)) requestSocialPublishingWorkerRun();
    const socialState = publicationResult.job.status === 'BLOCKED' || publicationResult.job.status === 'FAILED'
      ? 'provider_failed' as const
      : publicationResult.job.status === 'PUBLISHED'
        ? 'completed' as const
        : 'waiting_for_provider' as const;
    const stored = await persistCommandExecutionResult(record, command, {
      contentId: contentResult.content.id,
      publicationId: publicationResult.job.id,
      status: publicationResult.job.status,
      version: publicationResult.job.version,
    }, socialState);
    return {
      type: command.type,
      targetEntityId: publicationResult.job.id,
      provider: command.provider,
      resultRecordId: stored.id,
      executionState: socialState,
      result: { content: contentResult.content, publication: publicationResult.job },
    };
  }

  if (command.type === 'social.publication.retry' || command.type === 'social.publication.cancel') {
    const publicationId = textValue(payload.publicationId || command.targetEntityId);
    if (!publicationId) throw new Error(`${command.type} requires publicationId`);
    const input = transitionSocialPublicationSchema.parse(payload);
    const action = command.type === 'social.publication.retry' ? 'RETRY' as const : 'CANCEL' as const;
    const publication = await socialPublishingService.transitionPublication({
      workspaceId: record.workspaceId,
      jobId: publicationId,
      actorId: actorUserId,
      actorType: 'AI_AGENT',
      actorRef: record.id,
      expectedVersion: input.expectedVersion,
      action,
      ...(input.scheduledAt !== undefined ? { scheduledAt: input.scheduledAt } : {}),
    });
    if (action === 'RETRY') requestSocialPublishingWorkerRun();
    const socialState = action === 'RETRY'
      ? 'waiting_for_provider' as const
      : 'completed' as const;
    const stored = await persistCommandExecutionResult(record, command, {
      publicationId: publication.id,
      status: publication.status,
      version: publication.version,
    }, socialState);
    return { type: command.type, targetEntityId: publication.id, provider: command.provider, resultRecordId: stored.id, executionState: socialState, result: publication };
  }

  throw new Error(`No executable adapter is registered for agent command ${command.type}`);
}

type CommandExecutionResult = {
  type: AgentExecutionCommand['type'];
  targetEntityId: string | null;
  provider: string | null;
  resultRecordId?: string;
  result: unknown;
  executionState?: 'completed' | 'waiting_for_provider' | 'provider_failed';
};

export function normalizedCommandsForRecord(record: recordRepo.WorkspaceRecord) {
  const data = record.data ?? {};
  return normalizeAgentExecutionCommands(data.commands, {
    module: textValue(data.targetModule) || textValue(data.module) || 'general',
    targetSystem: textValue(data.targetSystem) || 'ai',
    actionResourceType: record.resourceType,
    pageId: textValue(data.pageId) || null,
    pageLabel: textValue(data.pageLabel) || record.name,
    goal: textValue(data.goal, 400) || record.name,
    jobs: stringList(data.jobs),
    policyDecision: ['require_budget', 'require_approval'].includes(textValue(data.policyDecision)) ? 'require_budget' : 'allow',
    executionMode: textValue(data.executionMode) === 'autonomous' ? 'autonomous' : 'analysis_only',
    accountId: textValue(data.accountId) || null,
    conversationId: textValue(data.conversationId) || null,
    messageText: textValue(data.messageText, 10_000) || null,
    messageType: textValue(data.messageType, 20) || null,
    recipientId: textValue(data.recipientId, 200) || null,
    recipientType: data.recipientType === 'group' || data.recipientType === 'channel' ? data.recipientType : null,
    threadId: textValue(data.threadId) || null,
    tone: textValue(data.tone) || null,
    language: textValue(data.language) || null,
    instruction: textValue(data.instruction, 2000) || null,
    to: data.to,
    cc: data.cc,
    subject: textValue(data.subject, 998) || null,
    bodyText: textValue(data.bodyText, 100_000) || null,
    replyToProviderMessageId: textValue(data.replyToProviderMessageId, 1000) || null,
    reviewId: textValue(data.reviewId) || null,
    locationId: textValue(data.locationId) || null,
    comment: textValue(data.comment, 4000) || null,
    siteId: textValue(data.siteId) || null,
    jobId: textValue(data.jobId) || null,
    provider: textValue(data.provider) || null,
    providerConnectionId: textValue(data.providerConnectionId) || null,
    eventTitle: textValue(data.eventTitle, 240) || null,
    startAt: textValue(data.startAt, 80) || null,
    endAt: textValue(data.endAt, 80) || null,
    timezone: textValue(data.timezone, 100) || null,
    location: textValue(data.location, 500) || null,
    customerId: textValue(data.customerId) || null,
    companyId: textValue(data.companyId) || null,
    orderId: textValue(data.orderId) || null,
    invoiceId: textValue(data.invoiceId) || null,
    invoiceAction: data.invoiceAction === 'issue' || data.invoiceAction === 'send' ? data.invoiceAction : null,
    domainId: textValue(data.domainId) || null,
    sourceText: textValue(data.sourceText, 20_000) || null,
    customerRecordId: textValue(data.customerRecordId) || null,
    companyRecordId: textValue(data.companyRecordId) || null,
    leadRecordId: textValue(data.leadRecordId) || null,
    opportunityRecordId: textValue(data.opportunityRecordId) || null,
    factoryId: textValue(data.factoryId) || null,
    marketCode: textValue(data.marketCode, 20) || null,
    currency: textValue(data.currency, 3) || null,
    validUntil: textValue(data.validUntil, 10) || null,
    shippingTotal: (typeof data.shippingTotal === 'number' || typeof data.shippingTotal === 'string') ? data.shippingTotal : null,
    terms: data.terms ?? null,
    quoteLines: Array.isArray(data.quoteLines) ? data.quoteLines : null,
    conversationIdForQuote: textValue(data.conversationIdForQuote) || null,
    socialAccountId: textValue(data.socialAccountId) || null,
    contentType: data.contentType === 'TEXT' || data.contentType === 'LINK' || data.contentType === 'IMAGE' ? data.contentType : null,
    contentMessage: textValue(data.contentMessage, 63_206) || null,
    contentLinkUrl: textValue(data.contentLinkUrl, 2_048) || null,
    contentMediaUrl: textValue(data.contentMediaUrl, 2_048) || null,
    contentAltText: textValue(data.contentAltText, 1_000) || null,
    scheduledAt: textValue(data.scheduledAt, 80) || null,
    maxAttempts: typeof data.maxAttempts === 'number' && Number.isInteger(data.maxAttempts) ? data.maxAttempts : null,
  });
}

async function finalizeExecutionRecord(
  record: recordRepo.WorkspaceRecord,
  commands: AgentExecutionCommand[],
  commandResults: CommandExecutionResult[],
) {
  const data = record.data ?? {};
  const planningOnly = commandResults.length > 0 && commandResults.every((item) => {
    if (item.type !== 'record.create_artifact') return false;
    return objectValue(item.result).executionBoundary === 'planning_artifact_only';
  });
  const executionStatus = planningOnly ? 'planned' as const : 'executed' as const;
  const artifacts = await createExecutionArtifacts(record, executionStatus);
  const commandResultEntries: Array<{ id: string; resourceType: ResourceType }> = commands.flatMap((command, index) => {
    const resultId = commandResults[index]?.resultRecordId;
    return typeof resultId === 'string'
      ? [{ id: resultId, resourceType: resolveCommandResultResourceType(command) }]
      : [];
  });
  const resultRecords: Array<{ id: string; resourceType: ResourceType }> = [
    { id: artifacts.activity.id, resourceType: artifacts.activity.resourceType },
    ...(artifacts.artifact ? [{ id: artifacts.artifact.id, resourceType: artifacts.artifact.resourceType }] : []),
    ...commandResultEntries,
  ];
  const update = await recordRepo.updateRecord(record.workspaceId, record.resourceType, record.id, record.createdBy, {
    status: 'completed',
    stage: planningOnly ? 'planned' : 'executed',
    data: {
      ...data,
      commands,
      commandTypes: [...new Set(commands.map((command) => command.type))],
      executionReady: false,
      executionStatus,
      executionBoundary: planningOnly ? 'planning_artifact_only' : 'canonical_domain_action',
      sideEffectsApplied: !planningOnly && commandResults.some((item) => item.type !== 'record.create_artifact'),
      executionCompletedAt: new Date().toISOString(),
      executorVersion: '1.0.0',
      executionSummary: executionSummary(record),
      executionResults: commandResults,
      resultRecords,
      resultRecordIds: resultRecords.map((entry) => entry.id),
      resultResourceTypes: resultRecords.map((entry) => entry.resourceType),
      pendingProviderOperations: [],
      executionNextAttemptAt: null,
      executionError: null,
    },
    description: textValue(record.description) || textValue(data.goal) || `Executed action packet for ${textValue(data.pageLabel) || record.name}.`,
    expectedVersion: record.version,
  });
  if (update.status !== 'updated') throw new Error(`Executor could not finalize record ${record.id}: ${update.status}`);
}

async function executeRecord(record: recordRepo.WorkspaceRecord) {
  const data = record.data ?? {};
  const commands = normalizedCommandsForRecord(record);
  const commandResults = await executeAuthorizedAgentPacket(record,commands,command=>executeAgentCommand(record,command));
  const failedProviderResult = commandResults.find((item) => 'executionState' in item && item.executionState === 'provider_failed');
  if (failedProviderResult) {
    throw new Error(`invalid provider execution state for ${failedProviderResult.type}`);
  }
  const pendingProviderResults = commandResults.filter((item) => 'executionState' in item && item.executionState === 'waiting_for_provider');
  if (pendingProviderResults.length > 0) {
    const update = await recordRepo.updateRecord(record.workspaceId, record.resourceType, record.id, record.createdBy, {
      status: 'active',
      stage: 'waiting_for_provider',
      data: {
        ...data,
        commands,
        commandTypes: [...new Set(commands.map((command) => command.type))],
        executionReady: false,
        executionStatus: 'waiting_for_provider',
        sideEffectsApplied: true,
        providerWaitingSince: new Date().toISOString(),
        executionResults: commandResults,
        pendingProviderOperations: pendingProviderResults.map((item) => ({
          type: item.type,
          targetEntityId: item.targetEntityId,
          resultRecordId: item.resultRecordId,
        })),
        executionNextAttemptAt: null,
        executionError: null,
      },
      expectedVersion: record.version,
    });
    if (update.status !== 'updated') throw new Error(`Executor could not persist provider wait for record ${record.id}: ${update.status}`);
    return;
  }
  await finalizeExecutionRecord(record, commands, commandResults as CommandExecutionResult[]);
}

function classifyExecutionError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Unknown execution failure';
  const normalized = message.toLowerCase();
  if (
    normalized.includes('requires') ||
    normalized.includes('not found') ||
    normalized.includes('approval') ||
    normalized.includes('forbidden') ||
    normalized.includes('invalid')
  ) {
    return { errorClass: 'validation', message };
  }
  return { errorClass: 'transient', message };
}

async function failRecord(record: recordRepo.WorkspaceRecord, error: unknown) {
  const failure = classifyExecutionError(error);
  const update = await recordRepo.updateRecord(record.workspaceId, record.resourceType, record.id, record.createdBy, {
    // Never put a failed AI action packet back on the worker queue. The Office
    // exposes this as Paused and a user can explicitly Resume it after fixing
    // the underlying issue.
    status: 'active',
    stage: 'execution_paused',
    data: {
      ...(record.data ?? {}),
      executionStatus: 'paused',
      executionFailedAt: new Date().toISOString(),
      executionError: failure.message,
      executionErrorClass: failure.errorClass,
      executionRetryable: false,
      executionNextAttemptAt: null,
      executionPausedAt: new Date().toISOString(),
      executionPauseReason: 'automatic_retry_disabled_after_failure',
    },
    expectedVersion: record.version,
  });
  if (update.status !== 'updated') {
    logger.warn({ workspaceId: record.workspaceId, recordId: record.id, updateStatus: update.status }, 'Agent execution record could not be marked as failed');
  }
}

function receiptPublicationId(receipt: recordRepo.WorkspaceRecord) {
  const commandResult = objectValue(receipt.data?.commandResult);
  return textValue(commandResult.publicationId);
}

function commandResultFromReceipt(
  command: AgentExecutionCommand,
  receipt: recordRepo.WorkspaceRecord,
): CommandExecutionResult {
  const result = objectValue(receipt.data?.commandResult);
  const targetEntityId = textValue(
    result.publicationId
      ?? result.orderId
      ?? result.invoiceId
      ?? result.quoteId
      ?? result.fulfillmentId
      ?? result.inventoryLevelId,
  ) || null;
  return {
    type: command.type,
    targetEntityId,
    provider: command.provider,
    resultRecordId: receipt.id,
    executionState: receipt.status === 'failed' || receipt.stage === 'provider_failed'
      ? 'provider_failed'
      : receipt.stage === 'waiting_for_provider'
        ? 'waiting_for_provider'
        : 'completed',
    result,
  };
}

async function reconcileSocialProviderResult(event: DomainEvent) {
  const workspaceId = event.workspaceId;
  const actionRecordId = typeof event.metadata.actorRef === 'string' ? event.metadata.actorRef : '';
  const actorType = typeof event.metadata.actorType === 'string' ? event.metadata.actorType.toUpperCase() : '';
  const publicationId = textValue(event.payload.jobId ?? event.aggregateId);
  const cancelled = event.type === DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_CANCELLED;
  if (!workspaceId || actorType !== 'AI_AGENT' || !actionRecordId || !publicationId) return { ignored: true };

  const actionRecord = await recordRepo.findAgentActionRecord(workspaceId, actionRecordId);
  if (!actionRecord) return { ignored: true, reason: 'action_packet_not_found' };
  if (actionRecord.stage === 'executing') {
    throw new Error(`Agent action packet ${actionRecord.id} has not persisted its provider wait state yet`);
  }
  const eligibleStages = cancelled
    ? ['waiting_for_provider', 'execution_failed', 'execution_cancelled']
    : ['waiting_for_provider'];
  if (!eligibleStages.includes(actionRecord.stage ?? '')) return { ignored: true, reason: 'action_packet_not_waiting' };

  const receipts = await recordRepo.listCommandExecutionResultsBySourceRecordId(workspaceId, actionRecord.id);
  const receipt = receipts.find((item) => receiptPublicationId(item) === publicationId);
  if (!receipt) throw new Error(`Social provider receipt for publication ${publicationId} was not found`);
  const receiptVersion = numberValue(objectValue(receipt.data?.commandResult).version);
  const eventVersion = numberValue(event.payload.version);
  if (receiptVersion > 0 && eventVersion > 0 && eventVersion < receiptVersion) {
    return { ignored: true, reason: 'stale_provider_transition', eventVersion, receiptVersion };
  }
  if (receipt.stage === 'waiting_for_provider' || (cancelled && receipt.stage === 'provider_failed')) {
    const published = event.type === DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_PUBLISHED;
    const terminalData = {
      ...(receipt.data ?? {}),
      commandResult: {
        ...objectValue(receipt.data?.commandResult),
        ...event.payload,
        status: cancelled ? 'CANCELLED' : published ? 'PUBLISHED' : textValue(event.payload.status) || 'FAILED',
        providerTerminalEventId: event.id,
      },
      executedAt: published ? event.occurredAt : null,
      providerCompletedAt: event.occurredAt,
      providerTerminalEventId: event.id,
      providerError: published || cancelled ? null : {
        code: textValue(event.payload.code) || 'SOCIAL_PUBLICATION_FAILED',
        message: textValue(event.payload.message, 2000) || 'The social provider did not publish the content.',
      },
    };
    const updated = await recordRepo.updateRecord(workspaceId, receipt.resourceType, receipt.id, actionRecord.createdBy, {
      status: cancelled ? 'cancelled' : published ? 'completed' : 'failed',
      stage: cancelled ? 'execution_cancelled' : published ? 'completed' : 'provider_failed',
      data: terminalData,
      expectedVersion: receipt.version,
    });
    if (updated.status !== 'updated') throw new Error(`Social provider receipt ${receipt.id} could not be reconciled: ${updated.status}`);
  }

  const terminalReceipts = await recordRepo.listCommandExecutionResultsBySourceRecordId(workspaceId, actionRecord.id);
  if (terminalReceipts.some((item) => item.stage === 'waiting_for_provider')) {
    return { reconciled: true, completed: false, waitingForOtherProviders: true };
  }
  const cancelledReceipt = terminalReceipts.find((item) => item.status === 'cancelled' || item.stage === 'execution_cancelled');
  if (cancelledReceipt) {
    if (actionRecord.status === 'cancelled' && actionRecord.stage === 'execution_cancelled') {
      return { reconciled: true, completed: false, cancelled: true };
    }
    const update = await recordRepo.updateRecord(workspaceId, actionRecord.resourceType, actionRecord.id, actionRecord.createdBy, {
      status: 'cancelled',
      stage: 'execution_cancelled',
      data: {
        ...(actionRecord.data ?? {}),
        executionReady: false,
        executionStatus: 'cancelled',
        executionRetryable: false,
        executionError: null,
        pendingProviderOperations: [],
        executionNextAttemptAt: null,
      },
      expectedVersion: actionRecord.version,
    });
    if (update.status !== 'updated') throw new Error(`Agent action packet ${actionRecord.id} could not record provider cancellation: ${update.status}`);
    return { reconciled: true, completed: false, cancelled: true };
  }
  const failedReceipt = terminalReceipts.find((item) => item.status === 'failed' || item.stage === 'provider_failed');
  if (failedReceipt) {
    const failedResult = objectValue(failedReceipt.data?.commandResult);
    const update = await recordRepo.updateRecord(workspaceId, actionRecord.resourceType, actionRecord.id, actionRecord.createdBy, {
      status: 'failed',
      stage: 'execution_failed',
      data: {
        ...(actionRecord.data ?? {}),
        executionReady: false,
        executionStatus: 'failed',
        executionFailedAt: event.occurredAt,
        executionRetryable: false,
        executionErrorClass: 'provider_terminal',
        executionError: textValue(failedResult.message, 2000)
          || textValue(event.payload.message, 2000)
          || 'A provider operation failed.',
        pendingProviderOperations: [],
        executionNextAttemptAt: null,
      },
      expectedVersion: actionRecord.version,
    });
    if (update.status !== 'updated') throw new Error(`Agent action packet ${actionRecord.id} could not record provider failure: ${update.status}`);
    return { reconciled: true, completed: false, failed: true };
  }

  const commands = normalizedCommandsForRecord(actionRecord);
  const receiptsByKey = new Map(terminalReceipts.map((item) => [textValue(item.data?.commandIdempotencyKey), item]));
  const consumedReceiptIds = new Set<string>();
  const results = commands.map((command) => {
    const exactReceipt = receiptsByKey.get(command.idempotencyKey);
    const commandReceipt = exactReceipt && !consumedReceiptIds.has(exactReceipt.id)
      ? exactReceipt
      : terminalReceipts.find((item) => !consumedReceiptIds.has(item.id) && item.data?.commandType === command.type);
    if (!commandReceipt) throw new Error(`Command receipt ${command.idempotencyKey} was not found during provider finalization`);
    consumedReceiptIds.add(commandReceipt.id);
    return commandResultFromReceipt(command, commandReceipt);
  });
  await finalizeExecutionRecord(actionRecord, commands, results);
  return { reconciled: true, completed: true };
}

export function runAgentExecutionCycle(): Promise<void> {
  if (activeCycle) return activeCycle;
  if (stopping) return Promise.resolve();
  activeCycle = (async () => {
    const heartbeat = setInterval(() => runtimeMonitor.progress({ phase: 'processing' }), 30_000);
    heartbeat.unref();
    let processed = 0;
    try {
      for (let index = 0; index < batchSize && !stopping; index += 1) {
        const record = (await recordRepo.claimExecutionReadyRecords(1))[0];
        if (!record) break;
        try {
          await executeRecord(record);
        } catch (error) {
          await failRecord(record, error);
          logger.error({ error, workspaceId: record.workspaceId, recordId: record.id }, 'Agent execution record failed');
        }
        processed += 1;
      }
      runtimeMonitor.progress({ phase: processed ? 'processed' : 'idle', processed });
    } finally {
      clearInterval(heartbeat);
    }
  })()
    .catch((error: unknown) => {
      runtimeMonitor.failed(error);
      logger.error({ error }, 'Agent execution worker cycle failed');
    })
    .finally(() => { activeCycle = null; });
  return activeCycle;
}

export function registerAgentExecutionHandlers() {
  registerDomainEventHandler({
    name: 'agents.execution-record-wakeup.v1',
    eventTypes: [DOMAIN_EVENT_TYPES.RECORD_CREATED],
    async handle() {
      await runAgentExecutionCycle();
      return { woken: true };
    },
  });
  registerDomainEventHandler({
    name: 'agents.social-provider-result.v1',
    eventTypes: [
      DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_PUBLISHED,
      DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_FAILED,
      DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_BLOCKED,
      DOMAIN_EVENT_TYPES.SOCIAL_PUBLICATION_CANCELLED,
    ],
    handle(event) {
      return trackAgentExecutionEvent(() => reconcileSocialProviderResult(event))
        ?? { ignored: true, stopping: true };
    },
  });
}

export function startAgentExecutionWorker() {
  if (timer) return;
  stopping = false;
  runtimeMonitor.start();
  registerAgentExecutionHandlers();
  timer = setInterval(() => void runAgentExecutionCycle(), intervalMs);
  timer.unref();
  void runAgentExecutionCycle();
  logger.info({ intervalMs, batchSize }, 'Agent execution worker started');
}

export async function stopAgentExecutionWorker() {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = undefined;
  await runtimeMonitor.stopping();
  if (activeCycle) await activeCycle;
  while (activeEventTasks.size > 0) await Promise.allSettled([...activeEventTasks]);
  await runtimeMonitor.stopped();
}
