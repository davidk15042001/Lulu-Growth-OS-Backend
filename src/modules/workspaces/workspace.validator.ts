import { z } from 'zod';

const optionalText = (maximum: number) => z.string().trim().max(maximum).nullable().optional();
const optionalStringList = (maximumItems: number, maximumLength = 120) =>
  z.array(z.string().trim().min(1).max(maximumLength)).max(maximumItems).optional();

export const workspaceIdParamsSchema = z.object({
  workspaceId: z.string().uuid(),
});

export const createWorkspaceSchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100).optional(),
  industry: optionalText(200),
  companySize: optionalText(100),
  countryRegion: optionalText(200),
});

export const updateWorkspaceSchema = z
  .object({
    companyName: z.string().trim().min(1).max(200).optional(),
    slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100).nullable().optional(),
    industry: optionalText(200),
    companySize: optionalText(100),
    countryRegion: optionalText(200),
    businessDescription: optionalText(10_000),
    valueProposition: optionalText(5_000),
    targetMarket: optionalText(2_000),
    shortBrandDescription: optionalText(500),
    positioningTags: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
    legalForm: optionalText(120),
    foundingYear: z.coerce.number().int().min(1800).max(2100).nullable().optional(),
    employeeCount: z.coerce.number().int().min(0).nullable().optional(),
    annualRevenueRange: optionalText(120),
    businessModelType: optionalText(120),
    companyStage: optionalText(120),
    salesModel: optionalText(120),
    salesCycleDays: z.coerce.number().int().min(0).nullable().optional(),
    primaryIcp: optionalText(2_000),
    usp: optionalText(2_000),
    mission: optionalText(2_000),
    vision: optionalText(2_000),
    primaryChallenges: optionalStringList(20, 160),
    languages: optionalStringList(20, 80),
    regulatedIndustries: optionalStringList(20, 120),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;
