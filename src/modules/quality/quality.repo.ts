import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import type {
  CreateArtifactInput, CreateEvidenceInput, CreateReviewInput, FeedbackInput, ListArtifactsQuery,
  OutcomeInput, ProviderStatusInput, QualityConfigInput, RepairInput, ReleaseDecisionInput,
} from './quality.validator.js';

const artifactSelect = `a.id,a.workspace_id AS "workspaceId",a.artifact_type AS "artifactType",
  a.canonical_entity_type AS "canonicalEntityType",a.canonical_entity_id AS "canonicalEntityId",
  a.current_version AS "currentVersion",a.status,a.risk_class AS "riskClass",a.language,
  a.target_market AS "targetMarket",a.target_channel AS "targetChannel",a.release_mode AS "releaseMode",
  a.provider_status AS "providerStatus",a.created_by AS "createdBy",a.created_at AS "createdAt",a.updated_at AS "updatedAt"`;

function json(value: unknown) { return JSON.stringify(value ?? {}); }

export async function createEvidence(workspaceId: string, userId: string, input: CreateEvidenceInput) {
  const { rows } = await query<{ id: string }>(`INSERT INTO quality_evidence(
      workspace_id,source_snapshot_id,reference,excerpt,status,observed_at,metadata
    ) SELECT $1,$2,$3,$4,$5,$6,$7::jsonb
    WHERE $2::uuid IS NULL OR EXISTS (
      SELECT 1 FROM quality_source_snapshots s WHERE s.id=$2 AND s.workspace_id=$1
    ) RETURNING id`, [workspaceId, input.sourceSnapshotId ?? null, input.reference,
      input.excerpt ?? null, input.status, input.observedAt ? new Date(input.observedAt) : null, json(input.metadata)]);
  const evidenceId = rows[0]?.id;
  if (!evidenceId) return null;
  await appendDomainEvent({ workspaceId, type: DOMAIN_EVENT_TYPES.QUALITY_EVIDENCE_RECORDED,
    aggregateType: 'quality_evidence', aggregateId: evidenceId,
    payload: { evidenceId, reference: input.reference, status: input.status },
    metadata: { actorId: userId, source: 'quality' }, idempotencyKey: `quality-evidence:${evidenceId}:created:v1` });
  return evidenceId;
}

export async function listRubrics(workspaceId: string, artifactType?: string) {
  const { rows } = await query(`SELECT id,workspace_id AS "workspaceId",artifact_type AS "artifactType",version,
      dimensions,hard_failure_rules AS "hardFailureRules",minimum_dimension_score AS "minimumDimensionScore",
      minimum_overall_score AS "minimumOverallScore",required_reviewers AS "requiredReviewers",risk_class AS "riskClass",
      active,created_at AS "createdAt"
    FROM quality_rubrics
    WHERE (workspace_id IS NULL OR workspace_id=$1) AND ($2::text IS NULL OR artifact_type=$2)
    ORDER BY (workspace_id IS NULL),artifact_type,version DESC`, [workspaceId, artifactType ?? null]);
  return rows;
}

export async function createArtifact(workspaceId: string, userId: string, input: CreateArtifactInput) {
  return withTransaction(async (client) => {
    let sourceSnapshotId: string | null = null;
    if (input.sourceSnapshot) {
      const source = await query<{ id: string }>(`INSERT INTO quality_source_snapshots(
        workspace_id,source_type,source_ref,status,payload,fresh_until
      ) VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING id`, [workspaceId,input.sourceSnapshot.sourceType,
        input.sourceSnapshot.sourceRef ?? null,input.sourceSnapshot.status,json(input.sourceSnapshot.payload),
        input.sourceSnapshot.freshUntil ? new Date(input.sourceSnapshot.freshUntil) : null], client);
      sourceSnapshotId = source.rows[0]?.id ?? null;
    }
    const artifact = await query<{ id: string }>(`INSERT INTO quality_artifacts(
      workspace_id,artifact_type,canonical_entity_type,canonical_entity_id,current_version,status,risk_class,
      language,target_market,target_channel,release_mode,provider_status,created_by
    ) VALUES($1,$2,$3,$4,1,'REVIEW_PENDING',$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [workspaceId,input.artifactType,
      input.canonicalEntityType,input.canonicalEntityId,input.riskClass,input.language,
      input.targetMarket ?? null,input.targetChannel ?? null,input.releaseMode,input.providerStatus,userId], client);
    const artifactId = artifact.rows[0]?.id;
    if (!artifactId) throw new Error('Quality artifact insert did not return an id');
    const version = await query<{ id: string }>(`INSERT INTO quality_artifact_versions(
      workspace_id,artifact_id,version,content,producer_agent_id,producer_version,model_provider,model_name,model_metadata,source_snapshot_id
    ) VALUES($1,$2,1,$3::jsonb,$4,$5,$6,$7,$8::jsonb,$9) RETURNING id`, [workspaceId,artifactId,
      json(input.content),input.producerAgentId,input.producerVersion,input.modelProvider ?? null,
      input.modelName ?? null,json(input.modelMetadata),sourceSnapshotId], client);
    const versionId = version.rows[0]?.id;
    if (!versionId) throw new Error('Quality artifact version insert did not return an id');
    for (const claim of input.claims) {
      const claimRow = await query<{ id: string }>(`INSERT INTO quality_claims(
        workspace_id,artifact_version_id,claim_text,position,claim_type,source_status,freshness,confidence
      ) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING id`, [workspaceId,versionId,claim.claimText,
        json(claim.position),claim.claimType,claim.sourceStatus,claim.freshness ?? null,claim.confidence], client);
      const claimId = claimRow.rows[0]?.id;
      if (claimId && claim.evidenceIds.length) {
        await query(`INSERT INTO quality_claim_evidence(workspace_id,claim_id,evidence_id)
          SELECT $1,$2,e.id FROM quality_evidence e WHERE e.workspace_id=$1 AND e.id=ANY($3::uuid[])
          ON CONFLICT DO NOTHING`, [workspaceId,claimId,claim.evidenceIds], client);
      }
    }
    await appendDomainEvent({ workspaceId, type: DOMAIN_EVENT_TYPES.QUALITY_ARTIFACT_CREATED,
      aggregateType: 'quality_artifact', aggregateId: artifactId,
      payload: { artifactId, artifactVersionId: versionId, artifactType: input.artifactType },
      metadata: { actorId: userId, source: 'quality' }, idempotencyKey: `quality-artifact:${artifactId}:created:v1` }, client);
    await appendDomainEvent({ workspaceId, type: DOMAIN_EVENT_TYPES.QUALITY_REVIEW_REQUESTED,
      aggregateType: 'quality_artifact', aggregateId: artifactId,
      payload: { artifactId, artifactVersionId: versionId, reason: 'artifact_created' },
      metadata: { actorId: userId, source: 'quality' }, idempotencyKey: `quality-review:${artifactId}:requested:v1` }, client);
    return { artifactId, artifactVersionId: versionId };
  });
}

export async function findArtifact(workspaceId: string, artifactId: string, client?: PoolClient) {
  const artifact = await query<Record<string, unknown>>(`SELECT ${artifactSelect} FROM quality_artifacts a WHERE a.workspace_id=$1 AND a.id=$2`, [workspaceId,artifactId], client);
  if (!artifact.rows[0]) return null;
  const versions = await query<Record<string, unknown>>(`SELECT v.id,v.version,v.content,v.rendered_ref AS "renderedRef",
      v.producer_agent_id AS "producerAgentId",v.producer_version AS "producerVersion",v.model_provider AS "modelProvider",
      v.model_name AS "modelName",v.model_metadata AS "modelMetadata",v.source_snapshot_id AS "sourceSnapshotId",v.created_at AS "createdAt"
      FROM quality_artifact_versions v WHERE v.workspace_id=$1 AND v.artifact_id=$2 ORDER BY v.version DESC`, [workspaceId,artifactId], client);
  const current = versions.rows[0] as { id?: string } | undefined;
  const [claims,reviews,findings,decisions,feedback,outcomes] = await Promise.all([
    query(`SELECT c.id,c.artifact_version_id AS "artifactVersionId",c.claim_text AS "claimText",c.position,c.claim_type AS "claimType",c.source_status AS "sourceStatus",c.freshness,c.confidence,c.verdict,c.created_at AS "createdAt",
      COALESCE((SELECT json_agg(ce.evidence_id) FROM quality_claim_evidence ce WHERE ce.workspace_id=c.workspace_id AND ce.claim_id=c.id),'[]'::json) AS "evidenceIds"
      FROM quality_claims c WHERE c.workspace_id=$1 AND c.artifact_version_id IN (SELECT id FROM quality_artifact_versions WHERE workspace_id=$1 AND artifact_id=$2) ORDER BY c.created_at`,[workspaceId,artifactId],client),
    query(`SELECT r.id,r.artifact_version_id AS "artifactVersionId",r.reviewer_agent_id AS "reviewerAgentId",r.reviewer_version AS "reviewerVersion",r.reviewer_kind AS "reviewerKind",r.verdict,r.overall_score AS "overallScore",r.dimensions,r.findings,r.checked_claims AS "checkedClaims",r.confidence,r.limitations,r.next_action AS "nextAction",r.created_at AS "createdAt" FROM quality_reviews r WHERE r.workspace_id=$1 AND r.artifact_version_id IN (SELECT id FROM quality_artifact_versions WHERE workspace_id=$1 AND artifact_id=$2) ORDER BY r.created_at DESC`,[workspaceId,artifactId],client),
    query(`SELECT f.id,f.review_id AS "reviewId",f.artifact_version_id AS "artifactVersionId",f.severity,f.category,f.location,f.message,f.evidence_refs AS "evidenceRefs",f.suggested_fix AS "suggestedFix",f.resolved_at AS "resolvedAt",f.created_at AS "createdAt" FROM quality_findings f WHERE f.workspace_id=$1 AND f.artifact_version_id IN (SELECT id FROM quality_artifact_versions WHERE workspace_id=$1 AND artifact_id=$2) ORDER BY f.created_at DESC`,[workspaceId,artifactId],client),
    query(`SELECT d.id,d.artifact_version_id AS "artifactVersionId",d.decision,d.reason,d.actor_type AS "actorType",d.actor_id AS "actorId",d.override_reason AS "overrideReason",d.created_at AS "createdAt" FROM quality_release_decisions d WHERE d.workspace_id=$1 AND d.artifact_id=$2 ORDER BY d.created_at DESC`,[workspaceId,artifactId],client),
    query(`SELECT id,artifact_version_id AS "artifactVersionId",outcome,edit_distance AS "editDistance",notes,created_by AS "createdBy",created_at AS "createdAt" FROM quality_feedback WHERE workspace_id=$1 AND artifact_id=$2 ORDER BY created_at DESC`,[workspaceId,artifactId],client),
    query(`SELECT id,artifact_version_id AS "artifactVersionId",metric_key AS "metricKey",value,value_text AS "valueText",source,observed_at AS "observedAt",verified,metadata FROM quality_outcomes WHERE workspace_id=$1 AND artifact_id=$2 ORDER BY observed_at DESC`,[workspaceId,artifactId],client),
  ]);
  return { artifact: artifact.rows[0], versions: versions.rows, currentVersionId: current?.id ?? null,
    claims: claims.rows, reviews: reviews.rows, findings: findings.rows, releaseDecisions: decisions.rows,
    feedback: feedback.rows, outcomes: outcomes.rows };
}

export async function findArtifactByVersion(workspaceId: string, versionId: string) {
  const { rows } = await query<{ artifactId: string }>(`SELECT artifact_id AS "artifactId" FROM quality_artifact_versions WHERE workspace_id=$1 AND id=$2`, [workspaceId, versionId]);
  return rows[0]?.artifactId ?? null;
}

export async function listArtifacts(workspaceId: string, filters: ListArtifactsQuery) {
  const { rows } = await query<Record<string, unknown>>(`SELECT ${artifactSelect},
      (SELECT count(*)::int FROM quality_reviews r WHERE r.workspace_id=a.workspace_id AND r.artifact_version_id IN (SELECT id FROM quality_artifact_versions WHERE artifact_id=a.id)) AS "reviewCount",
      (SELECT count(*)::int FROM quality_findings f WHERE f.workspace_id=a.workspace_id AND f.artifact_version_id IN (SELECT id FROM quality_artifact_versions WHERE artifact_id=a.id) AND f.resolved_at IS NULL AND f.severity='hard_block') AS "openHardBlockCount"
    FROM quality_artifacts a WHERE a.workspace_id=$1 AND ($2::text IS NULL OR a.status=$2) AND ($3::text IS NULL OR a.artifact_type=$3)
    ORDER BY a.updated_at DESC LIMIT $4 OFFSET $5`, [workspaceId,filters.status ?? null,filters.artifactType ?? null,filters.limit,filters.offset]);
  return rows;
}

export async function createReview(workspaceId: string, userId: string, input: CreateReviewInput) {
  return withTransaction(async (client) => {
    const version = await query<{ artifactId: string; producerAgentId: string }>(`SELECT artifact_id AS "artifactId",producer_agent_id AS "producerAgentId" FROM quality_artifact_versions WHERE workspace_id=$1 AND id=$2`,[workspaceId,input.artifactVersionId],client);
    const row = version.rows[0]; if (!row) return null;
    const review = await query<{ id: string }>(`INSERT INTO quality_reviews(workspace_id,artifact_version_id,reviewer_agent_id,reviewer_version,reviewer_kind,verdict,overall_score,dimensions,findings,checked_claims,confidence,limitations,next_action,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13,$14) RETURNING id`,[workspaceId,input.artifactVersionId,input.reviewerAgentId,input.reviewerVersion,input.reviewerKind,input.verdict,input.overallScore ?? null,json(input.dimensions),json(input.findings),json(input.checkedClaims),input.confidence,json(input.limitations),input.nextAction,userId],client);
    const reviewId=review.rows[0]?.id; if (!reviewId) throw new Error('Quality review insert did not return an id');
    for (const finding of input.findings) await query(`INSERT INTO quality_findings(workspace_id,review_id,artifact_version_id,severity,category,location,message,evidence_refs,suggested_fix) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,[workspaceId,reviewId,input.artifactVersionId,finding.severity,finding.category,finding.location ?? null,finding.message,json(finding.evidenceRefs),finding.suggestedFix ?? null],client);
    for (const claim of input.checkedClaims) await query(`UPDATE quality_claims SET verdict=$4 WHERE workspace_id=$1 AND artifact_version_id=$2 AND id=$3`,[workspaceId,input.artifactVersionId,claim.claimId,claim.verdict],client);
    const nextStatus = input.verdict === 'passed' ? (input.reviewerKind === 'final_gate' ? 'APPROVED' : 'FINAL_REVIEW') : input.verdict === 'needs_repair' ? 'REPAIR_REQUIRED' : input.verdict === 'unavailable' ? 'WITHHELD' : 'REJECTED';
    await query(`UPDATE quality_artifacts SET status=$3,updated_at=NOW() WHERE workspace_id=$1 AND id=$2`,[workspaceId,row.artifactId,nextStatus],client);
    await appendDomainEvent({ workspaceId, type: DOMAIN_EVENT_TYPES.QUALITY_REVIEW_COMPLETED, aggregateType:'quality_artifact', aggregateId:row.artifactId, payload:{ artifactId:row.artifactId, artifactVersionId:input.artifactVersionId, reviewId, verdict:input.verdict, reviewerKind:input.reviewerKind }, metadata:{ actorId:userId, source:'quality' }, idempotencyKey:`quality-review:${reviewId}:completed:v1` },client);
    return reviewId;
  });
}

export async function createRepair(workspaceId: string, userId: string, artifactId: string, input: RepairInput) {
  const result = await query<{ roundNumber: number }>(`SELECT COALESCE(MAX(round_number),0)+1 AS "roundNumber" FROM quality_repair_attempts WHERE workspace_id=$1 AND artifact_id=$2`,[workspaceId,artifactId]);
  const row = await query<{ id: string }>(`INSERT INTO quality_repair_attempts(workspace_id,artifact_id,input_version_id,round_number,finding_ids,created_by) VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING id`,[workspaceId,artifactId,input.artifactVersionId,Number(result.rows[0]?.roundNumber ?? 1),json(input.findingIds),userId]);
  await query(`UPDATE quality_artifacts SET status='REPAIRING',updated_at=NOW() WHERE workspace_id=$1 AND id=$2`,[workspaceId,artifactId]);
  await appendDomainEvent({workspaceId,type:DOMAIN_EVENT_TYPES.QUALITY_REPAIR_REQUESTED,aggregateType:'quality_artifact',aggregateId:artifactId,payload:{artifactId,artifactVersionId:input.artifactVersionId,repairAttemptId:row.rows[0]?.id,findingIds:input.findingIds},metadata:{actorId:userId,source:'quality'},idempotencyKey:`quality-repair:${row.rows[0]?.id}:requested:v1`});
  return row.rows[0]?.id ?? null;
}

export async function countRepairAttempts(workspaceId: string, artifactId: string) {
  const { rows } = await query<{ count: number }>(`SELECT count(*)::int AS count FROM quality_repair_attempts WHERE workspace_id=$1 AND artifact_id=$2`, [workspaceId, artifactId]);
  return Number(rows[0]?.count ?? 0);
}

export async function findRepairAttempt(workspaceId: string, repairAttemptId: string) {
  const { rows } = await query(`SELECT id,workspace_id AS "workspaceId",artifact_id AS "artifactId",input_version_id AS "inputVersionId",
      output_version_id AS "outputVersionId",round_number AS "roundNumber",status,finding_ids AS "findingIds",created_by AS "createdBy"
    FROM quality_repair_attempts WHERE workspace_id=$1 AND id=$2`, [workspaceId, repairAttemptId]);
  return rows[0] ?? null;
}

export async function markRepairFailed(workspaceId: string, repairAttemptId: string, message: string) {
  await query(`UPDATE quality_repair_attempts SET status='failed',error_message=$3,finished_at=NOW() WHERE workspace_id=$1 AND id=$2 AND status IN ('queued','running')`, [workspaceId, repairAttemptId, message.slice(0, 4000)]);
}

export async function createRepairVersion(workspaceId: string, repairAttemptId: string, content: Record<string, unknown>, producerAgentId: string, producerVersion: string) {
  return withTransaction(async (client) => {
    const attempt = await query<{ artifactId: string; inputVersionId: string; createdBy: string | null }>(`SELECT artifact_id AS "artifactId",input_version_id AS "inputVersionId",created_by AS "createdBy" FROM quality_repair_attempts WHERE workspace_id=$1 AND id=$2 AND status IN ('queued','running') FOR UPDATE`, [workspaceId, repairAttemptId], client);
    const row = attempt.rows[0];
    if (!row) return null;
    await query(`UPDATE quality_repair_attempts SET status='running' WHERE workspace_id=$1 AND id=$2`, [workspaceId, repairAttemptId], client);
    const version = await query<{ version: number; sourceSnapshotId: string | null }>(`SELECT COALESCE(MAX(version),0)+1 AS version,
      (SELECT source_snapshot_id FROM quality_artifact_versions WHERE workspace_id=$1 AND artifact_id=$2 ORDER BY version DESC LIMIT 1) AS "sourceSnapshotId"
      FROM quality_artifact_versions WHERE workspace_id=$1 AND artifact_id=$2`, [workspaceId, row.artifactId], client);
    const nextVersion = Number(version.rows[0]?.version ?? 1);
    const inserted = await query<{ id: string }>(`INSERT INTO quality_artifact_versions(workspace_id,artifact_id,version,content,producer_agent_id,producer_version,source_snapshot_id)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING id`, [workspaceId,row.artifactId,nextVersion,json(content),producerAgentId,producerVersion,version.rows[0]?.sourceSnapshotId ?? null], client);
    const versionId = inserted.rows[0]?.id;
    if (!versionId) throw new Error('Quality repair version insert did not return an id');
    await query(`INSERT INTO quality_claims(workspace_id,artifact_version_id,claim_text,position,claim_type,source_status,freshness,confidence,verdict)
      SELECT workspace_id,$3,claim_text,position,claim_type,source_status,freshness,confidence,'unchecked' FROM quality_claims WHERE workspace_id=$1 AND artifact_version_id=$2`, [workspaceId,row.inputVersionId,versionId], client);
    await query(`INSERT INTO quality_claim_evidence(workspace_id,claim_id,evidence_id)
      SELECT $1,new_claim.id,old_link.evidence_id
      FROM quality_claims old_claim JOIN quality_claims new_claim ON new_claim.workspace_id=old_claim.workspace_id AND new_claim.artifact_version_id=$3 AND new_claim.claim_text=old_claim.claim_text
      JOIN quality_claim_evidence old_link ON old_link.workspace_id=old_claim.workspace_id AND old_link.claim_id=old_claim.id
      WHERE old_claim.workspace_id=$1 AND old_claim.artifact_version_id=$2 ON CONFLICT DO NOTHING`, [workspaceId,row.inputVersionId,versionId], client);
    await query(`UPDATE quality_artifacts SET current_version=$3,status='REVIEW_PENDING',provider_status='completed',updated_at=NOW() WHERE workspace_id=$1 AND id=$2`, [workspaceId,row.artifactId,nextVersion], client);
    await query(`UPDATE quality_repair_attempts SET status='completed',output_version_id=$3,finished_at=NOW() WHERE workspace_id=$1 AND id=$2`, [workspaceId,repairAttemptId,versionId], client);
    await appendDomainEvent({ workspaceId, type: DOMAIN_EVENT_TYPES.QUALITY_REPAIR_COMPLETED, aggregateType:'quality_artifact', aggregateId:row.artifactId,
      payload:{ artifactId:row.artifactId, repairAttemptId, artifactVersionId:versionId }, metadata:{ actorId:row.createdBy, source:'quality.repair' }, idempotencyKey:`quality-repair:${repairAttemptId}:completed:v1` }, client);
    await appendDomainEvent({ workspaceId, type: DOMAIN_EVENT_TYPES.QUALITY_REVIEW_REQUESTED, aggregateType:'quality_artifact', aggregateId:row.artifactId,
      payload:{ artifactId:row.artifactId, artifactVersionId:versionId, reason:'repair_completed' }, metadata:{ actorId:row.createdBy, source:'quality.repair' }, idempotencyKey:`quality-review:${row.artifactId}:version:${versionId}:requested:v1` }, client);
    return { artifactId: row.artifactId, artifactVersionId: versionId };
  });
}

export async function updateProviderStatus(workspaceId: string, artifactId: string, providerStatus: ProviderStatusInput['providerStatus'], userId: string) {
  const { rows } = await query(`UPDATE quality_artifacts SET provider_status=$3,updated_at=NOW() WHERE workspace_id=$1 AND id=$2 RETURNING ${artifactSelect}`,[workspaceId,artifactId,providerStatus]);
  const artifact = rows[0];
  if (!artifact) return null;
  await appendDomainEvent({ workspaceId, type: DOMAIN_EVENT_TYPES.QUALITY_PROVIDER_STATUS_CHANGED, aggregateType:'quality_artifact', aggregateId:artifactId,
    payload:{ artifactId, providerStatus }, metadata:{ actorId:userId, source:'quality' }, idempotencyKey:`quality-provider-status:${artifactId}:${providerStatus}` });
  if (providerStatus === 'completed') await appendDomainEvent({ workspaceId, type: DOMAIN_EVENT_TYPES.QUALITY_REVIEW_REQUESTED, aggregateType:'quality_artifact', aggregateId:artifactId,
    payload:{ artifactId, reason:'provider_completed' }, metadata:{ actorId:userId, source:'quality' }, idempotencyKey:`quality-review:${artifactId}:provider-completed:v1` });
  return artifact;
}

export async function createReleaseDecision(workspaceId: string, userId: string | null, actorType: string, artifactId: string, input: ReleaseDecisionInput) {
  return withTransaction(async (client) => {
    const artifact = await query<{ producerAgentId: string }>(`SELECT v.producer_agent_id AS "producerAgentId" FROM quality_artifact_versions v JOIN quality_artifacts a ON a.workspace_id=v.workspace_id AND a.id=v.artifact_id WHERE a.workspace_id=$1 AND a.id=$2 AND v.id=$3`,[workspaceId,artifactId,input.artifactVersionId],client);
    if (!artifact.rows[0]) return null;
    const decision = await query<{ id: string }>(`INSERT INTO quality_release_decisions(workspace_id,artifact_id,artifact_version_id,decision,reason,actor_type,actor_id,override_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[workspaceId,artifactId,input.artifactVersionId,input.decision,input.reason,actorType,userId,input.overrideReason ?? null],client);
    const status = input.decision === 'released' ? 'RELEASED' : input.decision === 'approved' ? 'APPROVED' : input.decision === 'queued' ? 'RELEASE_QUEUED' : input.decision === 'withheld' ? 'WITHHELD' : input.decision === 'rejected' ? 'REJECTED' : 'ESCALATED';
    await query(`UPDATE quality_artifacts SET status=$3,updated_at=NOW() WHERE workspace_id=$1 AND id=$2`,[workspaceId,artifactId,status],client);
    await appendDomainEvent({workspaceId,type:input.decision==='released'?DOMAIN_EVENT_TYPES.QUALITY_ARTIFACT_RELEASED:DOMAIN_EVENT_TYPES.QUALITY_RELEASE_APPROVED,aggregateType:'quality_artifact',aggregateId:artifactId,payload:{artifactId,artifactVersionId:input.artifactVersionId,decision:input.decision,releaseDecisionId:decision.rows[0]?.id},metadata:{actorId:userId,source:'quality'},idempotencyKey:`quality-release:${decision.rows[0]?.id}:v1`},client);
    return decision.rows[0]?.id ?? null;
  });
}

export async function createFeedback(workspaceId: string, userId: string, artifactId: string, input: FeedbackInput) {
  const { rows } = await query<{ id: string }>(`INSERT INTO quality_feedback(workspace_id,artifact_id,artifact_version_id,outcome,edit_distance,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[workspaceId,artifactId,input.artifactVersionId,input.outcome,input.editDistance ?? null,input.notes ?? null,userId]);
  await appendDomainEvent({workspaceId,type:DOMAIN_EVENT_TYPES.QUALITY_FEEDBACK_RECORDED,aggregateType:'quality_artifact',aggregateId:artifactId,payload:{artifactId,artifactVersionId:input.artifactVersionId,feedbackId:rows[0]?.id,outcome:input.outcome},metadata:{actorId:userId,source:'quality'},idempotencyKey:`quality-feedback:${rows[0]?.id}:v1`});
  return rows[0]?.id ?? null;
}

export async function createOutcome(workspaceId: string, artifactId: string, input: OutcomeInput) {
  const { rows } = await query<{ id: string }>(`INSERT INTO quality_outcomes(workspace_id,artifact_id,artifact_version_id,metric_key,value,value_text,source,observed_at,verified,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING id`,[workspaceId,artifactId,input.artifactVersionId,input.metricKey,input.value ?? null,input.valueText ?? null,input.source,input.observedAt ? new Date(input.observedAt) : new Date(),input.verified,json(input.metadata)]);
  await appendDomainEvent({workspaceId,type:DOMAIN_EVENT_TYPES.QUALITY_OUTCOME_OBSERVED,aggregateType:'quality_artifact',aggregateId:artifactId,payload:{artifactId,artifactVersionId:input.artifactVersionId,outcomeId:rows[0]?.id,metricKey:input.metricKey},metadata:{source:'quality'},idempotencyKey:`quality-outcome:${rows[0]?.id}:v1`});
  return rows[0]?.id ?? null;
}

export async function getOverview(workspaceId: string) {
  const [counts, recent] = await Promise.all([
    query(`SELECT count(*)::int AS "artifactCount",count(*) FILTER (WHERE status IN ('REPAIR_REQUIRED','WITHHELD','ESCALATED'))::int AS "blockedCount",count(*) FILTER (WHERE status='RELEASED')::int AS "releasedCount",count(*) FILTER (WHERE status='MEASURED')::int AS "measuredCount" FROM quality_artifacts WHERE workspace_id=$1`,[workspaceId]),
    query(`SELECT ${artifactSelect},
      (SELECT count(*)::int FROM quality_reviews r WHERE r.workspace_id=a.workspace_id AND r.artifact_version_id IN (SELECT id FROM quality_artifact_versions WHERE artifact_id=a.id)) AS "reviewCount",
      (SELECT count(*)::int FROM quality_findings f WHERE f.workspace_id=a.workspace_id AND f.artifact_version_id IN (SELECT id FROM quality_artifact_versions WHERE artifact_id=a.id) AND f.resolved_at IS NULL AND f.severity='hard_block') AS "openHardBlockCount"
      FROM quality_artifacts a WHERE a.workspace_id=$1 ORDER BY a.updated_at DESC LIMIT 20`,[workspaceId]),
  ]);
  return { counts: counts.rows[0] ?? { artifactCount:0,blockedCount:0,releasedCount:0,measuredCount:0 }, recent: recent.rows };
}

export async function getConfig(workspaceId: string) {
  const { rows } = await query(`SELECT workspace_id AS "workspaceId",default_mode AS "defaultMode",max_repair_rounds AS "maxRepairRounds",independent_review_required AS "independentReviewRequired",updated_by AS "updatedBy",updated_at AS "updatedAt" FROM quality_workspace_config WHERE workspace_id=$1`,[workspaceId]);
  return rows[0] ?? { workspaceId, defaultMode:'SHADOW', maxRepairRounds:3, independentReviewRequired:false };
}

export async function updateConfig(workspaceId: string, userId: string, input: QualityConfigInput) {
  const { rows } = await query(`INSERT INTO quality_workspace_config(workspace_id,default_mode,max_repair_rounds,independent_review_required,updated_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id) DO UPDATE SET default_mode=EXCLUDED.default_mode,max_repair_rounds=EXCLUDED.max_repair_rounds,independent_review_required=EXCLUDED.independent_review_required,updated_by=EXCLUDED.updated_by,updated_at=NOW() RETURNING workspace_id AS "workspaceId",default_mode AS "defaultMode",max_repair_rounds AS "maxRepairRounds",independent_review_required AS "independentReviewRequired",updated_by AS "updatedBy",updated_at AS "updatedAt"`,[workspaceId,input.defaultMode,input.maxRepairRounds,input.independentReviewRequired,userId]);
  return rows[0];
}
