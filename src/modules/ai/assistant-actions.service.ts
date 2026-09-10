import { createHash } from 'node:crypto';
import { logger } from '../../config/logger.js';
import { isResourceType, type ResourceType } from '../../domain/resource-catalog.js';
import { query, withTransaction } from '../../db/pool.js';
import { AppError, notFoundError } from '../../utils/app-error.js';
import * as recordRepo from '../records/record.repo.js';
import { createAiDraft, createDraft, sendDraft } from '../email/email.service.js';
import { updateGoogleReviewReply } from '../workspace-app/workspace-app.service.js';
import { publishWebsiteJob } from '../websites/website.publish.service.js';
import { startContentRefresh } from '../content-generation/content-generation.service.js';
import { evaluateAgentActionPolicy } from '../agents/agent.autonomy-policy.js';
import { resolveWorkspaceEntitlements } from '../entitlements/entitlement.service.js';
import { assertWorkspaceCapability } from '../workspaces/workspace-authorization.service.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import { assertAdSpendFunded, consumeAdSpendReservation, releaseAdSpendReservation, reserveAdSpend } from '../adspend/adspend.repo.js';
import { executeAdvertisingProviderOperation } from '../adspend/advertising.provider.service.js';
import { sendAutonomousMessage } from '../omnichannel/omnichannel.service.js';
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

function publicAction(row: AssistantActionRow): AssistantPendingAction {
  return {
    id: row.id,
    conversationId: row.conversationId,
    type: row.type,
    summary: row.summary,
    payload: row.payload,
    status: row.status,
    approvalId: null,
    requiresApproval: false,
    result: row.result,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    expiresAt: row.expiresAt,
  };
}

function actionPolicy(type: AssistantActionInput['type'], autonomous: boolean) {
  return evaluateAgentActionPolicy(type, autonomous, {
    highRisk: type === 'google_reviews.reply' || type === 'website.publish_job',
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

function resultResourceType(type: string): ResourceType | null {
  if (type === 'crm.create_followup_task') return 'crm_tasks';
  if (type === 'sales.create_followup_task') return 'sales_tasks';
  if (type === 'advertising.create_optimization') return 'ad_optimizations';
  if (type === 'finance.create_automation') return 'finance_automations';
  if (type === 'website.publish_job') return 'marketing_publications';
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
    const sent = await sendDraft(workspaceId, draft.id);
    return { status: 'sent', resourceType: null, recordId: draft.id, message: 'Email sent.', providerMessageId: sent?.providerMessageId ?? null };
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
    const sent = await sendDraft(workspaceId, draft.id);
    return { status: 'sent', resourceType: null, recordId: draft.id, message: 'AI email sent.', providerMessageId: sent?.providerMessageId ?? null };
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

  if (action.type === 'advertising.create_optimization') {
    const provider=textValue(payload.provider,40);
    const providerAction=textValue(payload.action,20)==='pause'?'pause':'launch';
    if(provider!=='google-ads')throw new AppError(409,'AD_PROVIDER_EXECUTION_UNAVAILABLE','This action requires an executable Google Ads connection.');
    const common={provider:'google-ads' as const,customerId:textValue(payload.customerId),campaignId:textValue(payload.campaignId),...(textValue(payload.loginCustomerId)?{loginCustomerId:textValue(payload.loginCustomerId)}:{})};
    if(providerAction==='pause'){
      const result=await executeAdvertisingProviderOperation(workspaceId,{...common,action:'pause'});
      return {status:'executed',resourceType:'ad_optimizations' as ResourceType,recordId:null,message:'Google Ads campaign paused.',...result};
    }
    const wallet=await assertAdSpendFunded(workspaceId);
    const requested=Number(payload.budgetAmountCny)||wallet.availableAmount;
    const amount=Math.min(requested,wallet.availableAmount);
    const reservation=await reserveAdSpend({workspaceId,amount,idempotencyKey:`assistant:${action.id}:ad-spend`,platform:provider,campaignId:textValue(payload.campaignId),metadata:{assistantActionId:action.id}});
    try{
      const result=await executeAdvertisingProviderOperation(workspaceId,{...common,action:'launch',campaignBudgetId:textValue(payload.campaignBudgetId),accountCurrency:textValue(payload.accountCurrency),budgetAmountCny:amount});
      await consumeAdSpendReservation({workspaceId,reservationId:reservation.id,providerOperationId:result.providerOperationId,metadata:{providerResponse:result.response}});
      return {status:'executed',resourceType:'ad_optimizations' as ResourceType,recordId:null,message:'Google Ads campaign launched.',reservationId:reservation.id,budgetAmountCny:amount,...result};
    }catch(error){
      await releaseAdSpendReservation({workspaceId,reservationId:reservation.id,reason:error instanceof Error?error.message:'Provider execution failed'});
      throw error;
    }
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
    const result = await executeAssistantActionImplementation(claimed.workspaceId, claimed.requestedBy, publicAction(claimed));
    const completed = (await query<AssistantActionRow>(
      `UPDATE assistant_action_requests SET status='succeeded',result=$2::jsonb,completed_at=NOW() WHERE id=$1 AND status='executing' RETURNING ${actionSelect}`,
      [claimed.id, JSON.stringify(result)],
    )).rows[0]!;
    await recordSecurityEvent({eventType:'ADMIN_ACTION',workspaceId:claimed.workspaceId,userId:claimed.requestedBy,metadata:{action:'assistant_action_executed',targetId:claimed.id,actionType:claimed.type}});
    return publicAction(completed);
  } catch (error) {
    logger.error({ error, workspaceId: claimed.workspaceId, actionId: claimed.id, actionType: claimed.type }, 'Assistant action execution failed');
    const message = 'The assistant action could not be completed.';
    const failed = (await query<AssistantActionRow>(
      `UPDATE assistant_action_requests SET status='failed',error_code='ASSISTANT_ACTION_EXECUTION_FAILED',error_message=$2,completed_at=NOW() WHERE id=$1 RETURNING ${actionSelect}`,
      [claimed.id, message.slice(0, 2000)],
    )).rows[0]!;
    throw Object.assign(new AppError(502, 'ASSISTANT_ACTION_EXECUTION_FAILED', message), { action: publicAction(failed) });
  }
}

export async function requestAssistantAction(workspaceId: string, userId: string, conversationId: string, rawAction: unknown) {
  const action = assistantActionInputSchema.parse(rawAction);
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
    // without per-action approvals; the only customer authorization boundary
    // is the separately funded prepaid ad-spend wallet.
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
