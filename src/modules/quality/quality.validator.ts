import { z } from 'zod';
import { qualityReviewerKinds } from './quality.types.js';

const jsonObject = z.record(z.string(), z.unknown());

export const workspaceParamsSchema = z.object({ workspaceId: z.string().uuid() });
export const artifactParamsSchema = workspaceParamsSchema.extend({ artifactId: z.string().uuid() });

export const createArtifactSchema = z.object({
  artifactType: z.string().trim().min(1).max(120),
  canonicalEntityType: z.string().trim().min(1).max(120),
  canonicalEntityId: z.string().trim().min(1).max(200),
  content: jsonObject.default({}),
  producerAgentId: z.string().trim().min(1).max(160),
  producerVersion: z.string().trim().min(1).max(120).default('unknown'),
  modelProvider: z.string().trim().max(120).nullable().optional(),
  modelName: z.string().trim().max(160).nullable().optional(),
  modelMetadata: jsonObject.default({}),
  sourceSnapshot: z.object({
    sourceType: z.string().trim().min(1).max(120),
    sourceRef: z.string().trim().max(500).nullable().optional(),
    status: z.enum(['verified','derived','forecast','unavailable','not_applicable']).default('verified'),
    payload: jsonObject.default({}),
    freshUntil: z.string().datetime({ offset: true }).nullable().optional(),
  }).optional(),
  claims: z.array(z.object({
    claimText: z.string().trim().min(1).max(4_000),
    position: jsonObject.default({}),
    claimType: z.enum(['factual','numeric','comparative','testimonial','forecast','opinion','instruction','other']).default('factual'),
    sourceStatus: z.enum(['verified','derived','forecast','unavailable','not_applicable']).default('unavailable'),
    freshness: z.enum(['current','stale','unknown']).nullable().optional(),
    confidence: z.enum(['high','medium','low']).default('low'),
    evidenceIds: z.array(z.string().uuid()).default([]),
  })).max(500).default([]),
  riskClass: z.enum(['low','standard','high','regulated']).default('standard'),
  language: z.string().trim().min(2).max(20).default('en'),
  targetMarket: z.string().trim().max(120).nullable().optional(),
  targetChannel: z.string().trim().max(120).nullable().optional(),
  releaseMode: z.enum(['SHADOW','ASSISTED','CANARY','ENFORCED']).default('SHADOW'),
});

export const listArtifactsQuerySchema = z.object({
  status: z.string().trim().max(40).optional(),
  artifactType: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createEvidenceSchema = z.object({
  sourceSnapshotId: z.string().uuid().nullable().optional(),
  reference: z.string().trim().min(1).max(500),
  excerpt: z.string().max(8_000).nullable().optional(),
  status: z.enum(['verified','derived','forecast','unavailable','not_applicable','contradictory']).default('verified'),
  observedAt: z.string().datetime({ offset: true }).nullable().optional(),
  metadata: jsonObject.default({}),
});

const checkedClaimSchema = z.object({
  claimId: z.string().uuid(),
  verdict: z.enum(['verified','failed','unavailable','contradictory']),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
});

const findingSchema = z.object({
  severity: z.enum(['hard_block','major','minor','suggestion']),
  category: z.string().trim().min(1).max(120),
  location: z.string().trim().max(500).nullable().optional(),
  message: z.string().trim().min(1).max(4_000),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  suggestedFix: z.string().trim().max(4_000).nullable().optional(),
});

const dimensionSchema = z.object({
  key: z.string().trim().min(1).max(120),
  score: z.number().finite().min(0).max(100),
  required: z.boolean().default(true),
  status: z.enum(['passed','failed','unavailable']),
  summary: z.string().trim().max(2_000),
});

export const createReviewSchema = z.object({
  artifactVersionId: z.string().uuid(),
  reviewerAgentId: z.string().trim().min(1).max(160),
  reviewerVersion: z.string().trim().min(1).max(120).default('unknown'),
  reviewerKind: z.enum(qualityReviewerKinds),
  verdict: z.enum(['passed','failed','needs_repair','unavailable']),
  overallScore: z.number().finite().min(0).max(100).nullable().optional(),
  dimensions: z.array(dimensionSchema).max(100).default([]),
  findings: z.array(findingSchema).max(500).default([]),
  checkedClaims: z.array(checkedClaimSchema).max(500).default([]),
  confidence: z.enum(['high','medium','low']).default('low'),
  limitations: z.array(z.string().trim().max(2_000)).max(100).default([]),
  nextAction: z.enum(['approve','repair','withhold','escalate']),
});

export const repairSchema = z.object({
  artifactVersionId: z.string().uuid(),
  findingIds: z.array(z.string().uuid()).min(1).max(500),
});

export const releaseDecisionSchema = z.object({
  artifactVersionId: z.string().uuid(),
  decision: z.enum(['approved','rejected','withheld','escalated','queued','released']),
  reason: z.string().trim().min(1).max(4_000),
  overrideReason: z.string().trim().min(1).max(4_000).optional(),
});

export const feedbackSchema = z.object({
  artifactVersionId: z.string().uuid(),
  outcome: z.enum(['accepted_without_edit','accepted_with_edit','rejected','overridden','complaint','problem_reported']),
  editDistance: z.number().finite().min(0).nullable().optional(),
  notes: z.string().trim().max(4_000).nullable().optional(),
});

export const outcomeSchema = z.object({
  artifactVersionId: z.string().uuid(),
  metricKey: z.string().trim().min(1).max(160),
  value: z.number().finite().nullable().optional(),
  valueText: z.string().trim().max(500).nullable().optional(),
  source: z.string().trim().min(1).max(200),
  observedAt: z.string().datetime({ offset: true }).optional(),
  verified: z.boolean().default(false),
  metadata: jsonObject.default({}),
});

export const qualityConfigSchema = z.object({
  defaultMode: z.enum(['SHADOW','ASSISTED','CANARY','ENFORCED']),
  maxRepairRounds: z.number().int().min(0).max(20),
  independentReviewRequired: z.boolean(),
});

export type CreateArtifactInput = z.infer<typeof createArtifactSchema>;
export type CreateEvidenceInput = z.infer<typeof createEvidenceSchema>;
export type ListArtifactsQuery = z.infer<typeof listArtifactsQuerySchema>;
export type CreateReviewInput = z.infer<typeof createReviewSchema>;
export type RepairInput = z.infer<typeof repairSchema>;
export type ReleaseDecisionInput = z.infer<typeof releaseDecisionSchema>;
export type FeedbackInput = z.infer<typeof feedbackSchema>;
export type OutcomeInput = z.infer<typeof outcomeSchema>;
export type QualityConfigInput = z.infer<typeof qualityConfigSchema>;
