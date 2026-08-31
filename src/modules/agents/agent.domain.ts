import type { ResourceType } from '../../domain/resource-catalog.js';
import type { AgentPageContext } from './agent.page-context.js';
import type { AgentModule } from './agent.capabilities.js';

export type AgentExecutionProfile = {
  module: AgentModule;
  analystToolName: string;
  executorToolName: string | null;
  actionResourceType: ResourceType | null;
  resourceTypes: ResourceType[];
  telemetryTags: string[];
  plannerInstruction: string;
  strategistInstruction: string;
  executorInstruction: string | null;
  reviewerInstruction: string;
};

const DEFAULT_RESOURCE_TYPES: readonly ResourceType[] = [
  'activities',
  'opportunities',
  'reports',
  'forecasts',
  'trends',
  'comparisons',
  'benchmarks',
  'anomalies',
  'decisions',
  'risk_items',
  'growth_opportunities',
  'intelligence_signals',
  'kpis',
];

const RESOURCE_TYPES_BY_MODULE: Readonly<Record<AgentModule, readonly ResourceType[]>> = {
  general: DEFAULT_RESOURCE_TYPES,
  dashboard: DEFAULT_RESOURCE_TYPES,
  intelligence: [
    'activities',
    'reports',
    'forecasts',
    'trends',
    'comparisons',
    'benchmarks',
    'anomalies',
    'decisions',
    'risk_items',
    'growth_opportunities',
    'intelligence_signals',
    'kpis',
  ],
  finance: [
    'finance_accounts',
    'finance_budgets',
    'finance_cashflow',
    'finance_customers',
    'finance_expenses',
    'finance_settings',
    'finance_automations',
    'finance_plans',
    'finance_income',
    'finance_invoices',
    'finance_quotes',
    'finance_payments',
    'finance_payouts',
    'finance_reconciliations',
    'finance_recurring_revenue',
    'finance_taxes',
    'finance_transactions',
    'finance_vendors',
  ],
  sales: [
    'sales_activities',
    'sales_commissions',
    'sales_segments',
    'sales_deals',
    'sales_forecasts',
    'sales_lead_assignments',
    'sales_leads',
    'sales_opportunities',
    'sales_goals',
    'sales_reports',
    'sales_settings',
    'sales_tasks',
    'sales_territories',
  ],
  crm: [
    'crm_activities',
    'crm_companies',
    'crm_contacts',
    'crm_customer_insights',
    'crm_segments',
    'crm_deals',
    'crm_leads',
    'crm_pipeline_stages',
    'crm_tasks',
  ],
  ai: [
    'ai_actions',
    'ai_activity',
    'ai_agents',
    'ai_conversations',
    'ai_insights',
    'ai_knowledge',
    'ai_recommendations',
    'ai_tasks',
    'ai_optimizations',
  ],
  email: [],
  calendar: [],
  marketing: [
    'marketing_audiences',
    'marketing_campaigns',
    'marketing_competitors',
    'marketing_content',
    'marketing_geo_items',
    'marketing_keywords',
    'marketing_seo_items',
    'marketing_aeo_items',
    'marketing_strategies',
    'marketing_publications',
  ],
  ads: [
    'ad_accounts',
    'ad_campaigns',
    'ad_experiments',
    'ad_optimizations',
    'ad_audiences',
    'ad_budgets',
    'ad_creatives',
    'ad_approvals',
    'ad_attributions',
  ],
  website: [
    'marketing_seo_items',
    'marketing_geo_items',
    'marketing_aeo_items',
    'marketing_content',
    'marketing_publications',
  ],
  commerce: [
    'ecommerce_carts',
    'ecommerce_categories',
    'ecommerce_customers',
    'ecommerce_discounts',
    'ecommerce_inventory',
    'ecommerce_orders',
    'ecommerce_payments',
    'ecommerce_returns',
    'ecommerce_reviews',
    'ecommerce_shipping',
    'ecommerce_collections',
    'ecommerce_coupons',
    'ecommerce_products',
    'ecommerce_stores',
    'ecommerce_subscriptions',
    'ecommerce_taxes',
  ],
  reputation: ['ecommerce_reviews'],
  settings: ['activities', 'reports', 'ai_agents'],
  seo: ['marketing_keywords', 'marketing_seo_items', 'marketing_content', 'marketing_publications'],
  geo: ['marketing_geo_items', 'marketing_competitors', 'marketing_content', 'marketing_publications'],
  aeo: ['marketing_aeo_items', 'marketing_content', 'marketing_publications'],
};

const ANALYST_TOOL_BY_MODULE: Readonly<Record<AgentModule, string>> = {
  general: 'workspace_intelligence_snapshot',
  dashboard: 'workspace_intelligence_snapshot',
  intelligence: 'workspace_intelligence_snapshot',
  finance: 'record_resource_snapshot',
  sales: 'record_resource_snapshot',
  crm: 'record_resource_snapshot',
  ai: 'ai_workspace_snapshot',
  email: 'email_operations_snapshot',
  calendar: 'calendar_operations_snapshot',
  marketing: 'record_resource_snapshot',
  ads: 'record_resource_snapshot',
  website: 'website_operations_snapshot',
  commerce: 'record_resource_snapshot',
  reputation: 'reputation_snapshot',
  settings: 'workspace_intelligence_snapshot',
  seo: 'website_operations_snapshot',
  geo: 'website_operations_snapshot',
  aeo: 'website_operations_snapshot',
};

const ACTION_RESOURCE_BY_MODULE: Readonly<Record<AgentModule, ResourceType | null>> = {
  general: 'ai_actions',
  dashboard: 'ai_actions',
  intelligence: 'ai_actions',
  finance: 'finance_automations',
  sales: 'sales_tasks',
  crm: 'crm_tasks',
  ai: 'ai_actions',
  email: 'ai_tasks',
  calendar: 'ai_tasks',
  marketing: 'marketing_campaigns',
  ads: 'ad_optimizations',
  website: 'marketing_publications',
  commerce: 'ai_actions',
  reputation: 'ai_actions',
  settings: 'ai_actions',
  seo: 'marketing_seo_items',
  geo: 'marketing_geo_items',
  aeo: 'marketing_aeo_items',
};

function normalize(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? '';
}

function pageText(page: AgentPageContext | null) {
  return {
    id: normalize(page?.pageId),
    label: normalize(page?.pageLabel),
    section: normalize(page?.sectionLabel),
  };
}

function uniqueResourceTypes(values: readonly ResourceType[]) {
  return [...new Set(values)] as ResourceType[];
}

function pageSpecificResourceTypes(page: AgentPageContext | null, module: AgentModule) {
  if (!page) return [...RESOURCE_TYPES_BY_MODULE[module]];
  const text = pageText(page);
  const matches: ResourceType[] = [];
  const add = (...resourceTypes: ResourceType[]) => {
    matches.push(...resourceTypes);
  };

  if (module === 'crm') {
    if (text.label.includes('contact')) add('crm_contacts');
    if (text.label.includes('company') || text.label.includes('account')) add('crm_companies');
    if (text.label.includes('lead')) add('crm_leads');
    if (text.label.includes('deal')) add('crm_deals');
    if (text.label.includes('pipeline')) add('crm_pipeline_stages', 'crm_deals');
    if (text.label.includes('activity')) add('crm_activities');
    if (text.label.includes('task')) add('crm_tasks');
    if (text.label.includes('segment')) add('crm_segments');
    if (text.label.includes('intelligence') || text.label.includes('customer')) add('crm_customer_insights', 'crm_contacts', 'crm_companies');
  }

  if (module === 'sales') {
    if (text.label.includes('lead routing') || text.label.includes('routing')) add('sales_lead_assignments', 'sales_leads');
    if (text.label.includes('lead')) add('sales_leads');
    if (text.label.includes('opportun')) add('sales_opportunities');
    if (text.label.includes('deal')) add('sales_deals');
    if (text.label.includes('pipeline')) add('sales_deals', 'sales_opportunities');
    if (text.label.includes('activity')) add('sales_activities');
    if (text.label.includes('task')) add('sales_tasks');
    if (text.label.includes('segment')) add('sales_segments');
    if (text.label.includes('forecast')) add('sales_forecasts');
    if (text.label.includes('report')) add('sales_reports');
    if (text.label.includes('commission')) add('sales_commissions');
    if (text.label.includes('goal')) add('sales_goals');
    if (text.label.includes('territory')) add('sales_territories');
  }

  if (module === 'finance') {
    if (text.label.includes('invoice')) add('finance_invoices');
    if (text.label.includes('quote') || text.label.includes('offer')) add('finance_quotes');
    if (text.label.includes('income') || text.label.includes('revenue')) add('finance_income', 'finance_recurring_revenue');
    if (text.label.includes('transaction')) add('finance_transactions');
    if (text.label.includes('payment')) add('finance_payments');
    if (text.label.includes('expense')) add('finance_expenses');
    if (text.label.includes('debtor')) add('finance_invoices', 'finance_customers');
    if (text.label.includes('creditor') || text.label.includes('vendor')) add('finance_vendors');
    if (text.label.includes('account')) add('finance_accounts');
    if (text.label.includes('cash')) add('finance_cashflow');
    if (text.label.includes('budget')) add('finance_budgets');
    if (text.label.includes('planning') || text.label.includes('plan')) add('finance_plans');
    if (text.label.includes('reconciliation')) add('finance_reconciliations');
    if (text.label.includes('payout')) add('finance_payouts');
    if (text.label.includes('automation')) add('finance_automations');
    if (text.label.includes('tax')) add('finance_taxes');
    if (text.label.includes('config')) add('finance_settings');
  }

  if (module === 'marketing' || module === 'seo' || module === 'geo' || module === 'aeo') {
    if (text.label.includes('campaign')) add('marketing_campaigns');
    if (text.label.includes('content') || text.label.includes('publishing')) add('marketing_content', 'marketing_publications');
    if (text.label.includes('strategy')) add('marketing_strategies');
    if (text.label.includes('keyword')) add('marketing_keywords');
    if (text.label.includes('competitor')) add('marketing_competitors');
    if (text.label.includes('audience')) add('marketing_audiences');
    if (text.label.includes('seo') || module === 'seo') add('marketing_keywords', 'marketing_seo_items');
    if (text.label.includes('geo') || module === 'geo') add('marketing_geo_items');
    if (text.label.includes('aeo') || module === 'aeo') add('marketing_aeo_items');
  }

  if (module === 'ads') {
    if (text.label.includes('campaign')) add('ad_campaigns');
    if (text.label.includes('creative')) add('ad_creatives');
    if (text.label.includes('budget')) add('ad_budgets');
    if (text.label.includes('optimiz')) add('ad_optimizations');
    if (text.label.includes('builder')) add('ad_campaigns', 'ad_creatives', 'ad_audiences');
    if (text.label.includes('approv')) add('ad_approvals');
    if (text.label.includes('experiment')) add('ad_experiments');
    if (text.label.includes('measure') || text.label.includes('attribution')) add('ad_attributions');
    if (text.label.includes('audience')) add('ad_audiences');
    if (text.label.includes('platform')) add('ad_accounts');
  }

  if (module === 'commerce') {
    if (text.label.includes('store')) add('ecommerce_stores');
    if (text.label.includes('product')) add('ecommerce_products');
    if (text.label.includes('category')) add('ecommerce_categories');
    if (text.label.includes('order')) add('ecommerce_orders');
    if (text.label.includes('customer')) add('ecommerce_customers');
    if (text.label.includes('cart')) add('ecommerce_carts');
    if (text.label.includes('inventory')) add('ecommerce_inventory');
    if (text.label.includes('return')) add('ecommerce_returns');
    if (text.label.includes('promo') || text.label.includes('discount')) add('ecommerce_discounts');
    if (text.label.includes('recovery')) add('ecommerce_carts');
    if (text.label.includes('shipping') || text.label.includes('fulfillment')) add('ecommerce_shipping');
    if (text.label.includes('payment')) add('ecommerce_payments');
    if (text.label.includes('coupon')) add('ecommerce_coupons');
    if (text.label.includes('subscription')) add('ecommerce_subscriptions');
    if (text.label.includes('tax')) add('ecommerce_taxes');
    if (text.label.includes('merch')) add('ecommerce_collections', 'ecommerce_products');
    if (text.label.includes('performance')) add('ecommerce_orders', 'ecommerce_carts', 'ecommerce_payments');
  }

  if (module === 'ai') {
    if (text.label.includes('agent manager')) add('ai_agents');
    if (text.label.includes('capability')) add('ai_recommendations', 'ai_optimizations');
    if (text.label.includes('knowledge')) add('ai_knowledge');
    if (text.label.includes('action')) add('ai_actions');
    if (text.label.includes('conversation')) add('ai_conversations');
    if (text.label.includes('audit')) add('ai_activity');
  }

  if (module === 'dashboard' || module === 'intelligence' || module === 'general' || module === 'settings') {
    if (text.label.includes('kpi')) add('kpis');
    if (text.label.includes('forecast')) add('forecasts');
    if (text.label.includes('benchmark')) add('benchmarks');
    if (text.label.includes('comparison')) add('comparisons');
    if (text.label.includes('trend')) add('trends');
    if (text.label.includes('anomaly')) add('anomalies');
    if (text.label.includes('decision')) add('decisions');
    if (text.label.includes('risk')) add('risk_items');
    if (text.label.includes('opportunity')) add('growth_opportunities', 'opportunities');
  }

  if (module === 'reputation') {
    add('ecommerce_reviews');
  }

  return uniqueResourceTypes(matches.length > 0 ? matches : RESOURCE_TYPES_BY_MODULE[module]);
}

function plannerInstruction(page: AgentPageContext | null, module: AgentModule, resourceTypes: readonly ResourceType[]) {
  const pageContext = page
    ? `${page.agentName ?? page.pageLabel} on page ${page.pageLabel} in ${page.sectionLabel}. Jobs: ${page.jobs.join(', ') || 'none listed'}.`
    : 'No page-specific context was provided.';
  return [
    `Plan this run as the backend specialist for module "${module}".`,
    pageContext,
    `Base the analysis on the connected workspace state and the most relevant records: ${resourceTypes.join(', ') || 'none'}.`,
    'Prefer concrete operational signals, bottlenecks, overdue items, mismatches, and the next high-value actions.',
  ].join(' ');
}

function strategistInstruction(page: AgentPageContext | null, module: AgentModule) {
  const approvalGates = page?.approvalGates.join(', ') || 'none listed';
  return [
    `Convert the gathered evidence into a page-aware action plan for module "${module}".`,
    `Respect these approval gates: ${approvalGates}.`,
    'Separate immediate fixes, medium-term improvements, blocked items, and missing data needed for stronger automation.',
  ].join(' ');
}

function executorInstruction(page: AgentPageContext | null, module: AgentModule, actionResourceType: ResourceType | null) {
  if (!actionResourceType) return null;
  const pageName = page?.pageLabel ?? 'this page';
  const approvalGates = page?.approvalGates.join(', ') || 'none listed';
  return [
    `Prepare the next approved backend action packet for module "${module}" on ${pageName}.`,
    `Write the action into "${actionResourceType}" so downstream automation has a concrete execution record.`,
    `Respect these approval gates: ${approvalGates}.`,
    'Keep the action concise, operational, and traceable to the live evidence gathered in this run.',
  ].join(' ');
}

function reviewerInstruction(page: AgentPageContext | null, module: AgentModule) {
  const successMetrics = page?.successMetrics.join(', ') || 'none listed';
  return [
    `Review the result like the final quality gate for module "${module}".`,
    `Check whether the proposed outcome is traceable to evidence and aligned with these success metrics: ${successMetrics}.`,
    'Call out missing live data, uncertainty, approval requirements, and execution blockers explicitly.',
  ].join(' ');
}

export function buildAgentExecutionProfile(page: AgentPageContext | null, module: AgentModule): AgentExecutionProfile {
  const resourceTypes = pageSpecificResourceTypes(page, module);
  const actionResourceType = ACTION_RESOURCE_BY_MODULE[module];
  return {
    module,
    analystToolName: ANALYST_TOOL_BY_MODULE[module],
    executorToolName: actionResourceType ? 'page_action_writeback' : null,
    actionResourceType,
    resourceTypes,
    telemetryTags: uniqueResourceTypes(resourceTypes).slice(0, 6),
    plannerInstruction: plannerInstruction(page, module, resourceTypes),
    strategistInstruction: strategistInstruction(page, module),
    executorInstruction: executorInstruction(page, module, actionResourceType),
    reviewerInstruction: reviewerInstruction(page, module),
  };
}
