import { env } from '../../config/env.js';
import { AppError, notFoundError } from '../../utils/app-error.js';
import { getOpenAIResponsesClient, isAiGenerationConfigured } from '../ai/openai.service.js';
import { findWorkspaceById } from '../workspaces/workspace.repo.js';
import { getKnowledgeBundle } from '../agents/agent.repo.js';
import * as repo from './onboarding.repo.js';

type GeneratedCompetitorDraft = repo.GeneratedCompetitorInput;
type CompetitorContext = Pick<
  repo.Competitor,
  'name' | 'websiteUrl' | 'competitorType' | 'market' | 'positioning' | 'strengths' | 'weaknesses' | 'differentiators'
> | GeneratedCompetitorDraft;

type CustomerSegmentContext = Pick<
  repo.CustomerSegment,
  'name' | 'industry' | 'companySize' | 'region' | 'maturityLevel' | 'painPoints' | 'jobsToBeDone' | 'decisionCriteria' | 'useCases' | 'buyingRoles' | 'priceSensitivity' | 'primarySegment' | 'notes'
>;

function resolveAiModel() {
  return env.AI_PROVIDER === 'alibaba'
    ? env.DASHSCOPE_MODEL
    : env.AI_PROVIDER === 'deepseek'
      ? env.DEEPSEEK_MODEL
      : env.OPENAI_MODEL;
}

function extractJson<T>(text: string) {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new AppError(502, 'AI_EMPTY_RESPONSE', 'The AI provider did not return valid JSON');
  }
}

function normaliseOptionalText(value: unknown, maximum = 2000) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maximum) : null;
}

function normaliseStringList(value: unknown, maximumItems = 10, maximumLength = 240) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => typeof entry === 'string' ? entry.trim() : '')
    .filter(Boolean)
    .slice(0, maximumItems)
    .map((entry) => entry.slice(0, maximumLength));
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

function normaliseEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T) {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (allowed as readonly string[]).includes(candidate) ? candidate as T : fallback;
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
      strengths: normaliseStringList(item.strengths, 8, 160),
      weaknesses: normaliseStringList(item.weaknesses, 8, 160),
      differentiators: normaliseStringList(item.differentiators, 8, 160),
      featureOverlap: normaliseStringList(item.featureOverlap, 8, 160),
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

async function generateCompetitorDrafts(workspaceId: string, userId: string) {
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
      'The workspace profile does not contain enough business context for AI profile generation',
    );
  }

  const model = resolveAiModel();
  const response = await getOpenAIResponsesClient().create({
    model,
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

  const parsed = extractJson<{ competitors?: unknown }>(response.output_text);
  return normaliseGeneratedCompetitors(parsed.competitors);
}

function buildAiBusinessProfileInstructions() {
  return [
    'You are Lulu AI, an elite business strategist and positioning expert.',
    'Generate an AI business profile draft for the workspace.',
    'Use the provided workspace context, offerings, segments, connected platforms, existing intelligence, and exactly the provided competitor set.',
    'Return 5 to 10 high-quality options for each of these categories: value propositions, target markets, primary ICPs, USPs, short brand descriptions, primary challenges, and languages.',
    'Also return exactly 20 customer segments ranked from strongest to weakest opportunity for this business.',
    'Every option must be materially distinct, strategically useful, specific, and stronger than a generic marketing phrase.',
    'The suggestions must explicitly use competitor gaps, weaknesses, blind spots, or whitespace opportunities from the competitor set.',
    'Do not invent company facts, certifications, metrics, customers, or product capabilities that are not supported by the context.',
    'Treat the output as strategic recommendations, not verified facts.',
    'Also return a recommended best profile consisting of the single best value proposition, target market, primary ICP, USP, short brand description, plus the best list of primary challenges and languages.',
    'For each customer segment include: name, industry, companySize, region, maturityLevel, painPoints, jobsToBeDone, decisionCriteria, useCases, buyingRoles, priceSensitivity, primarySegment, notes, score, and whyItFits.',
    'The 20 customer segments must be the best 20, not filler. They should be ordered by expected strategic fit and revenue opportunity.',
    'Also compare all 10 competitors and explain for each where whitespace exists and why the workspace can win.',
    'Use only valid JSON without markdown fences.',
    'Output shape: {"summary":string,"recommendedProfile":{"valueProposition":string,"targetMarket":string,"primaryIcp":string,"usp":string,"shortBrandDescription":string,"primaryChallenges":string[],"languages":string[]},"suggestions":{"valuePropositions":[{"value":string,"whyItFits":string,"competitorGap":string,"score":number}],"targetMarkets":[{"value":string,"whyItFits":string,"competitorGap":string,"score":number}],"primaryIcps":[{"value":string,"whyItFits":string,"competitorGap":string,"score":number}],"usps":[{"value":string,"whyItFits":string,"competitorGap":string,"score":number}],"shortBrandDescriptions":[{"value":string,"whyItFits":string,"competitorGap":string,"score":number}],"primaryChallenges":[{"value":string,"whyItFits":string,"competitorGap":string,"score":number}],"languages":[{"value":string,"whyItFits":string,"competitorGap":string,"score":number}]},"customerSegments":[{"name":string,"industry":string|null,"companySize":string|null,"region":string|null,"maturityLevel":string|null,"painPoints":string[],"jobsToBeDone":string[],"decisionCriteria":string[],"useCases":string[],"buyingRoles":string[],"priceSensitivity":string|null,"primarySegment":boolean,"notes":string|null,"score":number,"whyItFits":string}],"competitorComparison":[{"name":string,"websiteUrl":string|null,"competitorType":string|null,"market":string|null,"positioning":string|null,"strengths":string[],"weaknesses":string[],"whitespace":string[],"whyYouCanWin":string}]}',
  ].join(' ');
}

function clampScore(value: unknown) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 70;
  return Math.max(1, Math.min(100, Math.round(numeric)));
}

function normaliseSuggestion(entry: unknown) {
  const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
  const value = normaliseOptionalText(item.value, 2000);
  if (!value) return null;
  return {
    value,
    whyItFits: normaliseOptionalText(item.whyItFits, 2000) ?? 'Fits the available workspace context.',
    competitorGap: normaliseOptionalText(item.competitorGap, 1200) ?? 'Creates whitespace versus the current competitor set.',
    score: clampScore(item.score),
  } satisfies repo.AiBusinessProfileSuggestion;
}

function normaliseSuggestionList(value: unknown, minimum = 3) {
  if (!Array.isArray(value)) return [];
  const items = value
    .map((entry) => normaliseSuggestion(entry))
    .filter((entry): entry is repo.AiBusinessProfileSuggestion => Boolean(entry))
    .slice(0, 10);
  if (items.length < minimum) return [];
  return items;
}

function normaliseGeneratedCustomerSegment(entry: unknown) {
  const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
  const name = normaliseOptionalText(item.name, 200);
  if (!name) return null;
  return {
    name,
    industry: normaliseOptionalText(item.industry, 200),
    companySize: normaliseOptionalText(item.companySize, 100),
    region: normaliseOptionalText(item.region, 200),
    maturityLevel: normaliseOptionalText(item.maturityLevel, 120),
    painPoints: normaliseStringList(item.painPoints, 20, 160),
    jobsToBeDone: normaliseStringList(item.jobsToBeDone, 20, 160),
    decisionCriteria: normaliseStringList(item.decisionCriteria, 20, 160),
    useCases: normaliseStringList(item.useCases, 20, 160),
    buyingRoles: normaliseStringList(item.buyingRoles, 20, 120),
    priceSensitivity: normaliseOptionalText(item.priceSensitivity, 120),
    primarySegment: typeof item.primarySegment === 'boolean' ? item.primarySegment : false,
    notes: normaliseOptionalText(item.notes, 4000),
    score: clampScore(item.score),
    whyItFits: normaliseOptionalText(item.whyItFits, 2000) ?? 'Fits the available workspace context and opportunity landscape.',
  } satisfies repo.AiGeneratedCustomerSegment;
}

function normaliseGeneratedCustomerSegments(
  raw: unknown,
  fallbackSegments: CustomerSegmentContext[],
) {
  if (!Array.isArray(raw)) {
    throw new AppError(502, 'AI_EMPTY_RESPONSE', 'The AI provider did not return customer segments');
  }

  const seen = new Set<string>();
  const normalized = raw
    .map((entry) => normaliseGeneratedCustomerSegment(entry))
    .filter((entry): entry is repo.AiGeneratedCustomerSegment => Boolean(entry))
    .filter((entry) => {
      const key = entry.name.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20)
    .map((entry, index) => ({
      ...entry,
      primarySegment: typeof raw[index] === 'object' && raw[index] !== null && typeof (raw[index] as Record<string, unknown>).primarySegment === 'boolean'
        ? entry.primarySegment
        : index < 3,
    }));

  if (normalized.length < 20 && fallbackSegments.length > 0) {
    for (const fallback of fallbackSegments) {
      if (normalized.length >= 20) break;
      const key = fallback.name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push({
        name: fallback.name,
        industry: fallback.industry ?? null,
        companySize: fallback.companySize ?? null,
        region: fallback.region ?? null,
        maturityLevel: fallback.maturityLevel ?? null,
        painPoints: (fallback.painPoints ?? []).slice(0, 20),
        jobsToBeDone: (fallback.jobsToBeDone ?? []).slice(0, 20),
        decisionCriteria: (fallback.decisionCriteria ?? []).slice(0, 20),
        useCases: (fallback.useCases ?? []).slice(0, 20),
        buyingRoles: (fallback.buyingRoles ?? []).slice(0, 20),
        priceSensitivity: fallback.priceSensitivity ?? null,
        primarySegment: normalized.length < 3 ? true : fallback.primarySegment,
        notes: fallback.notes ?? null,
        score: Math.max(50, 80 - normalized.length),
        whyItFits: 'Kept from the existing workspace segment library to preserve high-signal customer coverage.',
      });
    }
  }

  if (normalized.length < 20) {
    throw new AppError(502, 'AI_EMPTY_RESPONSE', 'The AI provider did not return the required 20 usable customer segments');
  }

  return normalized.slice(0, 20).map((entry, index) => ({
    ...entry,
    primarySegment: index < 3 ? entry.primarySegment : false,
  }));
}

function normaliseCompetitorComparisonEntry(entry: unknown, fallback?: CompetitorContext) {
  const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
  const name = normaliseOptionalText(item.name, 200) ?? fallback?.name ?? null;
  if (!name) return null;
  return {
    name,
    websiteUrl: normaliseWebsiteUrl(item.websiteUrl) ?? fallback?.websiteUrl ?? null,
    competitorType: normaliseOptionalText(item.competitorType, 120) ?? fallback?.competitorType ?? null,
    market: normaliseOptionalText(item.market, 200) ?? fallback?.market ?? null,
    positioning: normaliseOptionalText(item.positioning, 2000) ?? fallback?.positioning ?? null,
    strengths: normaliseStringList(item.strengths, 6, 160).length ? normaliseStringList(item.strengths, 6, 160) : (fallback?.strengths ?? []).slice(0, 6),
    weaknesses: normaliseStringList(item.weaknesses, 6, 160).length ? normaliseStringList(item.weaknesses, 6, 160) : (fallback?.weaknesses ?? []).slice(0, 6),
    whitespace: normaliseStringList(item.whitespace, 6, 160).length ? normaliseStringList(item.whitespace, 6, 160) : (fallback?.differentiators ?? []).slice(0, 6),
    whyYouCanWin: normaliseOptionalText(item.whyYouCanWin, 2000) ?? 'The workspace can win by being clearer, more focused, and more differentiated in this competitor gap.',
  } satisfies repo.AiBusinessProfileCompetitorComparison;
}

function fallbackCompetitorComparisons(competitors: CompetitorContext[]) {
  return competitors.slice(0, 10).map((competitor) => ({
    name: competitor.name,
    websiteUrl: competitor.websiteUrl ?? null,
    competitorType: competitor.competitorType ?? null,
    market: competitor.market ?? null,
    positioning: competitor.positioning ?? null,
    strengths: (competitor.strengths ?? []).slice(0, 6),
    weaknesses: (competitor.weaknesses ?? []).slice(0, 6),
    whitespace: (competitor.differentiators ?? []).slice(0, 6),
    whyYouCanWin: 'Use a sharper promise, a narrower ICP, and more specific proof than this competitor currently communicates.',
  }));
}

function normaliseAiBusinessProfilePayload(
  raw: unknown,
  competitors: CompetitorContext[],
  fallbackSegments: CustomerSegmentContext[],
) {
  const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const suggestionsValue = item.suggestions && typeof item.suggestions === 'object'
    ? item.suggestions as Record<string, unknown>
    : {};

  const suggestions = {
    valuePropositions: normaliseSuggestionList(suggestionsValue.valuePropositions),
    targetMarkets: normaliseSuggestionList(suggestionsValue.targetMarkets),
    primaryIcps: normaliseSuggestionList(suggestionsValue.primaryIcps),
    usps: normaliseSuggestionList(suggestionsValue.usps),
    shortBrandDescriptions: normaliseSuggestionList(suggestionsValue.shortBrandDescriptions),
    primaryChallenges: normaliseSuggestionList(suggestionsValue.primaryChallenges),
    languages: normaliseSuggestionList(suggestionsValue.languages),
  } satisfies repo.AiBusinessProfilePayload['suggestions'];

  const mandatoryGroups = Object.values(suggestions);
  if (mandatoryGroups.some((group) => group.length < 3)) {
    throw new AppError(502, 'AI_EMPTY_RESPONSE', 'The AI provider did not return enough usable profile suggestions');
  }

  const recommendedProfileValue = item.recommendedProfile && typeof item.recommendedProfile === 'object'
    ? item.recommendedProfile as Record<string, unknown>
    : {};

  const recommendedProfile = {
    valueProposition: normaliseOptionalText(recommendedProfileValue.valueProposition, 2000) ?? suggestions.valuePropositions[0]!.value,
    targetMarket: normaliseOptionalText(recommendedProfileValue.targetMarket, 2000) ?? suggestions.targetMarkets[0]!.value,
    primaryIcp: normaliseOptionalText(recommendedProfileValue.primaryIcp, 2000) ?? suggestions.primaryIcps[0]!.value,
    usp: normaliseOptionalText(recommendedProfileValue.usp, 2000) ?? suggestions.usps[0]!.value,
    shortBrandDescription: normaliseOptionalText(recommendedProfileValue.shortBrandDescription, 500) ?? suggestions.shortBrandDescriptions[0]!.value.slice(0, 500),
    primaryChallenges: normaliseStringList(recommendedProfileValue.primaryChallenges, 10, 160).length
      ? normaliseStringList(recommendedProfileValue.primaryChallenges, 10, 160)
      : suggestions.primaryChallenges.slice(0, 5).map((entry) => entry.value),
    languages: normaliseStringList(recommendedProfileValue.languages, 10, 80).length
      ? normaliseStringList(recommendedProfileValue.languages, 10, 80)
      : suggestions.languages.slice(0, 5).map((entry) => entry.value),
  };

  const rawComparison = Array.isArray(item.competitorComparison) ? item.competitorComparison : [];
  const fallbackByName = new Map(competitors.map((competitor) => [competitor.name.trim().toLowerCase(), competitor] as const));
  const competitorComparison = rawComparison
    .map((entry) => {
      const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
      const name = typeof record.name === 'string' ? record.name.trim().toLowerCase() : '';
      return normaliseCompetitorComparisonEntry(entry, fallbackByName.get(name));
    })
    .filter((entry): entry is repo.AiBusinessProfileCompetitorComparison => Boolean(entry))
    .slice(0, 10);

  const finalComparison = competitorComparison.length >= 5
    ? competitorComparison
    : fallbackCompetitorComparisons(competitors);

  return {
    summary: normaliseOptionalText(item.summary, 4000) ?? 'AI-generated business profile draft based on the current workspace context and competitor comparison.',
    recommendedProfile,
    suggestions,
    customerSegments: normaliseGeneratedCustomerSegments(item.customerSegments, fallbackSegments),
    competitorComparison: finalComparison,
  } satisfies repo.AiBusinessProfilePayload;
}

export function getAiBusinessProfile(workspaceId: string) {
  return repo.getAiBusinessProfile(workspaceId);
}

export async function generateAiBusinessProfile(workspaceId: string, userId: string) {
  if (!isAiGenerationConfigured()) {
    throw new AppError(503, 'AI_NOT_CONFIGURED', 'The AI provider is not configured for AI business profile generation');
  }

  const workspace = await findWorkspaceById(workspaceId);
  if (!workspace) throw notFoundError('Workspace not found');

  const [offerings, customerSegments, platforms, storedCompetitors, knowledgeBundle] = await Promise.all([
    repo.listOfferings(workspaceId),
    repo.listCustomerSegments(workspaceId),
    repo.listPlatforms(workspaceId),
    repo.listCompetitors(workspaceId),
    getKnowledgeBundle(workspaceId).catch(() => null),
  ]);

  const competitors = storedCompetitors.length >= 10
    ? storedCompetitors.slice(0, 10)
    : await generateCompetitorDrafts(workspaceId, userId);

  if (competitors.length === 0) {
    throw new AppError(422, 'SEARCH_INTELLIGENCE_CONTEXT_MISSING', 'At least one competitor is required for AI business profile generation');
  }

  const model = resolveAiModel();
  const response = await getOpenAIResponsesClient().create({
    model,
    instructions: buildAiBusinessProfileInstructions(),
    input: [{
      role: 'user',
      content: [
        `Workspace: ${workspaceId}`,
        'Workspace profile:',
        JSON.stringify({
          companyName: workspace.companyName,
          industry: workspace.industry,
          companySize: workspace.companySize,
          countryRegion: workspace.countryRegion,
          businessDescription: workspace.businessDescription,
          valueProposition: workspace.valueProposition,
          targetMarket: workspace.targetMarket,
          shortBrandDescription: workspace.shortBrandDescription,
          positioningTags: workspace.positioningTags,
          primaryIcp: workspace.primaryIcp,
          usp: workspace.usp,
          mission: workspace.mission,
          vision: workspace.vision,
          primaryChallenges: workspace.primaryChallenges,
          languages: workspace.languages,
        }),
        'Offerings:',
        JSON.stringify(offerings.slice(0, 20)),
        'Customer segments:',
        JSON.stringify(customerSegments.slice(0, 20)),
        'Connected platforms:',
        JSON.stringify(platforms.slice(0, 20)),
        'Competitors (exact comparison set):',
        JSON.stringify(competitors.slice(0, 10)),
        'Latest workspace intelligence:',
        JSON.stringify(knowledgeBundle?.snapshot
          ? {
              executiveSummary: knowledgeBundle.snapshot.executiveSummary,
              priorities: knowledgeBundle.snapshot.priorities.slice(0, 10),
              dataGaps: knowledgeBundle.snapshot.dataGaps.slice(0, 10),
              knowledgeBase: knowledgeBundle.snapshot.knowledgeBase,
            }
          : null),
      ].join('\n\n'),
    }],
    reasoning: { effort: 'high' },
    max_output_tokens: 12000,
    store: false,
  }, { billing: { workspaceId, userId } });

  const payload = normaliseAiBusinessProfilePayload(extractJson(response.output_text), competitors, customerSegments);
  return repo.saveAiBusinessProfile({
    workspaceId,
    payload,
    model,
    generatedAt: new Date().toISOString(),
  });
}

export function applyGeneratedCustomerSegments(workspaceId: string, segments: repo.AiGeneratedCustomerSegment[]) {
  return repo.replaceGeneratedCustomerSegments(workspaceId, segments);
}

export async function applyStoredAiCustomerSegments(workspaceId: string) {
  const profile = await repo.getAiBusinessProfile(workspaceId);
  if (!profile?.payload.customerSegments?.length) {
    throw new AppError(404, 'AI_BUSINESS_PROFILE_NOT_FOUND', 'No generated AI customer segments are available for this workspace');
  }
  return repo.replaceGeneratedCustomerSegments(workspaceId, profile.payload.customerSegments);
}
