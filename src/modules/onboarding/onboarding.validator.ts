import { z } from 'zod';

const nullableText = (maximum: number) => z.string().trim().max(maximum).nullable();
const optionalNullableText = (maximum: number) => nullableText(maximum).optional();
const jsonObject = z.record(z.string(), z.unknown());
const stringList = (maximumItems: number, maximumLength = 120) =>
  z.array(z.string().trim().min(1).max(maximumLength)).max(maximumItems).default([]);
const optionalStringList = (maximumItems: number, maximumLength = 120) =>
  stringList(maximumItems, maximumLength).optional();

export const companyInformationSchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  industry: nullableText(200),
  companySize: nullableText(100),
  countryRegion: nullableText(200),
});

export const businessDescriptionSchema = z.object({
  businessDescription: nullableText(10_000),
  valueProposition: nullableText(5_000),
  targetMarket: nullableText(2_000),
  shortBrandDescription: nullableText(500),
  positioningTags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  legalForm: nullableText(120),
  foundingYear: z.coerce.number().int().min(1800).max(2100).nullable().optional(),
  employeeCount: z.coerce.number().int().min(0).nullable().optional(),
  annualRevenueRange: nullableText(120),
  businessModelType: nullableText(120),
  companyStage: nullableText(120),
  salesModel: nullableText(120),
  salesCycleDays: z.coerce.number().int().min(0).nullable().optional(),
  primaryIcp: nullableText(2_000),
  usp: nullableText(2_000),
  mission: nullableText(2_000),
  vision: nullableText(2_000),
  primaryChallenges: stringList(20, 160),
  languages: stringList(20, 80),
  regulatedIndustries: stringList(20, 120),
});

const offeringFields = {
  name: z.string().trim().min(1).max(200),
  offeringType: z.enum(['product', 'service']),
  category: optionalNullableText(200),
  description: optionalNullableText(10_000),
  targetCustomer: optionalNullableText(2_000),
  pricingModel: optionalNullableText(100),
  priceAmount: z.coerce.number().finite().nonnegative().nullable().optional(),
  priceCurrency: z.string().trim().length(3).transform((value) => value.toUpperCase()).nullable().optional(),
  priceLabel: optionalNullableText(200),
  status: z.enum(['draft', 'active', 'inactive', 'archived']).optional(),
  customerProblem: optionalNullableText(5_000),
  valueProposition: optionalNullableText(5_000),
  url: z.string().url().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).max(100_000).optional(),
  sku: optionalNullableText(120),
  portfolioGroup: optionalNullableText(120),
  lifecycleStage: optionalNullableText(120),
  launchDate: z.string().date().nullable().optional(),
  deliveryModel: optionalNullableText(120),
  serviceScope: optionalNullableText(2_000),
  setupFee: z.coerce.number().finite().nonnegative().nullable().optional(),
  recurringFee: z.coerce.number().finite().nonnegative().nullable().optional(),
  usageFee: z.coerce.number().finite().nonnegative().nullable().optional(),
  billingInterval: optionalNullableText(120),
  minimumContractMonths: z.coerce.number().int().min(0).nullable().optional(),
  cancellationPeriodDays: z.coerce.number().int().min(0).nullable().optional(),
  onboardingEffort: optionalNullableText(120),
  fulfilmentEffort: optionalNullableText(120),
  differentiators: optionalStringList(20, 160),
  proofPoints: optionalStringList(20, 160),
  useCases: optionalStringList(20, 160),
  objections: optionalStringList(20, 160),
  addOns: optionalStringList(20, 160),
};

export const createOfferingSchema = z.object(offeringFields);
export const updateOfferingSchema = z
  .object(offeringFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');

const platformFields = {
  integrationKey: z.string().trim().regex(/^[a-z][a-z0-9_-]*$/).max(100).nullable().optional(),
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100).optional(),
  connectionStatus: z.enum([
    'not_connected',
    'pending',
    'connected',
    'syncing',
    'error',
    'disconnected',
  ]).optional(),
  externalAccountId: optionalNullableText(500),
  grantedScopes: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  secretReference: optionalNullableText(1_000),
  settings: jsonObject.optional(),
};

export const createPlatformSchema = z.object(platformFields);
export const updatePlatformSchema = z
  .object(platformFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');

const customerSegmentFields = {
  name: z.string().trim().min(1).max(200),
  industry: optionalNullableText(200),
  companySize: optionalNullableText(100),
  region: optionalNullableText(200),
  maturityLevel: optionalNullableText(120),
  painPoints: optionalStringList(20, 160),
  jobsToBeDone: optionalStringList(20, 160),
  decisionCriteria: optionalStringList(20, 160),
  useCases: optionalStringList(20, 160),
  buyingRoles: optionalStringList(20, 120),
  priceSensitivity: optionalNullableText(120),
  primarySegment: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).max(100_000).optional(),
  notes: optionalNullableText(4_000),
};

export const createCustomerSegmentSchema = z.object(customerSegmentFields);
export const updateCustomerSegmentSchema = z
  .object(customerSegmentFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');

const competitorFields = {
  name: z.string().trim().min(1).max(200),
  websiteUrl: z.string().url().nullable().optional(),
  competitorType: z.enum(['direct', 'indirect', 'substitute', 'emerging']).optional(),
  market: optionalNullableText(200),
  positioning: optionalNullableText(2_000),
  pricingSummary: optionalNullableText(2_000),
  strengths: optionalStringList(20, 160),
  weaknesses: optionalStringList(20, 160),
  differentiators: optionalStringList(20, 160),
  featureOverlap: optionalStringList(20, 160),
  threatLevel: optionalNullableText(120),
  strategicPriority: optionalNullableText(120),
  sourceQuality: optionalNullableText(120),
  monitoringFrequency: optionalNullableText(120),
  notes: optionalNullableText(4_000),
  lastReviewedAt: z.string().datetime({ offset: true }).nullable().optional(),
};

export const createCompetitorSchema = z.object(competitorFields);
export const updateCompetitorSchema = z
  .object(competitorFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');

const booleanMap = z.record(z.string(), z.boolean());
const approvalMode = z.enum(['always_ask', 'ask_high_impact', 'auto']);
const searchPriority = z.enum(['low', 'medium', 'high']);

export const aiPreferencesSchema = z.object({
  businessPriorities: z.array(z.string().trim().min(1).max(100)).max(30).default([
    'Revenue Growth',
    'Customer Acquisition',
    'SEO',
    'Marketing Performance',
  ]),
  priorityOrder: z.array(z.string().trim().min(1).max(100)).max(30).default([
    'Revenue Growth',
    'Customer Acquisition',
    'SEO',
    'Marketing Performance',
  ]),
  recommendationStyle: z.enum(['conservative', 'balanced', 'aggressive']).default('balanced'),
  riskTolerance: z.enum(['low', 'moderate', 'high']).default('moderate'),
  actionLevel: z.enum(['advisory', 'assisted', 'automated']).default('advisory'),
  communicationStyle: z.enum(['concise', 'balanced', 'detailed']).default('balanced'),
  insightDetail: z.enum(['executive', 'standard', 'detailed']).default('standard'),
  recommendationFrequency: z.enum(['only_important', 'daily', 'weekly', 'as_insights_occur']).default('only_important'),
  taskCreationMode: z.enum(['off', 'recommend', 'auto']).default('recommend'),
  detectionSettings: booleanMap.default({ opportunity: true, risk: true, anomaly: true, content: true }),
  searchPriorities: z.record(z.string(), searchPriority).default({ SEO: 'medium', GEO: 'medium', AEO: 'medium' }),
  approvalPreferences: z.record(z.string(), approvalMode).default({
    marketing: 'ask_high_impact',
    advertising: 'ask_high_impact',
    content: 'always_ask',
    website: 'always_ask',
    product: 'always_ask',
    customer_comms: 'always_ask',
    automation: 'ask_high_impact',
    financial: 'always_ask',
  }),
  approvalThreshold: z.coerce.number().finite().nonnegative().nullable().default(500),
  notificationPreferences: booleanMap.default({
    critical_risks: true,
    important_opportunities: true,
    ai_recommendations: true,
    ai_tasks: true,
    integration_issues: true,
    performance_changes: false,
  }),
  notificationChannels: booleanMap.default({ in_app: true, email: true, push: false }),
  businessHours: z.object({
    enabled: z.boolean().default(false),
    timezone: z.string().max(100).optional(),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    days: z.array(z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])).optional(),
  }).default({ enabled: false }),
  responseLanguage: z.string().trim().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/).default('en'),
  transparencySettings: booleanMap.default({
    insights: true,
    recommendations: true,
    content: true,
    labels: true,
    data: true,
  }),
});

export const onboardingRecordParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  offeringId: z.string().uuid().optional(),
  platformId: z.string().uuid().optional(),
  customerSegmentId: z.string().uuid().optional(),
  competitorId: z.string().uuid().optional(),
});

export const onboardingDocumentParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  documentId: z.string().uuid().optional(),
});

export type CompanyInformationInput = z.infer<typeof companyInformationSchema>;
export type BusinessDescriptionInput = z.infer<typeof businessDescriptionSchema>;
export type CreateOfferingInput = z.infer<typeof createOfferingSchema>;
export type UpdateOfferingInput = z.infer<typeof updateOfferingSchema>;
export type CreatePlatformInput = z.infer<typeof createPlatformSchema>;
export type UpdatePlatformInput = z.infer<typeof updatePlatformSchema>;
export type CreateCustomerSegmentInput = z.infer<typeof createCustomerSegmentSchema>;
export type UpdateCustomerSegmentInput = z.infer<typeof updateCustomerSegmentSchema>;
export type CreateCompetitorInput = z.infer<typeof createCompetitorSchema>;
export type UpdateCompetitorInput = z.infer<typeof updateCompetitorSchema>;
export type AiPreferencesInput = z.infer<typeof aiPreferencesSchema>;
