import { randomBytes } from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import type {
  KieProviderApi,
  PremiumMediaCandidate,
  PremiumMediaJob,
  PremiumMediaJobStatus,
  PremiumMediaPurpose,
  PremiumMediaReference,
  PremiumMediaType,
} from './premium-media.types.js';

const jobSelect = `
  id, workspace_id AS "workspaceId", product_id AS "productId", requested_by AS "requestedBy",
  status, aspect_ratio AS "aspectRatio", creative_direction AS "creativeDirection",
  reference_assets AS "referenceAssets", deliver_image AS "deliverImage", deliver_video AS "deliverVideo",
  image_round AS "imageRound", video_round AS "videoRound", max_rounds AS "maxRounds",
  image_quality_threshold AS "imageQualityThreshold", video_quality_threshold AS "videoQualityThreshold",
  selected_image_candidate_id AS "selectedImageCandidateId", selected_video_candidate_id AS "selectedVideoCandidateId",
  final_image_media_id AS "finalImageMediaId", final_video_media_id AS "finalVideoMediaId",
  error_code AS "errorCode", error_message AS "errorMessage", started_at AS "startedAt",
  completed_at AS "completedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

const candidateSelect = `
  id, job_id AS "jobId", workspace_id AS "workspaceId", product_id AS "productId", purpose,
  media_type AS "mediaType", model, provider_api AS "providerApi", provider_task_id AS "providerTaskId",
  callback_token AS "callbackToken", status, generation_round AS "generationRound", prompt,
  reference_urls AS "referenceUrls", result_urls AS "resultUrls", provider_payload AS "providerPayload",
  credits_consumed AS "creditsConsumed", usage_recorded AS "usageRecorded", quality_score AS "qualityScore",
  quality_report AS "qualityReport", storage_reference AS "storageReference", mime_type AS "mimeType",
  product_media_id AS "productMediaId", processing_attempts AS "processingAttempts", worker_id AS "workerId",
  processing_started_at AS "processingStartedAt", error_code AS "errorCode", error_message AS "errorMessage",
  submitted_at AS "submittedAt", completed_at AS "completedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

export type ProductMediaContext = {
  id: string;
  name: string;
  shortDescription: string | null;
  longDescription: string | null;
  media: Array<{
    id: string;
    storageReference: string;
    externalUrl: string | null;
    mimeType: string | null;
    title: string | null;
  }>;
};

export async function getProductMediaContext(workspaceId: string, productId: string): Promise<ProductMediaContext | null> {
  const product = await query<Omit<ProductMediaContext, 'media'>>(
    `SELECT id, name, short_description AS "shortDescription", long_description AS "longDescription"
       FROM products WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`,
    [workspaceId, productId],
  );
  if (!product.rows[0]) return null;
  const media = await query<ProductMediaContext['media'][number]>(
    `SELECT id, storage_reference AS "storageReference", external_url AS "externalUrl",
            NULL::text AS "mimeType", title
       FROM product_media
      WHERE workspace_id=$1 AND product_id=$2 AND media_type='IMAGE'
        AND storage_reference NOT LIKE $3
      ORDER BY is_primary DESC, sort_order, created_at`,
    [workspaceId, productId, `%/premium-media/%`],
  );
  return { ...product.rows[0], media: media.rows };
}

export async function getActiveJob(workspaceId: string, productId: string) {
  const { rows } = await query<PremiumMediaJob>(
    `SELECT ${jobSelect} FROM premium_media_jobs
      WHERE workspace_id=$1 AND product_id=$2 AND status NOT IN ('COMPLETED','FAILED','CANCELLED')
      ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, productId],
  );
  return rows[0] ?? null;
}

export async function createJob(input: {
  workspaceId: string;
  productId: string;
  requestedBy?: string | null;
  aspectRatio: '1:1' | '16:9' | '9:16';
  creativeDirection?: string | null;
  referenceAssets: PremiumMediaReference[];
  deliverImage: boolean;
  deliverVideo: boolean;
  maxRounds: number;
  imageQualityThreshold: number;
  videoQualityThreshold: number;
}) {
  return withTransaction(async (client) => {
    const { rows } = await query<PremiumMediaJob>(
      `INSERT INTO premium_media_jobs (
         workspace_id,product_id,requested_by,status,aspect_ratio,creative_direction,reference_assets,
         deliver_image,deliver_video,image_round,video_round,max_rounds,image_quality_threshold,video_quality_threshold
       ) VALUES ($1,$2,$3,'SUBMITTING_IMAGES',$4,$5,$6::jsonb,$7,$8,1,0,$9,$10,$11)
       RETURNING ${jobSelect}`,
      [
        input.workspaceId,
        input.productId,
        input.requestedBy ?? null,
        input.aspectRatio,
        input.creativeDirection ?? null,
        JSON.stringify(input.referenceAssets),
        input.deliverImage,
        input.deliverVideo,
        input.maxRounds,
        input.imageQualityThreshold,
        input.videoQualityThreshold,
      ],
      client,
    );
    const job = rows[0];
    if (!job) throw new Error('Premium media job insert did not return a row');
    await appendDomainEvent({
      workspaceId: input.workspaceId,
      type: DOMAIN_EVENT_TYPES.PREMIUM_MEDIA_REQUESTED,
      aggregateType: 'premium_media_job',
      aggregateId: job.id,
      payload: { jobId: job.id, productId: input.productId, deliverImage: input.deliverImage, deliverVideo: input.deliverVideo },
      metadata: { actorId: input.requestedBy ?? null, source: 'premium-media' },
      idempotencyKey: `premium-media:${job.id}:requested:v1`,
    }, client);
    return job;
  });
}

export async function getJob(workspaceId: string, jobId: string) {
  const { rows } = await query<PremiumMediaJob>(
    `SELECT ${jobSelect} FROM premium_media_jobs WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, jobId],
  );
  return rows[0] ?? null;
}

export async function getJobById(jobId: string) {
  const { rows } = await query<PremiumMediaJob>(`SELECT ${jobSelect} FROM premium_media_jobs WHERE id=$1`, [jobId]);
  return rows[0] ?? null;
}

export async function getLatestJob(workspaceId: string, productId: string) {
  const { rows } = await query<PremiumMediaJob>(
    `SELECT ${jobSelect} FROM premium_media_jobs WHERE workspace_id=$1 AND product_id=$2 ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, productId],
  );
  return rows[0] ?? null;
}

export async function listProductsAwaitingFirstProduction(limit = 10) {
  const { rows } = await query<{ workspaceId: string; productId: string }>(
    `SELECT p.workspace_id AS "workspaceId",p.id AS "productId"
       FROM products p
      WHERE p.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM product_media media
           WHERE media.workspace_id=p.workspace_id AND media.product_id=p.id AND media.media_type='IMAGE'
        )
        AND NOT EXISTS (
          SELECT 1 FROM premium_media_jobs job
           WHERE job.workspace_id=p.workspace_id AND job.product_id=p.id
        )
      ORDER BY p.created_at
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function listCandidates(workspaceId: string, jobId: string) {
  const { rows } = await query<PremiumMediaCandidate>(
    `SELECT ${candidateSelect} FROM premium_media_candidates WHERE workspace_id=$1 AND job_id=$2 ORDER BY created_at`,
    [workspaceId, jobId],
  );
  return rows;
}

export async function createCandidate(input: {
  job: PremiumMediaJob;
  purpose: PremiumMediaPurpose;
  mediaType: PremiumMediaType;
  model: string;
  providerApi: KieProviderApi;
  generationRound: number;
  prompt: string;
  referenceUrls: string[];
}) {
  const callbackToken = randomBytes(32).toString('hex');
  const { rows } = await query<PremiumMediaCandidate>(
    `INSERT INTO premium_media_candidates (
       job_id,workspace_id,product_id,purpose,media_type,model,provider_api,callback_token,
       status,generation_round,prompt,reference_urls
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'SUBMITTING',$9,$10,$11::jsonb)
     RETURNING ${candidateSelect}`,
    [
      input.job.id,
      input.job.workspaceId,
      input.job.productId,
      input.purpose,
      input.mediaType,
      input.model,
      input.providerApi,
      callbackToken,
      input.generationRound,
      input.prompt,
      JSON.stringify(input.referenceUrls),
    ],
  );
  const candidate = rows[0];
  if (!candidate) throw new Error('Premium media candidate insert did not return a row');
  return candidate;
}

export async function markCandidateSubmitted(candidateId: string, taskId: string, payload: Record<string, unknown>) {
  const { rows } = await query<PremiumMediaCandidate>(
    `UPDATE premium_media_candidates SET provider_task_id=$2,status='SUBMITTED',provider_payload=$3::jsonb,
       submitted_at=NOW(),error_code=NULL,error_message=NULL
      WHERE id=$1 AND status='SUBMITTING' RETURNING ${candidateSelect}`,
    [candidateId, taskId, JSON.stringify(payload)],
  );
  return rows[0] ?? null;
}

export async function markCandidateSubmissionFailed(candidateId: string, code: string, message: string) {
  await query(
    `UPDATE premium_media_candidates SET status='FAILED',error_code=$2,error_message=$3,completed_at=NOW()
      WHERE id=$1 AND status='SUBMITTING'`,
    [candidateId, code.slice(0, 120), message.slice(0, 2_000)],
  );
}

export async function applyProviderResult(input: {
  candidateId?: string;
  callbackToken?: string;
  providerTaskId?: string | null;
  state: 'pending' | 'success' | 'failed';
  resultUrls: string[];
  creditsConsumed: number;
  payload: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  const identifierSql = input.candidateId ? 'id=$1' : 'callback_token=$1';
  const identifier = input.candidateId ?? input.callbackToken;
  if (!identifier) return null;
  const status = input.state === 'success' ? 'PROVIDER_SUCCEEDED' : input.state === 'failed' ? 'FAILED' : 'SUBMITTED';
  const { rows } = await query<PremiumMediaCandidate>(
    `UPDATE premium_media_candidates SET
       provider_task_id=COALESCE(provider_task_id,$2),
       status=CASE
         WHEN status IN ('ACCEPTED','REJECTED','FAILED') THEN status
         WHEN $3='SUBMITTED' AND status='PROVIDER_SUCCEEDED' THEN status
         ELSE $3
       END,
       result_urls=CASE WHEN jsonb_array_length($4::jsonb)>0 THEN $4::jsonb ELSE result_urls END,
       credits_consumed=GREATEST(credits_consumed,$5),
       provider_payload=provider_payload || $6::jsonb,
       error_code=CASE WHEN status NOT IN ('ACCEPTED','REJECTED','FAILED') AND $3='FAILED' THEN $7 ELSE error_code END,
       error_message=CASE WHEN status NOT IN ('ACCEPTED','REJECTED','FAILED') AND $3='FAILED' THEN $8 ELSE error_message END,
       completed_at=CASE WHEN $3 IN ('PROVIDER_SUCCEEDED','FAILED') THEN NOW() ELSE completed_at END
     WHERE ${identifierSql}
     RETURNING ${candidateSelect}`,
    [
      identifier,
      input.providerTaskId ?? null,
      status,
      JSON.stringify(input.resultUrls),
      input.creditsConsumed,
      JSON.stringify(input.payload),
      input.errorCode ?? null,
      input.errorMessage?.slice(0, 2_000) ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function listCandidatesNeedingPoll(pollAfterSeconds: number, limit = 20) {
  const { rows } = await query<PremiumMediaCandidate>(
    `SELECT ${candidateSelect} FROM premium_media_candidates
      WHERE status='SUBMITTED' AND provider_task_id IS NOT NULL
        AND updated_at < NOW() - ($1::integer * INTERVAL '1 second')
      ORDER BY updated_at LIMIT $2`,
    [pollAfterSeconds, limit],
  );
  return rows;
}

export async function touchCandidate(candidateId: string) {
  await query(`UPDATE premium_media_candidates SET updated_at=NOW() WHERE id=$1 AND status='SUBMITTED'`, [candidateId]);
}

export async function failStaleSubmittingCandidates(staleSeconds: number) {
  await query(
    `UPDATE premium_media_candidates SET status='FAILED',error_code='KIE_SUBMISSION_TIMEOUT',
       error_message='The provider task submission did not complete before its recovery deadline.',completed_at=NOW()
      WHERE status='SUBMITTING' AND updated_at < NOW() - ($1::integer * INTERVAL '1 second')`,
    [staleSeconds],
  );
}

export async function failTimedOutProviderCandidates(timeoutMinutes: number) {
  await query(
    `UPDATE premium_media_candidates SET status='FAILED',error_code='KIE_TASK_TIMEOUT',
       error_message='The provider task exceeded Lulu''s automatic production deadline.',completed_at=NOW()
      WHERE status='SUBMITTED' AND submitted_at < NOW() - ($1::integer * INTERVAL '1 minute')`,
    [timeoutMinutes],
  );
}

export async function claimCandidateForProcessing(workerId: string, maxAttempts: number) {
  return withTransaction(async (client) => {
    await query(
      `UPDATE premium_media_candidates SET status='FAILED',error_code='PREMIUM_MEDIA_PROCESSING_RETRY_EXHAUSTED',
         error_message='Automatic quality processing exceeded its retry limit.',worker_id=NULL,completed_at=NOW()
        WHERE status IN ('PROVIDER_SUCCEEDED','PROCESSING') AND processing_attempts >= $1
          AND (worker_id IS NULL OR processing_started_at < NOW() - INTERVAL '10 minutes')`,
      [maxAttempts],
      client,
    );
    const { rows } = await query<PremiumMediaCandidate>(
      `WITH candidate AS (
         SELECT id FROM premium_media_candidates
          WHERE status IN ('PROVIDER_SUCCEEDED','PROCESSING') AND processing_attempts < $2
            AND (worker_id IS NULL OR processing_started_at < NOW() - INTERVAL '10 minutes')
          ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       UPDATE premium_media_candidates target SET status='PROCESSING',worker_id=$1,
         processing_started_at=NOW(),processing_attempts=target.processing_attempts+1
       FROM candidate WHERE target.id=candidate.id RETURNING ${candidateSelect}`,
      [workerId, maxAttempts],
      client,
    );
    return rows[0] ?? null;
  });
}

export async function releaseCandidateForRetry(candidateId: string, workerId: string, code: string, message: string) {
  await query(
    `UPDATE premium_media_candidates SET status='PROVIDER_SUCCEEDED',worker_id=NULL,processing_started_at=NULL,
       error_code=$3,error_message=$4 WHERE id=$1 AND worker_id=$2 AND status='PROCESSING'`,
    [candidateId, workerId, code.slice(0, 120), message.slice(0, 2_000)],
  );
}

export async function failClaimedCandidate(candidateId: string, workerId: string, code: string, message: string) {
  await query(
    `UPDATE premium_media_candidates SET status='FAILED',worker_id=NULL,processing_started_at=NULL,
       error_code=$3,error_message=$4,completed_at=NOW()
      WHERE id=$1 AND worker_id=$2 AND status='PROCESSING'`,
    [candidateId, workerId, code.slice(0, 120), message.slice(0, 2_000)],
  );
}

export async function listUnrecordedProviderUsage(limit = 50) {
  const { rows } = await query<PremiumMediaCandidate>(
    `SELECT ${candidateSelect} FROM premium_media_candidates
      WHERE provider_task_id IS NOT NULL AND usage_recorded=FALSE AND credits_consumed > 0
        AND status IN ('PROVIDER_SUCCEEDED','PROCESSING','ACCEPTED','REJECTED','FAILED')
      ORDER BY updated_at LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function finishCandidateQuality(input: {
  candidateId: string;
  workerId: string;
  accepted: boolean;
  score: number;
  report: Record<string, unknown>;
}) {
  const { rows } = await query<PremiumMediaCandidate>(
    `UPDATE premium_media_candidates SET status=$3,quality_score=$4,quality_report=$5::jsonb,
       worker_id=NULL,processing_started_at=NULL,error_code=NULL,error_message=NULL,completed_at=NOW()
      WHERE id=$1 AND worker_id=$2 AND status='PROCESSING' RETURNING ${candidateSelect}`,
    [input.candidateId, input.workerId, input.accepted ? 'ACCEPTED' : 'REJECTED', input.score, JSON.stringify(input.report)],
  );
  return rows[0] ?? null;
}

export async function markCandidateUsageRecorded(candidateId: string) {
  await query(`UPDATE premium_media_candidates SET usage_recorded=TRUE WHERE id=$1`, [candidateId]);
}

export async function listActiveJobs(limit = 25) {
  const { rows } = await query<PremiumMediaJob>(
    `SELECT ${jobSelect} FROM premium_media_jobs
      WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED') ORDER BY updated_at LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function transitionJob(input: {
  jobId: string;
  expected: PremiumMediaJobStatus[];
  status: PremiumMediaJobStatus;
  selectedImageCandidateId?: string | null;
  selectedVideoCandidateId?: string | null;
  imageRound?: number;
  videoRound?: number;
}) {
  const { rows } = await query<PremiumMediaJob>(
    `UPDATE premium_media_jobs SET status=$2,
       selected_image_candidate_id=COALESCE($3,selected_image_candidate_id),
       selected_video_candidate_id=COALESCE($4,selected_video_candidate_id),
       image_round=COALESCE($5,image_round),video_round=COALESCE($6,video_round),
       error_code=NULL,error_message=NULL
      WHERE id=$1 AND status=ANY($7::text[]) RETURNING ${jobSelect}`,
    [
      input.jobId,
      input.status,
      input.selectedImageCandidateId ?? null,
      input.selectedVideoCandidateId ?? null,
      input.imageRound ?? null,
      input.videoRound ?? null,
      input.expected,
    ],
  );
  return rows[0] ?? null;
}

export async function setJobStage(jobId: string, status: PremiumMediaJobStatus) {
  const { rows } = await query<PremiumMediaJob>(
    `UPDATE premium_media_jobs SET status=$2 WHERE id=$1 AND status NOT IN ('COMPLETED','FAILED','CANCELLED') RETURNING ${jobSelect}`,
    [jobId, status],
  );
  return rows[0] ?? null;
}

export async function attachAcceptedCandidate(input: {
  candidate: PremiumMediaCandidate;
  workerId: string;
  storageReference: string;
  mimeType: string;
  title: string;
  altText: string;
}) {
  return withTransaction(async (client) => {
    const locked = await query<PremiumMediaCandidate>(
      `SELECT ${candidateSelect} FROM premium_media_candidates WHERE id=$1 FOR UPDATE`,
      [input.candidate.id],
      client,
    );
    const candidate = locked.rows[0];
    if (!candidate) throw new Error('Premium media candidate disappeared while being stored');
    if (candidate.productMediaId) return candidate.productMediaId;
    if (candidate.workerId !== input.workerId || candidate.status !== 'PROCESSING') {
      throw new Error('Premium media candidate processing lease was lost');
    }
    const primaryType = candidate.mediaType;
    if (primaryType === 'IMAGE') {
      await query(`UPDATE product_media SET is_primary=FALSE WHERE workspace_id=$1 AND product_id=$2 AND media_type='IMAGE'`, [candidate.workspaceId, candidate.productId], client);
    }
    const inserted = await query<{ id: string }>(
      `INSERT INTO product_media (
         workspace_id,product_id,media_type,storage_reference,title,alt_text,sort_order,is_primary,language
       ) VALUES ($1,$2,$3,$4,$5,$6,0,$7,'en') RETURNING id`,
      [candidate.workspaceId, candidate.productId, primaryType, input.storageReference, input.title, input.altText, primaryType === 'IMAGE'],
      client,
    );
    const mediaId = inserted.rows[0]?.id;
    if (!mediaId) throw new Error('Product media insert did not return an id');
    await query(
      `UPDATE premium_media_candidates SET product_media_id=$2,storage_reference=$3,mime_type=$4
        WHERE id=$1`,
      [candidate.id, mediaId, input.storageReference, input.mimeType],
      client,
    );
    await appendDomainEvent({
      workspaceId: candidate.workspaceId,
      type: DOMAIN_EVENT_TYPES.PRODUCT_MEDIA_ADDED,
      aggregateType: 'product',
      aggregateId: candidate.productId,
      payload: { productId: candidate.productId, childType: 'media', childId: mediaId, premiumMediaJobId: candidate.jobId },
      metadata: { source: 'premium-media' },
      idempotencyKey: `premium-media:${candidate.id}:product-media:v1`,
    }, client);
    return mediaId;
  });
}

export async function finishStoredCandidate(input: {
  candidateId: string;
  workerId: string;
  mediaId: string;
  score: number;
  report: Record<string, unknown>;
  storageReference: string;
  mimeType: string;
}) {
  const { rows } = await query<PremiumMediaCandidate>(
    `UPDATE premium_media_candidates SET status='ACCEPTED',quality_score=$4,quality_report=$5::jsonb,
       product_media_id=$3,storage_reference=$6,mime_type=$7,worker_id=NULL,processing_started_at=NULL,
       error_code=NULL,error_message=NULL,completed_at=NOW()
      WHERE id=$1 AND worker_id=$2 AND status='PROCESSING' RETURNING ${candidateSelect}`,
    [
      input.candidateId,
      input.workerId,
      input.mediaId,
      input.score,
      JSON.stringify(input.report),
      input.storageReference,
      input.mimeType,
    ],
  );
  return rows[0] ?? null;
}

export async function completeJob(job: PremiumMediaJob, imageMediaId: string | null, videoMediaId: string | null) {
  return withTransaction(async (client) => {
    const { rows } = await query<PremiumMediaJob>(
      `UPDATE premium_media_jobs SET status='COMPLETED',final_image_media_id=$2,final_video_media_id=$3,
         completed_at=NOW(),error_code=NULL,error_message=NULL
        WHERE id=$1 AND status NOT IN ('COMPLETED','FAILED','CANCELLED') RETURNING ${jobSelect}`,
      [job.id, imageMediaId, videoMediaId],
      client,
    );
    const completed = rows[0];
    if (!completed) return null;
    await appendDomainEvent({
      workspaceId: completed.workspaceId,
      type: DOMAIN_EVENT_TYPES.PREMIUM_MEDIA_COMPLETED,
      aggregateType: 'premium_media_job',
      aggregateId: completed.id,
      payload: { jobId: completed.id, productId: completed.productId, imageMediaId, videoMediaId },
      metadata: { source: 'premium-media' },
      idempotencyKey: `premium-media:${completed.id}:completed:v1`,
    }, client);
    return completed;
  });
}

export async function failJob(job: PremiumMediaJob, code: string, message: string) {
  return withTransaction(async (client) => {
    const { rows } = await query<PremiumMediaJob>(
      `UPDATE premium_media_jobs SET status='FAILED',error_code=$2,error_message=$3,completed_at=NOW()
        WHERE id=$1 AND status NOT IN ('COMPLETED','FAILED','CANCELLED') RETURNING ${jobSelect}`,
      [job.id, code.slice(0, 120), message.slice(0, 2_000)],
      client,
    );
    const failed = rows[0];
    if (!failed) return null;
    await appendDomainEvent({
      workspaceId: failed.workspaceId,
      type: DOMAIN_EVENT_TYPES.PREMIUM_MEDIA_FAILED,
      aggregateType: 'premium_media_job',
      aggregateId: failed.id,
      payload: { jobId: failed.id, productId: failed.productId, code },
      metadata: { source: 'premium-media' },
      idempotencyKey: `premium-media:${failed.id}:failed:v1`,
    }, client);
    return failed;
  });
}

export async function addOriginalReferenceMedia(input: {
  workspaceId: string;
  productId: string;
  storageReference: string;
  title: string;
  altText: string;
}) {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO product_media (workspace_id,product_id,media_type,storage_reference,title,alt_text,is_primary,language)
     VALUES ($1,$2,'IMAGE',$3,$4,$5,FALSE,'en') RETURNING id`,
    [input.workspaceId, input.productId, input.storageReference, input.title, input.altText],
  );
  return rows[0]?.id ?? null;
}

export async function getStoredCandidateAsset(workspaceId: string, productId: string, candidateId: string) {
  const { rows } = await query<{ storageReference: string; mimeType: string }>(
    `SELECT storage_reference AS "storageReference",mime_type AS "mimeType"
       FROM premium_media_candidates
      WHERE workspace_id=$1 AND product_id=$2 AND id=$3 AND status='ACCEPTED'
        AND storage_reference IS NOT NULL AND mime_type IS NOT NULL AND product_media_id IS NOT NULL`,
    [workspaceId, productId, candidateId],
  );
  return rows[0] ?? null;
}
