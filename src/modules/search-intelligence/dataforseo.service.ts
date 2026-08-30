import { Buffer } from 'node:buffer';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';

function normalizeApiKey(value: string) {
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith('basic ')
    ? trimmed.slice(6).trim()
    : trimmed;
}

function requireCredentials() {
  if (env.DATAFORSEO_API_KEY) {
    const normalizedKey = normalizeApiKey(env.DATAFORSEO_API_KEY);

    if (normalizedKey.includes(':')) {
      return Buffer.from(normalizedKey, 'utf8').toString('base64');
    }

    return normalizedKey;
  }

  if (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD) {
    throw new AppError(
      503,
      'DATAFORSEO_NOT_CONFIGURED',
      'DataForSEO credentials are not configured on the server',
      {
        requiredEnv: ['DATAFORSEO_API_KEY'],
        legacyEnv: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'],
      },
    );
  }

  return Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`, 'utf8').toString('base64');
}

async function postDataForSeo(path: string, task: Record<string, unknown>) {
  const auth = requireCredentials();
  const response = await fetch(`${env.DATAFORSEO_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Basic ${auth}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify([task]),
  });

  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new AppError(
      502,
      'DATAFORSEO_REQUEST_FAILED',
      'DataForSEO rejected the request',
      {
        providerHttpStatus: response.status,
        providerMessage: payload ? JSON.stringify(payload).slice(0, 600) : 'No response body',
        path,
      },
    );
  }

  return payload ?? {};
}

export function taskResults(payload: unknown) {
  const value = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const tasks = Array.isArray(value.tasks) ? value.tasks : [];
  return tasks.flatMap((task) => {
    const result = task && typeof task === 'object' ? (task as Record<string, unknown>).result : null;
    return Array.isArray(result) ? result : [];
  });
}

export async function fetchKeywordOverview(input: {
  keywords: string[];
  locationCode: number;
  languageCode: string;
}) {
  return postDataForSeo('/v3/dataforseo_labs/google/keyword_overview/live', {
    keywords: input.keywords,
    location_code: input.locationCode,
    language_code: input.languageCode,
    include_clickstream_data: true,
    include_serp_info: true,
  });
}

export async function fetchSearchVolume(input: {
  keywords: string[];
  locationCode: number;
  languageCode: string;
}) {
  return postDataForSeo('/v3/keywords_data/clickstream_data/dataforseo_search_volume/live', {
    keywords: input.keywords,
    location_code: input.locationCode,
    language_code: input.languageCode,
    use_clickstream: true,
  });
}

export async function fetchGoogleOrganicSerp(input: {
  keyword: string;
  locationCode: number;
  languageCode: string;
  depth: number;
  device: 'desktop' | 'mobile';
  tag: string;
}) {
  return postDataForSeo('/v3/serp/google/organic/live/advanced', {
    keyword: input.keyword,
    location_code: input.locationCode,
    language_code: input.languageCode,
    depth: input.depth,
    device: input.device,
    os: input.device === 'mobile' ? 'android' : 'windows',
    load_async_ai_overview: true,
    tag: input.tag,
  });
}

export async function fetchOnPageAudit(input: {
  url: string;
  languageCode: string;
}) {
  return postDataForSeo('/v3/on_page/instant_pages', {
    url: input.url,
    browser_preset: 'desktop',
    enable_javascript: true,
    enable_browser_rendering: true,
    load_resources: false,
    validate_micromarkup: true,
    accept_language: input.languageCode,
  });
}
