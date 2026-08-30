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

const WEBSITE_SECTION_LABEL = 'Website & Commerce';
const GOOGLE_BUSINESS_SECTION_LABEL = 'Google Business';
const EMAIL_SECTION_LABEL = 'Email';
const CALENDAR_SECTION_LABEL = 'Calendar';

function cleanString(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function toAgentPageContext(pageId: string): AgentPageContext | null {
  const canonical = canonicalAgentPageProfileById[pageId];
  if (!canonical) return null;
  return {
    pageId: canonical.pageId,
    pageLabel: canonical.pageLabel,
    sectionLabel: canonical.sectionLabel,
    agentName: canonical.agentName,
    objective: canonical.objective,
    autonomy: canonical.autonomy,
    jobs: [...canonical.jobs],
    integrations: [...canonical.integrations],
    successMetrics: [...canonical.successMetrics],
    approvalGates: [...canonical.approvalGates],
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
  if (explicitModule && explicitModule !== 'general') return explicitModule;
  if (!page) return explicitModule ?? 'general';
  const normalizedSection = page.sectionLabel.trim().toLowerCase();
  const normalizedPageId = page.pageId.trim().toLowerCase();
  const normalizedPageLabel = page.pageLabel.trim().toLowerCase();
  if (normalizedPageId === 'sparklingly-moon-5114' || normalizedPageLabel === 'seo') return 'seo';
  if (normalizedPageId === 'zealously-path-4224' || normalizedPageLabel === 'geo') return 'geo';
  if (normalizedPageId === 'sunny-house-9595' || normalizedPageLabel === 'aeo') return 'aeo';
  if (
    normalizedSection === WEBSITE_SECTION_LABEL.toLowerCase()
    || normalizedSection === GOOGLE_BUSINESS_SECTION_LABEL.toLowerCase()
    || normalizedSection === EMAIL_SECTION_LABEL.toLowerCase()
    || normalizedSection === CALENDAR_SECTION_LABEL.toLowerCase()
    || normalizedPageId.startsWith('website-')
    || normalizedPageId.startsWith('email-')
    || normalizedPageId.startsWith('calendar-')
    || normalizedPageId === 'lulu-website-portal-9012'
  ) {
    return 'website';
  }
  return explicitModule ?? 'general';
}

export function buildPageAgentGoal(page: AgentPageContext) {
  const agentName = page.agentName ?? page.pageLabel;
  const objective = page.objective ?? `Continuously analyse and improve ${page.pageLabel}.`;
  return `[page-agent:${page.pageId}] ${agentName}: ${objective}`.slice(0, 4000);
}

export const automaticPageProfiles: readonly AgentPageContext[] = Object.freeze(
  canonicalAgentPageProfiles
    .map((profile) => toAgentPageContext(profile.pageId))
    .filter((profile): profile is AgentPageContext => Boolean(profile)),
);
