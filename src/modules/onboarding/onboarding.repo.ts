import { query, withTransaction } from '../../db/pool.js';
import { rotateStoredCredentials } from '../security/provider-credential.service.js';
import { buildUpdateSet } from '../../db/update-builder.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import { AppError } from '../../utils/app-error.js';
import { syncLegacyControlStatus, upsertLegacyPlatformControlConnection } from '../provider-control/provider.repo.js';
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
         country_region = $4,
         tax_id = $5,
         address = $6,
         onboarding_step = CASE
           WHEN onboarding_completed_at IS NULL AND onboarding_step='company_information' THEN 'billing'
           ELSE onboarding_step
         END
     WHERE id = $1 AND deleted_at IS NULL`,
    [workspaceId, input.companyName, input.industry, input.countryRegion, input.taxId, input.address]
  );
}

export const saveBusinessDescriptionSql = `
  UPDATE workspaces
     SET business_description = $2,
         value_proposition = $3,
         target_market = $4,
         short_brand_description = $5,
         positioning_tags = $6,
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

export async function replaceGeneratedCustomerSegments(
  workspaceId: string,
  segments: AiGeneratedCustomerSegment[],
) {
  return withTransaction(async (client) => {
    await query(
      `UPDATE workspace_customer_segments
       SET deleted_at = NOW()
       WHERE workspace_id = $1 AND deleted_at IS NULL`,
      [workspaceId],
      client,
    );

    const created: CustomerSegment[] = [];
    for (const [index, segment] of segments.entries()) {
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
          segment.name,
          segment.industry ?? null,
          segment.companySize ?? null,
          segment.region ?? null,
          segment.maturityLevel ?? null,
          segment.painPoints,
          segment.jobsToBeDone,
          segment.decisionCriteria,
          segment.useCases,
          segment.buyingRoles,
          segment.priceSensitivity ?? null,
          segment.primarySegment,
          index,
          segment.notes ?? null,
        ],
        client,
      );
      if (rows[0]) created.push(rows[0]);
    }
    return created;
  });
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
  if (rows[0] && input.connectionStatus !== undefined) {
    await syncLegacyControlStatus({ sourceType: 'workspace_platform', sourceId: rows[0].id, status: rows[0].connectionStatus, lastSyncedAt: rows[0].lastSyncedAt, lastError: rows[0].lastError });
  }
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
  if (rowCount > 0) await syncLegacyControlStatus({ sourceType: 'workspace_platform', sourceId: platformId, status: 'disconnected' });
  return rowCount > 0;
}

export type BusinessContextDefaults = {
  businessDescription: string;
  valueProposition: string;
  targetMarket: string;
  shortBrandDescription: string;
  positioningTags: string[];
  primaryIcp: string;
  usp: string;
  mission: string;
  vision: string;
  primaryChallenges: string[];
  languages: string[];
};

/**
 * Make the business context usable immediately after account activation.
 *
 * These are deliberately conservative drafts derived only from verified
 * company information. They never overwrite a value entered by the customer;
 * the later AI enrichment may replace only values that still equal these
 * drafts.
 */
export async function ensureBusinessContextDefaults(workspaceId: string, defaults: BusinessContextDefaults) {
  const { rows } = await query(
    `UPDATE workspaces
        SET business_description = COALESCE(NULLIF(trim(business_description), ''), $2),
            value_proposition = COALESCE(NULLIF(trim(value_proposition), ''), $3),
            target_market = COALESCE(NULLIF(trim(target_market), ''), $4),
            short_brand_description = COALESCE(NULLIF(trim(short_brand_description), ''), $5),
            positioning_tags = CASE WHEN COALESCE(array_length(positioning_tags, 1), 0) = 0 THEN $6::text[] ELSE positioning_tags END,
            primary_icp = COALESCE(NULLIF(trim(primary_icp), ''), $7),
            usp = COALESCE(NULLIF(trim(usp), ''), $8),
            mission = COALESCE(NULLIF(trim(mission), ''), $9),
            vision = COALESCE(NULLIF(trim(vision), ''), $10),
            primary_challenges = CASE WHEN COALESCE(array_length(primary_challenges, 1), 0) = 0 THEN $11::text[] ELSE primary_challenges END,
            languages = CASE WHEN COALESCE(array_length(languages, 1), 0) = 0 THEN $12::text[] ELSE languages END,
            updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id`,
    [
      workspaceId,
      defaults.businessDescription,
      defaults.valueProposition,
      defaults.targetMarket,
      defaults.shortBrandDescription,
      defaults.positioningTags,
      defaults.primaryIcp,
      defaults.usp,
      defaults.mission,
      defaults.vision,
      defaults.primaryChallenges,
      defaults.languages,
    ],
  );
  return rows[0] ?? null;
}

export type RecommendedBusinessContext = Pick<
  BusinessContextDefaults,
  'valueProposition' | 'targetMarket' | 'shortBrandDescription' | 'primaryIcp' | 'usp' | 'vision' | 'primaryChallenges' | 'languages'
>;

/** Apply AI recommendations without overwriting customer-entered values. */
export async function applyRecommendedBusinessContext(
  workspaceId: string,
  defaults: BusinessContextDefaults,
  recommended: RecommendedBusinessContext,
) {
  const { rowCount } = await query(
    `UPDATE workspaces
        SET value_proposition = CASE WHEN NULLIF(trim(value_proposition), '') IS NULL OR value_proposition = $2 THEN $3 ELSE value_proposition END,
            target_market = CASE WHEN NULLIF(trim(target_market), '') IS NULL OR target_market = $4 THEN $5 ELSE target_market END,
            short_brand_description = CASE WHEN NULLIF(trim(short_brand_description), '') IS NULL OR short_brand_description = $6 THEN $7 ELSE short_brand_description END,
            primary_icp = CASE WHEN NULLIF(trim(primary_icp), '') IS NULL OR primary_icp = $8 THEN $9 ELSE primary_icp END,
            usp = CASE WHEN NULLIF(trim(usp), '') IS NULL OR usp = $10 THEN $11 ELSE usp END,
            vision = CASE WHEN NULLIF(trim(vision), '') IS NULL OR vision = $12 THEN $13 ELSE vision END,
            primary_challenges = CASE WHEN COALESCE(array_length(primary_challenges, 1), 0) = 0 OR primary_challenges = $14::text[] THEN $15::text[] ELSE primary_challenges END,
            languages = CASE WHEN COALESCE(array_length(languages, 1), 0) = 0 OR languages = $16::text[] THEN $17::text[] ELSE languages END,
            updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL`,
    [
      workspaceId,
      defaults.valueProposition,
      recommended.valueProposition,
      defaults.targetMarket,
      recommended.targetMarket,
      defaults.shortBrandDescription,
      recommended.shortBrandDescription,
      defaults.primaryIcp,
      recommended.primaryIcp,
      defaults.usp,
      recommended.usp,
      defaults.vision,
      recommended.vision,
      defaults.primaryChallenges,
      recommended.primaryChallenges,
      defaults.languages,
      recommended.languages,
    ],
  );
  return rowCount > 0;
}

export type AiPreferences = AiPreferencesInput & { workspaceId: string; createdAt: string; updatedAt: string };

export type AiBusinessProfileSuggestion = {
  value: string;
  whyItFits: string;
  competitorGap: string;
  score: number;
};

export type AiBusinessProfileCompetitorComparison = {
  name: string;
  websiteUrl: string | null;
  competitorType: string | null;
  market: string | null;
  positioning: string | null;
  strengths: string[];
  weaknesses: string[];
  whitespace: string[];
  whyYouCanWin: string;
};

export type AiGeneratedCustomerSegment = {
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
  notes: string | null;
  score: number;
  whyItFits: string;
};

export type AiBusinessProfilePayload = {
  summary: string;
  recommendedProfile: {
    valueProposition: string;
    vision: string;
    targetMarket: string;
    primaryIcp: string;
    usp: string;
    shortBrandDescription: string;
    primaryChallenges: string[];
    languages: string[];
  };
  suggestions: {
    valuePropositions: AiBusinessProfileSuggestion[];
    visions: AiBusinessProfileSuggestion[];
    targetMarkets: AiBusinessProfileSuggestion[];
    primaryIcps: AiBusinessProfileSuggestion[];
    usps: AiBusinessProfileSuggestion[];
    shortBrandDescriptions: AiBusinessProfileSuggestion[];
    primaryChallenges: AiBusinessProfileSuggestion[];
    languages: AiBusinessProfileSuggestion[];
  };
  customerSegments: AiGeneratedCustomerSegment[];
  competitorComparison: AiBusinessProfileCompetitorComparison[];
};

export type AiBusinessProfile = {
  workspaceId: string;
  payload: AiBusinessProfilePayload;
  model: string | null;
  generatedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

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

const aiBusinessProfileSelect = `
  workspace_id AS "workspaceId",
  payload,
  model,
  generated_at AS "generatedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export async function getAiBusinessProfile(workspaceId: string) {
  const { rows } = await query<AiBusinessProfile>(
    `SELECT ${aiBusinessProfileSelect}
     FROM workspace_ai_business_profiles
     WHERE workspace_id = $1`,
    [workspaceId],
  );
  return rows[0] ?? null;
}

export async function saveAiBusinessProfile(input: {
  workspaceId: string;
  payload: AiBusinessProfilePayload;
  model?: string | null;
  generatedAt?: string | null;
}) {
  const { rows } = await query<AiBusinessProfile>(
    `INSERT INTO workspace_ai_business_profiles (
       workspace_id, payload, model, generated_at
     ) VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (workspace_id) DO UPDATE SET
       payload = EXCLUDED.payload,
       model = EXCLUDED.model,
       generated_at = EXCLUDED.generated_at,
       updated_at = NOW()
     RETURNING ${aiBusinessProfileSelect}`,
    [
      input.workspaceId,
      JSON.stringify(input.payload),
      input.model ?? null,
      input.generatedAt ?? null,
    ],
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
    hasProfile: boolean;
    hasKnowledgeBase: boolean;
  }>(
    `SELECT
       w.onboarding_completed_at AS "onboardingCompletedAt",
       (w.name IS NOT NULL AND trim(w.name) <> '') AS "hasCompanyInformation",
       (
         (w.business_description IS NOT NULL AND trim(w.business_description) <> '')
         OR EXISTS (SELECT 1 FROM onboarding_documents d WHERE d.workspace_id = w.id)
       ) AS "hasBusinessDescription",
       (SELECT count(*)::int FROM workspace_offerings o WHERE o.workspace_id = w.id AND o.deleted_at IS NULL) AS "offeringCount",
       EXISTS (SELECT 1 FROM workspace_ai_preferences p WHERE p.workspace_id = w.id) AS "hasAiPreferences",
       EXISTS (
         SELECT 1 FROM workspace_subscriptions s
         WHERE s.workspace_id = w.id
           AND s.status = 'active'
           AND s.provider IN ('internal', 'airwallex')
           AND s.plan_key IN ('viewer', 'starter', 'ai', 'test')
       ) OR w.billing_skipped_at IS NOT NULL AS "hasBillingConfirmation",
       w.profile_completed_at IS NOT NULL AS "hasProfile",
       w.knowledge_base_completed_at IS NOT NULL AS "hasKnowledgeBase"
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
  return withTransaction(async (client) => {
    const connectionStatus = 'connected';
    const existing = await query<{ id: string }>(
      `SELECT id FROM workspace_platforms
       WHERE workspace_id = $1 AND integration_key = $2 AND deleted_at IS NULL
       LIMIT 1`,
      [input.workspaceId, input.integrationKey],
      client,
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
        [input.workspaceId, platformId, input.name, input.category, connectionStatus, input.externalAccountId, input.grantedScopes, input.settings],
        client,
      );
    } else {
      const created = await query<{ id: string }>(
        `INSERT INTO workspace_platforms (
           workspace_id, integration_key, name, category, connection_status,
           external_account_id, granted_scopes, settings
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [input.workspaceId, input.integrationKey, input.name, input.category, connectionStatus, input.externalAccountId, input.grantedScopes, input.settings],
        client,
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
      [platformId, input.integrationKey, input.encryptedAccessToken, input.encryptedRefreshToken, input.tokenExpiresAt],
      client,
    );

    const { rows } = await query<Platform>(
      `SELECT ${platformSelect} FROM workspace_platforms WHERE id = $1`,
      [platformId],
      client,
    );
    const platform = rows[0];
    if (!platform) throw new Error('Platform connection insert did not return a row');
    await upsertLegacyPlatformControlConnection({
      workspaceId: input.workspaceId,
      platformId,
      integrationKey: input.integrationKey,
      name: input.name,
      category: input.category,
      connectionStatus,
      externalAccountId: input.externalAccountId,
      grantedScopes: input.grantedScopes,
      lastSyncedAt: platform.lastSyncedAt,
      lastError: platform.lastError,
      credentialReference: `workspace_platform_oauth_credentials:${platformId}`,
    }, client);
    await appendDomainEvent({
      workspaceId: input.workspaceId,
      type: DOMAIN_EVENT_TYPES.INTEGRATION_CONNECTED,
      aggregateType: 'workspace_platform',
      aggregateId: platformId,
      payload: {
        platformId,
        integrationKey: input.integrationKey,
        category: input.category,
        externalAccountId: input.externalAccountId,
      },
      metadata: { source: 'onboarding.oauth' },
    }, client);
    return platform;
  });
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
  return rows[0] ? rotateStoredCredentials('platform', workspaceId, rows[0].platformId, rows[0]) : null;
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
  const { rows } = await query<{ id: string }>(`SELECT id FROM workspace_platforms WHERE workspace_id=$1 AND integration_key=$2 AND deleted_at IS NULL`, [workspaceId, integrationKey]);
  for (const row of rows) await syncLegacyControlStatus({ sourceType: 'workspace_platform', sourceId: row.id, status: 'error', lastError: message });
}

export type CatalogImportJob = {
  id: string;
  workspaceId: string;
  activationId: string;
  attempts: number;
  maxAttempts: number;
  referenceDocumentIds: string[];
};

export type KnowledgeActivationImport = {
  id: string;
  workspaceId: string;
  userId: string;
  sourceText: string | null;
  sourceDocumentIds: string[];
  model: string | null;
  status: 'PROCESSING' | 'REVIEW_REQUIRED' | 'COMPLETED' | 'FAILED';
  classification: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CatalogImportEvidenceInput = {
  assetId: string;
  sourceDocumentId: string;
  kind: 'DOCUMENT_TEXT' | 'PDF_PAGE_TEXT' | 'PDF_IMAGE' | 'UPLOADED_IMAGE';
  pageNumber: number | null;
  mimeType: string | null;
  storageReference: string | null;
  extractedText: string;
  metadata: Record<string, unknown>;
};

export type CatalogImportEvidence = CatalogImportEvidenceInput & { id: string };

export async function createKnowledgeActivation(input:{workspaceId:string;userId:string;text:string;documentIds:string[];referenceDocumentIds?:string[];model:string|null}) {
  return withTransaction(async client=>{
    const workspace=(await query<{step:string;profileCompletedAt:string|null}>(`SELECT onboarding_step AS step,profile_completed_at AS "profileCompletedAt" FROM workspaces WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,[input.workspaceId],client)).rows[0];
    if(!workspace||workspace.step!=='knowledge_base'||!workspace.profileCompletedAt)throw new AppError(409,'PROFILE_COMPLETION_REQUIRED','Complete the company profile before building the Knowledge Base.');
    await query(`UPDATE workspace_knowledge_activations SET status='FAILED',error_code='PROCESSING_TIMEOUT',error_message='A stale activation was safely released.' WHERE workspace_id=$1 AND status='PROCESSING' AND updated_at<NOW()-INTERVAL '15 minutes'`,[input.workspaceId],client);
    const active=(await query<{id:string}>(`SELECT id FROM workspace_knowledge_activations WHERE workspace_id=$1 AND status IN ('PROCESSING','REVIEW_REQUIRED') LIMIT 1`,[input.workspaceId],client)).rows[0];
    if(active)throw new AppError(409,'KNOWLEDGE_PROCESSING_IN_PROGRESS','The Knowledge Base is already being processed.');
    const {rows}=await query<{id:string}>(`INSERT INTO workspace_knowledge_activations(workspace_id,created_by,source_text,source_document_ids,model) VALUES($1,$2,$3,$4,$5) RETURNING id`,[input.workspaceId,input.userId,input.text||null,input.documentIds,input.model],client);
    const activationId=rows[0]!.id;
    await query(
      `INSERT INTO background_jobs(workspace_id,job_type,payload,max_attempts)
       VALUES($1,'catalog.import',jsonb_build_object('activationId',$2::text,'referenceDocumentIds',$3::jsonb),3)`,
      [input.workspaceId,activationId,JSON.stringify(input.referenceDocumentIds ?? [])],client,
    );
    await appendDomainEvent({
      workspaceId: input.workspaceId,
      type: DOMAIN_EVENT_TYPES.CATALOG_IMPORT_REQUESTED,
      aggregateType: 'workspace_knowledge_activation',
      aggregateId: activationId,
      payload: { activationId, documentCount: input.documentIds.length },
      metadata: { actorId: input.userId, source: 'onboarding.catalog-import' },
      idempotencyKey: `catalog-import:${activationId}:requested`,
    }, client);
    return activationId;
  });
}

export async function failKnowledgeActivation(id:string,error:unknown) {
  const code=error instanceof Error&&'code' in error?String((error as Error&{code:unknown}).code):'KNOWLEDGE_PROCESSING_FAILED';
  const message=error instanceof Error?error.message:'Unknown knowledge processing error';
  await query(`UPDATE workspace_knowledge_activations SET status='FAILED',error_code=$2,error_message=$3 WHERE id=$1`,[id,code.slice(0,120),message.slice(0,2000)]);
}

export async function claimNextCatalogImportJob(workerId: string, leaseSeconds: number) {
  return withTransaction(async (client) => {
    const { rows } = await query<CatalogImportJob>(
      `WITH candidate AS (
         SELECT id
           FROM background_jobs
          WHERE job_type='catalog.import'
            AND attempts < max_attempts
            AND (
              (status='queued' AND scheduled_at <= NOW())
              OR (status='running' AND COALESCE(heartbeat_at,started_at,updated_at) < NOW() - ($1::int * INTERVAL '1 second'))
            )
          ORDER BY scheduled_at,created_at,id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE background_jobs job
          SET status='running',attempts=job.attempts+1,started_at=NOW(),heartbeat_at=NOW(),worker_id=$2,
              completed_at=NULL,error_message=NULL,updated_at=NOW()
         FROM candidate
        WHERE job.id=candidate.id
      RETURNING job.id,job.workspace_id AS "workspaceId",job.payload->>'activationId' AS "activationId",job.attempts,job.max_attempts AS "maxAttempts",
                COALESCE(job.payload->'referenceDocumentIds','[]'::jsonb) AS "referenceDocumentIds"`,
      [leaseSeconds, workerId], client,
    );
    return rows[0] ?? null;
  });
}

export async function heartbeatCatalogImportJob(jobId: string, workerId: string) {
  await query(
    `UPDATE background_jobs SET heartbeat_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND job_type='catalog.import' AND status='running' AND worker_id=$2`,
    [jobId, workerId],
  );
}

export async function getKnowledgeActivationImport(workspaceId: string, activationId: string) {
  const { rows } = await query<KnowledgeActivationImport>(
    `SELECT id,workspace_id AS "workspaceId",created_by AS "userId",source_text AS "sourceText",source_document_ids AS "sourceDocumentIds",
            model,status,classification,error_code AS "errorCode",error_message AS "errorMessage",completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt"
       FROM workspace_knowledge_activations
      WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, activationId],
  );
  return rows[0] ?? null;
}

export async function saveCatalogImportEvidence(input: { workspaceId: string; activationId: string; evidence: CatalogImportEvidenceInput[] }) {
  if (!input.evidence.length) return;
  await withTransaction(async (client) => {
    for (const evidence of input.evidence.slice(0, 240)) {
      await query(
        `INSERT INTO catalog_import_evidence(
           workspace_id,activation_id,source_document_id,asset_id,evidence_kind,page_number,mime_type,storage_reference,extracted_text,metadata
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT(activation_id,asset_id) DO UPDATE SET
           source_document_id=EXCLUDED.source_document_id,evidence_kind=EXCLUDED.evidence_kind,page_number=EXCLUDED.page_number,
           mime_type=EXCLUDED.mime_type,storage_reference=COALESCE(EXCLUDED.storage_reference,catalog_import_evidence.storage_reference),
           extracted_text=EXCLUDED.extracted_text,metadata=EXCLUDED.metadata`,
        [input.workspaceId,input.activationId,evidence.sourceDocumentId,evidence.assetId,evidence.kind,evidence.pageNumber,evidence.mimeType,
          evidence.storageReference,evidence.extractedText.slice(0,12_000),JSON.stringify(evidence.metadata)], client,
      );
    }
  });
}

export async function listCatalogImportEvidence(workspaceId: string, activationId: string, assetIds?: string[]) {
  const values: unknown[] = [workspaceId, activationId];
  const filter = assetIds?.length ? (values.push(assetIds), ` AND asset_id = ANY($3::text[])`) : '';
  const { rows } = await query<CatalogImportEvidence>(
    `SELECT id,source_document_id AS "sourceDocumentId",asset_id AS "assetId",evidence_kind AS kind,page_number AS "pageNumber",mime_type AS "mimeType",
            storage_reference AS "storageReference",extracted_text AS "extractedText",metadata
       FROM catalog_import_evidence
      WHERE workspace_id=$1 AND activation_id=$2${filter}
      ORDER BY page_number NULLS LAST,asset_id`, values,
  );
  return rows;
}

export async function markKnowledgeActivationReviewRequired(input: { workspaceId: string; activationId: string; classification: Record<string, unknown> }) {
  const { rows } = await query<KnowledgeActivationImport>(
    `UPDATE workspace_knowledge_activations
        SET status='REVIEW_REQUIRED',classification=$3::jsonb,error_code=NULL,error_message=NULL
      WHERE workspace_id=$1 AND id=$2 AND status='PROCESSING'
      RETURNING id,workspace_id AS "workspaceId",created_by AS "userId",source_text AS "sourceText",source_document_ids AS "sourceDocumentIds",
                model,status,classification,error_code AS "errorCode",error_message AS "errorMessage",completed_at AS "completedAt",created_at AS "createdAt",updated_at AS "updatedAt"`,
    [input.workspaceId,input.activationId,JSON.stringify(input.classification)],
  );
  return rows[0] ?? null;
}

export async function finishCatalogImportJob(input: { job: CatalogImportJob; workerId: string; error?: { code: string; message: string; retryable: boolean } }) {
  if (!input.error) {
    await query(
      `UPDATE background_jobs SET status='succeeded',result=jsonb_build_object('activationId',$3::text,'status','REVIEW_REQUIRED'),completed_at=NOW(),worker_id=NULL,heartbeat_at=NULL,updated_at=NOW()
        WHERE id=$1 AND job_type='catalog.import' AND status='running' AND worker_id=$2`,
      [input.job.id,input.workerId,input.job.activationId],
    );
    return;
  }
  const retry = input.error.retryable && input.job.attempts < input.job.maxAttempts;
  await query(
    `UPDATE background_jobs
        SET status=CASE WHEN $4 THEN 'queued' ELSE 'failed' END,
            scheduled_at=CASE WHEN $4 THEN NOW() + (LEAST(300,5 * (2 ^ GREATEST(0,attempts-1)))::text || ' seconds')::interval ELSE scheduled_at END,
            error_message=$3,completed_at=CASE WHEN $4 THEN NULL ELSE NOW() END,worker_id=NULL,heartbeat_at=NULL,
            result=CASE WHEN $4 THEN NULL ELSE jsonb_build_object('code',$5::text) END,updated_at=NOW()
      WHERE id=$1 AND job_type='catalog.import' AND status='running' AND worker_id=$2`,
    [input.job.id,input.workerId,input.error.message.slice(0,2_000),retry,input.error.code.slice(0,120)],
  );
  if (!retry) await failKnowledgeActivation(input.job.activationId, Object.assign(new Error(input.error.message), { code: input.error.code }));
}

export type CatalogVariantAttribute = { name: string; value: string; unit: string | null };
export type CatalogVariant = {
  name: string;
  sku: string | null;
  description: string | null;
  price: number | null;
  currency: string | null;
  attributes: CatalogVariantAttribute[];
  barcode?: string | null;
  weight?: number | null;
  weightUnit?: string | null;
  dimensionLength?: number | null;
  dimensionWidth?: number | null;
  dimensionHeight?: number | null;
  dimensionUnit?: string | null;
  moqQuantity?: number | null;
  moqUnit?: string | null;
  leadTimeMinDays?: number | null;
  leadTimeMaxDays?: number | null;
  imageEvidenceIds?: string[];
};
export type KnowledgeClassificationItem = {
  name: string;
  kind: 'product'|'service'|'other';
  productType: 'PHYSICAL_PRODUCT'|'DIGITAL_PRODUCT'|'OTHER'|null;
  description: string|null;
  category: string|null;
  price: number|null;
  currency: string|null;
  sku?: string | null;
  moqQuantity?: number | null;
  moqUnit?: string | null;
  leadTimeMinDays?: number | null;
  leadTimeMaxDays?: number | null;
  countryOfOrigin?: string | null;
  hsCode?: string | null;
  imageEvidenceIds?: string[];
  variants?: CatalogVariant[];
};

function catalogAttributeNumber(attributes: CatalogVariantAttribute[], expression: RegExp) {
  const attribute = attributes.find((candidate) => expression.test(candidate.name.trim()));
  if (!attribute) return null;
  const value = Number(attribute.value.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function catalogAttributeUnit(attributes: CatalogVariantAttribute[], expression: RegExp, maximum = 40) {
  const attribute = attributes.find((candidate) => expression.test(candidate.name.trim()));
  return attribute?.unit?.trim().slice(0, maximum) || null;
}

function catalogVariantFields(variant: CatalogVariant) {
  const lengthExpression = /^(length|laenge|lange|länge)$/i;
  const widthExpression = /^(width|breite)$/i;
  const heightExpression = /^(height|hoehe|höhe)$/i;
  const weightExpression = /^(weight|gewicht)$/i;
  return {
    barcode: variant.barcode ?? null,
    weight: variant.weight ?? catalogAttributeNumber(variant.attributes, weightExpression),
    weightUnit: variant.weightUnit ?? catalogAttributeUnit(variant.attributes, weightExpression),
    dimensionLength: variant.dimensionLength ?? catalogAttributeNumber(variant.attributes, lengthExpression),
    dimensionWidth: variant.dimensionWidth ?? catalogAttributeNumber(variant.attributes, widthExpression),
    dimensionHeight: variant.dimensionHeight ?? catalogAttributeNumber(variant.attributes, heightExpression),
    dimensionUnit: variant.dimensionUnit
      ?? catalogAttributeUnit(variant.attributes, lengthExpression)
      ?? catalogAttributeUnit(variant.attributes, widthExpression)
      ?? catalogAttributeUnit(variant.attributes, heightExpression),
    moqQuantity: variant.moqQuantity ?? null,
    moqUnit: variant.moqUnit ?? null,
    leadTimeMinDays: variant.leadTimeMinDays ?? null,
    leadTimeMaxDays: variant.leadTimeMaxDays ?? null,
  };
}

export async function applyKnowledgeClassification(input:{
  activationId:string;
  workspaceId:string;
  userId:string;
  classification:Record<string,unknown>;
  summary:string;
  businessDescription:string|null;
  sourceDocumentIds?: string[];
  items:KnowledgeClassificationItem[];
}) {
  return withTransaction(async client=>{
    const productIds:string[]=[];
    const missingImageProductIds:string[]=[];
    const variantMediaTargets:Array<{productId:string;variantId:string}>=[];
    const catalogMediaTargets:Array<{productId:string;variantId:string|null;evidenceIds:string[]}>=[];
    const activation=(await query<{id:string}>(
      `SELECT id FROM workspace_knowledge_activations
       WHERE id=$1 AND workspace_id=$2 AND created_by=$3 AND status IN ('REVIEW_REQUIRED','PROCESSING')
       FOR UPDATE`,
      [input.activationId,input.workspaceId,input.userId],client,
    )).rows[0];
    if(!activation)throw new AppError(409,'KNOWLEDGE_ACTIVATION_STALE','This Knowledge Base activation is no longer active.');
    for(const item of input.items){
      if(item.kind==='other')continue;
      await query(`INSERT INTO workspace_offerings(workspace_id,name,offering_type,category,description,price_amount,price_currency,status) SELECT $1,$2,$3,$4,$5,$6,$7,'active' WHERE NOT EXISTS(SELECT 1 FROM workspace_offerings WHERE workspace_id=$1 AND deleted_at IS NULL AND lower(name)=lower($2) AND offering_type=$3)`,[input.workspaceId,item.name,item.kind,item.category,item.description,item.price,item.currency],client);
      if(item.kind==='service')continue;
      const existing=(await query<{id:string;needsImage:boolean}>(`SELECT p.id,NOT EXISTS(SELECT 1 FROM product_media m WHERE m.workspace_id=p.workspace_id AND m.product_id=p.id AND m.media_type='IMAGE') AS "needsImage" FROM products p WHERE p.workspace_id=$1 AND p.deleted_at IS NULL AND lower(p.name)=lower($2) LIMIT 1`,[input.workspaceId,item.name],client)).rows[0];
      let productId=existing?.id;
      if (!productId) {
        const created=(await query<{id:string}>(`INSERT INTO products(
          workspace_id,status,product_type,sku,name,short_description,long_description,default_currency,default_price,pricing_type,
          moq_quantity,moq_unit,lead_time_min_days,lead_time_max_days,country_of_origin,hs_code,visibility,source_language,created_by,updated_by
        ) VALUES($1,'DRAFT',$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'PRIVATE','en',$15,$15) RETURNING id`,[
          input.workspaceId,item.productType??'OTHER',item.sku??null,item.name,item.description,item.currency,item.price,item.price===null?'QUOTE_REQUIRED':'FIXED',
          item.moqQuantity??null,item.moqUnit??null,item.leadTimeMinDays??null,item.leadTimeMaxDays??null,item.countryOfOrigin??null,item.hsCode??null,input.userId,
        ],client)).rows[0];
        if (!created) throw new Error('Product creation did not return an id');
        productId=created.id;
        await appendDomainEvent({workspaceId:input.workspaceId,type:DOMAIN_EVENT_TYPES.PRODUCT_CREATED,aggregateType:'product',aggregateId:productId,payload:{productId,name:item.name,source:'knowledge_activation'},metadata:{actorId:input.userId,source:'knowledge_activation'},idempotencyKey:`product:${productId}:created:v1`},client);
      }
      productIds.push(productId);
      const variants=item.variants??[];
      if (!variants.length) {
        if (existing?.needsImage ?? true) missingImageProductIds.push(productId);
        if (item.imageEvidenceIds?.length) catalogMediaTargets.push({productId,variantId:null,evidenceIds:item.imageEvidenceIds});
        continue;
      }
      for (const variant of variants) {
        const existingVariant=(await query<{id:string;hasImage:boolean}>(
          `SELECT v.id,EXISTS(SELECT 1 FROM product_media m WHERE m.workspace_id=v.workspace_id AND m.product_id=v.product_id AND m.variant_id=v.id AND m.media_type='IMAGE') AS "hasImage"
             FROM product_variants v
            WHERE v.workspace_id=$1 AND v.product_id=$2 AND v.status<>'ARCHIVED'
              AND (($3::text IS NOT NULL AND lower(v.sku)=lower($3)) OR lower(v.name)=lower($4))
            ORDER BY v.created_at LIMIT 1`,
          [input.workspaceId,productId,variant.sku,variant.name],client,
        )).rows[0];
        let variantId=existingVariant?.id;
        if (!variantId) {
          const fields=catalogVariantFields(variant);
          const metadata={
            source:'knowledge_activation_catalog',
            sourceDocumentIds:input.sourceDocumentIds??[],
            attributes:variant.attributes,
            sourceEvidenceIds:variant.imageEvidenceIds??item.imageEvidenceIds??[],
          };
          const createdVariant=(await query<{id:string}>(
            `INSERT INTO product_variants(
               workspace_id,product_id,sku,name,status,barcode,weight,weight_unit,dimension_length,dimension_width,dimension_height,dimension_unit,
               default_price,default_currency,moq_quantity,moq_unit,lead_time_min_days,lead_time_max_days,metadata
             ) VALUES($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb) RETURNING id`,
            [
              input.workspaceId,productId,variant.sku,variant.name,fields.barcode,fields.weight,fields.weightUnit,
              fields.dimensionLength,fields.dimensionWidth,fields.dimensionHeight,fields.dimensionUnit,
              variant.price??item.price,variant.currency??item.currency,fields.moqQuantity,fields.moqUnit,fields.leadTimeMinDays,fields.leadTimeMaxDays,JSON.stringify(metadata),
            ],client,
          )).rows[0];
          if (!createdVariant) throw new Error('Product variant creation did not return an id');
          variantId=createdVariant.id;
          await appendDomainEvent({workspaceId:input.workspaceId,type:DOMAIN_EVENT_TYPES.PRODUCT_VARIANT_CREATED,aggregateType:'product',aggregateId:productId,payload:{productId,variantId,name:variant.name,source:'knowledge_activation_catalog'},metadata:{actorId:input.userId,source:'knowledge_activation'},idempotencyKey:`product-variant:${variantId}:created:v1`},client);
        }
        for (const attribute of variant.attributes) {
          await query(
            `INSERT INTO product_specifications(workspace_id,product_id,variant_id,name,value,unit,group_name,key)
             SELECT $1,$2,$3,$4,$5,$6,'Catalog import',$7
              WHERE NOT EXISTS(
                SELECT 1 FROM product_specifications
                 WHERE workspace_id=$1 AND product_id=$2 AND variant_id=$3 AND lower(name)=lower($4) AND value=$5
              )`,
            [input.workspaceId,productId,variantId,attribute.name,attribute.value,attribute.unit,attribute.name.toLowerCase().replace(/[^a-z0-9]+/g,'_').slice(0,100)],client,
          );
        }
        const evidenceIds = variant.imageEvidenceIds?.length ? variant.imageEvidenceIds : item.imageEvidenceIds ?? [];
        if (evidenceIds.length) catalogMediaTargets.push({productId,variantId,evidenceIds});
        if (!(existingVariant?.hasImage ?? false)) variantMediaTargets.push({productId,variantId});
      }
    }
    await query(`UPDATE workspace_knowledge_activations SET status='COMPLETED',classification=$2::jsonb,completed_at=NOW() WHERE id=$1`,[input.activationId,JSON.stringify({...input.classification,canonicalProductIds:productIds})],client);
    const activated=(await query<{id:string}>(`UPDATE workspaces SET business_description=COALESCE(NULLIF(trim(business_description),''),$2),knowledge_base_completed_at=COALESCE(knowledge_base_completed_at,NOW()),onboarding_step='setup_complete',onboarding_completed_at=COALESCE(onboarding_completed_at,NOW()),onboarding_file_reupload_required=FALSE WHERE id=$1 AND profile_completed_at IS NOT NULL AND onboarding_step='knowledge_base' RETURNING id`,[input.workspaceId,input.businessDescription??input.summary],client)).rows[0];
    if(!activated)throw new AppError(409,'KNOWLEDGE_ACTIVATION_STALE','The workspace activation state changed before processing completed.');
    await appendDomainEvent({workspaceId:input.workspaceId,type:DOMAIN_EVENT_TYPES.WORKSPACE_ACTIVATED,aggregateType:'workspace',aggregateId:input.workspaceId,payload:{activationId:input.activationId,trigger:'knowledge_base_completed'},metadata:{actorId:input.userId,source:'knowledge_activation'},idempotencyKey:`workspace-activated:${input.activationId}`},client);
    await query(`INSERT INTO audit_log(workspace_id,actor_id,action,entity_type,entity_id,after_data) VALUES($1,$2,'onboarding.knowledge_activated','workspace_knowledge_activation',$3,$4::jsonb)`,[input.workspaceId,input.userId,input.activationId,JSON.stringify({productIds,variantMediaTargets,itemCount:input.items.length,completed:true})],client);
    return {activationId:input.activationId,productIds:[...new Set(productIds)],missingImageProductIds:[...new Set(missingImageProductIds)],variantMediaTargets,catalogMediaTargets,completed:true};
  });
}

export async function getKnowledgeActivationState(workspaceId:string){const row=(await query<{status:string;completedAt:string|null;classification:Record<string,unknown>}>(`SELECT status,completed_at AS "completedAt",classification FROM workspace_knowledge_activations WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`,[workspaceId])).rows[0];return row??null;}

export async function markPlatformConnected(workspaceId: string, integrationKey: string) {
  await query(
    `UPDATE workspace_platforms
     SET connection_status = 'connected', last_error = NULL, updated_at = NOW()
     WHERE workspace_id = $1 AND integration_key = $2 AND deleted_at IS NULL`,
    [workspaceId, integrationKey]
  );
  const { rows } = await query<{ id: string }>(`SELECT id FROM workspace_platforms WHERE workspace_id=$1 AND integration_key=$2 AND deleted_at IS NULL`, [workspaceId, integrationKey]);
  for (const row of rows) await syncLegacyControlStatus({ sourceType: 'workspace_platform', sourceId: row.id, status: 'connected', lastError: null });
}

export async function removePlatformByIntegration(workspaceId: string, integrationKey: string) {
  const { rows } = await query<{ id: string }>(`SELECT id FROM workspace_platforms WHERE workspace_id=$1 AND integration_key=$2`, [workspaceId, integrationKey]);
  const result = await query(
    `DELETE FROM workspace_platforms
     WHERE workspace_id = $1 AND integration_key = $2`,
    [workspaceId, integrationKey]
  );
  for (const row of rows) await syncLegacyControlStatus({ sourceType: 'workspace_platform', sourceId: row.id, status: 'disconnected' });
  return result.rowCount ?? 0;
}

export async function archivePlatformByIntegration(workspaceId: string, integrationKey: string, message: string) {
  const { rows } = await query<{ id: string }>(`SELECT id FROM workspace_platforms WHERE workspace_id=$1 AND integration_key=$2 AND deleted_at IS NULL`, [workspaceId, integrationKey]);
  await query(
    `UPDATE workspace_platforms
     SET connection_status = 'not_connected', last_error = $3, deleted_at = NOW(), updated_at = NOW()
     WHERE workspace_id = $1 AND integration_key = $2 AND deleted_at IS NULL`,
    [workspaceId, integrationKey, message.slice(0, 2_000)]
  );
  for (const row of rows) await syncLegacyControlStatus({ sourceType: 'workspace_platform', sourceId: row.id, status: 'not_connected', lastError: message });
}
