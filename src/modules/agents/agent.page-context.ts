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
  if (!page) return explicitModule ?? 'general';
  const normalizedSection = page.sectionLabel.trim().toLowerCase();
  const normalizedPageId = page.pageId.trim().toLowerCase();
  const normalizedPageLabel = page.pageLabel.trim().toLowerCase();
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
  const objective = page.objective ?? `Continuously analyse and improve ${page.pageLabel}.`;
  return `[page-agent:${page.pageId}] ${agentName}: ${objective}`.slice(0, 4000);
}

export const automaticPageProfiles: readonly AgentPageContext[] = Object.freeze(
  canonicalAgentPageProfiles
    .map((profile) => toAgentPageContext(profile.pageId))
    .filter((profile): profile is AgentPageContext => Boolean(profile)),
);
