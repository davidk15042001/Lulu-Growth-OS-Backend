import { isResourceType, type ResourceType } from '../../domain/resource-catalog.js';
import * as recordRepo from '../records/record.repo.js';
import { createAiDraft, createDraft } from '../email/email.service.js';
import { updateGoogleReviewReply } from '../workspace-app/workspace-app.service.js';
import { publishWebsiteJob } from '../websites/website.publish.service.js';
import type { AssistantPendingAction } from './assistant.tools.js';

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
    tags: ['ai-assistant', action.type].slice(0, 12),
    data: {
      sourceAction: action.type,
      jobs: Array.isArray(payload.jobs) ? payload.jobs : [],
    },
  });
  return { resourceType, recordId: item.id, status: 'created' };
}

export async function executeAssistantAction(workspaceId: string, userId: string, action: AssistantPendingAction) {
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
    return { status: 'created', resourceType: null, recordId: draft.id, message: 'Email draft created.' };
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
    return { status: 'created', resourceType: null, recordId: draft.id, message: 'AI email draft created.' };
  }

  if (action.type === 'website.publish_job') {
    const siteId = textValue(payload.siteId);
    const jobId = textValue(payload.jobId);
    if (!siteId || !jobId) throw new Error('website.publish_job requires siteId and jobId');
    await publishWebsiteJob(workspaceId, siteId, jobId);
    return { status: 'published', resourceType: 'marketing_publications' as ResourceType, recordId: null, message: 'Website publishing started.' };
  }

  const resourceType = resultResourceType(action.type);
  if (!resourceType || !isResourceType(resourceType)) {
    throw new Error(`Unsupported action type: ${action.type}`);
  }
  const result = await createTaskRecord(workspaceId, userId, resourceType, action);
  return { ...result, message: `${action.type} completed.` };
}
