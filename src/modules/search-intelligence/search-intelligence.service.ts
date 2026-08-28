import { decryptSecret } from '../../utils/secret-box.js';
import { AppError } from '../../utils/app-error.js';
import type { ResourceType } from '../../domain/resource-catalog.js';
import * as onboardingService from '../onboarding/onboarding.service.js';
import * as onboardingRepo from '../onboarding/onboarding.repo.js';
import { refreshStoredOAuthCredential } from '../onboarding/oauth.service.js';
import * as websiteRepo from '../websites/website.repo.js';
import type { WebsiteSite } from '../websites/website.types.js';
import {
  createWebflowItem,
  createWordpressPage,
  publishWebflowSite,
  publishWordpressPage,
  updateWordpressPage,
  webflowCustomDomains,
  withProviderConnectionError,
  wordpressPages,
} from '../websites/website.provider.service.js';
import {
  fetchGoogleOrganicSerp,
  fetchKeywordOverview,
  fetchOnPageAudit,
  fetchSearchVolume,
  taskResults,
} from './dataforseo.service.js';
import * as repo from './search-intelligence.repo.js';
import type {
  AnalyzeSearchInput,
  ApplySearchInput,
  SearchChannel,
} from './search-intelligence.validator.js';

const RESOURCE_TYPE_BY_CHANNEL: Record<SearchChannel, ResourceType> = {
  seo: 'marketing_seo_items',
  geo: 'marketing_geo_items',
  aeo: 'marketing_aeo_items',
};

type ChannelSummary = {
  channel: SearchChannel;
  resourceType: ResourceType;
  dataSource: 'dataforseo';
  connectedTargets: Array<{
    provider: 'wordpress' | 'webflow' | 'shopify';
    id: string;
    label: string;
    url: string | null;
  }>;
  metrics: {
    records: number;
    opportunities: number;
    answeredOrMentioned: number;
    siteAudits: number;
  };
  items: Array<ReturnType<typeof mapRecordForClient>>;
  lastAnalyzedAt: string | null;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeText(value: unknown) {
  return String(value ?? '').trim();
}

function normalizeDomain(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return value.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0]?.toLowerCase() ?? '';
  }
}

function uniqueStrings(values: Array<string | null | undefined>, limit = 15) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value)
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized || normalized.length < 3) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function findNumericValue(value: unknown, keys: string[]): number | null {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findNumericValue(item, keys);
      if (nested !== null) return nested;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  for (const key of keys) {
    const direct = object[key];
    if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
    if (typeof direct === 'string') {
      const parsed = Number.parseFloat(direct);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  for (const nested of Object.values(object)) {
    const result = findNumericValue(nested, keys);
    if (result !== null) return result;
  }
  return null;
}

function collectUrls(value: unknown, urls = new Set<string>()) {
  if (!value) return urls;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) urls.add(value);
    return urls;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, urls);
    return urls;
  }
  if (typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) collectUrls(nested, urls);
  }
  return urls;
}

function collectItemTypes(value: unknown, values = new Set<string>()) {
  if (!value) return values;
  if (Array.isArray(value)) {
    for (const item of value) collectItemTypes(item, values);
    return values;
  }
  if (typeof value !== 'object') return values;
  const object = value as Record<string, unknown>;
  const type = object.type;
  if (typeof type === 'string' && type.trim()) values.add(type.trim());
  for (const nested of Object.values(object)) collectItemTypes(nested, values);
  return values;
}

function mapRecordForClient(record: Awaited<ReturnType<typeof repo.listChannelRecords>>[number]) {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    status: record.status,
    stage: record.stage,
    updatedAt: record.updatedAt,
    createdAt: record.createdAt,
    data: record.data,
  };
}

function deriveQuestionsFromKeywords(keywords: string[], companyName: string) {
  return uniqueStrings(
    keywords.flatMap((keyword) => [
      `what is ${keyword}`,
      `how does ${keyword} work`,
      `why use ${keyword}`,
      `how does ${companyName} help with ${keyword}`,
    ]),
    10,
  );
}

function deriveGeoPromptsFromKeywords(keywords: string[], companyName: string) {
  return uniqueStrings(
    keywords.flatMap((keyword) => [
      `best ${keyword}`,
      `${keyword} alternatives`,
      `${companyName} ${keyword}`,
      `${keyword} for businesses`,
    ]),
    10,
  );
}

function deriveSeedKeywords(snapshot: Awaited<ReturnType<typeof onboardingService.getSnapshot>>, maxKeywords: number) {
  const workspace = snapshot.workspace;
  const offerings = snapshot.offerings;
  const customerSegments = snapshot.customerSegments;
  const candidates = uniqueStrings(
    [
      workspace.companyName,
      workspace.valueProposition,
      workspace.targetMarket,
      workspace.primaryIcp,
      workspace.usp,
      ...workspace.positioningTags,
      ...workspace.primaryChallenges,
      ...offerings.flatMap((offering) => [
        offering.name,
        offering.category,
        offering.valueProposition,
        offering.targetCustomer,
        ...offering.useCases,
        ...offering.differentiators,
      ]),
      ...customerSegments.flatMap((segment) => [
        segment.name,
        segment.industry,
        segment.region,
        ...segment.jobsToBeDone,
        ...segment.useCases,
        ...segment.decisionCriteria,
      ]),
    ],
    maxKeywords,
  );

  if (candidates.length > 0) return candidates;
  return uniqueStrings([workspace.companyName, workspace.industry, workspace.businessDescription], maxKeywords);
}

function connectedTargetsFromSnapshot(
  snapshot: Awaited<ReturnType<typeof onboardingService.getSnapshot>>,
  sites: WebsiteSite[],
) {
  const websiteTargets = sites
    .filter((site) => site.provider === 'wordpress' || site.provider === 'webflow')
    .map((site) => ({
      provider: site.provider as 'wordpress' | 'webflow',
      id: site.id,
      label: site.name,
      url: site.externalSiteUrl,
    }));

  const shopifyTargets = snapshot.platforms
    .filter((platform) => platform.integrationKey === 'shopify')
    .map((platform) => {
      const settings = objectValue(platform.settings);
      const shop = normalizeText(settings.shop);
      return {
        provider: 'shopify' as const,
        id: platform.id,
        label: platform.name,
        url: shop ? `https://${shop}` : null,
      };
    });

  return [...websiteTargets, ...shopifyTargets];
}

function recordSummary(
  channel: SearchChannel,
  records: Awaited<ReturnType<typeof repo.listChannelRecords>>,
  targets: ChannelSummary['connectedTargets'],
): ChannelSummary {
  const answeredOrMentioned = records.filter((record) => {
    const data = objectValue(record.data);
    const status = `${record.status} ${normalizeText(data.answerStatus)} ${normalizeText(data.mention)}`.toLowerCase();
    return status.includes('answered') || status.includes('mentioned') || status.includes('ranking');
  }).length;

  const opportunities = records.filter((record) => {
    const data = objectValue(record.data);
    return normalizeText(data.opportunity) || record.status === 'watch' || record.status === 'missing';
  }).length;

  return {
    channel,
    resourceType: RESOURCE_TYPE_BY_CHANNEL[channel],
    dataSource: 'dataforseo',
    connectedTargets: targets,
    metrics: {
      records: records.length,
      opportunities,
      answeredOrMentioned,
      siteAudits: records.filter((record) => normalizeText(objectValue(record.data).auditUrl)).length,
    },
    items: records.map(mapRecordForClient),
    lastAnalyzedAt: records[0]?.updatedAt ?? null,
  };
}

async function resolveContext(workspaceId: string, userId: string) {
  const [snapshot, sites] = await Promise.all([
    onboardingService.getSnapshot(workspaceId, userId),
    websiteRepo.listSites(workspaceId),
  ]);
  const targets = connectedTargetsFromSnapshot(snapshot, sites);
  return { snapshot, sites, targets };
}

async function buildKeywordSignals(
  input: AnalyzeSearchInput,
  keywords: string[],
  ownDomains: string[],
  channel: SearchChannel,
  companyName: string,
) {
  const [keywordOverview, searchVolume, serpResponses] = await Promise.all([
    fetchKeywordOverview({
      keywords,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
    }),
    fetchSearchVolume({
      keywords,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
    }),
    Promise.all(
      keywords.map((keyword, index) =>
        fetchGoogleOrganicSerp({
          keyword,
          locationCode: input.locationCode,
          languageCode: input.languageCode,
          depth: input.depth,
          device: input.device,
          tag: `${channel}-${index + 1}`,
        }),
      ),
    ),
  ]);

  const keywordOverviewResults = taskResults(keywordOverview);
  const searchVolumeResults = taskResults(searchVolume);

  return keywords.map((keyword, index) => {
    const overviewResult = keywordOverviewResults.find((result) => normalizeText(objectValue(result).keyword).toLowerCase() === keyword.toLowerCase()) ?? keywordOverviewResults[index];
    const volumeResult = searchVolumeResults.find((result) => normalizeText(objectValue(result).keyword).toLowerCase() === keyword.toLowerCase()) ?? searchVolumeResults[index];
    const serpResult = taskResults(serpResponses[index])[0] ?? {};
    const rawUrls = [...collectUrls(serpResult)];
    const citedDomains = uniqueStrings(rawUrls.map((url) => normalizeDomain(url)), 20);
    const ownMatch = citedDomains.some((domain) => ownDomains.includes(domain));
    const rawTypes = [...collectItemTypes(serpResult)];
    const volume = findNumericValue(volumeResult ?? overviewResult, ['search_volume', 'searchVolume', 'keyword_volume']) ?? 0;
    const competition = findNumericValue(overviewResult, ['competition', 'competition_index']) ?? 0;
    const topUrl = rawUrls[0] ?? null;
    const promptKeyword = keyword.toLowerCase();
    const companyMention = JSON.stringify(serpResult).toLowerCase().includes(companyName.toLowerCase());

    return {
      keyword,
      volume,
      competition,
      serpFeatures: rawTypes,
      citedDomains,
      citedUrls: rawUrls.slice(0, 10),
      topUrl,
      ownMatch,
      companyMention,
      raw: {
        keywordOverview: overviewResult ?? null,
        searchVolume: volumeResult ?? null,
        serp: serpResult ?? null,
      },
      inferredIntent:
        promptKeyword.startsWith('how ') || promptKeyword.startsWith('what ')
          ? 'informational'
          : promptKeyword.includes('best') || promptKeyword.includes('alternative')
            ? 'commercial'
            : 'mixed',
    };
  });
}

async function buildOnPageSignal(url: string | null, languageCode: string) {
  if (!url) return null;
  const audit = await fetchOnPageAudit({ url, languageCode });
  const result = taskResults(audit)[0] ?? {};
  return {
    url,
    raw: result,
    titleLength: findNumericValue(result, ['title_length']) ?? null,
    descriptionLength: findNumericValue(result, ['meta_description_length']) ?? null,
    warnings: [...collectItemTypes(result)].slice(0, 12),
  };
}

async function saveSeoRecords(
  workspaceId: string,
  userId: string,
  signals: Awaited<ReturnType<typeof buildKeywordSignals>>,
  onPageSignal: Awaited<ReturnType<typeof buildOnPageSignal>>,
) {
  for (const signal of signals) {
    const status = signal.ownMatch ? 'ranking' : 'watch';
    await repo.upsertChannelRecord({
      workspaceId,
      resourceType: RESOURCE_TYPE_BY_CHANNEL.seo,
      userId,
      externalId: `seo:${signal.keyword.toLowerCase()}`,
      name: signal.keyword,
      description: signal.topUrl ? `Top observed URL: ${signal.topUrl}` : 'No visible URL was parsed',
      status,
      stage: signal.inferredIntent,
      tags: ['dataforseo', 'seo', status],
      data: {
        keyword: signal.keyword,
        intent: signal.inferredIntent,
        volume: signal.volume,
        difficulty: signal.competition,
        url: signal.topUrl,
        citationDomains: signal.citedDomains,
        serpFeatures: signal.serpFeatures,
        status,
        opportunity: signal.ownMatch ? null : 'Increase presence for this keyword',
        auditUrl: onPageSignal?.url ?? null,
        onPageAudit: onPageSignal,
        raw: signal.raw,
      },
    });
  }
}

async function saveGeoRecords(
  workspaceId: string,
  userId: string,
  prompts: string[],
  signals: Awaited<ReturnType<typeof buildKeywordSignals>>,
) {
  for (const [index, signal] of signals.entries()) {
    const prompt = prompts[index] ?? signal.keyword;
    const status = signal.ownMatch || signal.companyMention ? 'mentioned' : 'missing';
    await repo.upsertChannelRecord({
      workspaceId,
      resourceType: RESOURCE_TYPE_BY_CHANNEL.geo,
      userId,
      externalId: `geo:${prompt.toLowerCase()}`,
      name: prompt,
      description: signal.topUrl ? `Top observed AI-adjacent source: ${signal.topUrl}` : 'No visible citation was parsed',
      status,
      stage: signal.inferredIntent,
      tags: ['dataforseo', 'geo', status],
      data: {
        prompt,
        topic: signal.keyword,
        intent: signal.inferredIntent,
        mention: status === 'mentioned' ? 'Mentioned' : 'Not Mentioned',
        competitors: signal.citedDomains.slice(0, 5).join(', ') || '—',
        citation: signal.topUrl ?? 'Not Cited',
        status: status === 'mentioned' ? 'Tracked' : 'Action Required',
        change: status === 'mentioned' ? '+1' : '0',
        citations: signal.citedUrls,
        serpFeatures: signal.serpFeatures,
        opportunity: status === 'mentioned' ? null : 'Increase mention and citation rate in AI-led discovery',
        raw: signal.raw,
      },
    });
  }
}

async function saveAeoRecords(
  workspaceId: string,
  userId: string,
  questions: string[],
  signals: Awaited<ReturnType<typeof buildKeywordSignals>>,
  onPageSignal: Awaited<ReturnType<typeof buildOnPageSignal>>,
) {
  for (const [index, signal] of signals.entries()) {
    const question = questions[index] ?? signal.keyword;
    const answerStatus = signal.ownMatch ? 'Answered' : 'Not Answered';
    await repo.upsertChannelRecord({
      workspaceId,
      resourceType: RESOURCE_TYPE_BY_CHANNEL.aeo,
      userId,
      externalId: `aeo:${question.toLowerCase()}`,
      name: question,
      description: signal.topUrl ? `Observed answer source: ${signal.topUrl}` : 'No answer source was parsed',
      status: answerStatus.toLowerCase().replace(/\s+/g, '_'),
      stage: signal.inferredIntent,
      tags: ['dataforseo', 'aeo', answerStatus.toLowerCase()],
      data: {
        question,
        topic: signal.keyword,
        intent: signal.inferredIntent,
        answerStatus,
        sourcePage: signal.topUrl ?? '—',
        quality: signal.ownMatch ? 'High' : 'Low',
        opportunity: signal.ownMatch ? 'Low' : 'High',
        schemaSignals: onPageSignal?.warnings ?? [],
        peopleAlsoAsk: signal.serpFeatures.filter((item) => /people|question|faq/i.test(item)),
        raw: signal.raw,
      },
    });
  }
}

function buildInsightPage(
  channel: SearchChannel,
  summary: ChannelSummary,
  companyName: string,
) {
  const title = `${companyName} ${channel.toUpperCase()} Insights`;
  const slug = `${channel}-insights`;
  const bullets = summary.items.slice(0, 8).map((item) => {
    const data = objectValue(item.data);
    const details = [
      normalizeText(data.intent),
      normalizeText(data.volume),
      normalizeText(data.answerStatus),
      normalizeText(data.mention),
      normalizeText(data.opportunity),
    ].filter(Boolean).join(' | ');
    return `<li><strong>${item.name}</strong>${details ? ` - ${details}` : ''}</li>`;
  }).join('');

  const html = [
    `<main data-lulu-search-intelligence="${channel}">`,
    `<h1>${title}</h1>`,
    `<p>Auto-generated from DataForSEO-backed ${channel.toUpperCase()} analysis.</p>`,
    `<p>Tracked records: ${summary.metrics.records} | Opportunities: ${summary.metrics.opportunities} | Connected targets: ${summary.connectedTargets.length}</p>`,
    `<ul>${bullets || '<li>No verified items available yet.</li>'}</ul>`,
    `</main>`,
  ].join('');

  return {
    title,
    slug,
    seoTitle: `${title} | ${companyName}`,
    seoDescription: `Auto-applied ${channel.toUpperCase()} analysis for ${companyName}.`,
    html,
  };
}

async function applyToWordpressSite(
  workspaceId: string,
  site: WebsiteSite,
  page: ReturnType<typeof buildInsightPage>,
  publish: boolean,
) {
  if (!site.externalSiteId) {
    throw new AppError(409, 'WEBSITE_PROVIDER_CONFIGURATION_MISSING', 'WordPress site ID is missing');
  }
  const existingPages = await withProviderConnectionError(workspaceId, 'wordpress', () =>
    wordpressPages(workspaceId, site.externalSiteId!),
  );
  const existing = existingPages.find((item: any) => normalizeText(item.slug).toLowerCase() === page.slug);
  const pageId = existing?.ID ?? existing?.id;
  const draft = pageId
    ? await withProviderConnectionError(workspaceId, 'wordpress', () =>
        updateWordpressPage(workspaceId, site.externalSiteId!, String(pageId), {
          title: page.title,
          slug: page.slug,
          content: page.html,
          seoDescription: page.seoDescription,
          status: publish ? 'publish' : 'draft',
        }),
      )
    : await withProviderConnectionError(workspaceId, 'wordpress', () =>
        createWordpressPage(workspaceId, site.externalSiteId!, {
          title: page.title,
          slug: page.slug,
          content: page.html,
          seoDescription: page.seoDescription,
          status: publish ? 'publish' : 'draft',
        }),
      );
  const published = publish
    ? await withProviderConnectionError(workspaceId, 'wordpress', () =>
        publishWordpressPage(workspaceId, site.externalSiteId!, String(draft?.ID ?? draft?.id ?? pageId)),
      )
    : draft;
  return {
    provider: 'wordpress' as const,
    targetId: site.id,
    label: site.name,
    url: normalizeText(published?.URL ?? published?.url ?? published?.link) || site.externalSiteUrl,
    status: publish ? ('applied' as const) : ('drafted' as const),
  };
}

async function applyToWebflowSite(
  workspaceId: string,
  site: WebsiteSite,
  page: ReturnType<typeof buildInsightPage>,
  publish: boolean,
) {
  const collectionId = normalizeText(objectValue(site.settings).collectionId);
  if (!collectionId || !site.externalSiteId) {
    throw new AppError(
      409,
      'WEBSITE_PROVIDER_CONFIGURATION_MISSING',
      'Webflow collection and site IDs are required for auto-apply',
    );
  }
  await withProviderConnectionError(workspaceId, 'webflow', () =>
    createWebflowItem(
      workspaceId,
      collectionId,
      {
        name: page.title,
        slug: page.slug,
        content: page.html,
        seoTitle: page.seoTitle,
        seoDescription: page.seoDescription,
      },
      !publish,
    ),
  );
  if (publish) {
    const providerDomains = await withProviderConnectionError(workspaceId, 'webflow', () =>
      webflowCustomDomains(workspaceId, site.externalSiteId!),
    );
    const domainItems = Array.isArray(providerDomains?.customDomains)
      ? providerDomains.customDomains
      : Array.isArray(providerDomains)
        ? providerDomains
        : [];
    const verifiedHostnames = new Set(
      site.domains.filter((domain) => domain.status === 'verified').map((domain) => domain.hostname.toLowerCase()),
    );
    const customDomainIds = domainItems
      .filter((domain: any) => verifiedHostnames.has(normalizeText(domain.url ?? domain.hostname).toLowerCase()))
      .map((domain: any) => String(domain.id));
    await withProviderConnectionError(workspaceId, 'webflow', () =>
      publishWebflowSite(workspaceId, site.externalSiteId!, customDomainIds),
    );
  }
  return {
    provider: 'webflow' as const,
    targetId: site.id,
    label: site.name,
    url: site.externalSiteUrl,
    status: publish ? ('applied' as const) : ('drafted' as const),
  };
}

async function shopifyTokenFor(workspaceId: string) {
  const credential = await onboardingRepo.getPlatformOAuthCredential(workspaceId, 'shopify');
  if (!credential) {
    throw new AppError(409, 'WEBSITE_PROVIDER_NOT_CONNECTED', 'Shopify is not connected for this workspace');
  }
  const expiresAt = credential.tokenExpiresAt ? new Date(credential.tokenExpiresAt).getTime() : null;
  if (expiresAt && Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000) {
    return refreshStoredOAuthCredential({
      workspaceId,
      provider: 'shopify',
      encryptedRefreshToken: credential.encryptedRefreshToken,
    });
  }
  return decryptSecret(credential.encryptedAccessToken);
}

async function shopifyRequest(
  workspaceId: string,
  shop: string,
  path: string,
  init: RequestInit = {},
) {
  const token = await shopifyTokenFor(workspaceId);
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  headers.set('x-shopify-access-token', token);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`https://${shop}${path}`, { ...init, headers });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new AppError(
      502,
      'SHOPIFY_REQUEST_FAILED',
      'Shopify rejected the optimization request',
      {
        providerHttpStatus: response.status,
        providerMessage: payload ? JSON.stringify(payload).slice(0, 600) : 'No response body',
      },
    );
  }
  return payload ?? {};
}

async function applyToShopify(
  workspaceId: string,
  platform: Awaited<ReturnType<typeof onboardingService.getSnapshot>>['platforms'][number],
  page: ReturnType<typeof buildInsightPage>,
  publish: boolean,
) {
  const settings = objectValue(platform.settings);
  const shop = normalizeText(settings.shop);
  if (!shop) {
    throw new AppError(409, 'WEBSITE_PROVIDER_CONFIGURATION_MISSING', 'Shopify shop domain is missing');
  }
  const existingPages = await shopifyRequest(
    workspaceId,
    shop,
    `/admin/api/2024-10/pages.json?handle=${encodeURIComponent(page.slug)}`,
  );
  const pageItems = arrayValue(objectValue(existingPages).pages);
  const existingPage = objectValue(pageItems[0]);
  const payload = {
    page: {
      title: page.title,
      handle: page.slug,
      body_html: page.html,
      published: publish,
      metafields_global_title_tag: page.seoTitle,
      metafields_global_description_tag: page.seoDescription,
    },
  };
  if (normalizeText(existingPage.id)) {
    await shopifyRequest(
      workspaceId,
      shop,
      `/admin/api/2024-10/pages/${encodeURIComponent(normalizeText(existingPage.id))}.json`,
      { method: 'PUT', body: JSON.stringify(payload) },
    );
  } else {
    await shopifyRequest(
      workspaceId,
      shop,
      '/admin/api/2024-10/pages.json',
      { method: 'POST', body: JSON.stringify(payload) },
    );
  }
  return {
    provider: 'shopify' as const,
    targetId: platform.id,
    label: platform.name,
    url: `https://${shop}/pages/${page.slug}`,
    status: publish ? ('applied' as const) : ('drafted' as const),
  };
}

export async function getChannelSummary(workspaceId: string, userId: string, channel: SearchChannel) {
  const { targets } = await resolveContext(workspaceId, userId);
  const records = await repo.listChannelRecords(workspaceId, RESOURCE_TYPE_BY_CHANNEL[channel], 100);
  return recordSummary(channel, records, targets);
}

export async function applyChannel(
  workspaceId: string,
  userId: string,
  channel: SearchChannel,
  input: ApplySearchInput,
  existingSummary?: ChannelSummary,
) {
  const { snapshot, sites } = await resolveContext(workspaceId, userId);
  const summary = existingSummary ?? await getChannelSummary(workspaceId, userId, channel);
  const page = buildInsightPage(channel, summary, snapshot.workspace.companyName);
  const selectedSites = input.targetSiteIds?.length
    ? sites.filter((site) => input.targetSiteIds!.includes(site.id))
    : sites;
  const connectedSites = selectedSites.filter((site) => site.provider === 'wordpress' || site.provider === 'webflow');
  const shopifyPlatforms = snapshot.platforms.filter((platform) =>
    platform.integrationKey === 'shopify'
    && (!input.targetSiteIds?.length || input.targetSiteIds.includes(platform.id)),
  );

  if (connectedSites.length === 0 && shopifyPlatforms.length === 0) {
    throw new AppError(
      409,
      'WEBSITE_PROVIDER_NOT_CONNECTED',
      'Connect WordPress, Webflow or Shopify before running auto-apply',
    );
  }

  const appliedTargets = [];
  for (const site of connectedSites) {
    if (site.provider === 'wordpress') {
      appliedTargets.push(await applyToWordpressSite(workspaceId, site, page, input.publish));
    } else if (site.provider === 'webflow') {
      appliedTargets.push(await applyToWebflowSite(workspaceId, site, page, input.publish));
    }
  }
  for (const platform of shopifyPlatforms) {
    appliedTargets.push(await applyToShopify(workspaceId, platform, page, input.publish));
  }

  return {
    channel,
    appliedTargets,
    publish: input.publish,
    page,
  };
}

export async function analyzeChannel(
  workspaceId: string,
  userId: string,
  channel: SearchChannel,
  input: AnalyzeSearchInput,
) {
  const { snapshot, targets } = await resolveContext(workspaceId, userId);
  const websiteUrls = targets.map((target) => target.url).filter((value): value is string => Boolean(value));
  const ownDomains = uniqueStrings(websiteUrls.map((url) => normalizeDomain(url)), 20).map((domain) => domain.toLowerCase());
  const seedKeywords = deriveSeedKeywords(snapshot, input.maxKeywords);

  if (seedKeywords.length === 0) {
    throw new AppError(409, 'SEARCH_INTELLIGENCE_CONTEXT_MISSING', 'Workspace context is not rich enough to derive search topics');
  }

  const analysisKeywords =
    channel === 'seo'
      ? seedKeywords
      : channel === 'geo'
        ? deriveGeoPromptsFromKeywords(seedKeywords, snapshot.workspace.companyName)
        : deriveQuestionsFromKeywords(seedKeywords, snapshot.workspace.companyName);

  const keywordSignals = await buildKeywordSignals(
    input,
    analysisKeywords,
    ownDomains,
    channel,
    snapshot.workspace.companyName,
  );
  const onPageSignal = await buildOnPageSignal(websiteUrls[0] ?? null, input.languageCode);

  if (channel === 'seo') {
    await saveSeoRecords(workspaceId, userId, keywordSignals, onPageSignal);
  } else if (channel === 'geo') {
    await saveGeoRecords(workspaceId, userId, analysisKeywords, keywordSignals);
  } else {
    await saveAeoRecords(workspaceId, userId, analysisKeywords, keywordSignals, onPageSignal);
  }

  const records = await repo.listChannelRecords(workspaceId, RESOURCE_TYPE_BY_CHANNEL[channel], 100);
  const summary = recordSummary(channel, records, targets);
  const applied = input.autoApply
    ? await applyChannel(workspaceId, userId, channel, { publish: true }, summary)
    : null;

  return {
    ...summary,
    analyzedKeywords: analysisKeywords,
    autoApply: input.autoApply,
    ...(applied ? { appliedTargets: applied.appliedTargets, generatedPage: applied.page } : {}),
  };
}
