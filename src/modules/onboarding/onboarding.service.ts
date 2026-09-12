import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { deleteObject, getObject, onboardingDocumentKey, putObject } from '../../storage/s3.service.js';
import { AppError, badRequest, notFoundError } from '../../utils/app-error.js';
import { configuredModel, getOpenAIResponsesClient, isAiGenerationConfigured } from '../ai/openai.service.js';
import { sanitizeUploadedFileName } from '../../utils/file-name.js';
import * as workspaceService from '../workspaces/workspace.service.js';
import * as authRepo from '../auth/auth.repo.js';
import { extractTextFromFile } from '../records/record.service.js';
import { startPremiumMediaFromProductBrief } from '../premium-media/premium-media.service.js';
import { findWorkspaceById } from '../workspaces/workspace.repo.js';
import * as repo from './onboarding.repo.js';
import * as oauthService from './oauth.service.js';
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
  KnowledgeActivationInput,
} from './onboarding.validator.js';

export async function getSnapshot(workspaceId: string, userId: string) {
  const [workspace, offerings, customerSegments, competitors, platforms, aiPreferences, completion, aiBusinessProfile] = await Promise.all([
    workspaceService.getWorkspace(workspaceId, userId),
    repo.listOfferings(workspaceId),
    repo.listCustomerSegments(workspaceId),
    repo.listCompetitors(workspaceId),
    repo.listPlatforms(workspaceId),
    repo.getAiPreferences(workspaceId),
    repo.getCompletionState(workspaceId),
    repo.getAiBusinessProfile(workspaceId),
  ]);

  return { workspace, offerings, customerSegments, competitors, platforms, aiPreferences: aiPreferences ?? null, completion, aiBusinessProfile };
}

export async function saveCompanyInformation(
  workspaceId: string,
  userId: string,
  input: CompanyInformationInput
) {
  const workspace=await findWorkspaceById(workspaceId);
  const initial=workspace?.onboardingStep==='company_information'&&!workspace.onboardingCompletedAt;
  if(initial&&(!input.fullName||!input.password||!input.repeatPassword||!input.industry?.trim())) {
    throw new AppError(422,'COMPANY_INFORMATION_INCOMPLETE','Full name, password, company name and industry are required.');
  }
  if(input.password){
    if(!input.fullName)throw new AppError(422,'FULL_NAME_REQUIRED','A full name is required when confirming the account password.');
    const user = await authRepo.getUserById(userId);
    if (!user || !await bcrypt.compare(input.password, user.password_hash)) throw new AppError(422, 'CURRENT_PASSWORD_INVALID', 'The password is incorrect.');
    const nameParts = input.fullName!.trim().split(/\s+/);
    const firstName = nameParts.shift() ?? '';
    const lastName = nameParts.join(' ');
    await authRepo.updateUserProfile(userId, { firstName, lastName });
  }
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
  return repo.createOffering(workspaceId, input);
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

function competitorJsonCandidates(text: string) {
  const normalized = text
    .trim()
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const candidates = [normalized];
  const firstBrace = normalized.indexOf('{');
  const lastBrace = normalized.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(normalized.slice(firstBrace, lastBrace + 1));

  const firstBracket = normalized.indexOf('[');
  const lastBracket = normalized.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) candidates.push(normalized.slice(firstBracket, lastBracket + 1));

  return [...new Set(candidates.filter(Boolean))];
}

function extractCompetitorJson(text: string) {
  for (const candidate of competitorJsonCandidates(text)) {
    try {
      const value = JSON.parse(candidate) as { competitors?: unknown } | unknown[];
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object' && Array.isArray((value as { competitors?: unknown }).competitors)) {
        return (value as { competitors?: unknown }).competitors;
      }
    } catch {
      // Try the next normalized candidate.
    }
  }

  throw new AppError(502, 'AI_EMPTY_RESPONSE', 'The AI provider did not return a valid competitor list');
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
    model: configuredModel(),
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
  if (input.integrationKey && oauthService.isSupportedProvider(input.integrationKey) && oauthService.isLuluManagedOAuthProvider(input.integrationKey)) {
    await oauthService.assertWorkspaceOAuthProviderAllowed(input.integrationKey, workspaceId);
  }
  const platform = await repo.createPlatform(workspaceId, input);
  await repo.setOnboardingStep(workspaceId, 'billing');
  return platform;
}

export async function updatePlatform(
  workspaceId: string,
  platformId: string,
  input: UpdatePlatformInput
) {
  const current = (await repo.listPlatforms(workspaceId)).find((item) => item.id === platformId);
  if (current?.integrationKey && oauthService.isSupportedProvider(current.integrationKey) && oauthService.isLuluManagedOAuthProvider(current.integrationKey)) {
    await oauthService.assertWorkspaceOAuthProviderAllowed(current.integrationKey, workspaceId);
  }
  if (input.integrationKey && oauthService.isSupportedProvider(input.integrationKey) && oauthService.isLuluManagedOAuthProvider(input.integrationKey)) {
    await oauthService.assertWorkspaceOAuthProviderAllowed(input.integrationKey, workspaceId);
  }
  const platform = await repo.updatePlatform(workspaceId, platformId, input);
  if (!platform) throw notFoundError('Platform not found');
  return platform;
}

export async function archivePlatform(workspaceId: string, platformId: string) {
  const current = (await repo.listPlatforms(workspaceId)).find((item) => item.id === platformId);
  if (current?.integrationKey && oauthService.isSupportedProvider(current.integrationKey) && oauthService.isLuluManagedOAuthProvider(current.integrationKey)) {
    await oauthService.assertWorkspaceOAuthProviderAllowed(current.integrationKey, workspaceId);
  }
  if (!(await repo.archivePlatform(workspaceId, platformId))) {
    throw notFoundError('Platform not found');
  }
}

export async function continueFromExistingPlatforms(workspaceId: string, userId: string) {
  const workspace = await workspaceService.getWorkspace(workspaceId, userId);
  if (workspace.onboardingCompletedAt || workspace.onboardingStep === 'billing') return workspace;
  if (workspace.onboardingStep === 'company_information') {
    throw badRequest('Complete company information before billing', { missing: ['companyInformation'] });
  }

  await repo.setOnboardingStep(workspaceId, 'billing');
  return workspaceService.getWorkspace(workspaceId, userId);
}

export async function continueFromProductsServices(workspaceId: string, userId: string) {
  const workspace = await workspaceService.getWorkspace(workspaceId, userId);
  if (workspace.onboardingCompletedAt || workspace.onboardingStep === 'billing') return workspace;
  if (workspace.onboardingStep === 'company_information') {
    throw badRequest('Complete company information before billing', { missing: ['companyInformation'] });
  }

  const state = await repo.getCompletionState(workspaceId);
  if (!state) throw notFoundError('Workspace not found');

  const missing: string[] = [];
  if (!state.hasCompanyInformation) missing.push('companyInformation');
  if (missing.length > 0) {
    throw badRequest('Complete company information before billing', { missing });
  }

  await repo.setOnboardingStep(workspaceId, 'billing');
  return workspaceService.getWorkspace(workspaceId, userId);
}

export async function getAiPreferences(workspaceId: string) {
  return (await repo.getAiPreferences(workspaceId)) ?? null;
}

export async function saveAiPreferences(workspaceId: string, input: AiPreferencesInput) {
  return repo.saveAiPreferences(workspaceId, {
    ...input,
    actionLevel: 'automated',
    taskCreationMode: 'auto',
    approvalPreferences: {
      marketing: 'auto', advertising: 'auto', content: 'auto', website: 'auto',
      product: 'auto', customer_comms: 'auto', automation: 'auto', financial: 'auto',
      ...Object.fromEntries(Object.keys(input.approvalPreferences).map((key) => [key, 'auto' as const])),
    },
    approvalThreshold: null,
  });
}

export async function completeOnboarding(workspaceId: string) {
  const state = await repo.getCompletionState(workspaceId);
  if (!state) throw notFoundError('Workspace not found');

  const missing: string[] = [];
  if (!state.hasCompanyInformation) missing.push('companyInformation');
  if (!state.hasBillingConfirmation) missing.push('billing');
  if (!state.hasProfile) missing.push('profile');
  if (!state.hasKnowledgeBase) missing.push('knowledgeBase');
  if (missing.length > 0) {
    throw badRequest('Onboarding is incomplete', { missing });
  }

  await repo.completeOnboarding(workspaceId);
  return {
    completed: true,
    completedAt: new Date().toISOString(),
  };
}

function activationJson(text:string){
  const clean=text.trim().replace(/<think>[\s\S]*?<\/think>/gi,'').replace(/^```json\s*/i,'').replace(/\s*```$/,'');
  const start=clean.indexOf('{');const end=clean.lastIndexOf('}');
  try{return JSON.parse(start>=0&&end>start?clean.slice(start,end+1):clean) as Record<string,unknown>;}catch{throw new AppError(502,'KNOWLEDGE_AI_RESPONSE_INVALID','AI could not return a valid company knowledge structure.');}
}
function activationText(value:unknown,max:number){return typeof value==='string'&&value.trim()?value.trim().slice(0,max):null;}

export async function activateKnowledgeBase(workspaceId:string,userId:string,input:KnowledgeActivationInput){
  const workspace=await findWorkspaceById(workspaceId);
  if(!workspace)throw notFoundError('Workspace not found');
  if(workspace.onboardingCompletedAt)return {completed:true,alreadyCompleted:true,productIds:[]};
  if(workspace.onboardingStep!=='knowledge_base'||!workspace.profileCompletedAt)throw new AppError(409,'PROFILE_COMPLETION_REQUIRED','Complete the company profile before building the Knowledge Base.');
  if(!isAiGenerationConfigured())throw new AppError(503,'AI_NOT_CONFIGURED','AI knowledge processing is not configured on the server.');
  const documents:string[]=[];
  for(const id of input.documentIds){
    const document=await getOnboardingDocumentContent(workspaceId,id);
    const text=await extractTextFromFile({name:document.fileName,type:document.mimeType,buffer:document.content},workspaceId,userId,{platformFunded:true});
    documents.push(`Document: ${document.fileName}\n${text}`);
    if(documents.join('\n\n').length>=100_000)break;
  }
  const source=[input.text,...documents].filter(Boolean).join('\n\n').slice(0,100_000);
  if(!source.trim())throw new AppError(422,'KNOWLEDGE_CONTENT_EMPTY','No readable company information was found.');
  const model=configuredModel();
  const activationId=await repo.createKnowledgeActivation({workspaceId,userId,text:input.text,documentIds:input.documentIds,model});
  try{
    // This single activation analysis is platform-funded. Normal agent and
    // premium-media execution remains strictly protected by the AI wallet.
    const response=await getOpenAIResponsesClient().create({model,instructions:[
      'You are Lulu company knowledge activation intelligence.',
      'Classify only facts supported by the supplied information. Never invent products, prices, claims or credentials.',
      'Separate physical/digital products, services and general company knowledge.',
      'Return JSON only: {"summary":string,"businessDescription":string,"contentTypes":string[],"items":[{"name":string,"kind":"product"|"service"|"other","productType":"PHYSICAL_PRODUCT"|"DIGITAL_PRODUCT"|"OTHER"|null,"description":string|null,"category":string|null,"price":number|null,"currency":string|null}],"generalKnowledge":[{"title":string,"content":string}]}.'
    ].join(' '),input:[{role:'user',content:`Company: ${workspace.companyName}\nIndustry: ${workspace.industry??''}\n\n${source}`}],max_output_tokens:8000,store:false});
    const classification=activationJson(response.output_text??'');
    const rawItems=Array.isArray(classification.items)?classification.items:[];
    const seen=new Set<string>();
    const items=rawItems.slice(0,100).map(entry=>{
      const value=entry&&typeof entry==='object'?entry as Record<string,unknown>:{};
      const name=activationText(value.name,300);if(!name)return null;
      const kind=['product','service','other'].includes(String(value.kind))?String(value.kind) as 'product'|'service'|'other':'other';
      const productType=['PHYSICAL_PRODUCT','DIGITAL_PRODUCT','OTHER'].includes(String(value.productType))?String(value.productType) as 'PHYSICAL_PRODUCT'|'DIGITAL_PRODUCT'|'OTHER':null;
      const key=`${kind}:${name.toLowerCase()}`;if(seen.has(key))return null;seen.add(key);
      const price=typeof value.price==='number'&&Number.isFinite(value.price)&&value.price>=0?value.price:null;
      const currency=activationText(value.currency,3)?.toUpperCase()??null;
      return{name,kind,productType,description:activationText(value.description,20_000),category:activationText(value.category,200),price,currency};
    }).filter((item):item is NonNullable<typeof item>=>Boolean(item));
    const summary=activationText(classification.summary,5000)??`Knowledge for ${workspace.companyName}`;
    const generalKnowledge=(Array.isArray(classification.generalKnowledge)?classification.generalKnowledge:[]).slice(0,100).map(entry=>{
      const value=entry&&typeof entry==='object'?entry as Record<string,unknown>:{};
      const title=activationText(value.title,300);const content=activationText(value.content,20_000);
      return title&&content?{title,content}:null;
    }).filter((entry):entry is NonNullable<typeof entry>=>Boolean(entry));
    const contentTypes=(Array.isArray(classification.contentTypes)?classification.contentTypes:[]).map(value=>activationText(value,100)).filter((value):value is string=>Boolean(value)).slice(0,30);
    const normalizedClassification={summary,businessDescription:activationText(classification.businessDescription,10_000),contentTypes,items,generalKnowledge};
    const result=await repo.applyKnowledgeClassification({activationId,workspaceId,userId,classification:normalizedClassification,summary,businessDescription:normalizedClassification.businessDescription,items});
    const premiumJobs:Array<{productId:string;status:string}>=[];
    for(const productId of result.missingImageProductIds){
      try{const production=await startPremiumMediaFromProductBrief(workspaceId,productId,userId,false,false);premiumJobs.push({productId,status:production.job.status});}
      catch(error){premiumJobs.push({productId,status:error instanceof AppError&&['AI_FUNDS_REQUIRED','AI_FUNDS_EXHAUSTED'].includes(error.code)?'WAITING_FOR_AI_FUNDS':'WAITING_FOR_PREMIUM_RUNTIME'});}
    }
    return {...result,classification:normalizedClassification,premiumJobs};
  }catch(error){await repo.failKnowledgeActivation(activationId,error);throw error;}
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
