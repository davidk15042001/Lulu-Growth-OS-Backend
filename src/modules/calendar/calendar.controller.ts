import type { NextFunction, Request, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import { AppError } from '../../utils/app-error.js';
import { env } from '../../config/env.js';
import * as service from './calendar.service.js';
import { completeCalendarOAuth, getSafeCalendarReturnTo, isCalendarOAuthProvider } from './calendar.oauth.service.js';
import { accountParams, listEventsQuery, oauthStartSchema, syncJobParams, tokenConnectSchema, workspaceParams } from './calendar.validator.js';

export async function overview(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = workspaceParams.parse(req.params);
    return successResponse(res, 'Calendar workspace loaded', await service.getOverview(workspaceId, listEventsQuery.parse(req.query)));
  } catch (error) { next(error); }
}

export async function accounts(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = workspaceParams.parse(req.params);
    return successResponse(res, 'Calendar accounts loaded', { items: await service.listAccounts(workspaceId) });
  } catch (error) { next(error); }
}

export async function startOAuth(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = workspaceParams.parse(req.params);
    const input = oauthStartSchema.parse(req.body);
    return successResponse(res, 'Calendar authorization URL created', service.startOAuth(input.provider, workspaceId, req.user!.id, input.returnTo));
  } catch (error) { next(error); }
}

export async function connectToken(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = workspaceParams.parse(req.params);
    return createdResponse(res, 'Calendar account connected', await service.connectToken(workspaceId, req.user!.id, tokenConnectSchema.parse(req.body)));
  } catch (error) { next(error); }
}

export async function disconnect(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, accountId } = accountParams.parse(req.params);
    await service.disconnect(workspaceId, accountId);
    return successResponse(res, 'Calendar account disconnected');
  } catch (error) { next(error); }
}

export async function startSync(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, accountId } = accountParams.parse(req.params);
    return createdResponse(res, 'Calendar synchronization queued', await service.startSync(workspaceId, accountId, req.user!.id));
  } catch (error) { next(error); }
}

export async function syncJob(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, accountId, jobId } = syncJobParams.parse(req.params);
    return successResponse(res, 'Calendar synchronization status loaded', await service.getSyncJob(workspaceId, accountId, jobId));
  } catch (error) { next(error); }
}

function frontendUrl(path: string) { return `${(env.FRONTEND_BASE_URL ?? '').replace(/\/$/, '')}${path}`; }

export async function oauthCallback(req: Request, res: Response) {
  const providerValue = String(req.params.provider ?? '');
  const stateValue = typeof req.query.state === 'string' ? req.query.state : undefined;
  const returnTo = getSafeCalendarReturnTo(stateValue);
  const redirectError = (code: string) => res.redirect(302, frontendUrl(`${returnTo}${returnTo.includes('?') ? '&' : '?'}calendarConnection=error&code=${encodeURIComponent(code)}`));
  if (!isCalendarOAuthProvider(providerValue)) return redirectError('CALENDAR_PROVIDER_NOT_SUPPORTED');
  if (req.query.error) return redirectError('CALENDAR_OAUTH_DENIED');
  if (typeof req.query.code !== 'string' || !stateValue) return redirectError('CALENDAR_OAUTH_CALLBACK_INCOMPLETE');
  try {
    const result = await completeCalendarOAuth(providerValue, req.query.code, stateValue);
    return res.redirect(302, frontendUrl(`${result.returnTo}${result.returnTo.includes('?') ? '&' : '?'}calendarConnection=success&accountId=${encodeURIComponent(result.account.id)}`));
  } catch (error) {
    return redirectError(error instanceof AppError ? error.code : 'CALENDAR_OAUTH_CALLBACK_FAILED');
  }
}
