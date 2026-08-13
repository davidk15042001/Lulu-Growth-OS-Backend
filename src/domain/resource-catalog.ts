export const RESOURCE_DOMAINS = [
  'core',
  'crm',
  'sales',
  'marketing',
  'advertising',
  'ecommerce',
  'finance',
  'intelligence',
  'ai',
] as const;

export type ResourceDomain = (typeof RESOURCE_DOMAINS)[number];

export type ResourceDefinition = {
  key: string;
  domain: ResourceDomain;
  label: string;
  description: string;
};

export const RESOURCE_CATALOG = [
  { key: 'activities', domain: 'core', label: 'Activities', description: 'Workspace-wide activity timeline entries.' },
  { key: 'customers', domain: 'core', label: 'Customers', description: 'Cross-domain customer records.' },
  { key: 'opportunities', domain: 'core', label: 'Opportunities', description: 'Business growth opportunities.' },
  { key: 'reports', domain: 'core', label: 'Reports', description: 'Saved reports and report configurations.' },
  { key: 'forecasts', domain: 'core', label: 'Forecasts', description: 'Cross-domain forecast records.' },
  { key: 'trends', domain: 'core', label: 'Trends', description: 'Detected business trends.' },
  { key: 'comparisons', domain: 'core', label: 'Comparisons', description: 'Saved performance comparisons.' },
  { key: 'benchmarks', domain: 'core', label: 'Benchmarks', description: 'Internal and external benchmark records.' },
  { key: 'anomalies', domain: 'core', label: 'Anomalies', description: 'Detected anomalous business signals.' },
  { key: 'decisions', domain: 'core', label: 'Decisions', description: 'Documented business decisions.' },
  { key: 'risk_items', domain: 'core', label: 'Risk Items', description: 'Business and operational risks.' },

  { key: 'crm_activities', domain: 'crm', label: 'CRM Activities', description: 'Calls, meetings, notes and messages.' },
  { key: 'crm_companies', domain: 'crm', label: 'CRM Companies', description: 'Account and company records.' },
  { key: 'crm_contacts', domain: 'crm', label: 'CRM Contacts', description: 'People and contact records.' },
  { key: 'crm_customer_insights', domain: 'crm', label: 'Customer Insights', description: 'Customer intelligence observations.' },
  { key: 'crm_segments', domain: 'crm', label: 'CRM Segments', description: 'Saved customer segments.' },
  { key: 'crm_deals', domain: 'crm', label: 'CRM Deals', description: 'Commercial deal records.' },
  { key: 'crm_leads', domain: 'crm', label: 'CRM Leads', description: 'CRM lead records.' },
  { key: 'crm_pipeline_stages', domain: 'crm', label: 'CRM Pipeline Stages', description: 'Pipeline stage configuration.' },
  { key: 'crm_tasks', domain: 'crm', label: 'CRM Tasks', description: 'CRM-related tasks.' },

  { key: 'sales_activities', domain: 'sales', label: 'Sales Activities', description: 'Sales calls, meetings and outreach.' },
  { key: 'sales_commissions', domain: 'sales', label: 'Sales Commissions', description: 'Commission plans and results.' },
  { key: 'sales_segments', domain: 'sales', label: 'Sales Segments', description: 'Sales customer segments.' },
  { key: 'sales_deals', domain: 'sales', label: 'Sales Deals', description: 'Sales deal records.' },
  { key: 'sales_forecasts', domain: 'sales', label: 'Sales Forecasts', description: 'Sales forecast records.' },
  { key: 'sales_lead_assignments', domain: 'sales', label: 'Lead Assignments', description: 'Lead ownership and routing.' },
  { key: 'sales_leads', domain: 'sales', label: 'Sales Leads', description: 'Sales lead records.' },
  { key: 'sales_opportunities', domain: 'sales', label: 'Sales Opportunities', description: 'Qualified sales opportunities.' },
  { key: 'sales_goals', domain: 'sales', label: 'Sales Goals', description: 'Sales targets and goals.' },
  { key: 'sales_reports', domain: 'sales', label: 'Sales Reports', description: 'Saved sales reports.' },
  { key: 'sales_settings', domain: 'sales', label: 'Sales Settings', description: 'Sales module configuration.' },
  { key: 'sales_tasks', domain: 'sales', label: 'Sales Tasks', description: 'Sales team tasks.' },
  { key: 'sales_territories', domain: 'sales', label: 'Sales Territories', description: 'Territory definitions and assignments.' },

  { key: 'marketing_audiences', domain: 'marketing', label: 'Marketing Audiences', description: 'Marketing audience definitions.' },
  { key: 'marketing_campaigns', domain: 'marketing', label: 'Marketing Campaigns', description: 'Marketing campaign records.' },
  { key: 'marketing_competitors', domain: 'marketing', label: 'Competitors', description: 'Competitor profiles and monitoring.' },
  { key: 'marketing_content', domain: 'marketing', label: 'Marketing Content', description: 'Content assets and briefs.' },
  { key: 'marketing_geo_items', domain: 'marketing', label: 'GEO Items', description: 'Generative engine optimization work.' },
  { key: 'marketing_keywords', domain: 'marketing', label: 'Keywords', description: 'Keyword research and tracking.' },
  { key: 'marketing_seo_items', domain: 'marketing', label: 'SEO Items', description: 'Search engine optimization work.' },
  { key: 'marketing_aeo_items', domain: 'marketing', label: 'AEO Items', description: 'Answer engine optimization work.' },
  { key: 'marketing_strategies', domain: 'marketing', label: 'Marketing Strategies', description: 'Marketing strategy records.' },
  { key: 'marketing_publications', domain: 'marketing', label: 'Publications', description: 'Publishing and approval records.' },

  { key: 'ad_accounts', domain: 'advertising', label: 'Ad Accounts', description: 'Advertising platform accounts.' },
  { key: 'ad_campaigns', domain: 'advertising', label: 'Ad Campaigns', description: 'Advertising campaign records.' },
  { key: 'ad_experiments', domain: 'advertising', label: 'Ad Experiments', description: 'Advertising A/B tests.' },
  { key: 'ad_optimizations', domain: 'advertising', label: 'Ad Optimizations', description: 'Optimization recommendations and actions.' },
  { key: 'ad_audiences', domain: 'advertising', label: 'Ad Audiences', description: 'Advertising audience definitions.' },
  { key: 'ad_budgets', domain: 'advertising', label: 'Ad Budgets', description: 'Advertising budget records.' },
  { key: 'ad_creatives', domain: 'advertising', label: 'Ad Creatives', description: 'Advertising creative assets.' },
  { key: 'ad_approvals', domain: 'advertising', label: 'Ad Approvals', description: 'Advertising publishing approvals.' },
  { key: 'ad_attributions', domain: 'advertising', label: 'Ad Attributions', description: 'Advertising tracking and attribution.' },

  { key: 'ecommerce_carts', domain: 'ecommerce', label: 'Carts', description: 'Active and abandoned ecommerce carts.' },
  { key: 'ecommerce_categories', domain: 'ecommerce', label: 'Categories', description: 'Product category records.' },
  { key: 'ecommerce_customers', domain: 'ecommerce', label: 'Ecommerce Customers', description: 'Ecommerce customer records.' },
  { key: 'ecommerce_discounts', domain: 'ecommerce', label: 'Discounts', description: 'Discount and promotion records.' },
  { key: 'ecommerce_inventory', domain: 'ecommerce', label: 'Inventory', description: 'Inventory items and stock state.' },
  { key: 'ecommerce_orders', domain: 'ecommerce', label: 'Orders', description: 'Ecommerce order records.' },
  { key: 'ecommerce_payments', domain: 'ecommerce', label: 'Ecommerce Payments', description: 'Ecommerce payment records.' },
  { key: 'ecommerce_returns', domain: 'ecommerce', label: 'Returns', description: 'Return and refund records.' },
  { key: 'ecommerce_reviews', domain: 'ecommerce', label: 'Reviews', description: 'Product and store reviews.' },
  { key: 'ecommerce_shipping', domain: 'ecommerce', label: 'Shipping', description: 'Shipping and fulfillment records.' },
  { key: 'ecommerce_collections', domain: 'ecommerce', label: 'Collections', description: 'Product collection records.' },
  { key: 'ecommerce_coupons', domain: 'ecommerce', label: 'Coupons', description: 'Coupon records.' },
  { key: 'ecommerce_products', domain: 'ecommerce', label: 'Products', description: 'Ecommerce product records.' },
  { key: 'ecommerce_stores', domain: 'ecommerce', label: 'Stores', description: 'Store and storefront records.' },
  { key: 'ecommerce_subscriptions', domain: 'ecommerce', label: 'Subscriptions', description: 'Commerce subscription records.' },
  { key: 'ecommerce_taxes', domain: 'ecommerce', label: 'Ecommerce Taxes', description: 'Ecommerce tax configuration and records.' },

  { key: 'finance_accounts', domain: 'finance', label: 'Finance Accounts', description: 'Financial account records.' },
  { key: 'finance_budgets', domain: 'finance', label: 'Finance Budgets', description: 'Financial budgets.' },
  { key: 'finance_cashflow', domain: 'finance', label: 'Cash Flow', description: 'Cash flow entries and projections.' },
  { key: 'finance_customers', domain: 'finance', label: 'Finance Customers', description: 'Billing customer records.' },
  { key: 'finance_expenses', domain: 'finance', label: 'Expenses', description: 'Expense records.' },
  { key: 'finance_settings', domain: 'finance', label: 'Finance Settings', description: 'Finance module configuration.' },
  { key: 'finance_automations', domain: 'finance', label: 'Financial Automations', description: 'Financial automation rules.' },
  { key: 'finance_plans', domain: 'finance', label: 'Financial Plans', description: 'Financial planning records.' },
  { key: 'finance_income', domain: 'finance', label: 'Income', description: 'Income records.' },
  { key: 'finance_invoices', domain: 'finance', label: 'Invoices', description: 'Invoice records.' },
  { key: 'finance_quotes', domain: 'finance', label: 'Offers and Quotes', description: 'Offer and quote records.' },
  { key: 'finance_payments', domain: 'finance', label: 'Finance Payments', description: 'Financial payment records.' },
  { key: 'finance_payouts', domain: 'finance', label: 'Payouts', description: 'Payout records.' },
  { key: 'finance_reconciliations', domain: 'finance', label: 'Reconciliations', description: 'Reconciliation runs and results.' },
  { key: 'finance_recurring_revenue', domain: 'finance', label: 'Recurring Revenue', description: 'Recurring revenue records.' },
  { key: 'finance_taxes', domain: 'finance', label: 'Finance Taxes', description: 'Finance tax records.' },
  { key: 'finance_transactions', domain: 'finance', label: 'Transactions', description: 'Financial transactions.' },
  { key: 'finance_vendors', domain: 'finance', label: 'Vendors', description: 'Vendor records.' },

  { key: 'intelligence_signals', domain: 'intelligence', label: 'Intelligence Signals', description: 'Business intelligence observations.' },
  { key: 'kpis', domain: 'intelligence', label: 'KPIs', description: 'Key performance indicator definitions.' },
  { key: 'growth_opportunities', domain: 'intelligence', label: 'Growth Opportunities', description: 'Intelligence-driven growth opportunities.' },

  { key: 'ai_actions', domain: 'ai', label: 'AI Actions', description: 'AI-proposed and executed actions.' },
  { key: 'ai_activity', domain: 'ai', label: 'AI Activity', description: 'AI activity log entries.' },
  { key: 'ai_agents', domain: 'ai', label: 'AI Agents', description: 'Configured AI agents.' },
  { key: 'ai_conversations', domain: 'ai', label: 'AI Conversations', description: 'AI assistant conversations.' },
  { key: 'ai_insights', domain: 'ai', label: 'AI Insights', description: 'AI-generated insights.' },
  { key: 'ai_knowledge', domain: 'ai', label: 'AI Knowledge', description: 'AI knowledge sources and documents.' },
  { key: 'ai_recommendations', domain: 'ai', label: 'AI Recommendations', description: 'AI recommendations.' },
  { key: 'ai_tasks', domain: 'ai', label: 'AI Tasks', description: 'AI-created and AI-managed tasks.' },
  { key: 'ai_optimizations', domain: 'ai', label: 'AI Optimizations', description: 'AI optimization records.' },
] as const satisfies readonly ResourceDefinition[];

export type ResourceType = (typeof RESOURCE_CATALOG)[number]['key'];

const resourceTypeSet = new Set<string>(RESOURCE_CATALOG.map((resource) => resource.key));

export function isResourceType(value: string): value is ResourceType {
  return resourceTypeSet.has(value);
}

export function getResourceDefinition(value: string) {
  return RESOURCE_CATALOG.find((resource) => resource.key === value);
}
