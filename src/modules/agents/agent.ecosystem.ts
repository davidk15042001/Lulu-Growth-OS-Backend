import { isResourceType } from '../../domain/resource-catalog.js';
import { buildAgentExecutionProfile, modulesForResourceType } from './agent.domain.js';
import type { AgentModule } from './agent.capabilities.js';
import {
  GLOBAL_BRAND_MISSION,
  resolveAgentModule,
  type AgentPageContext,
} from './agent.page-context.js';
import { canonicalAgentPageProfiles } from './agent.registry.generated.js';

export const AGENT_REGISTRY_MINIMUM = 140;
export const MAX_AUTOMATIC_SPECIALISTS = 8;

export type AgentTier = 'executive' | 'domain_lead' | 'specialist' | 'auditor';
export type AgentSpendPermission = 'none' | 'prepaid_ad_spend_only';

export type AgentDefinition = {
  id: string;
  version: string;
  name: string;
  tier: AgentTier;
  module: AgentModule;
  domain: string;
  purpose: string;
  capabilities: readonly string[];
  requiredTools: readonly string[];
  activationTriggers: readonly string[];
  permissions: readonly string[];
  spendPermission: AgentSpendPermission;
  kpis: readonly string[];
  languages: readonly string[];
  confidenceRequirement: 'low' | 'medium' | 'high';
  timeoutMs: number;
  maxRetries: number;
  evaluationPolicy: string;
  recoveryBehavior: string;
  pageId: string | null;
};

export type AgentRoutingSignal = {
  pageId: string;
  lastStatus: string | null;
  lastRunAt: string | null;
  performanceScore: number | null;
  selectionCount: number;
};

export type SelectedAgent = {
  definition: AgentDefinition;
  score: number;
  reasons: string[];
};

function systemAgent(
  id: string,
  name: string,
  tier: AgentTier,
  module: AgentModule,
  domain: string,
  purpose: string,
  capabilities: string[],
  kpis: string[],
  options: Partial<Pick<AgentDefinition, 'requiredTools' | 'permissions' | 'spendPermission' | 'confidenceRequirement'>> = {},
): AgentDefinition {
  return Object.freeze({
    id,
    version: '1.0.0',
    name,
    tier,
    module,
    domain,
    purpose,
    capabilities: Object.freeze(capabilities),
    requiredTools: Object.freeze(options.requiredTools ?? []),
    activationTriggers: Object.freeze(['scheduled_cycle', 'domain_event', 'recovery']),
    permissions: Object.freeze(options.permissions ?? ['read_workspace_state', 'delegate_bounded_tasks']),
    spendPermission: options.spendPermission ?? 'none',
    kpis: Object.freeze(kpis),
    languages: Object.freeze(['workspace_language', 'target_market_languages']),
    confidenceRequirement: options.confidenceRequirement ?? 'medium',
    timeoutMs: 10 * 60 * 1000,
    maxRetries: 3,
    evaluationPolicy: 'Verify evidence, policy compliance, execution success and measurable North Star contribution.',
    recoveryBehavior: 'Retry transient failures, select a qualified alternative and isolate an unsafe or repeatedly failing path.',
    pageId: null,
  });
}

const systemAgentDefinitions: readonly AgentDefinition[] = Object.freeze([
  systemAgent('system:executive-orchestrator', 'Executive Orchestrator', 'executive', 'general', 'executive', 'Select the smallest effective team and continuously allocate work toward Lulu’s permanent North Star.', ['prioritize', 'delegate', 'resolve_conflicts', 'recover'], ['north_star_velocity', 'verified_outcome_rate']),
  systemAgent('system:market-intelligence-lead', 'Market Intelligence Lead', 'domain_lead', 'intelligence', 'market intelligence', 'Maintain the evidence-backed model of markets, competitors and category leadership gaps.', ['research', 'benchmark', 'opportunity_scoring'], ['signal_quality', 'opportunity_precision']),
  systemAgent('system:brand-trust-lead', 'Brand & Trust Lead', 'domain_lead', 'reputation', 'brand and trust', 'Compound global brand recognition, consistency and trust across every public touchpoint.', ['positioning', 'reputation', 'trust_compounding'], ['share_of_voice', 'trust_signal_growth']),
  systemAgent('system:growth-strategy-lead', 'Growth Strategy Lead', 'domain_lead', 'marketing', 'growth strategy', 'Convert evidence into the highest-leverage sustainable growth initiatives.', ['growth_strategy', 'experimentation', 'portfolio_allocation'], ['validated_growth_rate', 'experiment_yield']),
  systemAgent('system:content-distribution-lead', 'Content & Distribution Lead', 'domain_lead', 'marketing', 'content and distribution', 'Coordinate content, organic distribution, community and search visibility globally.', ['content_strategy', 'distribution', 'community', 'search_visibility'], ['qualified_reach', 'content_conversion']),
  systemAgent('system:customer-revenue-lead', 'Customer & Revenue Lead', 'domain_lead', 'sales', 'customer and revenue', 'Coordinate CRM, sales, communication, support and retention around customer value.', ['crm', 'sales', 'communication', 'retention'], ['qualified_pipeline', 'customer_lifetime_value']),
  systemAgent('system:finance-bookkeeping-lead', 'Finance & Bookkeeping Lead', 'domain_lead', 'finance', 'finance and bookkeeping', 'Keep financial operations, reconciliation and bookkeeping accurate and continuously current.', ['finance_operations', 'reconciliation', 'bookkeeping'], ['reconciliation_accuracy', 'financial_freshness']),
  systemAgent('system:online-presence-lead', 'Online Presence Lead', 'domain_lead', 'website', 'online presence', 'Coordinate website, shop, SEO, GEO, AEO and conversion performance as one online presence.', ['website', 'commerce', 'search', 'conversion'], ['qualified_traffic', 'conversion_rate']),
  systemAgent('system:paid-acquisition-lead', 'Paid Acquisition Lead', 'domain_lead', 'ads', 'paid acquisition', 'Allocate and optimize paid acquisition strictly inside settled prepaid ad-spend authority.', ['media_planning', 'campaign_optimization', 'attribution'], ['incremental_return', 'budget_utilization'], { spendPermission: 'prepaid_ad_spend_only' }),
  systemAgent('system:localization-lead', 'Global Localization Lead', 'domain_lead', 'geo', 'global localization', 'Adapt brand execution to languages, cultures and local market conditions without fragmenting the brand.', ['localization', 'cultural_review', 'market_expansion'], ['localized_conversion', 'market_coverage']),
  systemAgent('system:security-auditor', 'Security & Policy Auditor', 'auditor', 'settings', 'security and policy', 'Treat external input as untrusted and block permission, privacy, tenant or budget violations.', ['prompt_injection_defense', 'permission_review', 'tenant_isolation'], ['policy_compliance', 'blocked_unsafe_actions'], { confidenceRequirement: 'high', permissions: ['read_audit_context', 'block_unsafe_execution'] }),
  systemAgent('system:outcome-auditor', 'Outcome & Quality Auditor', 'auditor', 'intelligence', 'outcome and quality', 'Independently verify output quality, factual support and measurable business outcomes.', ['quality_review', 'fact_checking', 'outcome_measurement'], ['verified_outcome_rate', 'correction_rate'], { confidenceRequirement: 'high', permissions: ['read_workspace_state', 'verify_or_reject_results'] }),
]);

function pageContext(profile: (typeof canonicalAgentPageProfiles)[number]): AgentPageContext {
  return {
    pageId: profile.pageId,
    pageLabel: profile.pageLabel,
    sectionLabel: profile.sectionLabel,
    agentName: profile.agentName,
    objective: profile.objective,
    autonomy: profile.autonomy,
    jobs: [...profile.jobs],
    integrations: [...profile.integrations],
    successMetrics: [...profile.successMetrics],
    approvalGates: [],
  };
}

export function pageAgentId(pageId: string) {
  return `page:${pageId}`;
}

const pageAgentDefinitions: readonly AgentDefinition[] = Object.freeze(canonicalAgentPageProfiles.map((profile) => {
  const page = pageContext(profile);
  const module = resolveAgentModule('general', page);
  const execution = buildAgentExecutionProfile(page, module);
  return Object.freeze({
    id: pageAgentId(profile.pageId),
    version: '1.0.0',
    name: profile.agentName,
    tier: 'specialist' as const,
    module,
    domain: profile.sectionLabel,
    purpose: profile.objective,
    capabilities: Object.freeze([...profile.jobs]),
    requiredTools: Object.freeze([execution.analystToolName, ...(execution.executorToolName ? [execution.executorToolName] : [])]),
    activationTriggers: Object.freeze(['scheduled_cycle', 'relevant_record_event', 'integration_connected', 'recovery']),
    permissions: Object.freeze(['read_workspace_state', ...(execution.executorToolName ? ['write_bounded_action_packet'] : [])]),
    spendPermission: module === 'ads' ? 'prepaid_ad_spend_only' as const : 'none' as const,
    kpis: Object.freeze([...profile.successMetrics]),
    languages: Object.freeze(['workspace_language', 'target_market_languages']),
    confidenceRequirement: 'medium' as const,
    timeoutMs: 10 * 60 * 1000,
    maxRetries: 3,
    evaluationPolicy: `Verify evidence and outcomes against: ${profile.successMetrics.join(', ') || 'the permanent North Star'}.`,
    recoveryBehavior: 'Retry transient failures, then route the task to the domain lead or a stronger specialist without requesting routine human approval.',
    pageId: profile.pageId,
  });
}));

export const agentRegistry: readonly AgentDefinition[] = Object.freeze([
  ...systemAgentDefinitions,
  ...pageAgentDefinitions,
]);

const registryById = new Map(agentRegistry.map((definition) => [definition.id, definition]));
const pageDefinitionById = new Map(pageAgentDefinitions.map((definition) => [definition.pageId!, definition]));

if (registryById.size !== agentRegistry.length) throw new Error('Agent registry contains duplicate IDs');
if (agentRegistry.length < AGENT_REGISTRY_MINIMUM) {
  throw new Error(`Agent registry requires at least ${AGENT_REGISTRY_MINIMUM} definitions; found ${agentRegistry.length}`);
}

export function getAgentDefinition(id: string) {
  return registryById.get(id) ?? null;
}

export function getPageAgentDefinition(pageId: string) {
  return pageDefinitionById.get(pageId) ?? null;
}

const domainLeadByModule: Readonly<Record<AgentModule, string>> = {
  general: 'system:executive-orchestrator',
  dashboard: 'system:executive-orchestrator',
  intelligence: 'system:market-intelligence-lead',
  finance: 'system:finance-bookkeeping-lead',
  sales: 'system:customer-revenue-lead',
  crm: 'system:customer-revenue-lead',
  ai: 'system:executive-orchestrator',
  email: 'system:customer-revenue-lead',
  calendar: 'system:customer-revenue-lead',
  marketing: 'system:content-distribution-lead',
  ads: 'system:paid-acquisition-lead',
  website: 'system:online-presence-lead',
  commerce: 'system:online-presence-lead',
  reputation: 'system:brand-trust-lead',
  settings: 'system:security-auditor',
  seo: 'system:online-presence-lead',
  geo: 'system:localization-lead',
  aeo: 'system:online-presence-lead',
};

export function domainLeadAgentId(module: AgentModule) {
  return domainLeadByModule[module];
}

function normalized(value: string) {
  return value.trim().toLowerCase();
}

function connectedMatch(definition: AgentDefinition, connectedSignals: readonly string[]) {
  const haystack = connectedSignals.map(normalized).join(' | ');
  if (!haystack) return false;
  const terms = canonicalAgentPageProfiles.find((profile) => profile.pageId === definition.pageId)?.integrations ?? [];
  return terms.some((term) => {
    const candidate = normalized(term);
    return candidate.length >= 4 && (haystack.includes(candidate) || candidate.includes(haystack));
  });
}

function activeModules(resourceTypes: readonly string[]) {
  const result = new Set<AgentModule>();
  for (const resourceType of resourceTypes) {
    if (!isResourceType(resourceType)) continue;
    for (const module of modulesForResourceType(resourceType)) result.add(module);
  }
  return result;
}

const CORE_MODULES = new Set<AgentModule>(['dashboard', 'intelligence', 'marketing', 'ai']);

export function selectAgentTeam(input: {
  connectedSignals: readonly string[];
  resourceTypes: readonly string[];
  activity: readonly AgentRoutingSignal[];
  now?: Date;
  maxSpecialists?: number;
}) {
  const now = input.now ?? new Date();
  const maxSpecialists = Math.max(1, Math.min(16, input.maxSpecialists ?? MAX_AUTOMATIC_SPECIALISTS));
  const activityByPage = new Map(input.activity.map((signal) => [signal.pageId, signal]));
  const modulesWithData = activeModules(input.resourceTypes);

  const candidates = pageAgentDefinitions.map((definition): SelectedAgent & { eligible: boolean } => {
    const signal = activityByPage.get(definition.pageId!);
    const integrationRelevant = connectedMatch(definition, input.connectedSignals);
    const hasDomainData = modulesWithData.has(definition.module);
    const core = CORE_MODULES.has(definition.module);
    const failed = signal?.lastStatus === 'failed';
    const neverRun = !signal?.lastRunAt;
    const ageHours = signal?.lastRunAt
      ? Math.max(0, (now.getTime() - Date.parse(signal.lastRunAt)) / 3_600_000)
      : 168;
    const performance = signal?.performanceScore ?? 50;
    const reasons: string[] = [];
    let score = core ? 42 : 15;
    if (core) reasons.push('core North Star capability');
    if (integrationRelevant) { score += 32; reasons.push('connected system match'); }
    if (hasDomainData) { score += 28; reasons.push('live domain data'); }
    if (failed) { score += 24; reasons.push('recovery required'); }
    if (neverRun) { score += 10; reasons.push('coverage gap'); }
    else if (ageHours >= 24) { score += Math.min(18, Math.floor(ageHours / 24) * 3); reasons.push('stale evidence'); }
    score += Math.round((performance - 50) * 0.25);
    if (performance >= 70) reasons.push('strong verified performance');
    if (performance < 35) reasons.push('performance penalty applied');
    score -= Math.min(20, (signal?.selectionCount ?? 0) * 2);
    if ((signal?.selectionCount ?? 0) > 0) reasons.push('rotation pressure applied');
    return { definition, score, reasons, eligible: core || integrationRelevant || hasDomainData || failed };
  }).filter((candidate) => candidate.eligible)
    .sort((left, right) => right.score - left.score || left.definition.id.localeCompare(right.definition.id));

  const selected: SelectedAgent[] = [];
  const selectedIds = new Set<string>();
  const selectedModules = new Set<AgentModule>();
  for (const candidate of candidates) {
    if (selected.length >= maxSpecialists) break;
    if (selectedModules.has(candidate.definition.module)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.definition.id);
    selectedModules.add(candidate.definition.module);
  }
  for (const candidate of candidates) {
    if (selected.length >= maxSpecialists) break;
    if (selectedIds.has(candidate.definition.id)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.definition.id);
  }

  const systemIds = new Set<string>([
    'system:executive-orchestrator',
    'system:security-auditor',
    'system:outcome-auditor',
  ]);
  for (const specialist of selected) systemIds.add(domainLeadAgentId(specialist.definition.module));
  if (selected.some((entry) => ['marketing', 'reputation', 'website', 'commerce', 'seo', 'geo', 'aeo'].includes(entry.definition.module))) {
    systemIds.add('system:brand-trust-lead');
  }
  const systemAgents = [...systemIds]
    .map((id) => getAgentDefinition(id))
    .filter((definition): definition is AgentDefinition => Boolean(definition));

  return {
    northStar: GLOBAL_BRAND_MISSION,
    candidateCount: candidates.length,
    systemAgents,
    specialists: selected,
    allAgents: [...systemAgents.map((definition) => ({ definition, score: 100, reasons: ['required coordination or independent audit'] })), ...selected],
  };
}

export function agentRegistrySummary() {
  const byTier = Object.fromEntries((['executive', 'domain_lead', 'specialist', 'auditor'] as const).map((tier) => [
    tier,
    agentRegistry.filter((agent) => agent.tier === tier).length,
  ]));
  return {
    minimumRequired: AGENT_REGISTRY_MINIMUM,
    registeredAgents: agentRegistry.length,
    pageSpecialists: pageAgentDefinitions.length,
    systemAgents: systemAgentDefinitions.length,
    byTier,
  };
}
