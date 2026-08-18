import { query } from '../../db/pool.js';
import { AppError } from '../../utils/app-error.js';
import { getOpenAIResponsesClient, isAiGenerationConfigured } from '../ai/openai.service.js';
import { listOfferings, listPlatforms } from '../onboarding/onboarding.repo.js';
import { findWorkspaceById } from '../workspaces/workspace.repo.js';
import * as agentRepo from './agent.repo.js';

const INITIAL_ANALYSIS_GOAL = '[initial-business-analysis] Detailed post-onboarding business intelligence analysis';

const actualMetricCategories = [
  'actual_customer_structure', 'validated_customer_personas', 'actual_customer_needs', 'actual_purchase_motives', 'actual_purchase_barriers', 'actual_customer_behavior', 'actual_purchase_history', 'actual_conversion_rate', 'actual_sales_volume', 'actual_average_order_value', 'actual_repeat_purchase_rate', 'actual_customer_retention', 'actual_churn_risk', 'actual_customer_lifetime_value', 'actual_purchase_probability', 'actual_upsell_cross_sell', 'actual_product_demand', 'actual_product_market_fit', 'actual_product_performance', 'actual_service_performance', 'actual_product_reviews', 'actual_customer_satisfaction', 'actual_return_rate', 'actual_complaint_rate', 'actual_product_quality', 'actual_support_load', 'actual_support_quality', 'actual_website_performance', 'actual_website_traffic', 'actual_website_conversion', 'actual_marketing_performance', 'actual_email_performance', 'actual_social_performance', 'actual_google_ads_performance', 'actual_meta_ads_performance', 'actual_ad_profitability', 'actual_attribution', 'actual_customer_journey', 'actual_seo_rankings', 'actual_geo_visibility', 'actual_aeo_performance', 'actual_competitor_performance', 'actual_market_size_development', 'actual_price_elasticity', 'actual_willingness_to_pay', 'actual_profitability', 'actual_unit_economics', 'actual_liquidity', 'actual_inventory_performance', 'actual_supply_chain_performance', 'actual_process_performance', 'actual_employee_performance', 'actual_brand_awareness', 'actual_brand_perception', 'actual_partner_performance', 'actual_marketplace_performance', 'actual_ab_test_results', 'reliable_forecasts', 'actual_scenario_impacts', 'actual_risks', 'actual_anomalies', 'actual_data_quality', 'actual_privacy_compliance',
] as const;

const analysisSections = [
  ['business', 'Company profile, business model, goals and operating model'],
  ['offerings', 'Products, services, customer value and product/service architecture'],
  ['customers', 'Target groups, personas, segments, use cases and objections'],
  ['positioning', 'Positioning, differentiation, competitors, alternatives and brand hypotheses'],
  ['marketing', 'Marketing messages, sales arguments, content foundations and customer support knowledge'],
  ['search', 'SEO, GEO, AEO, entities, FAQs, structured data and internal linking'],
  ['website', 'Website information architecture, pages, landing pages and conversion paths'],
  ['operations', 'Process knowledge, business rules, approvals, risks, growth hypotheses and planning models'],
] as const;

async function hasInitialAnalysis(workspaceId: string) {
  const { rows } = await query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM agent_runs
       WHERE workspace_id=$1 AND goal=$2
         AND status IN ('queued','planning','running','waiting_approval','completed')
     ) AS exists`,
    [workspaceId, INITIAL_ANALYSIS_GOAL],
  );
  return Boolean(rows[0]?.exists);
}

async function loadInitialAnalysisContext(workspaceId: string) {
  const workspace = await findWorkspaceById(workspaceId);
  if (!workspace) throw new AppError(404, 'INITIAL_ANALYSIS_WORKSPACE_NOT_FOUND', 'The workspace for the initial analysis was not found');
  const [offerings, platforms, records] = await Promise.all([
    listOfferings(workspaceId),
    listPlatforms(workspaceId),
    query<{ resourceType: string; name: string; description: string | null; data: Record<string, unknown> }>(
      `SELECT resource_type AS "resourceType", name, description, data
       FROM workspace_records
       WHERE workspace_id=$1 AND deleted_at IS NULL
       ORDER BY updated_at DESC
       LIMIT 600`,
      [workspaceId],
    ),
  ]);
  return {
    workspace: {
      companyName: workspace.companyName,
      industry: workspace.industry,
      companySize: workspace.companySize,
      countryRegion: workspace.countryRegion,
      businessDescription: workspace.businessDescription,
      valueProposition: workspace.valueProposition,
      targetMarket: workspace.targetMarket,
      shortBrandDescription: workspace.shortBrandDescription,
      positioningTags: workspace.positioningTags ?? [],
    },
    offerings: offerings.filter((item) => item.status === 'active' || item.status === 'draft').slice(0, 200),
    connectedPlatforms: platforms.filter((item) => ['connected', 'active'].includes(item.connectionStatus)).map((item) => ({
      name: item.name,
      category: item.category,
      status: item.connectionStatus,
      lastSyncedAt: item.lastSyncedAt,
    })),
    liveRecords: records.rows,
  };
}

function extractJson(text: string): Record<string, unknown> {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try {
    const value = JSON.parse(cleaned) as Record<string, unknown>;
    if (!value.executiveSummary || !value.sections) throw new Error('missing required fields');
    return value;
  } catch {
    throw new AppError(502, 'INITIAL_ANALYSIS_INVALID_AI_OUTPUT', 'The AI returned an invalid initial analysis structure');
  }
}

function buildInstructions() {
  return [
    'You are Lulu Intelligence, a senior multi-agent business analysis system.',
    'Produce a detailed, evidence-grounded initial business intelligence report after onboarding and confirmed payment.',
    'Use only the verified workspace context. Never invent company facts, prices, certifications, customers, competitors, market share, statistics, legal claims or integrations.',
    'Clearly separate verified facts, derived observations, hypotheses, unknowns and recommended data collection.',
    'Do not execute actions, publish content, contact customers or claim that anything was changed. This job only analyses and stores knowledge.',
    'Analyse every requested category in depth. Where evidence is missing, return an explicit data gap instead of fabricating content.',
    'Return ONLY valid JSON without markdown fences. Use concise but substantive paragraphs and arrays of structured findings.',
    'The result must contain executiveSummary, confidence, dataGaps, verifiedFacts, sections, priorities, actualMetrics and knowledgeBaseDraft.',
    `Cover every actual metric category, including all customer, conversion, commerce, support, website, marketing, advertising, SEO/GEO/AEO, competition, market, finance, operations, brand, partner, experiment, forecast, scenario, risk, anomaly, data-quality and privacy/compliance categories: ${actualMetricCategories.join(', ')}.`,
    'For every actual metric return value, unit, period, source, sourceStatus, confidence, limitations and whether it is measured, derived, forecast, unavailable or not applicable.',
    'Each section must contain title, status, verifiedFacts, derivedInsights, hypotheses, risks, opportunities, questionsToResolve and recommendedNextData.',
  ].join(' ');
}

export async function queueInitialBusinessAnalysis(workspaceId: string) {
  if (await hasInitialAnalysis(workspaceId)) return null;
  const plan = await agentRepo.getWorkspacePlan(workspaceId);
  if ((plan.status !== 'active' && plan.status !== 'trialing') || !['starter', 'ai'].includes(plan.plan_key)) return null;
  if (!isAiGenerationConfigured()) throw new AppError(503, 'INITIAL_ANALYSIS_AI_NOT_CONFIGURED', 'The AI provider is not configured for the initial analysis');

  const context = await loadInitialAnalysisContext(workspaceId);
  const run = await agentRepo.createRun(workspaceId, null, INITIAL_ANALYSIS_GOAL);
  if (!run) throw new AppError(500, 'INITIAL_ANALYSIS_RUN_CREATION_FAILED', 'The initial analysis run could not be created');
  const steps = await agentRepo.createSteps(analysisSections.map(([key, title], index) => ({
    runId: run.id,
    workspaceId,
    sequenceNo: index + 1,
    agentRole: key === 'search' ? 'search-strategist' : key === 'operations' ? 'operations-analyst' : 'business-analyst',
    title,
    instruction: `Analyse section ${key} using verified workspace context only. Separate facts from hypotheses.`,
  })));
  await agentRepo.updateRun(run.id, { status: 'running', started_at: new Date(), plan: { version: 1, type: 'initial_business_analysis', sections: analysisSections.map(([key, title]) => ({ key, title })), contextSources: ['workspace', 'offerings', 'connected_platforms', 'live_records'] } });
  await agentRepo.addEvent({ runId: run.id, workspaceId, eventType: 'initial_analysis.started', agentRole: 'planner', payload: { sectionCount: analysisSections.length } });

  void (async () => {
    try {
      const response = await getOpenAIResponsesClient().create({
        model: process.env.OPENAI_ANALYSIS_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        instructions: buildInstructions(),
        input: [{ role: 'user', content: [
          `Workspace analysis target: ${workspaceId}`,
          'Required sections:',
          JSON.stringify(analysisSections),
          'Required actual metric categories:',
          JSON.stringify(actualMetricCategories),
          'Verified workspace context:',
          JSON.stringify(context),
          'Required JSON shape:',
          '{"executiveSummary":string,"confidence":"high"|"medium"|"low","dataGaps":string[],"verifiedFacts":string[],"sections":{"business":object,"offerings":object,"customers":object,"positioning":object,"marketing":object,"search":object,"website":object,"operations":object},"actualMetrics":{"metric_key":{"value":unknown,"unit":string|null,"period":string|null,"source":string|null,"sourceStatus":"verified"|"derived"|"forecast"|"unavailable"|"not_applicable","confidence":"high"|"medium"|"low","limitations":string[]}},"priorities":string[],"knowledgeBaseDraft":object}',
        ].join('\n\n') }],
        max_output_tokens: 30000,
        store: false,
      });
      const result = extractJson(response.output_text);
      for (const step of steps) {
        await agentRepo.updateStep(step.id, { status: 'completed', result: { analysed: true, reportSection: step.title }, finished_at: new Date() });
      }
      await agentRepo.updateRun(run.id, { status: 'completed', result: { type: 'initial_business_analysis', generatedAt: new Date().toISOString(), metricCategories: actualMetricCategories, ...result }, finished_at: new Date() });
      await agentRepo.addEvent({ runId: run.id, workspaceId, eventType: 'initial_analysis.completed', agentRole: 'reviewer', payload: { confidence: result.confidence ?? null, dataGapCount: Array.isArray(result.dataGaps) ? result.dataGaps.length : null } });
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(502, 'INITIAL_ANALYSIS_FAILED', error instanceof Error ? error.message : 'The initial analysis failed');
      await agentRepo.updateRun(run.id, { status: 'failed', error_code: appError.code, error_message: appError.message, finished_at: new Date() });
      await agentRepo.addEvent({ runId: run.id, workspaceId, eventType: 'initial_analysis.failed', agentRole: 'reviewer', payload: { code: appError.code, message: appError.message } });
    }
  })();

  return run;
}

export { INITIAL_ANALYSIS_GOAL };
