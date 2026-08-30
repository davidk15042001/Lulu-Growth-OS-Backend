import type { AgentModule } from './agent.capabilities.js';

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
  pageLabel?: unknown;
  sectionLabel?: unknown;
  agentName?: unknown;
  objective?: unknown;
  autonomy?: unknown;
  jobs?: unknown;
  integrations?: unknown;
  successMetrics?: unknown;
  approvalGates?: unknown;
};

const WEBSITE_SECTION_LABEL = 'Website & Commerce';
const GOOGLE_BUSINESS_SECTION_LABEL = 'Google Business';
const FINANCE_SECTION_LABEL = 'Finance';
const MARKETING_SECTION_LABEL = 'Marketing';
const AI_SECTION_LABEL = 'AI';
const CRM_SECTION_LABEL = 'CRM';
const SALES_SECTION_LABEL = 'Sales';
const EMAIL_SECTION_LABEL = 'Email';
const CALENDAR_SECTION_LABEL = 'Calendar';
const DASHBOARD_SECTION_LABEL = 'Dashboard';

function cleanString(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function cleanStringArray(value: unknown, maxItems: number, maxLength: number) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanString(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function sanitizeAgentPageContext(input: AgentPageContextInput | null | undefined): AgentPageContext | null {
  if (!input) return null;
  const pageId = cleanString(input.pageId, 120);
  const pageLabel = cleanString(input.pageLabel, 200);
  const sectionLabel = cleanString(input.sectionLabel, 120);
  if (!pageId || !pageLabel || !sectionLabel) return null;
  return {
    pageId,
    pageLabel,
    sectionLabel,
    agentName: cleanString(input.agentName, 200) || null,
    objective: cleanString(input.objective, 1000) || null,
    autonomy: cleanString(input.autonomy, 16) || null,
    jobs: cleanStringArray(input.jobs, 12, 160),
    integrations: cleanStringArray(input.integrations, 12, 160),
    successMetrics: cleanStringArray(input.successMetrics, 12, 160),
    approvalGates: cleanStringArray(input.approvalGates, 12, 160),
  };
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

export const automaticPageProfiles: readonly AgentPageContext[] = [
  {
    pageId: 'fancily-leaf-1766',
    pageLabel: 'Executive Dashboard',
    sectionLabel: DASHBOARD_SECTION_LABEL,
    agentName: 'CEO Agent',
    objective: 'Run the workspace from one command center.',
    autonomy: 'A2',
    jobs: ['roll up signals', 'reprioritize work'],
    integrations: ['All connected systems'],
    successMetrics: ['issue detection speed', 'task throughput'],
    approvalGates: ['cross-domain execution'],
  },
  {
    pageId: 'serene-cloud-7079',
    pageLabel: 'Intelligence Overview',
    sectionLabel: DASHBOARD_SECTION_LABEL,
    agentName: 'Chief Intelligence Agent',
    objective: 'Merge business signals into one model.',
    autonomy: 'A2',
    jobs: ['aggregate signals', 'cluster themes'],
    integrations: ['All domain data'],
    successMetrics: ['insight quality', 'duplicate reduction'],
    approvalGates: [],
  },
  {
    pageId: 'fresh-moon-5374',
    pageLabel: 'Assistant',
    sectionLabel: AI_SECTION_LABEL,
    agentName: 'Universal Assistant Agent',
    objective: 'Let the user command the business in natural language.',
    autonomy: 'A3',
    jobs: ['answer', 'orchestrate work'],
    integrations: ['All accessible tools', 'workspace memory'],
    successMetrics: ['user task completion time', 'assistant adoption'],
    approvalGates: ['sensitive execution'],
  },
  {
    pageId: 'bright-meadow-7537',
    pageLabel: 'Overview',
    sectionLabel: CRM_SECTION_LABEL,
    agentName: 'CRM Lead Agent',
    objective: 'Keep the CRM healthy as one system.',
    autonomy: 'A2',
    jobs: ['audit hygiene', 'summarize state'],
    integrations: ['CRM records', 'tasks', 'activities'],
    successMetrics: ['CRM completeness', 'CRM hygiene'],
    approvalGates: ['bulk edits'],
  },
  {
    pageId: 'fine-park-8079',
    pageLabel: 'Sales Overview',
    sectionLabel: SALES_SECTION_LABEL,
    agentName: 'CSO Agent',
    objective: 'Run the sales domain from one overview.',
    autonomy: 'A2',
    jobs: ['summarize sales health', 'rank gaps'],
    integrations: ['CRM', 'finance', 'pipeline'],
    successMetrics: ['sales visibility', 'pipeline health'],
    approvalGates: ['external sales action'],
  },
  {
    pageId: 'email-inbox',
    pageLabel: 'Inbox',
    sectionLabel: EMAIL_SECTION_LABEL,
    agentName: 'Inbox Agent',
    objective: 'Triage and draft responses for inbound mail.',
    autonomy: 'A3',
    jobs: ['summarize threads', 'classify urgency'],
    integrations: ['Connected inboxes', 'CRM', 'calendar'],
    successMetrics: ['inbox zero speed', 'first-response time'],
    approvalGates: ['sending replies'],
  },
  {
    pageId: 'calendar-overview',
    pageLabel: 'Calendar',
    sectionLabel: CALENDAR_SECTION_LABEL,
    agentName: 'Calendar Agent',
    objective: 'Coordinate time and scheduling intelligently.',
    autonomy: 'A3',
    jobs: ['detect conflicts', 'propose slots'],
    integrations: ['Connected calendars', 'tasks', 'email'],
    successMetrics: ['conflict reduction', 'scheduling speed'],
    approvalGates: ['sending invites or rescheduling'],
  },
  {
    pageId: 'finely-garden-9221',
    pageLabel: 'Overview',
    sectionLabel: MARKETING_SECTION_LABEL,
    agentName: 'CMO Agent',
    objective: 'Operate the whole marketing function.',
    autonomy: 'A2',
    jobs: ['summarize domain status', 'prioritize work'],
    integrations: ['All marketing systems'],
    successMetrics: ['channel coordination quality', 'marketing responsiveness'],
    approvalGates: ['major channel changes'],
  },
  {
    pageId: 'breezily-wood-5980',
    pageLabel: 'Audiences',
    sectionLabel: MARKETING_SECTION_LABEL,
    agentName: 'Audience Agent',
    objective: 'Build living target audiences for the business.',
    autonomy: 'A4',
    jobs: ['enrich segments', 'score fit'],
    integrations: ['Onboarding', 'CRM', 'website', 'SEO/GEO/AEO', 'commerce'],
    successMetrics: ['audience quality', 'segment lift'],
    approvalGates: ['activating in ad or email systems'],
  },
  {
    pageId: 'lulu-website-portal-9012',
    pageLabel: 'Website',
    sectionLabel: WEBSITE_SECTION_LABEL,
    agentName: 'Website Manager Agent',
    objective: 'Operate the web presence as one managed system.',
    autonomy: 'A3',
    jobs: ['monitor generation jobs', 'plan changes'],
    integrations: ['CMS platforms', 'website generation', 'analytics'],
    successMetrics: ['site health', 'delivery speed'],
    approvalGates: ['publishing site structure'],
  },
  {
    pageId: 'sparklingly-moon-5114',
    pageLabel: 'SEO',
    sectionLabel: WEBSITE_SECTION_LABEL,
    agentName: 'SEO Agent',
    objective: 'Improve classic search visibility.',
    autonomy: 'A4',
    jobs: ['prioritize fixes', 'monitor rankings'],
    integrations: ['Search data', 'page content', 'technical site data'],
    successMetrics: ['organic traffic growth', 'rank improvement'],
    approvalGates: ['publishing technical or content changes'],
  },
  {
    pageId: 'zealously-path-4224',
    pageLabel: 'GEO',
    sectionLabel: WEBSITE_SECTION_LABEL,
    agentName: 'GEO Agent',
    objective: 'Improve generative search visibility.',
    autonomy: 'A3',
    jobs: ['generate citation tasks', 'improve entity clarity'],
    integrations: ['Brand knowledge', 'citations', 'site structure'],
    successMetrics: ['generative visibility growth', 'citation coverage'],
    approvalGates: ['publishing source changes'],
  },
  {
    pageId: 'sunny-house-9595',
    pageLabel: 'AEO',
    sectionLabel: WEBSITE_SECTION_LABEL,
    agentName: 'AEO Agent',
    objective: 'Improve answer-engine readiness.',
    autonomy: 'A3',
    jobs: ['generate answer blocks', 'identify snippet opportunities'],
    integrations: ['FAQs', 'structured content', 'page content'],
    successMetrics: ['answer capture rate', 'snippet coverage'],
    approvalGates: ['publishing answer content'],
  },
  {
    pageId: 'daring-brook-9034',
    pageLabel: 'Reviews',
    sectionLabel: GOOGLE_BUSINESS_SECTION_LABEL,
    agentName: 'Google Reputation Agent',
    objective: 'Operate Google review management.',
    autonomy: 'A4',
    jobs: ['sync reviews', 'draft replies'],
    integrations: ['Google Business Profile APIs', 'sentiment', 'workspace context'],
    successMetrics: ['response time', 'review sentiment'],
    approvalGates: ['posting public replies'],
  },
  {
    pageId: 'quietly-stone-4158',
    pageLabel: 'Finance Overview',
    sectionLabel: FINANCE_SECTION_LABEL,
    agentName: 'CFO Agent',
    objective: 'Run the finance domain as a whole.',
    autonomy: 'A2',
    jobs: ['summarize finance status', 'rank issues'],
    integrations: ['Finance stack', 'billing', 'revenue systems'],
    successMetrics: ['finance issue resolution speed', 'cash visibility'],
    approvalGates: ['financial execution'],
  },
] as const;
