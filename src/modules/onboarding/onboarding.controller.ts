import type { NextFunction, Request, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { sanitizeUploadedFileName } from '../../utils/file-name.js';
import { AppError } from '../../utils/app-error.js';
import * as oauthService from './oauth.service.js';
import { generateTokenTestNumber } from '../ai/openai.service.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './onboarding.service.js';
import {
  aiPreferencesSchema,
  businessDescriptionSchema,
  companyInformationSchema,
  createOfferingSchema,
  createPlatformSchema,
  onboardingDocumentParamsSchema,
  onboardingRecordParamsSchema,
  updateOfferingSchema,
  updatePlatformSchema,
} from './onboarding.validator.js';

function workspaceId(req: WorkspaceRequest) {
  return onboardingRecordParamsSchema.parse(req.params).workspaceId;
}

export async function tokenTest(_req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const result = await generateTokenTestNumber();
    return successResponse(res, 'AI token test completed', result);
  } catch (error) {
    next(error);
  }
}

export async function snapshot(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getSnapshot(workspaceId(req), req.user!.id);
    return successResponse(res, 'Onboarding loaded', result);
  } catch (error) {
    next(error);
  }
}

const MAX_DOCUMENT_SIZE = 5000 * 1024;
const allowedMimeTypes = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  'application/pdf', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

function documentError(req: WorkspaceRequest, res: Response, status: number, code: string, message: string, details?: unknown) {
  const diagnostics = {
    requestId: String(req.id || 'request-id-unavailable'),
    endpoint: `${req.method} ${req.originalUrl}`,
    timestamp: new Date().toISOString(),
  };
  res.setHeader('X-Request-ID', diagnostics.requestId);
  return res.status(status).json({
    success: false,
    error: { code, message, ...(details === undefined ? {} : { details }), diagnostics },
  });
}

export async function companyInformation(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const input = companyInformationSchema.parse(req.body);
    const result = await service.saveCompanyInformation(workspaceId(req), req.user!.id, input);
    return successResponse(res, 'Company information saved', result);
  } catch (error) {
    next(error);
  }
}

export async function businessDescription(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const input = businessDescriptionSchema.parse(req.body);
    const result = await service.saveBusinessDescription(workspaceId(req), req.user!.id, input);
    return successResponse(res, 'Business description saved', result);
  } catch (error) {
    next(error);
  }
}

export async function listOfferings(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const items = await service.listOfferings(workspaceId(req));
    return successResponse(res, 'Offerings loaded', { items });
  } catch (error) {
    next(error);
  }
}

export async function createOffering(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const input = createOfferingSchema.parse(req.body);
    const offering = await service.createOffering(workspaceId(req), input);
    return createdResponse(res, 'Offering created', offering);
  } catch (error) {
    next(error);
  }
}

export async function updateOffering(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = onboardingRecordParamsSchema.parse(req.params);
    const input = updateOfferingSchema.parse(req.body);
    const offering = await service.updateOffering(params.workspaceId, params.offeringId!, input);
    return successResponse(res, 'Offering updated', offering);
  } catch (error) {
    next(error);
  }
}

export async function deleteOffering(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = onboardingRecordParamsSchema.parse(req.params);
    await service.archiveOffering(params.workspaceId, params.offeringId!);
    return successResponse(res, 'Offering archived');
  } catch (error) {
    next(error);
  }
}

export async function listPlatforms(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const items = await service.listPlatforms(workspaceId(req));
    return successResponse(res, 'Platforms loaded', { items });
  } catch (error) {
    next(error);
  }
}

export async function createPlatform(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const input = createPlatformSchema.parse(req.body);
    const platform = await service.createPlatform(workspaceId(req), input);
    return createdResponse(res, 'Platform created', platform);
  } catch (error) {
    next(error);
  }
}

export async function updatePlatform(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = onboardingRecordParamsSchema.parse(req.params);
    const input = updatePlatformSchema.parse(req.body);
    const platform = await service.updatePlatform(params.workspaceId, params.platformId!, input);
    return successResponse(res, 'Platform updated', platform);
  } catch (error) {
    next(error);
  }
}

export async function deletePlatform(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = onboardingRecordParamsSchema.parse(req.params);
    await service.archivePlatform(params.workspaceId, params.platformId!);
    return successResponse(res, 'Platform archived');
  } catch (error) {
    next(error);
  }
}

export async function getAiPreferences(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const preferences = await service.getAiPreferences(workspaceId(req));
    return successResponse(res, 'AI preferences loaded', preferences);
  } catch (error) {
    next(error);
  }
}

export async function saveAiPreferences(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const input = aiPreferencesSchema.parse(req.body);
    const preferences = await service.saveAiPreferences(workspaceId(req), input);
    return successResponse(res, 'AI preferences saved', preferences);
  } catch (error) {
    next(error);
  }
}

export async function complete(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.completeOnboarding(workspaceId(req));
    return successResponse(res, 'Onboarding completed', result);
  } catch (error) {
    next(error);
  }
}

export async function listDocuments(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = onboardingDocumentParamsSchema.parse(req.params);
    const documents = await service.listOnboardingDocuments(params.workspaceId);
    return successResponse(res, 'Onboarding documents loaded', { items: documents });
  } catch (error) {
    next(error);
  }
}

export async function uploadDocument(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = onboardingDocumentParamsSchema.parse(req.params);
    const file = req.file;
    if (!file) return documentError(req, res, 400, 'FILE_REQUIRED', 'A file is required');
    if (file.size <= 0 || file.size > MAX_DOCUMENT_SIZE) {
      return documentError(req, res, 413, 'FILE_TOO_LARGE', 'The file must be between 1 byte and 5,000 KB', { maxBytes: MAX_DOCUMENT_SIZE });
    }
    if (!allowedMimeTypes.has(file.mimetype)) {
      return documentError(req, res, 415, 'UNSUPPORTED_FILE_TYPE', 'This file type is not supported', { mimeType: file.mimetype });
    }
    const fileName = sanitizeUploadedFileName(file.originalname);
    if (!fileName) {
      return documentError(req, res, 400, 'FILE_NAME_REQUIRED', 'The file name is required');
    }
    const document = await service.createOnboardingDocument({
      workspaceId: params.workspaceId,
      uploadedBy: req.user!.id,
      fileName,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      content: file.buffer,
    });
    return createdResponse(res, 'Onboarding document uploaded', document);
  } catch (error) {
    next(error);
  }
}

export async function documentContent(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = onboardingDocumentParamsSchema.parse(req.params);
    const document = await service.getOnboardingDocumentContent(params.workspaceId, params.documentId!);
    res.setHeader('Content-Type', document.mimeType);
    res.setHeader('Content-Length', String(document.sizeBytes));
    res.setHeader('Content-Disposition', `inline; filename="${document.fileName.replace(/["]+/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(document.content);
  } catch (error) {
    next(error);
  }
}

export async function deleteDocument(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const params = onboardingDocumentParamsSchema.parse(req.params);
    await service.deleteOnboardingDocument(params.workspaceId, params.documentId!);
    return successResponse(res, 'Onboarding document deleted');
  } catch (error) {
    next(error);
  }
}


export async function startOAuth(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const provider = String(req.params.provider);
    if (!oauthService.isSupportedProvider(provider)) {
      res.status(404).json({ success: false, error: { code: 'OAUTH_PROVIDER_NOT_SUPPORTED', message: 'This provider is not supported yet' } });
      return;
    }
    const shop = typeof req.query.shop === 'string' ? req.query.shop.trim().toLowerCase() : undefined;
    const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : undefined;
    const url = oauthService.buildAuthorizationUrl(provider, workspaceId(req), req.user!.id, shop, returnTo);
    return successResponse(res, 'OAuth authorization URL created', { provider, authorizationUrl: url });
  } catch (error) {
    next(error);
  }
}

function appendQuery(path: string, params: Record<string, string>) {
  const url = new URL(path, 'http://lulu.local');
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return `${url.pathname}${url.search}${url.hash}`;
}

export async function oauthCallback(req: Request, res: Response) {
  try {
    const provider = String(req.params.provider);
    if (!oauthService.isSupportedProvider(provider)) {
      res.status(404).send('Unsupported OAuth provider');
      return;
    }
    const frontend = envFrontendBaseUrl();
    const requestId = String(req.id || 'request-id-unavailable');
    const providerReturnTo = provider === 'wordpress' ? '/app/website?section=wordpress-jetpack-9013' : provider === 'webflow' ? '/app/website?section=webflow-9014' : '/onboarding/existing-platforms';
    const returnTo = oauthService.getSafeReturnTo(typeof req.query.state === 'string' ? req.query.state : undefined) ?? providerReturnTo;
    const errorRedirect = (code: string, message: string) => res.redirect(`${frontend}${appendQuery(returnTo, { oauthCode: code, oauthError: message.slice(0, 240), oauthRequestId: requestId })}`);
    if (typeof req.query.error === 'string') return errorRedirect('OAUTH_PROVIDER_DENIED', `Provider denied access (${provider}; provider_error=${req.query.error})`);
    if (typeof req.query.code !== 'string' || typeof req.query.state !== 'string') return errorRedirect('OAUTH_CALLBACK_INCOMPLETE', `OAuth callback did not include both code and state for ${provider}`);
    await oauthService.completeOAuthCallback(provider, req.query.code, req.query.state);
    return res.redirect(`${frontend}${appendQuery(returnTo, { connected: provider })}`);
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'OAUTH_CALLBACK_FAILED';
    const message = error instanceof AppError ? error.message : 'OAuth callback failed before the account could be connected';
    const requestId = String(req.id || 'request-id-unavailable');
    const frontend = envFrontendBaseUrl();
    const provider = String(req.params.provider);
    const providerReturnTo = provider === 'wordpress' ? '/app/website?section=wordpress-jetpack-9013' : provider === 'webflow' ? '/app/website?section=webflow-9014' : '/onboarding/existing-platforms';
    const returnTo = oauthService.getSafeReturnTo(typeof req.query.state === 'string' ? req.query.state : undefined) ?? providerReturnTo;
    return res.redirect(`${frontend}${appendQuery(returnTo, { oauthCode: code, oauthError: message.slice(0, 240), oauthRequestId: requestId })}`);
  }
}

function envFrontendBaseUrl() {
  // Empty string keeps the callback redirect same-origin when FRONTEND_BASE_URL is not set.
  // A fallback of '/' would create '//onboarding/...' and be interpreted as a host URL by browsers.
  return process.env.FRONTEND_BASE_URL?.replace(/\/$/, '') || '';
}
