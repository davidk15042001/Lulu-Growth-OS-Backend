import crypto from 'node:crypto';

export const COMPANY_RESEARCH_FIELDS = [
  'websiteUrl',
  'email',
  'phone',
  'industry',
  'country',
  'city',
  'address',
  'socialProfiles',
] as const;

export type CompanyResearchStatus =
  | 'queued'
  | 'researching'
  | 'complete'
  | 'partial'
  | 'blocked_funds'
  | 'failed';

export type CompanyIntelligenceData = Record<string, unknown> & {
  websiteUrl?: string | null;
  email?: string | null;
  phone?: string | null;
  industry?: string | null;
  country?: string | null;
  city?: string | null;
  address?: string | null;
  aiDescription?: string | null;
  aiNotes?: string | null;
  socialProfiles?: Record<string, string>;
  customerProvidedEvidence?: Array<{ text: string; conversationId: string; receivedAt: string }>;
  enrichment?: {
    status: CompanyResearchStatus;
    completeness?: number;
    confidence?: 'low' | 'medium' | 'high';
    fieldConfidence?: Record<string, 'low' | 'medium' | 'high'>;
    missingFields?: string[];
    sources?: Array<{ url: string; title?: string; kind: 'official_website' | 'search_result' | 'customer' }>;
    inputFingerprint?: string;
    queuedAt?: string;
    startedAt?: string;
    researchedAt?: string;
    nextAction?: string | null;
    errorCode?: string | null;
    outreach?: {
      status: 'not_needed' | 'sent' | 'channel_missing' | 'failed';
      channel?: string | null;
      conversationId?: string | null;
      sentAt?: string | null;
      attempts?: number;
      missingFieldsKey?: string;
      error?: string | null;
    };
  };
};

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedSocialProfiles(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {} as Record<string, string>;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key.trim().toLowerCase(), text(item)] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[0] && entry[1])),
  );
}

export function companyResearchFingerprint(name: string, raw: Record<string, unknown>) {
  const stable = {
    name: name.trim().toLowerCase(),
    websiteUrl: text(raw.websiteUrl ?? raw.website ?? raw.url)?.toLowerCase() ?? null,
    email: text(raw.email)?.toLowerCase() ?? null,
    phone: text(raw.phone ?? raw.phoneNumber) ?? null,
    industry: text(raw.industry)?.toLowerCase() ?? null,
    country: text(raw.country)?.toLowerCase() ?? null,
    city: text(raw.city)?.toLowerCase() ?? null,
    address: text(raw.address)?.toLowerCase() ?? null,
    socialProfiles: normalizedSocialProfiles(raw.socialProfiles),
    customerEvidence: Array.isArray(raw.customerProvidedEvidence)
      ? raw.customerProvidedEvidence.slice(-5).map((entry) => entry && typeof entry === 'object' ? text((entry as Record<string, unknown>).text) : null).filter(Boolean)
      : [],
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function normalizeCompanyData(raw: Record<string, unknown> = {}): CompanyIntelligenceData {
  return {
    ...raw,
    websiteUrl: text(raw.websiteUrl ?? raw.website ?? raw.url),
    email: text(raw.email),
    phone: text(raw.phone ?? raw.phoneNumber),
    industry: text(raw.industry),
    country: text(raw.country),
    city: text(raw.city),
    address: text(raw.address),
    socialProfiles: normalizedSocialProfiles(raw.socialProfiles),
  };
}

export function queueCompanyResearch(name: string, raw: Record<string, unknown> = {}, reason = 'company_saved') {
  const data = normalizeCompanyData(raw);
  const previous = data.enrichment && typeof data.enrichment === 'object' ? data.enrichment : undefined;
  return {
    ...data,
    enrichment: {
      ...previous,
      status: 'queued' as const,
      queuedAt: new Date().toISOString(),
      inputFingerprint: companyResearchFingerprint(name, data),
      nextAction: reason,
      errorCode: null,
    },
  };
}

export function companyResearchInputsChanged(
  beforeName: string,
  beforeData: Record<string, unknown>,
  afterName: string,
  afterData: Record<string, unknown>,
) {
  return companyResearchFingerprint(beforeName, normalizeCompanyData(beforeData))
    !== companyResearchFingerprint(afterName, normalizeCompanyData(afterData));
}
