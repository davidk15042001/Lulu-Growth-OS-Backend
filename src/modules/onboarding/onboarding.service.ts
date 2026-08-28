import { randomUUID } from 'node:crypto';
import { deleteObject, getObject, onboardingDocumentKey, putObject } from '../../storage/s3.service.js';
import { AppError, badRequest, notFoundError } from '../../utils/app-error.js';
import { sanitizeUploadedFileName } from '../../utils/file-name.js';
import * as workspaceService from '../workspaces/workspace.service.js';
import * as repo from './onboarding.repo.js';
import type {
  AiPreferencesInput,
  BusinessDescriptionInput,
  CompanyInformationInput,
  CreateCompetitorInput,
  CreateCustomerSegmentInput,
  CreateOfferingInput,
  CreatePlatformInput,
  UpdateCompetitorInput,
  UpdateCustomerSegmentInput,
  UpdateOfferingInput,
  UpdatePlatformInput,
} from './onboarding.validator.js';

export async function getSnapshot(workspaceId: string, userId: string) {
  const [workspace, offerings, customerSegments, competitors, platforms, aiPreferences, completion] = await Promise.all([
    workspaceService.getWorkspace(workspaceId, userId),
    repo.listOfferings(workspaceId),
    repo.listCustomerSegments(workspaceId),
    repo.listCompetitors(workspaceId),
    repo.listPlatforms(workspaceId),
    repo.getAiPreferences(workspaceId),
    repo.getCompletionState(workspaceId),
  ]);

  return { workspace, offerings, customerSegments, competitors, platforms, aiPreferences: aiPreferences ?? null, completion };
}

export async function saveCompanyInformation(
  workspaceId: string,
  userId: string,
  input: CompanyInformationInput
) {
  await repo.saveCompanyInformation(workspaceId, input);
  return workspaceService.getWorkspace(workspaceId, userId);
}

export async function saveBusinessDescription(
  workspaceId: string,
  userId: string,
  input: BusinessDescriptionInput
) {
  const saved = await repo.saveBusinessDescription(workspaceId, input);
  if (!saved) {
    throw new AppError(
      422,
      'ONBOARDING_FILE_REUPLOAD_REQUIRED',
      'Upload at least one onboarding file before continuing',
    );
  }
  return workspaceService.getWorkspace(workspaceId, userId);
}

export function listOfferings(workspaceId: string) {
  return repo.listOfferings(workspaceId);
}

export async function createOffering(workspaceId: string, input: CreateOfferingInput) {
  const offering = await repo.createOffering(workspaceId, input);
  await repo.setOnboardingStep(workspaceId, 'existing_platforms');
  return offering;
}

export async function updateOffering(
  workspaceId: string,
  offeringId: string,
  input: UpdateOfferingInput
) {
  const offering = await repo.updateOffering(workspaceId, offeringId, input);
  if (!offering) throw notFoundError('Offering not found');
  return offering;
}

export async function archiveOffering(workspaceId: string, offeringId: string) {
  if (!(await repo.archiveOffering(workspaceId, offeringId))) {
    throw notFoundError('Offering not found');
  }
}

export function listCustomerSegments(workspaceId: string) {
  return repo.listCustomerSegments(workspaceId);
}

export async function createCustomerSegment(workspaceId: string, input: CreateCustomerSegmentInput) {
  return repo.createCustomerSegment(workspaceId, input);
}

export async function updateCustomerSegment(
  workspaceId: string,
  customerSegmentId: string,
  input: UpdateCustomerSegmentInput
) {
  const segment = await repo.updateCustomerSegment(workspaceId, customerSegmentId, input);
  if (!segment) throw notFoundError('Customer segment not found');
  return segment;
}

export async function archiveCustomerSegment(workspaceId: string, customerSegmentId: string) {
  if (!(await repo.archiveCustomerSegment(workspaceId, customerSegmentId))) {
    throw notFoundError('Customer segment not found');
  }
}

export function listCompetitors(workspaceId: string) {
  return repo.listCompetitors(workspaceId);
}

export async function createCompetitor(workspaceId: string, input: CreateCompetitorInput) {
  return repo.createCompetitor(workspaceId, input);
}

export async function updateCompetitor(
  workspaceId: string,
  competitorId: string,
  input: UpdateCompetitorInput
) {
  const competitor = await repo.updateCompetitor(workspaceId, competitorId, input);
  if (!competitor) throw notFoundError('Competitor not found');
  return competitor;
}

export async function archiveCompetitor(workspaceId: string, competitorId: string) {
  if (!(await repo.archiveCompetitor(workspaceId, competitorId))) {
    throw notFoundError('Competitor not found');
  }
}

export function listPlatforms(workspaceId: string) {
  return repo.listPlatforms(workspaceId);
}

export async function createPlatform(workspaceId: string, input: CreatePlatformInput) {
  const platform = await repo.createPlatform(workspaceId, input);
  await repo.setOnboardingStep(workspaceId, 'billing');
  return platform;
}

export async function updatePlatform(
  workspaceId: string,
  platformId: string,
  input: UpdatePlatformInput
) {
  const platform = await repo.updatePlatform(workspaceId, platformId, input);
  if (!platform) throw notFoundError('Platform not found');
  return platform;
}

export async function archivePlatform(workspaceId: string, platformId: string) {
  if (!(await repo.archivePlatform(workspaceId, platformId))) {
    throw notFoundError('Platform not found');
  }
}

export async function continueFromExistingPlatforms(workspaceId: string, userId: string) {
  await repo.setOnboardingStep(workspaceId, 'billing');
  return workspaceService.getWorkspace(workspaceId, userId);
}

export async function getAiPreferences(workspaceId: string) {
  return (await repo.getAiPreferences(workspaceId)) ?? null;
}

export async function saveAiPreferences(workspaceId: string, input: AiPreferencesInput) {
  const preferences = await repo.saveAiPreferences(workspaceId, input);
  await repo.setOnboardingStep(workspaceId, 'setup_complete');
  return preferences;
}

export async function completeOnboarding(workspaceId: string) {
  const state = await repo.getCompletionState(workspaceId);
  if (!state) throw notFoundError('Workspace not found');

  const missing: string[] = [];
  if (!state.hasCompanyInformation) missing.push('companyInformation');
  if (!state.hasBusinessDescription) missing.push('businessDescription');
  if (!state.hasBillingConfirmation) missing.push('billing');

  if (missing.length > 0) {
    throw badRequest('Onboarding is incomplete', { missing });
  }

  await repo.completeOnboarding(workspaceId);
  return { completed: true, completedAt: new Date().toISOString() };
}


export async function listOnboardingDocuments(workspaceId: string) {
  const documents = await repo.listOnboardingDocuments(workspaceId);
  return documents.map((document) => ({
    ...document,
    fileName: sanitizeUploadedFileName(document.fileName),
  }));
}

export async function createOnboardingDocument(input: {
  workspaceId: string;
  uploadedBy: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  content: Buffer;
}) {
  const id = randomUUID();
  const storageKey = onboardingDocumentKey(input.workspaceId, id);
  await putObject({ key: storageKey, content: input.content, mimeType: input.mimeType, fileName: input.fileName });
  try {
    return await repo.createOnboardingDocument({
      id,
      workspaceId: input.workspaceId,
      uploadedBy: input.uploadedBy,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      storageKey,
      content: input.content,
    });
  } catch (error) {
    await deleteObject(storageKey).catch(() => undefined);
    throw error;
  }
}

export async function getOnboardingDocumentContent(workspaceId: string, documentId: string) {
  const document = await repo.getOnboardingDocumentContent(workspaceId, documentId);
  if (!document) throw notFoundError('Onboarding document not found');
  let content = document.content;
  if (document.storageKey) {
    try {
      content = await getObject(document.storageKey);
    } catch {
      if (!content) throw new AppError(503, 'ONBOARDING_DOCUMENT_STORAGE_UNAVAILABLE', 'The saved document is temporarily unavailable. Please try again shortly', { documentId });
    }
  }
  if (!content) throw new AppError(404, 'ONBOARDING_DOCUMENT_CONTENT_MISSING', 'The saved document content is unavailable', { documentId });
  return { ...document, fileName: sanitizeUploadedFileName(document.fileName), content };
}

export async function deleteOnboardingDocument(workspaceId: string, documentId: string) {
  const document = await repo.getOnboardingDocumentContent(workspaceId, documentId);
  if (!document) throw notFoundError('Onboarding document not found');
  if (document.storageKey) await deleteObject(document.storageKey);
  await repo.deleteOnboardingDocument(workspaceId, documentId);
}
