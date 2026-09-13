import { randomUUID } from 'node:crypto';
import { env, hasAiProvider } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { registerDomainEventHandler } from '../../events/domain-event.registry.js';
import { DOMAIN_EVENT_TYPES, type DomainEvent } from '../../events/domain-event.types.js';
import { createRuntimeWorkerMonitor } from '../../operations/worker-liveness.js';
import { configuredModel, getOpenAIResponsesClient } from '../ai/openai.service.js';
import * as repo from './quality.repo.js';
import * as service from './quality.service.js';

const workerId = `quality-intelligence-${process.pid}-${randomUUID()}`;
const runtimeMonitor = createRuntimeWorkerMonitor('quality-intelligence', { required: true, staleAfterMs: 120_000 });
let started = false;
let stopping = false;

function objectValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseJsonObject(value: string) {
  const normalized = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed: unknown = JSON.parse(normalized);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Quality repair returned a non-object content payload');
  return parsed as Record<string, unknown>;
}

function eventVersionId(event: DomainEvent, artifact: Awaited<ReturnType<typeof service.getArtifact>>) {
  const candidate = event.payload.artifactVersionId;
  if (typeof candidate === 'string' && artifact.versions.some((version) => version.id === candidate)) return candidate;
  return artifact.currentVersionId;
}

async function runAutomaticReview(event: DomainEvent) {
  if (!event.workspaceId || !event.aggregateId) return { ignored: true };
  const artifact = await service.getArtifact(event.workspaceId, event.aggregateId);
  const versionId = eventVersionId(event, artifact);
  const actorId = typeof artifact.artifact.createdBy === 'string' ? artifact.artifact.createdBy : null;
  if (!versionId || !actorId) return { ignored: true, reason: 'missing_version_or_actor' };
  const claims = artifact.claims.filter((claim) => claim.artifactVersionId === versionId) as Array<{
    id: string; claimType?: string; sourceStatus?: string; evidenceIds?: unknown;
  }>;
  const factualClaims = claims.filter((claim) => ['factual', 'numeric', 'comparative', 'testimonial'].includes(String(claim.claimType)));
  const checkedClaims = factualClaims.map((claim) => {
    const evidenceRefs = Array.isArray(claim.evidenceIds) ? claim.evidenceIds.filter((id): id is string => typeof id === 'string') : [];
    const verified = claim.sourceStatus === 'verified' && evidenceRefs.length > 0;
    return { claimId: claim.id, verdict: verified ? 'verified' as const : 'failed' as const, evidenceRefs };
  });
  const evidencePass = checkedClaims.every((claim) => claim.verdict === 'verified');
  const alreadyReviewed = artifact.reviews.some((review) => review.artifactVersionId === versionId && review.reviewerAgentId === 'quality.evidence-claims.v1');
  if (!alreadyReviewed) {
    await service.createReview(event.workspaceId, actorId, {
      artifactVersionId: versionId,
      reviewerAgentId: 'quality.evidence-claims.v1',
      reviewerVersion: '1.0.0',
      reviewerKind: 'evidence_claim',
      verdict: evidencePass ? 'passed' : 'needs_repair',
      overallScore: evidencePass ? 100 : 60,
      dimensions: [
        { key: 'factual_accuracy', score: evidencePass ? 100 : 60, required: true, status: evidencePass ? 'passed' : 'failed', summary: evidencePass ? 'Factual claims have verified evidence.' : 'One or more factual claims lack verified evidence.' },
        { key: 'evidence_coverage', score: evidencePass ? 100 : 40, required: true, status: evidencePass ? 'passed' : 'failed', summary: evidencePass ? 'All factual claims are linked to evidence.' : 'Evidence coverage is incomplete.' },
      ],
      findings: evidencePass ? [] : [{ severity: 'hard_block', category: 'evidence', location: null, message: 'Factual, numeric, comparative or testimonial claims require verified evidence references.', evidenceRefs: [], suggestedFix: 'Attach current evidence to every public claim.' }],
      checkedClaims,
      confidence: evidencePass ? 'high' : 'medium',
      limitations: [],
      nextAction: evidencePass ? 'approve' : 'repair',
    });
  }

  const refreshed = await service.getArtifact(event.workspaceId, event.aggregateId);
  const providerStatus = String((refreshed.artifact as { providerStatus?: string }).providerStatus ?? 'not_started');
  const finalAlreadyReviewed = refreshed.reviews.some((review) => review.artifactVersionId === versionId && review.reviewerAgentId === 'quality.final-gate.v1');
  if (evidencePass && providerStatus === 'completed' && !finalAlreadyReviewed) {
    await service.createReview(event.workspaceId, actorId, {
      artifactVersionId: versionId,
      reviewerAgentId: 'quality.final-gate.v1',
      reviewerVersion: '1.0.0',
      reviewerKind: 'final_gate',
      verdict: 'passed',
      overallScore: 100,
      dimensions: [
        { key: 'release_safety', score: 100, required: true, status: 'passed', summary: 'Provider result, evidence review and release contract are complete.' },
      ],
      findings: [],
      checkedClaims,
      confidence: 'high',
      limitations: [],
      nextAction: 'approve',
    });
  }
  runtimeMonitor.progress({ phase: 'reviewed', metadata: { artifactId: event.aggregateId, artifactVersionId: versionId, evidencePass, providerStatus } });
  return { reviewed: true, evidencePass, providerStatus, artifactVersionId: versionId };
}

async function runAutomaticRepair(event: DomainEvent) {
  if (!event.workspaceId) return { ignored: true };
  const repairAttemptId = typeof event.payload.repairAttemptId === 'string' ? event.payload.repairAttemptId : null;
  if (!repairAttemptId) return { ignored: true, reason: 'missing_repair_attempt' };
  const attempt = await repo.findRepairAttempt(event.workspaceId, repairAttemptId);
  if (!attempt || !['queued', 'running'].includes(String(attempt.status))) return { ignored: true, reason: 'repair_already_terminal' };
  const artifact = await service.getArtifact(event.workspaceId, String(attempt.artifactId));
  const version = artifact.versions.find((candidate) => candidate.id === attempt.inputVersionId) as { content?: unknown } | undefined;
  const actorId = typeof attempt.createdBy === 'string' ? attempt.createdBy : typeof artifact.artifact.createdBy === 'string' ? artifact.artifact.createdBy : null;
  if (!actorId || !version) {
    await repo.markRepairFailed(event.workspaceId, repairAttemptId, 'Repair input or actor is missing');
    return { repaired: false, reason: 'missing_input' };
  }
  if (!hasAiProvider) {
    await repo.markRepairFailed(event.workspaceId, repairAttemptId, 'No AI provider is configured for autonomous repair');
    return { repaired: false, reason: 'ai_not_configured' };
  }
  try {
    const findings = artifact.findings.filter((finding) => finding.artifactVersionId === attempt.inputVersionId);
    const response = await getOpenAIResponsesClient().create({
      model: configuredModel(),
      instructions: 'You are Lulu Quality Repair. Return ONLY a JSON object containing the corrected artifact content. Preserve supported facts, remove unsupported claims, and never invent evidence, prices, customers, legal claims or performance guarantees.',
      input: [{ role: 'user', content: JSON.stringify({ content: objectValue(version.content), findings }) }],
      max_output_tokens: env.OPENAI_MAX_OUTPUT_TOKENS,
      store: false,
    }, { billing: { workspaceId: event.workspaceId, userId: actorId, operationId: `quality-repair:${repairAttemptId}`, operation: 'quality.repair' } });
    const content = parseJsonObject(String(response.output_text ?? ''));
    const result = await repo.createRepairVersion(event.workspaceId, repairAttemptId, content, 'quality.repair.orchestrator', '1.0.0');
    if (!result) return { repaired: false, reason: 'repair_claim_lost' };
    runtimeMonitor.progress({ phase: 'repair_completed', metadata: { repairAttemptId, artifactVersionId: result.artifactVersionId } });
    return { repaired: true, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repo.markRepairFailed(event.workspaceId, repairAttemptId, message);
    logger.error({ error, workspaceId: event.workspaceId, repairAttemptId }, 'Quality repair worker failed');
    return { repaired: false, reason: 'provider_error' };
  }
}

export function startQualityIntelligenceWorker() {
  if (started) return;
  started = true;
  stopping = false;
  runtimeMonitor.start({ workerId });
  registerDomainEventHandler({
    name: 'quality.intelligence.v1',
    eventTypes: [DOMAIN_EVENT_TYPES.QUALITY_REVIEW_REQUESTED, DOMAIN_EVENT_TYPES.QUALITY_PROVIDER_STATUS_CHANGED, DOMAIN_EVENT_TYPES.QUALITY_REPAIR_REQUESTED],
    async handle(event) {
      if (stopping) return { ignored: true, stopping: true };
      if (event.type === DOMAIN_EVENT_TYPES.QUALITY_REPAIR_REQUESTED) return runAutomaticRepair(event);
      return runAutomaticReview(event);
    },
  });
  logger.info({ workerId }, 'Quality intelligence worker started');
}

export async function stopQualityIntelligenceWorker() {
  if (!started) return;
  stopping = true;
  await runtimeMonitor.stopping();
  await runtimeMonitor.stopped();
  started = false;
}
