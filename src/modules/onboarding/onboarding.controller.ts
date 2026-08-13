import type { NextFunction, Response } from 'express';
import type { WorkspaceRequest } from '../../middlewares/workspace.middleware.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as service from './onboarding.service.js';
import {
  aiPreferencesSchema,
  businessDescriptionSchema,
  companyInformationSchema,
  createOfferingSchema,
  createPlatformSchema,
  onboardingRecordParamsSchema,
  updateOfferingSchema,
  updatePlatformSchema,
} from './onboarding.validator.js';

function workspaceId(req: WorkspaceRequest) {
  return onboardingRecordParamsSchema.parse(req.params).workspaceId;
}

export async function snapshot(req: WorkspaceRequest, res: Response, next: NextFunction) {
  try {
    const result = await service.getSnapshot(workspaceId(req), req.user!.id);
    return successResponse(res, 'Onboarding loaded', result);
  } catch (error) {
    next(error);
  }
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
