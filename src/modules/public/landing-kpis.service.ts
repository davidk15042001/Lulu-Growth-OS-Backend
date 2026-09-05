import { hasDb } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { query } from '../../db/pool.js';

export type LandingMetricUnit = 'count' | 'currency' | 'percent' | 'seconds' | 'hours' | 'ratio' | 'text';

export type LandingMetric = {
  value: number | string | null;
  unit: LandingMetricUnit;
  available: boolean;
  source: string;
  measuredAt: string | null;
};

export type LandingBreakdownItem = { label: string; count: number };

export type LandingKpisData = {
  available: boolean;
  generatedAt: string;
  period: { label: string; from: string | null; to: string };
  metrics: Record<string, LandingMetric>;
  breakdowns: {
    markets: LandingBreakdownItem[];
    categories: LandingBreakdownItem[];
    factories: LandingBreakdownItem[];
    caseStudies: LandingBreakdownItem[];
  };
  privacy: {
    factories: string;
    caseStudies: string;
  };
};

type NumericSource = {
  key: string;
  value: unknown;
  source: string | null;
  measuredAt: string | null;
  workspaceId?: string;
};

type WorkspaceAggregate = {
  activeFactories: string;
  activeUsingFactories: string;
};

type RecordAggregate = {
  products: string;
  internationalizedProducts: string;
  leads: string;
  qualifiedLeads: string;
  buyerRequests: string;
  offers: string;
  offerValue: string;
  orders: string;
  internationalNewCustomers: string;
  averageOrderValue: string | null;
  luluAttributedExportRevenue: string;
  automaticFollowUps: string;
  automaticTasks: string;
  allTasks: string;
};

type SiteAggregate = { publishedWebsites: string };
type CountAggregate = { count: string };
type EmailAggregate = { automaticallyAnswered: string };
type IntelligenceRow = NumericSource;
type BreakdownRow = { label: string; count: string };

const ALL_METRIC_KEYS = [
  'activeFactories',
  'internationalizedProducts',
  'internationalWebsites',
  'supportedLanguages',
  'targetMarkets',
  'internationalWebsiteVisitors',
  'organicInternationalTraffic',
  'adImpressions',
  'adClicks',
  'averageCpc',
  'internationalLeads',
  'qualifiedLeads',
  'buyerRequests',
  'aiCustomerConversations',
  'automaticallyAnsweredInquiries',
  'averageResponseTime',
  'automaticFollowUps',
  'offersCreated',
  'offerValue',
  'internationalNewCustomers',
  'internationalOrders',
  'averageOrderValue',
  'luluAttributedExportRevenue',
  'leadToQualifiedRate',
  'leadToOfferRate',
  'offerToOrderRate',
  'adRoas',
  'totalFactoryRoi',
  'medianFactoryRoi',
  'autonomousProcessShare',
  'automaticTasks',
  'timeSaved',
  'costSaved',
  'beforeAfter',
  'byMarket',
  'byCategory',
  'byFactory',
  'caseStudies',
  'measurementPeriod',
  'activeUsingFactories',
] as const;

const NUMERIC_ALIASES: Record<string, string[]> = {
  internationalWebsiteVisitors: ['website_visitors', 'international_website_visitors', 'website_traffic', 'actual_website_traffic'],
  organicInternationalTraffic: ['organic_international_traffic', 'organic_traffic', 'organic_search_traffic'],
  adImpressions: ['ad_impressions', 'advertising_impressions', 'impressions'],
  adClicks: ['ad_clicks', 'advertising_clicks', 'clicks'],
  averageCpc: ['average_cpc', 'avg_cpc', 'cpc'],
  averageResponseTime: ['average_response_time', 'avg_response_time', 'response_time'],
  adRoas: ['advertising_roas', 'ad_roas', 'roas'],
  totalFactoryRoi: ['factory_roi', 'roi', 'actual_profitability'],
  medianFactoryRoi: ['median_factory_roi', 'median_roi', 'factory_roi_median'],
  timeSaved: ['time_saved_hours', 'hours_saved', 'time_savings'],
  costSaved: ['cost_saved', 'marketing_cost_savings', 'manual_marketing_cost_savings'],
};

const SUM_METRICS = new Set([
  'internationalWebsiteVisitors',
  'organicInternationalTraffic',
  'adImpressions',
  'adClicks',
  'totalFactoryRoi',
  'timeSaved',
  'costSaved',
]);

const unavailable = (source: string): LandingMetric => ({
  value: null,
  unit: 'count',
  available: false,
  source,
  measuredAt: null,
});

function metric(
  value: number | string | null,
  unit: LandingMetricUnit,
  source: string,
  measuredAt: string | null = null,
): LandingMetric {
  const available = typeof value === 'string' ? value.trim().length > 0 : value !== null && Number.isFinite(value);
  return { value, unit, available, source, measuredAt };
}

function emptyMetrics() {
  return Object.fromEntries(ALL_METRIC_KEYS.map((key) => [key, unavailable('Keine verifizierten Daten verfügbar')])) as Record<string, LandingMetric>;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of ['value', 'amount', 'numericValue', 'number']) {
      const nested = numberValue(object[key]);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function parseCount(value: string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function aggregateNumeric(rows: NumericSource[], aliases: string[], mode: 'sum' | 'average' | 'median') {
  const allowed = new Set(aliases.map((alias) => alias.toLowerCase()));
  const seenWorkspaceKeys = new Set<string>();
  const matches = rows
    .filter((row) => allowed.has(row.key.toLowerCase()))
    .filter((row) => {
      if (!row.workspaceId) return true;
      const identity = `${row.workspaceId}:${row.key.toLowerCase()}`;
      if (seenWorkspaceKeys.has(identity)) return false;
      seenWorkspaceKeys.add(identity);
      return true;
    })
    .map((row) => ({ value: numberValue(row.value), source: row.source, measuredAt: toIso(row.measuredAt) }))
    .filter((row): row is { value: number; source: string | null; measuredAt: string | null } => row.value !== null);
  if (!matches.length) return null;
  const values = matches.map((row) => row.value);
  let value: number;
  if (mode === 'sum') value = values.reduce((sum, item) => sum + item, 0);
  else if (mode === 'median') {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    value = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  } else value = values.reduce((sum, item) => sum + item, 0) / values.length;
  const latest = matches
    .filter((row) => row.measuredAt)
    .sort((a, b) => String(b.measuredAt).localeCompare(String(a.measuredAt)))[0];
  return { value, source: latest?.source ?? 'Verifizierte KPI-Metriken', measuredAt: latest?.measuredAt ?? null };
}

function aggregateFromRows(rows: NumericSource[], key: string, unit: LandingMetricUnit) {
  const aliases = NUMERIC_ALIASES[key] ?? [];
  if (!aliases.length) return unavailable('Keine verifizierten Daten verfügbar');
  const mode = key === 'medianFactoryRoi' ? 'median' : SUM_METRICS.has(key) ? 'sum' : 'average';
  const result = aggregateNumeric(rows, aliases, mode);
  return result ? metric(result.value, unit, result.source, result.measuredAt) : unavailable('Keine verifizierten Daten verfügbar');
}

async function loadDatabaseData() {
  const [workspaces, records, sites, languages, marketTotal, markets, categories, ai, email, intelligence, points] = await Promise.all([
    query<WorkspaceAggregate>(`SELECT
      COUNT(*) FILTER (WHERE w.deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM workspace_members wm
        JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = w.id AND u.verified_at IS NOT NULL AND u.deleted_at IS NULL
      ))::text AS "activeFactories",
      COUNT(*) FILTER (WHERE w.deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM workspace_members wm
        JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = w.id AND u.verified_at IS NOT NULL AND u.deleted_at IS NULL
      ) AND EXISTS (
        SELECT 1 FROM workspace_subscriptions ws
        WHERE ws.workspace_id = w.id AND ws.status IN ('active', 'trialing')
      ))::text AS "activeUsingFactories"
      FROM workspaces w`),
    query<RecordAggregate>(`SELECT
      COUNT(*) FILTER (WHERE resource_type = 'ecommerce_products')::text AS products,
      COUNT(*) FILTER (WHERE resource_type = 'ecommerce_products' AND (
        tags @> ARRAY['internationalized']::text[]
        OR lower(COALESCE(data->>'internationalized', '')) = 'true'
        OR lower(COALESCE(data->>'isInternationalized', '')) = 'true'
        OR jsonb_typeof(data->'translations') IN ('object', 'array')
        OR jsonb_typeof(data->'languages') = 'array'
      ))::text AS "internationalizedProducts",
      COUNT(*) FILTER (WHERE resource_type IN ('crm_leads', 'sales_leads'))::text AS leads,
      COUNT(*) FILTER (WHERE resource_type IN ('crm_leads', 'sales_leads') AND (
        lower(COALESCE(stage, '')) IN ('qualified', 'qualified_lead')
        OR lower(COALESCE(status, '')) IN ('qualified', 'qualified_lead')
        OR lower(COALESCE(data->>'stage', '')) IN ('qualified', 'qualified_lead')
        OR lower(COALESCE(data->>'status', '')) IN ('qualified', 'qualified_lead')
      ))::text AS "qualifiedLeads",
      COUNT(*) FILTER (WHERE resource_type IN ('crm_leads', 'sales_leads') AND (
        lower(COALESCE(data->>'type', '')) IN ('rfq', 'buyer_request', 'inquiry')
        OR lower(name) LIKE '%rfq%'
        OR lower(name) LIKE '%request for quote%'
      ))::text AS "buyerRequests",
      COUNT(*) FILTER (WHERE resource_type = 'finance_quotes')::text AS offers,
      COALESCE(SUM(value_amount) FILTER (WHERE resource_type = 'finance_quotes'), 0)::text AS "offerValue",
      COUNT(*) FILTER (WHERE resource_type = 'ecommerce_orders')::text AS orders,
      COUNT(*) FILTER (WHERE resource_type IN ('customers', 'ecommerce_customers') AND (
        lower(COALESCE(data->>'international', '')) = 'true'
        OR lower(COALESCE(data->>'isInternational', '')) = 'true'
        OR lower(COALESCE(data->>'customerType', '')) IN ('international', 'export')
      ))::text AS "internationalNewCustomers",
      AVG(value_amount) FILTER (WHERE resource_type = 'ecommerce_orders' AND value_amount IS NOT NULL)::text AS "averageOrderValue",
      COALESCE(SUM(value_amount) FILTER (WHERE resource_type = 'ecommerce_orders' AND (
        lower(COALESCE(source, '')) IN ('lulu', 'lulu_ai', 'lulu-managed')
        OR lower(COALESCE(data->>'attributedBy', '')) IN ('lulu', 'lulu_ai', 'lulu-managed')
        OR lower(COALESCE(data->>'attributionSource', '')) IN ('lulu', 'lulu_ai', 'lulu-managed')
      )), 0)::text AS "luluAttributedExportRevenue",
      COUNT(*) FILTER (WHERE resource_type IN ('crm_tasks', 'sales_tasks') AND (
        lower(COALESCE(source, '')) LIKE '%agent%'
        OR lower(COALESCE(source, '')) LIKE '%automation%'
        OR lower(COALESCE(data->>'action', '')) LIKE '%follow%up%'
        OR lower(COALESCE(data->>'type', '')) LIKE '%follow%up%'
      ))::text AS "automaticFollowUps",
      COUNT(*) FILTER (WHERE resource_type IN ('crm_tasks', 'sales_tasks') AND (
        lower(COALESCE(source, '')) IN ('agent_executor', 'automation', 'ai')
        AND lower(COALESCE(data->>'executionStatus', '')) IN ('executed', 'completed', 'succeeded')
      ))::text AS "automaticTasks",
      COUNT(*) FILTER (WHERE resource_type IN ('crm_tasks', 'sales_tasks'))::text AS "allTasks"
      FROM workspace_records
      WHERE deleted_at IS NULL`),
    query<SiteAggregate>(`SELECT COUNT(*)::text AS "publishedWebsites"
      FROM workspace_sites ws
      JOIN workspaces w ON w.id = ws.workspace_id
      WHERE ws.status = 'published' AND w.deleted_at IS NULL`),
    query<CountAggregate>(`SELECT COUNT(DISTINCT lower(trim(value)))::text AS count
      FROM (
        SELECT unnest(COALESCE(w.languages, '{}'::text[])) AS value
        FROM workspaces w WHERE w.deleted_at IS NULL
        UNION ALL
        SELECT wap.response_language AS value
        FROM workspace_ai_preferences wap
        JOIN workspaces w ON w.id = wap.workspace_id
        WHERE w.deleted_at IS NULL
      ) language_values
      WHERE trim(value) <> ''`),
    query<CountAggregate>(`SELECT COUNT(DISTINCT lower(trim(label)))::text AS count
      FROM (
        SELECT NULLIF(trim(w.target_market), '') AS label FROM workspaces w WHERE w.deleted_at IS NULL
        UNION ALL
        SELECT NULLIF(trim(s.region), '') AS label
        FROM workspace_customer_segments s
        JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.deleted_at IS NULL AND w.deleted_at IS NULL
      ) market_values
      WHERE label IS NOT NULL`),
    query<BreakdownRow>(`SELECT MIN(label) AS label, COUNT(*)::text AS count
      FROM (
        SELECT NULLIF(trim(w.target_market), '') AS label FROM workspaces w WHERE w.deleted_at IS NULL
        UNION ALL
        SELECT NULLIF(trim(s.region), '') AS label
        FROM workspace_customer_segments s
        JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.deleted_at IS NULL AND w.deleted_at IS NULL
      ) market_values
      WHERE label IS NOT NULL
      GROUP BY lower(label)
      HAVING COUNT(*) >= 3
      ORDER BY COUNT(*) DESC, MIN(label)
      LIMIT 20`),
    query<BreakdownRow>(`SELECT MIN(label) AS label, COUNT(*)::text AS count
      FROM (
        SELECT NULLIF(trim(wo.category), '') AS label
        FROM workspace_offerings wo
        JOIN workspaces w ON w.id = wo.workspace_id
        WHERE wo.deleted_at IS NULL AND w.deleted_at IS NULL
        UNION ALL
        SELECT NULLIF(trim(wr.data->>'category'), '') AS label
        FROM workspace_records wr
        JOIN workspaces w ON w.id = wr.workspace_id
        WHERE wr.deleted_at IS NULL AND wr.resource_type = 'ecommerce_products' AND w.deleted_at IS NULL
      ) category_values
      WHERE label IS NOT NULL
      GROUP BY lower(label)
      HAVING COUNT(*) >= 3
      ORDER BY COUNT(*) DESC, MIN(label)
      LIMIT 20`),
    query<CountAggregate>(`SELECT COUNT(*)::text AS count
      FROM ai_conversations c
      JOIN workspaces w ON w.id = c.workspace_id
      WHERE c.archived_at IS NULL AND w.deleted_at IS NULL`),
    query<EmailAggregate>(`SELECT COUNT(*)::text AS "automaticallyAnswered"
      FROM email_drafts d
      JOIN workspaces w ON w.id = d.workspace_id
      WHERE d.source = 'automation' AND d.status = 'sent' AND w.deleted_at IS NULL`),
    query<IntelligenceRow>(`SELECT DISTINCT ON (m.workspace_id, lower(m.metric_key))
      m.workspace_id AS "workspaceId", lower(m.metric_key) AS key, m.value, m.source, COALESCE(m.measured_at, m.updated_at) AS "measuredAt"
      FROM workspace_intelligence_metrics m
      JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.source_status IN ('verified', 'derived') AND w.deleted_at IS NULL
      ORDER BY m.workspace_id, lower(m.metric_key), m.updated_at DESC`),
    query<IntelligenceRow>(`SELECT DISTINCT ON (md.workspace_id, lower(md.key))
      md.workspace_id AS "workspaceId", lower(md.key) AS key, mp.value::text AS value, md.source, mp.recorded_at AS "measuredAt"
      FROM metric_definitions md
      JOIN metric_points mp ON mp.metric_id = md.id
      JOIN workspaces w ON w.id = md.workspace_id
      WHERE md.deleted_at IS NULL AND w.deleted_at IS NULL
      ORDER BY md.workspace_id, lower(md.key), mp.recorded_at DESC, mp.id DESC`),
  ]);
  return { workspaces: workspaces.rows[0], records: records.rows[0], sites: sites.rows[0], languages: languages.rows[0], marketTotal: marketTotal.rows[0], markets: markets.rows, categories: categories.rows, ai: ai.rows[0], email: email.rows[0], intelligence: intelligence.rows, points: points.rows };
}

function buildUnavailableData(generatedAt: string): LandingKpisData {
  const metrics = emptyMetrics();
  metrics.measurementPeriod = metric('All available data', 'text', 'Aggregation window');
  return {
    available: false,
    generatedAt,
    period: { label: 'All available data', from: null, to: generatedAt },
    metrics,
    breakdowns: { markets: [], categories: [], factories: [], caseStudies: [] },
    privacy: {
      factories: 'Factory-level identities are intentionally not exposed on the public login page.',
      caseStudies: 'Case studies require explicit public consent and are not published by default.',
    },
  };
}

export async function getLandingKpis(): Promise<LandingKpisData> {
  const generatedAt = new Date().toISOString();
  if (!hasDb) return buildUnavailableData(generatedAt);

  try {
    const data = await loadDatabaseData();
    const metrics = emptyMetrics();
    const activeFactories = parseCount(data.workspaces?.activeFactories);
    const activeUsingFactories = parseCount(data.workspaces?.activeUsingFactories);
    const productCount = parseCount(data.records?.internationalizedProducts);
    const siteCount = parseCount(data.sites?.publishedWebsites);
    const languageCount = parseCount(data.languages?.count);
    const leadCount = parseCount(data.records?.leads);
    const qualifiedLeadCount = parseCount(data.records?.qualifiedLeads);
    const buyerRequestCount = parseCount(data.records?.buyerRequests);
    const offerCount = parseCount(data.records?.offers);
    const orderCount = parseCount(data.records?.orders);
    const internationalNewCustomerCount = parseCount(data.records?.internationalNewCustomers);
    const averageOrderValue = numberValue(data.records?.averageOrderValue);
    const offerValue = numberValue(data.records?.offerValue);
    const luluRevenue = numberValue(data.records?.luluAttributedExportRevenue);
    const automaticTasks = parseCount(data.records?.automaticTasks);
    const allTasks = parseCount(data.records?.allTasks);

    metrics.activeFactories = metric(activeFactories, 'count', 'Verified members in active workspaces');
    metrics.activeUsingFactories = metric(activeUsingFactories, 'count', 'Active or trialing subscriptions');
    metrics.internationalizedProducts = metric(productCount, 'count', 'Products with explicit internationalization metadata');
    metrics.internationalWebsites = metric(siteCount, 'count', 'Published workspace sites');
    metrics.supportedLanguages = metric(languageCount, 'count', 'Workspace language preferences');
    metrics.targetMarkets = metric(parseCount(data.marketTotal?.count), 'count', 'Workspace markets and customer segments');
    metrics.internationalLeads = metric(leadCount, 'count', 'CRM and sales lead records');
    metrics.qualifiedLeads = metric(qualifiedLeadCount, 'count', 'Explicitly qualified CRM and sales leads');
    metrics.buyerRequests = metric(buyerRequestCount, 'count', 'Explicit RFQ/buyer-request lead records');
    metrics.offersCreated = metric(offerCount, 'count', 'Finance quote records');
    metrics.offerValue = offerValue === null ? unavailable('No quote values recorded') : metric(offerValue, 'currency', 'Quote value_amount totals');
    metrics.internationalOrders = metric(orderCount, 'count', 'Ecommerce order records');
    metrics.internationalNewCustomers = metric(internationalNewCustomerCount, 'count', 'Customer records with explicit international/export classification');
    metrics.averageOrderValue = averageOrderValue === null ? unavailable('No order values recorded') : metric(averageOrderValue, 'currency', 'Average order value_amount');
    metrics.luluAttributedExportRevenue = luluRevenue === null ? unavailable('No explicit Lulu attribution recorded') : metric(luluRevenue, 'currency', 'Orders with explicit Lulu attribution');
    metrics.aiCustomerConversations = metric(parseCount(data.ai?.count), 'count', 'Non-archived AI conversations');
    metrics.automaticallyAnsweredInquiries = metric(parseCount(data.email?.automaticallyAnswered), 'count', 'Sent automation email drafts');
    metrics.automaticFollowUps = metric(parseCount(data.records?.automaticFollowUps), 'count', 'Agent or automation follow-up tasks');
    metrics.automaticTasks = metric(automaticTasks, 'count', 'Executed agent/automation tasks');
    metrics.autonomousProcessShare = allTasks > 0 ? metric(automaticTasks / allTasks, 'percent', 'Executed automatic tasks divided by all tasks') : unavailable('No task execution denominator recorded');
    metrics.leadToQualifiedRate = leadCount > 0 ? metric(qualifiedLeadCount / leadCount, 'percent', 'Qualified leads divided by leads') : unavailable('No lead denominator recorded');
    metrics.leadToOfferRate = leadCount > 0 ? metric(offerCount / leadCount, 'percent', 'Offers divided by leads') : unavailable('No lead denominator recorded');
    metrics.offerToOrderRate = offerCount > 0 ? metric(orderCount / offerCount, 'percent', 'Orders divided by offers') : unavailable('No offer denominator recorded');

    const numericRows = [...data.intelligence, ...data.points];
    metrics.internationalWebsiteVisitors = aggregateFromRows(numericRows, 'internationalWebsiteVisitors', 'count');
    metrics.organicInternationalTraffic = aggregateFromRows(numericRows, 'organicInternationalTraffic', 'count');
    metrics.adImpressions = aggregateFromRows(numericRows, 'adImpressions', 'count');
    metrics.adClicks = aggregateFromRows(numericRows, 'adClicks', 'count');
    metrics.averageCpc = aggregateFromRows(numericRows, 'averageCpc', 'currency');
    metrics.averageResponseTime = aggregateFromRows(numericRows, 'averageResponseTime', 'seconds');
    metrics.adRoas = aggregateFromRows(numericRows, 'adRoas', 'ratio');
    metrics.totalFactoryRoi = aggregateFromRows(numericRows, 'totalFactoryRoi', 'percent');
    metrics.medianFactoryRoi = aggregateFromRows(numericRows, 'medianFactoryRoi', 'percent');
    metrics.timeSaved = aggregateFromRows(numericRows, 'timeSaved', 'hours');
    metrics.costSaved = aggregateFromRows(numericRows, 'costSaved', 'currency');
    metrics.measurementPeriod = metric('All available data', 'text', 'Aggregation window');
    metrics.byMarket = metric(null, 'text', 'See privacy-safe market breakdown');
    metrics.byCategory = metric(null, 'text', 'See privacy-safe category breakdown');
    metrics.byFactory = metric(null, 'text', 'Factory identities are privacy protected');
    metrics.caseStudies = metric(null, 'text', 'No explicitly public case studies');
    const markets = data.markets.map((row) => ({ label: row.label, count: parseCount(row.count) })).filter((row) => row.label);
    const categories = data.categories.map((row) => ({ label: row.label, count: parseCount(row.count) })).filter((row) => row.label);
    const hasUsableMetric = Object.entries(metrics).some(([key, value]) => key !== 'measurementPeriod' && value.available);
    return {
      available: hasUsableMetric,
      generatedAt,
      period: { label: 'All available data', from: null, to: generatedAt },
      metrics,
      breakdowns: { markets, categories, factories: [], caseStudies: [] },
      privacy: {
        factories: 'Factory-level identities are intentionally not exposed on the public login page.',
        caseStudies: 'Case studies require explicit public consent and are not published by default.',
      },
    };
  } catch (error) {
    logger.warn({ error }, 'Public landing KPI aggregation unavailable');
    return buildUnavailableData(generatedAt);
  }
}
