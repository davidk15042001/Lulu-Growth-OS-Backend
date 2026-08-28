import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { deleteObject, getObject, onboardingDocumentKey, putObject } from '../../storage/s3.service.js';
import { AppError, badRequest, notFoundError } from '../../utils/app-error.js';
import { getOpenAIResponsesClient, isAiGenerationConfigured } from '../ai/openai.service.js';
import { sanitizeUploadedFileName } from '../../utils/file-name.js';
import * as workspaceService from '../workspaces/workspace.service.js';
import { findWorkspaceById } from '../workspaces/workspace.repo.js';
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

type GeneratedCompetitorDraft = repo.GeneratedCompetitorInput;

function extractCompetitorJson(text: string) {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try {
    const value = JSON.parse(cleaned) as { competitors?: unknown };
    if (!Array.isArray(value.competitors)) {
      throw new Error('Missing competitors array');
    }
    return value.competitors;
  } catch {
    throw new AppError(502, 'AI_EMPTY_RESPONSE', 'The AI provider did not return a valid competitor list');
  }
}

function normaliseStringArray(value: unknown, limit: number) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)
    .slice(0, limit);
}

function normaliseEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T) {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (allowed as readonly string[]).includes(candidate) ? candidate as T : fallback;
}

function normaliseOptionalText(value: unknown, maximum = 2000) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maximum) : null;
}

function normaliseWebsiteUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).toString();
  } catch {
    return null;
  }
}

function normaliseGeneratedCompetitors(raw: unknown) {
  if (!Array.isArray(raw)) {
    throw new AppError(502, 'AI_EMPTY_RESPONSE', 'The AI provider did not return a valid competitor list');
  }

  const competitors: GeneratedCompetitorDraft[] = [];
  for (const entry of raw) {
    if (competitors.length >= 10) break;
    const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const name = normaliseOptionalText(item.name, 200);
    if (!name) continue;

    competitors.push({
      name,
      websiteUrl: normaliseWebsiteUrl(item.websiteUrl),
      competitorType: normaliseEnum(item.competitorType, ['direct', 'indirect', 'substitute', 'emerging'] as const, 'direct'),
      market: normaliseOptionalText(item.market, 200),
      positioning: normaliseOptionalText(item.positioning, 2000),
      pricingSummary: normaliseOptionalText(item.pricingSummary, 2000),
      strengths: normaliseStringArray(item.strengths, 8),
      weaknesses: normaliseStringArray(item.weaknesses, 8),
      differentiators: normaliseStringArray(item.differentiators, 8),
      featureOverlap: normaliseStringArray(item.featureOverlap, 8),
      threatLevel: normaliseOptionalText(item.threatLevel, 120),
      strategicPriority: normaliseOptionalText(item.strategicPriority, 120),
      sourceQuality: normaliseOptionalText(item.sourceQuality, 120) ?? 'ai_inferred',
      monitoringFrequency: normaliseOptionalText(item.monitoringFrequency, 120) ?? 'weekly',
      notes: normaliseOptionalText(item.notes, 4000),
      lastReviewedAt: new Date().toISOString(),
      rank: competitors.length + 1,
      visibility: normaliseOptionalText(item.visibility, 120),
      growth: normaliseOptionalText(item.growth, 120),
      intelligence: normaliseOptionalText(item.intelligence, 120),
      competitivePosition: normaliseOptionalText(item.competitivePosition, 120),
    });
  }

  return competitors;
}

function buildCompetitorDiscoveryInstructions() {
  return [
    'You are Lulu AI competitive intelligence.',
    'Return exactly 10 real competitors for the target company.',
    'Focus on the biggest and most relevant competitors in the target market and ICP.',
    'Never include the company itself, fake brands, placeholders, or invented domains.',
    'Prefer established, recognizable competitors with meaningful market presence.',
    'Use only valid JSON without markdown fences.',
    'Output shape: {"competitors":[{"name":string,"websiteUrl":string|null,"competitorType":"direct"|"indirect"|"substitute"|"emerging","market":string|null,"positioning":string|null,"pricingSummary":string|null,"strengths":string[],"weaknesses":string[],"differentiators":string[],"featureOverlap":string[],"threatLevel":string|null,"strategicPriority":string|null,"sourceQuality":string|null,"monitoringFrequency":string|null,"notes":string|null,"visibility":string|null,"growth":string|null,"intelligence":string|null,"competitivePosition":string|null}]}',
  ].join(' ');
}

export async function discoverCompetitors(workspaceId: string, userId: string) {
  if (!isAiGenerationConfigured()) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'The AI provider is not configured for competitor discovery');
  }

  const workspace = await findWorkspaceById(workspaceId);
  if (!workspace) throw notFoundError('Workspace not found');

  const [offerings, customerSegments] = await Promise.all([
    repo.listOfferings(workspaceId),
    repo.listCustomerSegments(workspaceId),
  ]);

  const hasContext = [
    workspace.companyName,
    workspace.industry,
    workspace.businessDescription,
    workspace.valueProposition,
    workspace.targetMarket,
    workspace.primaryIcp,
    offerings[0]?.name,
  ].some((value) => typeof value === 'string' && value.trim().length > 0);

  if (!hasContext) {
    throw new AppError(
      422,
      'SEARCH_INTELLIGENCE_CONTEXT_MISSING',
      'The workspace profile does not contain enough business context for competitor discovery',
    );
  }

  const response = await getOpenAIResponsesClient().create({
    model: env.AI_PROVIDER === 'alibaba'
      ? env.DASHSCOPE_MODEL
      : env.AI_PROVIDER === 'deepseek'
        ? env.DEEPSEEK_MODEL
        : env.OPENAI_MODEL,
    instructions: buildCompetitorDiscoveryInstructions(),
    input: [{
      role: 'user',
      content: [
        `Workspace: ${workspaceId}`,
        'Company profile:',
        JSON.stringify({
          companyName: workspace.companyName,
          industry: workspace.industry,
          companySize: workspace.companySize,
          countryRegion: workspace.countryRegion,
          businessDescription: workspace.businessDescription,
          valueProposition: workspace.valueProposition,
          targetMarket: workspace.targetMarket,
          shortBrandDescription: workspace.shortBrandDescription,
          primaryIcp: workspace.primaryIcp,
          usp: workspace.usp,
          positioningTags: workspace.positioningTags ?? [],
          mission: workspace.mission,
          vision: workspace.vision,
          languages: workspace.languages ?? [],
        }),
        'Offerings:',
        JSON.stringify(offerings.slice(0, 20)),
        'Customer segments:',
        JSON.stringify(customerSegments.slice(0, 20)),
      ].join('\n\n'),
    }],
    reasoning: { effort: 'medium' },
    max_output_tokens: 6000,
    store: false,
  }, { billing: { workspaceId, userId } });

  const competitors = normaliseGeneratedCompetitors(extractCompetitorJson(response.output_text));
  if (competitors.length === 0) {
    throw new AppError(502, 'AI_EMPTY_RESPONSE', 'The AI provider did not return any usable competitors');
  }

  return repo.replaceGeneratedCompetitors(workspaceId, userId, competitors);
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
