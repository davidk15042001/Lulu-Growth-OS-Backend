import { query, withTransaction } from '../../db/pool.js';
import { buildUpdateSet } from '../../db/update-builder.js';
import type {
  AiPreferencesInput,
  BusinessDescriptionInput,
  CompanyInformationInput,
  CreateCompetitorInput,
  CreateCustomerSegmentInput,
  CreateOfferingInput,
  CreatePlatformInput,
  UpdateCompetitorInput,
  UpdateCustomerSegmentInput,
  UpdateOfferingInput,
  UpdatePlatformInput,
} from './onboarding.validator.js';

export type Offering = {
  id: string;
  workspaceId: string;
  name: string;
  offeringType: 'product' | 'service';
  category: string | null;
  description: string | null;
  targetCustomer: string | null;
  pricingModel: string | null;
  priceAmount: string | null;
  priceCurrency: string | null;
  priceLabel: string | null;
  status: 'draft' | 'active' | 'inactive' | 'archived';
  customerProblem: string | null;
  valueProposition: string | null;
  url: string | null;
  imageUrl: string | null;
  sortOrder: number;
  sku: string | null;
  portfolioGroup: string | null;
  lifecycleStage: string | null;
  launchDate: string | null;
  deliveryModel: string | null;
  serviceScope: string | null;
  setupFee: string | null;
  recurringFee: string | null;
  usageFee: string | null;
  billingInterval: string | null;
  minimumContractMonths: number | null;
  cancellationPeriodDays: number | null;
  onboardingEffort: string | null;
  fulfilmentEffort: string | null;
  differentiators: string[];
  proofPoints: string[];
  useCases: string[];
  objections: string[];
  addOns: string[];
  createdAt: string;
  updatedAt: string;
};

const offeringSelect = `
  id,
  workspace_id AS "workspaceId",
  name,
  offering_type AS "offeringType",
  category,
  description,
  target_customer AS "targetCustomer",
  pricing_model AS "pricingModel",
  price_amount AS "priceAmount",
  price_currency AS "priceCurrency",
  price_label AS "priceLabel",
  status,
  customer_problem AS "customerProblem",
  value_proposition AS "valueProposition",
  url,
  image_url AS "imageUrl",
  sort_order AS "sortOrder",
  sku,
  portfolio_group AS "portfolioGroup",
  lifecycle_stage AS "lifecycleStage",
  launch_date AS "launchDate",
  delivery_model AS "deliveryModel",
  service_scope AS "serviceScope",
  setup_fee AS "setupFee",
  recurring_fee AS "recurringFee",
  usage_fee AS "usageFee",
  billing_interval AS "billingInterval",
  minimum_contract_months AS "minimumContractMonths",
  cancellation_period_days AS "cancellationPeriodDays",
  onboarding_effort AS "onboardingEffort",
  fulfilment_effort AS "fulfilmentEffort",
  differentiators,
  proof_points AS "proofPoints",
  use_cases AS "useCases",
  objections,
  add_ons AS "addOns",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export type CustomerSegment = {
  id: string;
  workspaceId: string;
  name: string;
  industry: string | null;
  companySize: string | null;
  region: string | null;
  maturityLevel: string | null;
  painPoints: string[];
  jobsToBeDone: string[];
  decisionCriteria: string[];
  useCases: string[];
  buyingRoles: string[];
  priceSensitivity: string | null;
  primarySegment: boolean;
  sortOrder: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

const customerSegmentSelect = `
  id,
  workspace_id AS "workspaceId",
  name,
  industry,
  company_size AS "companySize",
  region,
  maturity_level AS "maturityLevel",
  pain_points AS "painPoints",
  jobs_to_be_done AS "jobsToBeDone",
  decision_criteria AS "decisionCriteria",
  use_cases AS "useCases",
  buying_roles AS "buyingRoles",
  price_sensitivity AS "priceSensitivity",
  primary_segment AS "primarySegment",
  sort_order AS "sortOrder",
  notes,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export type Competitor = {
  id: string;
  workspaceId: string;
  name: string;
  websiteUrl: string | null;
  competitorType: 'direct' | 'indirect' | 'substitute' | 'emerging';
  market: string | null;
  positioning: string | null;
  pricingSummary: string | null;
  strengths: string[];
  weaknesses: string[];
  differentiators: string[];
  featureOverlap: string[];
  threatLevel: string | null;
  strategicPriority: string | null;
  sourceQuality: string | null;
  monitoringFrequency: string | null;
  notes: string | null;
  lastReviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GeneratedCompetitorInput = {
  name: string;
  websiteUrl: string | null;
  competitorType: 'direct' | 'indirect' | 'substitute' | 'emerging';
  market: string | null;
  positioning: string | null;
  pricingSummary: string | null;
  strengths: string[];
  weaknesses: string[];
  differentiators: string[];
  featureOverlap: string[];
  threatLevel: string | null;
  strategicPriority: string | null;
  sourceQuality: string | null;
  monitoringFrequency: string | null;
  notes: string | null;
  lastReviewedAt: string | null;
  rank: number;
  visibility: string | null;
  growth: string | null;
  intelligence: string | null;
  competitivePosition: string | null;
};

const competitorSelect = `
  id,
  workspace_id AS "workspaceId",
  name,
  website_url AS "websiteUrl",
  competitor_type AS "competitorType",
  market,
  positioning,
  pricing_summary AS "pricingSummary",
  strengths,
  weaknesses,
  differentiators,
  feature_overlap AS "featureOverlap",
  threat_level AS "threatLevel",
  strategic_priority AS "strategicPriority",
  source_quality AS "sourceQuality",
  monitoring_frequency AS "monitoringFrequency",
  notes,
  last_reviewed_at AS "lastReviewedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export type Platform = {
  id: string;
  workspaceId: string;
  integrationKey: string | null;
  name: string;
  category: string;
  connectionStatus: string;
  externalAccountId: string | null;
  grantedScopes: string[];
  settings: Record<string, unknown>;
  lastSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

const platformSelect = `
  id,
  workspace_id AS "workspaceId",
  integration_key AS "integrationKey",
  name,
  category,
  connection_status AS "connectionStatus",
  external_account_id AS "externalAccountId",
  granted_scopes AS "grantedScopes",
  settings,
  last_synced_at AS "lastSyncedAt",
  last_error AS "lastError",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export async function saveCompanyInformation(workspaceId: string, input: CompanyInformationInput) {
  await query(
    `UPDATE workspaces
     SET name = $2,
         industry = $3,
         company_size = $4,
         country_region = $5,
         onboarding_step = 'business_description'
     WHERE id = $1 AND deleted_at IS NULL`,
    [workspaceId, input.companyName, input.industry, input.companySize, input.countryRegion]
  );
}

export const saveBusinessDescriptionSql = `
  UPDATE workspaces
     SET business_description = $2,
         value_proposition = $3,
         target_market = $4,
         short_brand_description = $5,
         positioning_tags = $6,
         onboarding_step = 'existing_platforms',
         onboarding_file_reupload_required = FALSE
     WHERE id = $1
       AND deleted_at IS NULL
       AND (
         onboarding_file_reupload_required = FALSE
         OR EXISTS (SELECT 1 FROM onboarding_documents d WHERE d.workspace_id = workspaces.id)
       )
     RETURNING id
`;

export async function saveBusinessDescription(workspaceId: string, input: BusinessDescriptionInput) {
  const { rowCount } = await query(
    saveBusinessDescriptionSql,
    [
      workspaceId,
      input.businessDescription,
      input.valueProposition,
      input.targetMarket,
      input.shortBrandDescription,
      input.positioningTags,
    ]
  );
  await query(
    `UPDATE workspaces
     SET legal_form = $2,
         founding_year = $3,
         employee_count = $4,
         annual_revenue_range = $5,
         business_model_type = $6,
         company_stage = $7,
         sales_model = $8,
         sales_cycle_days = $9,
         primary_icp = $10,
         usp = $11,
         mission = $12,
         vision = $13,
         primary_challenges = $14,
         languages = $15,
         regulated_industries = $16
     WHERE id = $1 AND deleted_at IS NULL`,
    [
      workspaceId,
      input.legalForm ?? null,
      input.foundingYear ?? null,
      input.employeeCount ?? null,
      input.annualRevenueRange ?? null,
      input.businessModelType ?? null,
      input.companyStage ?? null,
      input.salesModel ?? null,
      input.salesCycleDays ?? null,
      input.primaryIcp ?? null,
      input.usp ?? null,
      input.mission ?? null,
      input.vision ?? null,
      input.primaryChallenges ?? [],
      input.languages ?? [],
      input.regulatedIndustries ?? [],
    ]
  );
  return rowCount > 0;
}

export async function listOfferings(workspaceId: string) {
  const { rows } = await query<Offering>(
    `SELECT ${offeringSelect}
     FROM workspace_offerings
     WHERE workspace_id = $1 AND deleted_at IS NULL
     ORDER BY sort_order, created_at`,
    [workspaceId]
  );
  return rows;
}

export async function createOffering(workspaceId: string, input: CreateOfferingInput) {
  const { rows } = await query<Offering>(
    `INSERT INTO workspace_offerings (
       workspace_id, name, offering_type, category, description, target_customer,
       pricing_model, price_amount, price_currency, price_label, status,
       customer_problem, value_proposition, url, image_url, sort_order,
       sku, portfolio_group, lifecycle_stage, launch_date, delivery_model,
       service_scope, setup_fee, recurring_fee, usage_fee, billing_interval,
       minimum_contract_months, cancellation_period_days, onboarding_effort,
       fulfilment_effort, differentiators, proof_points, use_cases, objections, add_ons
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
       $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
       $31, $32, $33, $34, $35
     )
     RETURNING ${offeringSelect}`,
    [
      workspaceId,
      input.name,
      input.offeringType,
      input.category ?? null,
      input.description ?? null,
      input.targetCustomer ?? null,
      input.pricingModel ?? null,
      input.priceAmount ?? null,
      input.priceCurrency ?? null,
      input.priceLabel ?? null,
      input.status ?? 'active',
      input.customerProblem ?? null,
      input.valueProposition ?? null,
      input.url ?? null,
      input.imageUrl ?? null,
      input.sortOrder ?? 0,
      input.sku ?? null,
      input.portfolioGroup ?? null,
      input.lifecycleStage ?? null,
      input.launchDate ?? null,
      input.deliveryModel ?? null,
      input.serviceScope ?? null,
      input.setupFee ?? null,
      input.recurringFee ?? null,
      input.usageFee ?? null,
      input.billingInterval ?? null,
      input.minimumContractMonths ?? null,
      input.cancellationPeriodDays ?? null,
      input.onboardingEffort ?? null,
      input.fulfilmentEffort ?? null,
      input.differentiators ?? [],
      input.proofPoints ?? [],
      input.useCases ?? [],
      input.objections ?? [],
      input.addOns ?? [],
    ]
  );
  return rows[0];
}

const offeringUpdateColumns: Partial<Record<keyof UpdateOfferingInput, string>> = {
  name: 'name',
  offeringType: 'offering_type',
  category: 'category',
  description: 'description',
  targetCustomer: 'target_customer',
  pricingModel: 'pricing_model',
  priceAmount: 'price_amount',
  priceCurrency: 'price_currency',
  priceLabel: 'price_label',
  status: 'status',
  customerProblem: 'customer_problem',
  valueProposition: 'value_proposition',
  url: 'url',
  imageUrl: 'image_url',
  sortOrder: 'sort_order',
  sku: 'sku',
  portfolioGroup: 'portfolio_group',
  lifecycleStage: 'lifecycle_stage',
  launchDate: 'launch_date',
  deliveryModel: 'delivery_model',
  serviceScope: 'service_scope',
  setupFee: 'setup_fee',
  recurringFee: 'recurring_fee',
  usageFee: 'usage_fee',
  billingInterval: 'billing_interval',
  minimumContractMonths: 'minimum_contract_months',
  cancellationPeriodDays: 'cancellation_period_days',
  onboardingEffort: 'onboarding_effort',
  fulfilmentEffort: 'fulfilment_effort',
  differentiators: 'differentiators',
  proofPoints: 'proof_points',
  useCases: 'use_cases',
  objections: 'objections',
  addOns: 'add_ons',
};

export async function updateOffering(
  workspaceId: string,
  offeringId: string,
  input: UpdateOfferingInput
) {
  const update = buildUpdateSet(input, offeringUpdateColumns, 2);
  const { rows } = await query<Offering>(
    `UPDATE workspace_offerings
     SET ${update.assignments.join(', ')}
     WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
     RETURNING ${offeringSelect}`,
    [workspaceId, offeringId, ...update.values]
  );
  return rows[0];
}

export async function archiveOffering(workspaceId: string, offeringId: string) {
  const { rowCount } = await query(
    `UPDATE workspace_offerings
     SET deleted_at = NOW(), status = 'archived'
     WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [workspaceId, offeringId]
  );
  return rowCount > 0;
}

export async function listCustomerSegments(workspaceId: string) {
  const { rows } = await query<CustomerSegment>(
    `SELECT ${customerSegmentSelect}
     FROM workspace_customer_segments
     WHERE workspace_id = $1 AND deleted_at IS NULL
     ORDER BY primary_segment DESC, sort_order, created_at`,
    [workspaceId]
  );
  return rows;
}

export async function createCustomerSegment(workspaceId: string, input: CreateCustomerSegmentInput) {
  const { rows } = await query<CustomerSegment>(
    `INSERT INTO workspace_customer_segments (
       workspace_id, name, industry, company_size, region, maturity_level,
       pain_points, jobs_to_be_done, decision_criteria, use_cases, buying_roles,
       price_sensitivity, primary_segment, sort_order, notes
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11,
       $12, $13, $14, $15
     )
     RETURNING ${customerSegmentSelect}`,
    [
      workspaceId,
      input.name,
      input.industry ?? null,
      input.companySize ?? null,
      input.region ?? null,
      input.maturityLevel ?? null,
      input.painPoints ?? [],
      input.jobsToBeDone ?? [],
      input.decisionCriteria ?? [],
      input.useCases ?? [],
      input.buyingRoles ?? [],
      input.priceSensitivity ?? null,
      input.primarySegment ?? false,
      input.sortOrder ?? 0,
      input.notes ?? null,
    ]
  );
  return rows[0];
}

const customerSegmentUpdateColumns: Partial<Record<keyof UpdateCustomerSegmentInput, string>> = {
  name: 'name',
  industry: 'industry',
  companySize: 'company_size',
  region: 'region',
  maturityLevel: 'maturity_level',
  painPoints: 'pain_points',
  jobsToBeDone: 'jobs_to_be_done',
  decisionCriteria: 'decision_criteria',
  useCases: 'use_cases',
  buyingRoles: 'buying_roles',
  priceSensitivity: 'price_sensitivity',
  primarySegment: 'primary_segment',
  sortOrder: 'sort_order',
  notes: 'notes',
};

export async function updateCustomerSegment(
  workspaceId: string,
  customerSegmentId: string,
  input: UpdateCustomerSegmentInput
) {
  const update = buildUpdateSet(input, customerSegmentUpdateColumns, 2);
  const { rows } = await query<CustomerSegment>(
    `UPDATE workspace_customer_segments
     SET ${update.assignments.join(', ')}
     WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
     RETURNING ${customerSegmentSelect}`,
    [workspaceId, customerSegmentId, ...update.values]
  );
  return rows[0];
}

export async function archiveCustomerSegment(workspaceId: string, customerSegmentId: string) {
  const { rowCount } = await query(
    `UPDATE workspace_customer_segments
     SET deleted_at = NOW()
     WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [workspaceId, customerSegmentId]
  );
  return rowCount > 0;
}

export async function listCompetitors(workspaceId: string) {
  const { rows } = await query<Competitor>(
    `SELECT ${competitorSelect}
     FROM workspace_competitors
     WHERE workspace_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [workspaceId]
  );
  return rows;
}

export async function createCompetitor(workspaceId: string, input: CreateCompetitorInput) {
  const { rows } = await query<Competitor>(
    `INSERT INTO workspace_competitors (
       workspace_id, name, website_url, competitor_type, market, positioning,
       pricing_summary, strengths, weaknesses, differentiators, feature_overlap,
       threat_level, strategic_priority, source_quality, monitoring_frequency,
       notes, last_reviewed_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11,
       $12, $13, $14, $15,
       $16, $17
     )
     RETURNING ${competitorSelect}`,
    [
      workspaceId,
      input.name,
      input.websiteUrl ?? null,
      input.competitorType ?? 'direct',
      input.market ?? null,
      input.positioning ?? null,
      input.pricingSummary ?? null,
      input.strengths ?? [],
      input.weaknesses ?? [],
      input.differentiators ?? [],
      input.featureOverlap ?? [],
      input.threatLevel ?? null,
      input.strategicPriority ?? null,
      input.sourceQuality ?? null,
      input.monitoringFrequency ?? null,
      input.notes ?? null,
      input.lastReviewedAt ?? null,
    ]
  );
  return rows[0];
}

const competitorUpdateColumns: Partial<Record<keyof UpdateCompetitorInput, string>> = {
  name: 'name',
  websiteUrl: 'website_url',
  competitorType: 'competitor_type',
  market: 'market',
  positioning: 'positioning',
  pricingSummary: 'pricing_summary',
  strengths: 'strengths',
  weaknesses: 'weaknesses',
  differentiators: 'differentiators',
  featureOverlap: 'feature_overlap',
  threatLevel: 'threat_level',
  strategicPriority: 'strategic_priority',
  sourceQuality: 'source_quality',
  monitoringFrequency: 'monitoring_frequency',
  notes: 'notes',
  lastReviewedAt: 'last_reviewed_at',
};

export async function updateCompetitor(
  workspaceId: string,
  competitorId: string,
  input: UpdateCompetitorInput
) {
  const update = buildUpdateSet(input, competitorUpdateColumns, 2);
  const { rows } = await query<Competitor>(
    `UPDATE workspace_competitors
     SET ${update.assignments.join(', ')}
     WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
     RETURNING ${competitorSelect}`,
    [workspaceId, competitorId, ...update.values]
  );
  return rows[0];
}

export async function archiveCompetitor(workspaceId: string, competitorId: string) {
  const { rowCount } = await query(
    `UPDATE workspace_competitors
     SET deleted_at = NOW()
     WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [workspaceId, competitorId]
  );
  return rowCount > 0;
}

function titleCase(value: string | null | undefined) {
  if (!value) return null;
  return value
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export async function replaceGeneratedCompetitors(
  workspaceId: string,
  userId: string,
  competitors: GeneratedCompetitorInput[]
) {
  return withTransaction(async (client) => {
    await query(
      `UPDATE workspace_competitors
       SET deleted_at = NOW()
       WHERE workspace_id = $1 AND deleted_at IS NULL`,
      [workspaceId],
      client
    );

    await query(
      `UPDATE workspace_records
       SET deleted_at = NOW(),
           updated_by = $2,
           version = version + 1
       WHERE workspace_id = $1
         AND resource_type = 'marketing_competitors'
         AND deleted_at IS NULL`,
      [workspaceId, userId],
      client
    );

    const created: Competitor[] = [];
    for (const competitor of competitors) {
      const { rows } = await query<Competitor>(
        `INSERT INTO workspace_competitors (
           workspace_id, name, website_url, competitor_type, market, positioning,
           pricing_summary, strengths, weaknesses, differentiators, feature_overlap,
           threat_level, strategic_priority, source_quality, monitoring_frequency,
           notes, last_reviewed_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11,
           $12, $13, $14, $15,
           $16, $17
         )
         RETURNING ${competitorSelect}`,
        [
          workspaceId,
          competitor.name,
          competitor.websiteUrl,
          competitor.competitorType,
          competitor.market,
          competitor.positioning,
          competitor.pricingSummary,
          competitor.strengths,
          competitor.weaknesses,
          competitor.differentiators,
          competitor.featureOverlap,
          competitor.threatLevel,
          competitor.strategicPriority,
          competitor.sourceQuality,
          competitor.monitoringFrequency,
          competitor.notes,
          competitor.lastReviewedAt,
        ],
        client
      );
      const createdCompetitor = rows[0];
      if (!createdCompetitor) continue;
      created.push(createdCompetitor);

      await query(
        `INSERT INTO workspace_records (
           workspace_id, resource_type, name, description, status, stage,
           external_id, source, tags, data, created_by, updated_by
         ) VALUES (
           $1, 'marketing_competitors', $2, $3, 'active', $4,
           NULL, 'ai_competitor_discovery', $5, $6::jsonb, $7, $7
         )`,
        [
          workspaceId,
          competitor.name,
          competitor.notes ?? competitor.positioning,
          competitor.threatLevel,
          ['ai-generated', 'competitor-discovery', competitor.competitorType],
          JSON.stringify({
            competitorId: createdCompetitor.id,
            rank: competitor.rank,
            name: competitor.name,
            type: titleCase(competitor.competitorType) ?? 'Direct',
            market: competitor.market ?? '—',
            position: titleCase(competitor.competitivePosition) ?? 'Peer',
            growth: competitor.growth ?? 'Stable',
            visibility: competitor.visibility ?? 'High',
            priority: titleCase(competitor.strategicPriority) ?? 'High',
            intelligence: titleCase(competitor.intelligence) ?? 'Partial',
            updated: new Date().toISOString(),
            websiteUrl: competitor.websiteUrl,
            positioning: competitor.positioning,
            strengths: competitor.strengths,
            weaknesses: competitor.weaknesses,
            differentiators: competitor.differentiators,
            featureOverlap: competitor.featureOverlap,
            sourceQuality: competitor.sourceQuality,
          }),
          userId,
        ],
        client
      );
    }

    return created;
  });
}

export async function listPlatforms(workspaceId: string) {
  const { rows } = await query<Platform>(
    `SELECT ${platformSelect}
     FROM workspace_platforms
     WHERE workspace_id = $1 AND deleted_at IS NULL
     ORDER BY created_at`,
    [workspaceId]
  );
  return rows;
}

export async function createPlatform(workspaceId: string, input: CreatePlatformInput) {
  const { rows } = await query<Platform>(
    `INSERT INTO workspace_platforms (
       workspace_id, integration_key, name, category, connection_status,
       external_account_id, granted_scopes, secret_reference, settings
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${platformSelect}`,
    [
      workspaceId,
      input.integrationKey ?? null,
      input.name,
      input.category ?? 'custom',
      input.connectionStatus ?? 'not_connected',
      input.externalAccountId ?? null,
      input.grantedScopes ?? [],
      input.secretReference ?? null,
      input.settings ?? {},
    ]
  );
  return rows[0];
}

const platformUpdateColumns: Partial<Record<keyof UpdatePlatformInput, string>> = {
  integrationKey: 'integration_key',
  name: 'name',
  category: 'category',
  connectionStatus: 'connection_status',
  externalAccountId: 'external_account_id',
  grantedScopes: 'granted_scopes',
  secretReference: 'secret_reference',
  settings: 'settings',
};

export async function updatePlatform(
  workspaceId: string,
  platformId: string,
  input: UpdatePlatformInput
) {
  const update = buildUpdateSet(input, platformUpdateColumns, 2);
  const { rows } = await query<Platform>(
    `UPDATE workspace_platforms
     SET ${update.assignments.join(', ')}
     WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL
     RETURNING ${platformSelect}`,
    [workspaceId, platformId, ...update.values]
  );
  return rows[0];
}

export async function archivePlatform(workspaceId: string, platformId: string) {
  const { rowCount } = await query(
    `UPDATE workspace_platforms
     SET deleted_at = NOW(), connection_status = 'disconnected'
     WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [workspaceId, platformId]
  );
  return rowCount > 0;
}

export type AiPreferences = AiPreferencesInput & { workspaceId: string; createdAt: string; updatedAt: string };

const aiPreferencesSelect = `
  workspace_id AS "workspaceId",
  business_priorities AS "businessPriorities",
  priority_order AS "priorityOrder",
  recommendation_style AS "recommendationStyle",
  risk_tolerance AS "riskTolerance",
  action_level AS "actionLevel",
  communication_style AS "communicationStyle",
  insight_detail AS "insightDetail",
  recommendation_frequency AS "recommendationFrequency",
  task_creation_mode AS "taskCreationMode",
  detection_settings AS "detectionSettings",
  search_priorities AS "searchPriorities",
  approval_preferences AS "approvalPreferences",
  approval_threshold AS "approvalThreshold",
  notification_preferences AS "notificationPreferences",
  notification_channels AS "notificationChannels",
  business_hours AS "businessHours",
  response_language AS "responseLanguage",
  transparency_settings AS "transparencySettings",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export async function getAiPreferences(workspaceId: string) {
  const { rows } = await query<AiPreferences>(
    `SELECT ${aiPreferencesSelect}
     FROM workspace_ai_preferences
     WHERE workspace_id = $1`,
    [workspaceId]
  );
  return rows[0];
}

export async function saveAiPreferences(workspaceId: string, input: AiPreferencesInput) {
  const { rows } = await query<AiPreferences>(
    `INSERT INTO workspace_ai_preferences (
       workspace_id, business_priorities, priority_order, recommendation_style,
       risk_tolerance, action_level, communication_style, insight_detail,
       recommendation_frequency, task_creation_mode, detection_settings,
       search_priorities, approval_preferences, approval_threshold,
       notification_preferences, notification_channels, business_hours,
       response_language, transparency_settings
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
     )
     ON CONFLICT (workspace_id) DO UPDATE SET
       business_priorities = EXCLUDED.business_priorities,
       priority_order = EXCLUDED.priority_order,
       recommendation_style = EXCLUDED.recommendation_style,
       risk_tolerance = EXCLUDED.risk_tolerance,
       action_level = EXCLUDED.action_level,
       communication_style = EXCLUDED.communication_style,
       insight_detail = EXCLUDED.insight_detail,
       recommendation_frequency = EXCLUDED.recommendation_frequency,
       task_creation_mode = EXCLUDED.task_creation_mode,
       detection_settings = EXCLUDED.detection_settings,
       search_priorities = EXCLUDED.search_priorities,
       approval_preferences = EXCLUDED.approval_preferences,
       approval_threshold = EXCLUDED.approval_threshold,
       notification_preferences = EXCLUDED.notification_preferences,
       notification_channels = EXCLUDED.notification_channels,
       business_hours = EXCLUDED.business_hours,
       response_language = EXCLUDED.response_language,
       transparency_settings = EXCLUDED.transparency_settings
     RETURNING ${aiPreferencesSelect}`,
    [
      workspaceId,
      input.businessPriorities,
      input.priorityOrder,
      input.recommendationStyle,
      input.riskTolerance,
      input.actionLevel,
      input.communicationStyle,
      input.insightDetail,
      input.recommendationFrequency,
      input.taskCreationMode,
      input.detectionSettings,
      input.searchPriorities,
      input.approvalPreferences,
      input.approvalThreshold,
      input.notificationPreferences,
      input.notificationChannels,
      input.businessHours,
      input.responseLanguage,
      input.transparencySettings,
    ]
  );
  return rows[0];
}

export async function getCompletionState(workspaceId: string) {
  const { rows } = await query<{
    onboardingCompletedAt: string | null;
    hasCompanyInformation: boolean;
    hasBusinessDescription: boolean;
    offeringCount: number;
    hasAiPreferences: boolean;
    hasBillingConfirmation: boolean;
  }>(
    `SELECT
       w.onboarding_completed_at AS "onboardingCompletedAt",
       (w.name IS NOT NULL AND trim(w.name) <> '') AS "hasCompanyInformation",
       (w.business_description IS NOT NULL AND trim(w.business_description) <> '') AS "hasBusinessDescription",
       (SELECT count(*)::int FROM workspace_offerings o WHERE o.workspace_id = w.id AND o.deleted_at IS NULL) AS "offeringCount",
       EXISTS (SELECT 1 FROM workspace_ai_preferences p WHERE p.workspace_id = w.id) AS "hasAiPreferences",
       EXISTS (
         SELECT 1 FROM workspace_subscriptions s
         WHERE s.workspace_id = w.id
           AND s.status = 'active'
           AND s.provider IN ('internal', 'airwallex')
           AND s.plan_key IN ('viewer', 'starter', 'ai', 'test')
       ) AS "hasBillingConfirmation"
     FROM workspaces w
     WHERE w.id = $1 AND w.deleted_at IS NULL`,
    [workspaceId]
  );
  return rows[0];
}

export async function completeOnboarding(workspaceId: string) {
  await query(
    `UPDATE workspaces
     SET onboarding_step = 'setup_complete', onboarding_completed_at = COALESCE(onboarding_completed_at, NOW())
     WHERE id = $1 AND deleted_at IS NULL`,
    [workspaceId]
  );
}

export async function setOnboardingStep(workspaceId: string, step: string) {
  await query(
    `UPDATE workspaces
     SET onboarding_step = $2
     WHERE id = $1 AND deleted_at IS NULL AND onboarding_completed_at IS NULL`,
    [workspaceId, step]
  );
}


export type OnboardingDocument = {
  id: string;
  workspaceId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
};

const onboardingDocumentSelect = `
  id,
  workspace_id AS "workspaceId",
  file_name AS "fileName",
  mime_type AS "mimeType",
  size_bytes AS "sizeBytes",
  created_at AS "createdAt"
`;

export async function listOnboardingDocuments(workspaceId: string) {
  const { rows } = await query<OnboardingDocument>(
    `SELECT ${onboardingDocumentSelect}
     FROM onboarding_documents
     WHERE workspace_id = $1
     ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows;
}

export async function createOnboardingDocument(input: {
  id: string;
  workspaceId: string;
  uploadedBy: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  content: Buffer;
}) {
  const { rows } = await query<OnboardingDocument>(
    `INSERT INTO onboarding_documents (id, workspace_id, uploaded_by, file_name, mime_type, size_bytes, storage_key, content)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${onboardingDocumentSelect}`,
    [input.id, input.workspaceId, input.uploadedBy, input.fileName, input.mimeType, input.sizeBytes, input.storageKey, input.content],
  );
  return rows[0];
}

export async function getOnboardingDocumentContent(workspaceId: string, documentId: string) {
  const { rows } = await query<{
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string | null;
    content: Buffer | null;
  }>(
    `SELECT file_name AS "fileName", mime_type AS "mimeType", size_bytes AS "sizeBytes", storage_key AS "storageKey", content
     FROM onboarding_documents
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, documentId],
  );
  return rows[0];
}

export async function deleteOnboardingDocument(workspaceId: string, documentId: string) {
  const { rowCount } = await query(
    `DELETE FROM onboarding_documents
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, documentId],
  );
  return rowCount > 0;
}


export type PlatformOAuthCredentialInput = {
  workspaceId: string;
  integrationKey: string;
  name: string;
  category: string;
  externalAccountId: string | null;
  grantedScopes: string[];
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  tokenExpiresAt: string | null;
  settings: Record<string, unknown>;
};

export async function upsertPlatformOAuthCredential(input: PlatformOAuthCredentialInput) {
  const connectionStatus = 'connected';
  const existing = await query<{ id: string }>(
    `SELECT id FROM workspace_platforms
     WHERE workspace_id = $1 AND integration_key = $2 AND deleted_at IS NULL
     LIMIT 1`,
    [input.workspaceId, input.integrationKey]
  );

  let platformId = existing.rows[0]?.id;
  if (platformId) {
    await query(
      `UPDATE workspace_platforms
       SET name = $3,
           category = $4,
           connection_status = $5,
           external_account_id = $6,
           granted_scopes = $7,
           settings = $8,
           last_error = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [input.workspaceId, platformId, input.name, input.category, connectionStatus, input.externalAccountId, input.grantedScopes, input.settings]
    );
  } else {
    const created = await query<{ id: string }>(
      `INSERT INTO workspace_platforms (
         workspace_id, integration_key, name, category, connection_status,
         external_account_id, granted_scopes, settings
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [input.workspaceId, input.integrationKey, input.name, input.category, connectionStatus, input.externalAccountId, input.grantedScopes, input.settings]
    );
    platformId = created.rows[0]?.id;
  }

  if (!platformId) throw new Error('Could not create platform connection');

  await query(
    `INSERT INTO workspace_platform_oauth_credentials (
       platform_id, provider, encrypted_access_token, encrypted_refresh_token, token_expires_at
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (platform_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       encrypted_access_token = EXCLUDED.encrypted_access_token,
       encrypted_refresh_token = COALESCE(EXCLUDED.encrypted_refresh_token, workspace_platform_oauth_credentials.encrypted_refresh_token),
       token_expires_at = EXCLUDED.token_expires_at,
       updated_at = NOW()`,
    [platformId, input.integrationKey, input.encryptedAccessToken, input.encryptedRefreshToken, input.tokenExpiresAt]
  );

  const { rows } = await query<Platform>(
    `SELECT ${platformSelect} FROM workspace_platforms WHERE id = $1`,
    [platformId]
  );
  return rows[0];
}

export async function getPlatformOAuthCredential(workspaceId: string, integrationKey: string) {
  const { rows } = await query<{
    platformId: string;
    provider: string;
    encryptedAccessToken: string;
    encryptedRefreshToken: string | null;
    tokenExpiresAt: string | null;
  }>(
    `SELECT p.id AS "platformId",
            c.provider,
            c.encrypted_access_token AS "encryptedAccessToken",
            c.encrypted_refresh_token AS "encryptedRefreshToken",
            c.token_expires_at AS "tokenExpiresAt"
     FROM workspace_platforms p
     JOIN workspace_platform_oauth_credentials c ON c.platform_id = p.id
     WHERE p.workspace_id = $1 AND p.integration_key = $2 AND p.deleted_at IS NULL`,
    [workspaceId, integrationKey]
  );
  return rows[0] ?? null;
}

export async function updatePlatformOAuthTokens(input: {
  workspaceId: string;
  integrationKey: string;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  tokenExpiresAt: string | null;
}) {
  await query(
    `UPDATE workspace_platform_oauth_credentials c
     SET encrypted_access_token = $3,
         encrypted_refresh_token = COALESCE($4, c.encrypted_refresh_token),
         token_expires_at = $5,
         updated_at = NOW()
     FROM workspace_platforms p
     WHERE c.platform_id = p.id
       AND p.workspace_id = $1
       AND p.integration_key = $2
       AND p.deleted_at IS NULL`,
    [input.workspaceId, input.integrationKey, input.encryptedAccessToken, input.encryptedRefreshToken, input.tokenExpiresAt]
  );
  await markPlatformConnected(input.workspaceId, input.integrationKey);
}

export async function markPlatformConnectionError(workspaceId: string, integrationKey: string, message: string) {
  await query(
    `UPDATE workspace_platforms
     SET connection_status = 'error', last_error = $3, updated_at = NOW()
     WHERE workspace_id = $1 AND integration_key = $2 AND deleted_at IS NULL`,
    [workspaceId, integrationKey, message.slice(0, 2_000)]
  );
}

export async function markPlatformConnected(workspaceId: string, integrationKey: string) {
  await query(
    `UPDATE workspace_platforms
     SET connection_status = 'connected', last_error = NULL, updated_at = NOW()
     WHERE workspace_id = $1 AND integration_key = $2 AND deleted_at IS NULL`,
    [workspaceId, integrationKey]
  );
}

export async function removePlatformByIntegration(workspaceId: string, integrationKey: string) {
  const result = await query(
    `DELETE FROM workspace_platforms
     WHERE workspace_id = $1 AND integration_key = $2`,
    [workspaceId, integrationKey]
  );
  return result.rowCount ?? 0;
}

export async function archivePlatformByIntegration(workspaceId: string, integrationKey: string, message: string) {
  await query(
    `UPDATE workspace_platforms
     SET connection_status = 'not_connected', last_error = $3, deleted_at = NOW(), updated_at = NOW()
     WHERE workspace_id = $1 AND integration_key = $2 AND deleted_at IS NULL`,
    [workspaceId, integrationKey, message.slice(0, 2_000)]
  );
}
