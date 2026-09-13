import type { AgentModule } from './agent.capabilities.js';
import { canonicalAgentPageProfileById, canonicalAgentPageProfiles } from './agent.registry.generated.js';

export type AgentPageContext = {
  pageId: string;
  pageLabel: string;
  sectionLabel: string;
  agentName: string | null;
  objective: string | null;
  autonomy: string | null;
  jobs: string[];
  integrations: string[];
  successMetrics: string[];
  approvalGates: string[];
};

type AgentPageContextInput = Partial<AgentPageContext> & {
  pageId?: unknown;
};

function cleanString(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export const GLOBAL_BRAND_MISSION = 'Continuously build a trusted global brand at maximum sustainable speed and make the company the number-one choice in its category worldwide.';
const MARKET_LEADERSHIP_SUFFIX = 'Compare against competitors and category leaders wherever relevant, close the highest-leverage gaps, and move the business toward becoming number one globally.';

// Historical generated navigation metadata placed Sales pages inside Finance
// and advertising pages inside Marketing. Runtime ownership must follow the
// business capability, not a legacy sidebar group.
const PAGE_MODULE_OVERRIDES: Readonly<Partial<Record<string, AgentModule>>> = {
  'fine-park-8079': 'sales',
  'softly-autumn-9038': 'sales',
  'wildly-sun-6424': 'sales',
  'deeply-month-1392': 'sales',
  'sweet-evening-7753': 'sales',
  'warmly-road-3804': 'sales',
  'wondrously-gate-2200': 'sales',
  'sharp-cliff-6925': 'sales',
  'lovingly-shore-4782': 'sales',
  'rich-moon-9195': 'sales',
  'lively-house-6788': 'sales',
  'gentle-cliff-7133': 'sales',
  'kindly-morning-7115': 'sales',
  'friendly-tower-1528': 'sales',
  'friendly-path-8200': 'ads',
  'wise-brook-1762': 'ads',
  'happily-storm-2690': 'ads',
  'sunny-minute-1092': 'ads',
  'zesty-grass-9196': 'ads',
  'nicely-shade-2637': 'ads',
  'nice-moon-2056': 'ads',
  'sunnily-peak-7188': 'ads',
  'solid-sand-5563': 'ads',
  'sunny-summer-2293': 'ads',
  'website-posts-9016': 'website',
  'fresh-tide-9404': 'settings',
  'glad-coast-1428': 'settings',
};

// The former Companies page redirects to the product-selected CRM route. It
// remains addressable for old run history but must not schedule a second copy
// of the same Company employee.
export const LEGACY_AUTOMATIC_PAGE_IDS = new Set(['kindly-pool-8785']);

function withCompetitiveObjective(objective: string | null) {
  const normalized = typeof objective === 'string' ? objective.trim() : '';
  if (!normalized) return MARKET_LEADERSHIP_SUFFIX;
  if (/compet/i.test(normalized) || /category leader/i.test(normalized) || /number one/i.test(normalized)) {
    return normalized;
  }
  return `${normalized} ${MARKET_LEADERSHIP_SUFFIX}`;
}

function toAgentPageContext(pageId: string): AgentPageContext | null {
  const canonical = canonicalAgentPageProfileById[pageId];
  if (!canonical) return null;
  const companyRoute = canonical.pageId === 'sturdy-month-1562';
  return {
    pageId: canonical.pageId,
    pageLabel: companyRoute ? 'Companies' : canonical.pageLabel,
    sectionLabel: canonical.sectionLabel,
    agentName: companyRoute ? 'Company Agent' : canonical.agentName,
    objective: withCompetitiveObjective(companyRoute ? 'Maintain complete, verified company records.' : canonical.objective),
    autonomy: canonical.autonomy,
    jobs: companyRoute ? ['enrich companies', 'detect duplicates', 'maintain company context'] : [...canonical.jobs],
    integrations: [...canonical.integrations],
    successMetrics: companyRoute ? ['account completeness', 'duplicate reduction', 'verified data coverage'] : [...canonical.successMetrics],
    approvalGates: [],
  };
}

export function sanitizeAgentPageContext(input: AgentPageContextInput | null | undefined): AgentPageContext | null {
  if (!input) return null;
  const pageId = cleanString(input.pageId, 120);
  if (!pageId) return null;
  return toAgentPageContext(pageId);
}

export function pageSnapshotType(pageId: string) {
  return `page_agent:${pageId}`;
}

export function resolveAgentModule(explicitModule: AgentModule | undefined, page: AgentPageContext | null) {
  if (!page) return explicitModule ?? 'general';
  const normalizedSection = page.sectionLabel.trim().toLowerCase();
  const normalizedPageId = page.pageId.trim().toLowerCase();
  const normalizedPageLabel = page.pageLabel.trim().toLowerCase();
  const moduleOverride = PAGE_MODULE_OVERRIDES[normalizedPageId];
  if (moduleOverride) return moduleOverride;
  if (normalizedPageId === 'sparklingly-moon-5114' || normalizedPageLabel === 'seo') return 'seo';
  if (normalizedPageId === 'zealously-path-4224' || normalizedPageLabel === 'geo') return 'geo';
  if (normalizedPageId === 'sunny-house-9595' || normalizedPageLabel === 'aeo') return 'aeo';

  let derived: AgentModule | null = null;

  if (normalizedSection === 'dashboard') derived = 'dashboard';
  else if (normalizedSection === 'finance') derived = 'finance';
  else if (normalizedSection === 'crm') derived = 'crm';
  else if (normalizedSection === 'sales') derived = 'sales';
  else if (normalizedSection === 'ai') derived = 'ai';
  else if (normalizedSection === 'email' || normalizedPageId.startsWith('email-')) derived = 'email';
  else if (normalizedSection === 'calendar' || normalizedPageId.startsWith('calendar-')) derived = 'calendar';
  else if (normalizedSection === 'marketing') derived = 'marketing';
  else if (normalizedSection === 'advertising') derived = 'ads';
  else if (normalizedSection === 'google business') derived = 'reputation';
  else if (normalizedSection === 'settings') derived = 'settings';
  else if (normalizedSection === 'website & commerce' || normalizedPageId.startsWith('website-') || normalizedPageId === 'lulu-website-portal-9012') {
    const websiteSignals = [
      'website',
      'wordpress',
      'webflow',
      'cms',
      'publishing',
      'asset',
      'domain',
    ];
    derived = websiteSignals.some((signal) => normalizedPageLabel.includes(signal)) ? 'website' : 'commerce';
  } else if (normalizedPageLabel.includes('intelligence') || normalizedPageLabel.includes('insight')) {
    derived = 'intelligence';
  }

  if (!derived) return explicitModule ?? 'general';
  if (!explicitModule || explicitModule === 'general' || explicitModule === 'website') return derived;
  return explicitModule;
}

export function buildPageAgentGoal(page: AgentPageContext) {
  const agentName = page.agentName ?? page.pageLabel;
  const objective = withCompetitiveObjective(page.objective ?? `Continuously analyse and improve ${page.pageLabel}.`);
  return `[permanent-mission] ${GLOBAL_BRAND_MISSION} [page-agent:${page.pageId}] ${agentName}: ${objective}`.slice(0, 4000);
}

export function buildGlobalAgentGoal() {
  return `[permanent-mission] ${GLOBAL_BRAND_MISSION}`;
}

export const automaticPageProfiles: readonly AgentPageContext[] = Object.freeze(
  canonicalAgentPageProfiles
    .filter((profile) => !LEGACY_AUTOMATIC_PAGE_IDS.has(profile.pageId))
    .map((profile) => toAgentPageContext(profile.pageId))
    .filter((profile): profile is AgentPageContext => Boolean(profile)),
);
