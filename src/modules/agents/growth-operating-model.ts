import type { WorkspaceCapability } from '../workspaces/workspace-permissions.js';

export type GrowthAgentId =
  | 'orchestrator' | 'customer_intelligence' | 'market_research' | 'website' | 'seo'
  | 'measurement' | 'google_ads_strategy' | 'search_ads' | 'performance_max'
  | 'display' | 'demand_gen' | 'shopping' | 'lead_generation' | 'offline_conversion'
  | 'budget_bidding' | 'creative' | 'landingpage_cro' | 'business_profile'
  | 'local_services' | 'page_speed' | 'bigquery_data' | 'policy_verification'
  | 'reporting' | 'qa_audit_rollback';

export type GrowthActionClass = 'read' | 'propose' | 'execute' | 'financial' | 'identity';
export type GrowthProviderKey =
  | 'google_ads' | 'google_analytics' | 'google_tag_manager' | 'google_search_console'
  | 'google_pagespeed' | 'google_merchant' | 'google_business' | 'google_local_services'
  | 'bigquery' | 'perplexity' | 'firecrawl' | 'higgsfield' | 'kie';

export type GrowthAgentContract = {
  id: GrowthAgentId;
  name: string;
  purpose: string;
  allowedActions: readonly GrowthActionClass[];
  requiredCapabilities: readonly WorkspaceCapability[];
  allowedProviders: readonly GrowthProviderKey[];
  approvalRequiredFor: readonly GrowthActionClass[];
  minimumConfidence: 'low' | 'medium' | 'high';
};

const readOnly: readonly GrowthActionClass[] = ['read', 'propose'];
const governedWrite: readonly GrowthActionClass[] = ['read', 'propose', 'execute'];
const marketingWrite: readonly GrowthActionClass[] = ['read', 'propose', 'execute', 'financial'];

const contract = (
  id: GrowthAgentId,
  name: string,
  purpose: string,
  allowedActions: readonly GrowthActionClass[],
  allowedProviders: readonly GrowthProviderKey[],
  requiredCapabilities: readonly WorkspaceCapability[] = ['agents.execute'],
  approvalRequiredFor: readonly GrowthActionClass[] = ['execute'],
  minimumConfidence: GrowthAgentContract['minimumConfidence'] = 'medium',
): GrowthAgentContract => Object.freeze({
  id, name, purpose, allowedActions, allowedProviders, requiredCapabilities,
  approvalRequiredFor, minimumConfidence,
});

/**
 * This is a policy registry, not proof that a provider is connected. Runtime
 * provider readiness is still checked by the Provider Control Plane before any
 * external side effect.
 */
export const GROWTH_AGENT_CONTRACTS: readonly GrowthAgentContract[] = Object.freeze([
  contract('orchestrator', 'Orchestrator Agent', 'Coordinate bounded, tenant-scoped work and prevent conflicting mutations.', governedWrite, []),
  contract('customer_intelligence', 'Customer Intelligence Agent', 'Maintain the evidence-backed ICP, products, markets and buyer context.', readOnly, ['perplexity', 'firecrawl', 'google_search_console']),
  contract('market_research', 'Market Research Agent', 'Research demand, competitors, trends and market opportunities with citations.', readOnly, ['perplexity', 'firecrawl', 'google_search_console']),
  contract('website', 'Website Agent', 'Create and improve customer websites, landing pages and technical metadata.', governedWrite, ['firecrawl', 'google_analytics', 'google_tag_manager', 'google_search_console', 'google_pagespeed'], ['agents.execute', 'website.manage'], ['execute', 'identity'], 'high'),
  contract('seo', 'SEO Agent', 'Monitor indexation, technical SEO, search demand and organic visibility.', readOnly, ['google_search_console', 'google_pagespeed', 'firecrawl']),
  contract('measurement', 'Tracking & Measurement Agent', 'Validate GA4, GTM, conversion, consent and offline measurement quality.', governedWrite, ['google_analytics', 'google_tag_manager', 'google_ads', 'bigquery'], ['agents.execute', 'quality.review'], ['execute', 'identity'], 'high'),
  contract('google_ads_strategy', 'Google Ads Strategy Agent', 'Plan profitable channel, funnel and budget strategy.', readOnly, ['google_ads', 'google_analytics', 'bigquery']),
  contract('search_ads', 'Search Ads Agent', 'Manage search intent, keywords, search terms, ads and exclusions.', marketingWrite, ['google_ads', 'google_analytics'], ['agents.execute', 'advertising.manage'], ['execute', 'financial'], 'high'),
  contract('performance_max', 'Performance Max Agent', 'Evaluate and optimize PMax assets, products and conversion objectives.', marketingWrite, ['google_ads', 'google_merchant', 'google_analytics'], ['agents.execute', 'advertising.manage'], ['execute', 'financial'], 'high'),
  contract('display', 'Display Agent', 'Manage display audiences, placements, exclusions and brand safety.', marketingWrite, ['google_ads', 'google_analytics'], ['agents.execute', 'advertising.manage'], ['execute', 'financial'], 'high'),
  contract('demand_gen', 'Demand Gen Agent', 'Plan visual demand-generation campaigns and qualified follow-up actions.', marketingWrite, ['google_ads', 'google_analytics', 'higgsfield', 'kie'], ['agents.execute', 'advertising.manage'], ['execute', 'financial'], 'high'),
  contract('shopping', 'Shopping Agent', 'Manage product data, Merchant diagnostics and profitable Shopping distribution.', marketingWrite, ['google_merchant', 'google_ads', 'google_analytics'], ['agents.execute', 'advertising.manage', 'products.update'], ['execute', 'financial'], 'high'),
  contract('lead_generation', 'Lead Generation Agent', 'Validate, deduplicate and route leads through the customer funnel.', governedWrite, ['google_ads', 'google_analytics', 'bigquery'], ['agents.execute', 'leads.manage'], ['execute'], 'high'),
  contract('offline_conversion', 'Offline Conversion Agent', 'Import verified qualified leads, opportunities, orders and revenue.', governedWrite, ['google_ads', 'google_analytics', 'bigquery'], ['agents.execute', 'finance.manage'], ['execute', 'identity'], 'high'),
  contract('budget_bidding', 'Budget & Bidding Agent', 'Recommend bounded budget and bidding changes based on profit and data sufficiency.', marketingWrite, ['google_ads', 'google_analytics', 'bigquery'], ['agents.execute', 'advertising.manage', 'finance.read'], ['execute', 'financial'], 'high'),
  contract('creative', 'Creative Agent', 'Create evidence-backed multilingual ad and media variants without unsupported claims.', governedWrite, ['google_ads', 'perplexity', 'firecrawl', 'higgsfield', 'kie'], ['agents.execute', 'quality.review'], ['execute'], 'high'),
  contract('landingpage_cro', 'Landing Page CRO Agent', 'Improve qualified conversion rate through measured, reversible experiments.', governedWrite, ['google_analytics', 'google_search_console', 'google_pagespeed', 'firecrawl'], ['agents.execute', 'website.manage', 'quality.review'], ['execute'], 'high'),
  contract('business_profile', 'Business Profile Agent', 'Maintain verified business data, locations and review workflows.', governedWrite, ['google_business'], ['agents.execute', 'providers.manage'], ['execute', 'identity'], 'high'),
  contract('local_services', 'Local Services Agent', 'Manage eligible local lead acquisition and qualification.', marketingWrite, ['google_local_services', 'google_business', 'google_analytics'], ['agents.execute', 'advertising.manage'], ['execute', 'financial'], 'high'),
  contract('page_speed', 'Page Speed Agent', 'Prioritize performance improvements by conversion impact and Core Web Vitals.', readOnly, ['google_pagespeed', 'google_analytics']),
  contract('bigquery_data', 'BigQuery Data Agent', 'Unify historical marketing, CRM, sales and profit data without tenant leakage.', readOnly, ['bigquery', 'google_analytics', 'google_ads', 'google_search_console'], ['agents.execute', 'finance.read', 'quality.review'], ['execute'], 'high'),
  contract('policy_verification', 'Policy & Verification Agent', 'Block identity, policy, privacy and authorization violations.', readOnly, ['google_ads', 'google_business', 'google_merchant'], ['agents.execute', 'quality.override'], ['execute', 'identity'], 'high'),
  contract('reporting', 'Reporting Agent', 'Produce tenant-isolated reports distinguishing measured, modeled and estimated data.', readOnly, ['google_ads', 'google_analytics', 'google_search_console', 'bigquery', 'google_business']),
  contract('qa_audit_rollback', 'QA, Audit & Rollback Agent', 'Validate changes, preserve snapshots and reverse unsafe mutations.', governedWrite, ['google_ads', 'google_analytics', 'google_tag_manager', 'google_merchant', 'google_business'], ['agents.execute', 'quality.review', 'quality.repair'], ['execute'], 'high'),
]);

const byId = new Map(GROWTH_AGENT_CONTRACTS.map((item) => [item.id, item]));
if (byId.size !== GROWTH_AGENT_CONTRACTS.length) throw new Error('Growth agent contracts contain duplicate IDs');

export function getGrowthAgentContract(agentId: string) {
  return byId.get(agentId as GrowthAgentId) ?? null;
}

export function canGrowthAgentUseProvider(agentId: string, providerKey: string) {
  const agent = getGrowthAgentContract(agentId);
  return Boolean(agent?.allowedProviders.includes(providerKey as GrowthProviderKey));
}

export function growthActionRequiresApproval(agentId: string, action: GrowthActionClass) {
  const agent = getGrowthAgentContract(agentId);
  return agent ? agent.approvalRequiredFor.includes(action) : true;
}

export function growthAgentContractSummary() {
  return GROWTH_AGENT_CONTRACTS.map(({ id, name, allowedActions, allowedProviders, minimumConfidence }) => ({
    id, name, allowedActions: [...allowedActions], allowedProviders: [...allowedProviders], minimumConfidence,
  }));
}
