import type { NextFunction, Request, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import { AppError } from '../../utils/app-error.js';
import { env } from '../../config/env.js';
import * as service from './email.service.js';
import { completeEmailOAuth, getSafeEmailReturnTo, isEmailOAuthProvider } from './email.oauth.service.js';
import {
  accountParams, aiDraftSchema, createDraftSchema, createRuleSchema, draftParams, imapConnectSchema,
  listThreadsQuery, messageParams, messageStateSchema, oauthStartSchema, ruleParams, syncJobParams,
  threadParams, updateDraftSchema, updateRuleSchema, workspaceParams,
} from './email.validator.js';

export async function accounts(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = workspaceParams.parse(req.params); return successResponse(res, 'Email accounts loaded', { items: await service.listAccounts(workspaceId) }); } catch (error) { next(error); }
}

export async function startOAuth(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = workspaceParams.parse(req.params); const input = oauthStartSchema.parse(req.body); return successResponse(res, 'Email authorization URL created', service.startOAuth(input.provider, workspaceId, req.user!.id, input.returnTo)); } catch (error) { next(error); }
}

export async function connectImap(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = workspaceParams.parse(req.params); const account = await service.connectImap(workspaceId, req.user!.id, imapConnectSchema.parse(req.body)); return createdResponse(res, 'Email account connected', account); } catch (error) { next(error); }
}

export async function disconnect(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId, accountId } = accountParams.parse(req.params); await service.disconnect(workspaceId, accountId); return successResponse(res, 'Email account disconnected'); } catch (error) { next(error); }
}

export async function startSync(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId, accountId } = accountParams.parse(req.params); return createdResponse(res, 'Email synchronization queued', await service.startSync(workspaceId, accountId, req.user!.id)); } catch (error) { next(error); }
}

export async function syncJob(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId, accountId, jobId } = syncJobParams.parse(req.params); return successResponse(res, 'Email synchronization status loaded', await service.getSyncJob(workspaceId, accountId, jobId)); } catch (error) { next(error); }
}

export async function folders(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = workspaceParams.parse(req.params); const accountId = typeof req.query.accountId === 'string' ? accountParams.shape.accountId.parse(req.query.accountId) : undefined; return successResponse(res, 'Email folders loaded', { items: await service.listFolders(workspaceId, accountId) }); } catch (error) { next(error); }
}

export async function threads(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = workspaceParams.parse(req.params); return successResponse(res, 'Email threads loaded', await service.listThreads(workspaceId, listThreadsQuery.parse(req.query))); } catch (error) { next(error); }
}

export async function thread(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId, threadId } = threadParams.parse(req.params); return successResponse(res, 'Email thread loaded', await service.getThread(workspaceId, threadId)); } catch (error) { next(error); }
}

export async function updateMessage(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId, messageId } = messageParams.parse(req.params); return successResponse(res, 'Email message updated', await service.updateMessageState(workspaceId, messageId, messageStateSchema.parse(req.body))); } catch (error) { next(error); }
}

export async function drafts(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = workspaceParams.parse(req.params); return successResponse(res, 'Email drafts loaded', { items: await service.listDrafts(workspaceId) }); } catch (error) { next(error); }
}

export async function createDraft(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = workspaceParams.parse(req.params); return createdResponse(res, 'Email draft created', await service.createDraft(workspaceId, req.user!.id, createDraftSchema.parse(req.body))); } catch (error) { next(error); }
}

export async function updateDraft(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId, draftId } = draftParams.parse(req.params); return successResponse(res, 'Email draft updated', await service.updateDraft(workspaceId, draftId, updateDraftSchema.parse(req.body))); } catch (error) { next(error); }
}

export async function aiDraft(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId, threadId } = threadParams.parse(req.params); return createdResponse(res, 'AI email draft created', await service.createAiDraft(workspaceId, req.user!.id, threadId, aiDraftSchema.parse(req.body))); } catch (error) { next(error); }
}

export async function sendDraft(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId, draftId } = draftParams.parse(req.params); return successResponse(res, 'Email sent', await service.sendDraft(workspaceId, draftId)); } catch (error) { next(error); }
}

export async function rules(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = workspaceParams.parse(req.params); return successResponse(res, 'Email automation rules loaded', { items: await service.listRules(workspaceId) }); } catch (error) { next(error); }
}

export async function createRule(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId } = workspaceParams.parse(req.params); return createdResponse(res, 'Email automation rule created', await service.createRule(workspaceId, req.user!.id, createRuleSchema.parse(req.body))); } catch (error) { next(error); }
}

export async function updateRule(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId, ruleId } = ruleParams.parse(req.params); return successResponse(res, 'Email automation rule updated', await service.updateRule(workspaceId, ruleId, updateRuleSchema.parse(req.body))); } catch (error) { next(error); }
}

export async function deleteRule(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try { const { workspaceId, ruleId } = ruleParams.parse(req.params); await service.deleteRule(workspaceId, ruleId); return successResponse(res, 'Email automation rule deleted'); } catch (error) { next(error); }
}

function frontendUrl(path: string) { return `${(env.FRONTEND_BASE_URL ?? '').replace(/\/$/, '')}${path}`; }

export async function oauthCallback(req: Request, res: Response) {
  const providerValue = String(req.params.provider ?? '');
  const stateValue = typeof req.query.state === 'string' ? req.query.state : undefined;
  const returnTo = getSafeEmailReturnTo(stateValue);
  const redirectError = (code: string) => res.redirect(302, frontendUrl(`${returnTo}${returnTo.includes('?') ? '&' : '?'}emailConnection=error&code=${encodeURIComponent(code)}`));
  if (!isEmailOAuthProvider(providerValue)) return redirectError('EMAIL_PROVIDER_NOT_SUPPORTED');
  if (req.query.error) return redirectError('EMAIL_OAUTH_DENIED');
  if (typeof req.query.code !== 'string' || !stateValue) return redirectError('EMAIL_OAUTH_CALLBACK_INCOMPLETE');
  try {
    const result = await completeEmailOAuth(providerValue, req.query.code, stateValue);
    return res.redirect(302, frontendUrl(`${result.returnTo}${result.returnTo.includes('?') ? '&' : '?'}emailConnection=success&accountId=${encodeURIComponent(result.account.id)}`));
  } catch (error) {
    return redirectError(error instanceof AppError ? error.code : 'EMAIL_OAUTH_CALLBACK_FAILED');
  }
}
