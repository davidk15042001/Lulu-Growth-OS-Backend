import { conflictError, forbiddenError, notFoundError } from '../../utils/app-error.js';
import * as repo from './quality.repo.js';
import { releaseBlockers } from './quality.policy.js';
import type {
  CreateArtifactInput, CreateEvidenceInput, CreateReviewInput, FeedbackInput, ListArtifactsQuery,
  OutcomeInput, RepairInput, ReleaseDecisionInput,
} from './quality.validator.js';

export async function createArtifact(workspaceId: string, userId: string, input: CreateArtifactInput) {
  return repo.createArtifact(workspaceId, userId, input);
}

export async function listArtifacts(workspaceId: string, filters: ListArtifactsQuery) {
  return repo.listArtifacts(workspaceId, filters);
}

export async function addEvidence(workspaceId: string, userId: string, input: CreateEvidenceInput) {
  const evidenceId = await repo.createEvidence(workspaceId, userId, input);
  if (!evidenceId) throw conflictError('The source snapshot does not belong to this workspace');
  return { evidenceId };
}

export async function getArtifact(workspaceId: string, artifactId: string) {
  const artifact = await repo.findArtifact(workspaceId, artifactId);
  if (!artifact) throw notFoundError('Quality artifact not found');
  return artifact;
}

export async function createReview(workspaceId: string, userId: string, input: CreateReviewInput) {
  const artifactId = await repo.findArtifactByVersion(workspaceId, input.artifactVersionId);
  if (!artifactId) throw notFoundError('Quality artifact version not found');
  const artifact = await getArtifact(workspaceId, artifactId);
  const version = artifact.versions.find((item) => item.id === input.artifactVersionId) as { producerAgentId?: string } | undefined;
  if (version?.producerAgentId === input.reviewerAgentId) throw forbiddenError('The producer cannot approve or review its own artifact');
  if (input.reviewerKind === 'final_gate' && input.verdict === 'passed') {
    const hardBlock = input.findings.some((finding) => finding.severity === 'hard_block');
    const dimensionFailure = input.dimensions.some((dimension) => dimension.required && (dimension.status !== 'passed' || dimension.score < 85));
    if (hardBlock || dimensionFailure || (input.overallScore ?? 0) < 90) {
      throw conflictError('A final quality gate cannot pass with an open hard block or below-threshold dimension');
    }
    const factualClaims = artifact.claims.filter((claim) =>
      ['factual', 'numeric', 'comparative', 'testimonial'].includes(String((claim as { claimType?: string }).claimType)),
    ) as Array<{ id: string }>;
    const checked = new Map(input.checkedClaims.map((claim) => [claim.claimId, claim]));
    const missingEvidence = factualClaims.some((claim) => {
      const checkedClaim = checked.get(claim.id);
      return !checkedClaim || checkedClaim.verdict !== 'verified' || checkedClaim.evidenceRefs.length === 0;
    });
    if (missingEvidence) throw conflictError('A final quality gate requires every factual claim to be verified with evidence references');
  }
  const reviewId = await repo.createReview(workspaceId, userId, input);
  if (!reviewId) throw notFoundError('Quality artifact version not found');
  return getArtifact(workspaceId, artifact.artifact.id as string);
}

export async function requestRepair(workspaceId: string, userId: string, artifactId: string, input: RepairInput) {
  const artifact = await getArtifact(workspaceId, artifactId);
  if (!artifact.versions.some((version) => version.id === input.artifactVersionId)) throw notFoundError('Quality artifact version not found');
  const config = await repo.getConfig(workspaceId);
  const attemptCount = artifact.reviews.length ? artifact.reviews.filter((review) => review.artifactVersionId === input.artifactVersionId).length : 0;
  if (attemptCount >= Number(config.maxRepairRounds ?? 3)) throw conflictError('Maximum quality repair rounds reached');
  const repairId = await repo.createRepair(workspaceId, userId, artifactId, input);
  if (!repairId) throw notFoundError('Quality artifact not found');
  return { repairAttemptId: repairId, status: 'queued', artifactId };
}

export async function decideRelease(workspaceId: string, userId: string, artifactId: string, input: ReleaseDecisionInput, isOverride = false) {
  const artifact = await getArtifact(workspaceId, artifactId);
  if (!artifact.versions.some((version) => version.id === input.artifactVersionId)) throw notFoundError('Quality artifact version not found');
  const relevantReviews = artifact.reviews.filter((review) => review.artifactVersionId === input.artifactVersionId) as Array<{ reviewerKind: string; verdict: string }>;
  const releaseLike = input.decision === 'approved' || input.decision === 'released' || input.decision === 'queued';
  const config = await repo.getConfig(workspaceId);
  const blockers = releaseBlockers({
    reviews: relevantReviews,
    findings: (artifact.findings as Array<{ artifactVersionId: string; severity: string; resolvedAt?: string | null }>).filter((finding) => finding.artifactVersionId === input.artifactVersionId),
    providerStatus: String((artifact.artifact as { providerStatus?: string }).providerStatus ?? 'not_started'),
    riskClass: String((artifact.artifact as { riskClass?: string }).riskClass ?? 'standard'),
    independentReviewRequired: Boolean(config.independentReviewRequired),
  });
  if (releaseLike && !isOverride && blockers.length > 0) {
    throw conflictError(`Release is blocked: ${blockers.join(', ')}`);
  }
  if (isOverride && !input.overrideReason) throw conflictError('An audited override requires an explicit reason');
  const id = await repo.createReleaseDecision(workspaceId, userId, isOverride ? 'USER' : 'SYSTEM', artifactId, input);
  if (!id) throw notFoundError('Quality artifact version not found');
  return getArtifact(workspaceId, artifactId);
}

export const getOverview = repo.getOverview;
export const getConfig = repo.getConfig;
export const updateConfig = repo.updateConfig;
export const listRubrics = repo.listRubrics;

export async function addFeedback(workspaceId: string, userId: string, artifactId: string, input: FeedbackInput) {
  const artifact = await getArtifact(workspaceId, artifactId);
  if (!artifact.versions.some((version) => version.id === input.artifactVersionId)) throw notFoundError('Quality artifact version not found');
  const feedbackId = await repo.createFeedback(workspaceId, userId, artifactId, input);
  return { feedbackId };
}

export async function addOutcome(workspaceId: string, artifactId: string, input: OutcomeInput) {
  const artifact = await getArtifact(workspaceId, artifactId);
  if (!artifact.versions.some((version) => version.id === input.artifactVersionId)) throw notFoundError('Quality artifact version not found');
  const outcomeId = await repo.createOutcome(workspaceId, artifactId, input);
  return { outcomeId };
}
