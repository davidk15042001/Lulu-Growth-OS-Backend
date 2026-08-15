import { z } from 'zod';

const nullableText = (maximum: number) => z.string().trim().max(maximum).nullable();
const optionalNullableText = (maximum: number) => nullableText(maximum).optional();
const jsonObject = z.record(z.string(), z.unknown());

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
export type AiPreferencesInput = z.infer<typeof aiPreferencesSchema>;
