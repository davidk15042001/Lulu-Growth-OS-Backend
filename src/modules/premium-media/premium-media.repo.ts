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
import type { KieCostVariant } from './premium-media-cost-catalog.js';

const jobSelect = `
  id, workspace_id AS "workspaceId", product_id AS "productId", variant_id AS "variantId", requested_by AS "requestedBy",
  status, aspect_ratio AS "aspectRatio", creative_direction AS "creativeDirection",
  reference_assets AS "referenceAssets", deliver_image AS "deliverImage", deliver_video AS "deliverVideo",
  image_round AS "imageRound", video_round AS "videoRound", max_rounds AS "maxRounds",
  image_quality_threshold AS "imageQualityThreshold", video_quality_threshold AS "videoQualityThreshold",
  selected_image_candidate_id AS "selectedImageCandidateId", selected_video_candidate_id AS "selectedVideoCandidateId",
  final_image_media_id AS "finalImageMediaId", final_video_media_id AS "finalVideoMediaId",
  error_code AS "errorCode", error_message AS "errorMessage", started_at AS "startedAt",
  completed_at AS "completedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

const candidateSelect = `
  id, job_id AS "jobId", workspace_id AS "workspaceId", product_id AS "productId", variant_id AS "variantId", purpose,
  media_type AS "mediaType", model, provider_api AS "providerApi", provider_task_id AS "providerTaskId",
  reservation_id AS "reservationId",funding_mode AS "fundingMode",
  provider_submission_state AS "providerSubmissionState",billing_resolution AS "billingResolution",
  billing_duration_seconds AS "billingDurationSeconds",billing_max_credits AS "billingMaxCredits",
  callback_token AS "callbackToken", status, generation_round AS "generationRound", prompt,
  reference_urls AS "referenceUrls", result_urls AS "resultUrls", provider_payload AS "providerPayload",
  credits_consumed AS "creditsConsumed", usage_recorded AS "usageRecorded", quality_score AS "qualityScore",
  quality_reservation_id AS "qualityReservationId",quality_funding_mode AS "qualityFundingMode",
  quality_submission_state AS "qualitySubmissionState",quality_provider_response_id AS "qualityProviderResponseId",
  quality_credits_consumed AS "qualityCreditsConsumed",quality_billing_resolution AS "qualityBillingResolution",
  quality_billing_duration_seconds AS "qualityBillingDurationSeconds",
  quality_billing_max_credits AS "qualityBillingMaxCredits",quality_usage_recorded AS "qualityUsageRecorded",
  quality_report AS "qualityReport", storage_reference AS "storageReference", mime_type AS "mimeType",
  product_media_id AS "productMediaId", processing_attempts AS "processingAttempts", worker_id AS "workerId",
  processing_started_at AS "processingStartedAt", error_code AS "errorCode", error_message AS "errorMessage",
  submitted_at AS "submittedAt", completed_at AS "completedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

export type ProductMediaContext = {
  id: string;
  name: string;
  shortDescription: string | null;
  longDescription: string | null;
  variant: {
    id: string;
    name: string;
    sku: string | null;
    dimensionLength: string | null;
    dimensionUnit: string | null;
    metadata: Record<string, unknown>;
  } | null;
  media: Array<{
    id: string;
    storageReference: string;
    externalUrl: string | null;
    mimeType: string | null;
    title: string | null;
  }>;
};

export async function getProductMediaContext(workspaceId: string, productId: string, variantId?: string | null): Promise<ProductMediaContext | null> {
  const product = await query<Omit<ProductMediaContext, 'media' | 'variant'>>(
    `SELECT id, name, short_description AS "shortDescription", long_description AS "longDescription"
       FROM products WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`,
    [workspaceId, productId],
  );
  if (!product.rows[0]) return null;
  let variant: ProductMediaContext['variant']=null;
  if (variantId) {
    const row=await query<{
      id: string;
      name: string;
      sku: string | null;
      dimensionLength: string | null;
      dimensionUnit: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT id,name,sku,dimension_length::text AS "dimensionLength",dimension_unit AS "dimensionUnit",metadata
         FROM product_variants
        WHERE workspace_id=$1 AND product_id=$2 AND id=$3 AND status<>'ARCHIVED'`,
      [workspaceId,productId,variantId],
    );
    if (!row.rows[0]) return null;
    variant=row.rows[0];
  }
  const media = await query<ProductMediaContext['media'][number]>(
    `SELECT id, storage_reference AS "storageReference", external_url AS "externalUrl",
            NULL::text AS "mimeType", title
       FROM product_media
      WHERE workspace_id=$1 AND product_id=$2 AND media_type='IMAGE'
        AND ($4::uuid IS NULL OR variant_id IS NULL OR variant_id=$4)
        AND storage_reference NOT LIKE $3
      ORDER BY is_primary DESC, sort_order, created_at`,
    [workspaceId, productId, `%/premium-media/%`, variantId ?? null],
  );
  return { ...product.rows[0], variant, media: media.rows };
}

export async function getActiveJob(workspaceId: string, productId: string, variantId?: string | null) {
  const { rows } = await query<PremiumMediaJob>(
    `SELECT ${jobSelect} FROM premium_media_jobs
      WHERE workspace_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3::uuid
        AND status NOT IN ('COMPLETED','FAILED','CANCELLED')
      ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, productId, variantId ?? null],
  );
  return rows[0] ?? null;
}

export async function createJob(input: {
  workspaceId: string;
  productId: string;
  variantId?: string | null;
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
         workspace_id,product_id,variant_id,requested_by,status,aspect_ratio,creative_direction,reference_assets,
         deliver_image,deliver_video,image_round,video_round,max_rounds,image_quality_threshold,video_quality_threshold
       ) VALUES ($1,$2,$3,$4,'SUBMITTING_IMAGES',$5,$6,$7::jsonb,$8,$9,1,0,$10,$11,$12)
       RETURNING ${jobSelect}`,
      [
        input.workspaceId,
        input.productId,
        input.variantId ?? null,
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
      payload: { jobId: job.id, productId: input.productId, variantId: input.variantId ?? null, deliverImage: input.deliverImage, deliverVideo: input.deliverVideo },
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

export async function hasActiveVariants(workspaceId: string, productId: string) {
  const { rows } = await query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM product_variants
        WHERE workspace_id=$1 AND product_id=$2 AND status<>'ARCHIVED'
     ) AS "exists"`,
    [workspaceId, productId],
  );
  return rows[0]?.exists ?? false;
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
        AND NOT EXISTS (SELECT 1 FROM product_variants variant WHERE variant.workspace_id=p.workspace_id AND variant.product_id=p.id AND variant.status<>'ARCHIVED')
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

export async function listVariantsAwaitingFirstProduction(workspaceId: string, limit = 25) {
  const { rows } = await query<{ workspaceId: string; productId: string; variantId: string }>(
    `SELECT variant.workspace_id AS "workspaceId",variant.product_id AS "productId",variant.id AS "variantId"
       FROM product_variants variant
      WHERE variant.workspace_id=$1
        AND variant.status<>'ARCHIVED'
        AND EXISTS (
          SELECT 1 FROM product_media reference
           WHERE reference.workspace_id=variant.workspace_id
             AND reference.product_id=variant.product_id
             AND reference.media_type='IMAGE'
             AND reference.storage_reference NOT LIKE '%/premium-media/%'
        )
        AND NOT EXISTS (
          SELECT 1 FROM product_media media
           WHERE media.workspace_id=variant.workspace_id
             AND media.product_id=variant.product_id
             AND media.variant_id=variant.id
             AND media.media_type='IMAGE'
        )
        AND NOT EXISTS (
          SELECT 1 FROM premium_media_jobs job
           WHERE job.workspace_id=variant.workspace_id
             AND job.product_id=variant.product_id
             AND job.variant_id=variant.id
        )
      ORDER BY variant.created_at,variant.id
      LIMIT $2`,
    [workspaceId, limit],
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
  return withTransaction(async (client) => {
    const operationKey = `${input.job.id}:${input.purpose}:${input.generationRound}:${input.model}`;
    await query(`SELECT pg_advisory_xact_lock(hashtext('premium-media-candidate'),hashtext($1))`, [operationKey], client);
    const existing = (await query<PremiumMediaCandidate>(
      `SELECT ${candidateSelect} FROM premium_media_candidates
        WHERE workspace_id=$1 AND job_id=$2 AND purpose=$3 AND generation_round=$4 AND model=$5
          AND status NOT IN ('ACCEPTED','REJECTED','FAILED')
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [input.job.workspaceId, input.job.id, input.purpose, input.generationRound, input.model],
      client,
    )).rows[0];
    if (existing) return { candidate: existing, created: false };

    const callbackToken = randomBytes(32).toString('hex');
    const { rows } = await query<PremiumMediaCandidate>(
      `INSERT INTO premium_media_candidates (
         job_id,workspace_id,product_id,variant_id,purpose,media_type,model,provider_api,callback_token,
         status,generation_round,prompt,reference_urls
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SUBMITTING',$10,$11,$12::jsonb)
       RETURNING ${candidateSelect}`,
      [
        input.job.id,
        input.job.workspaceId,
        input.job.productId,
        input.job.variantId,
        input.purpose,
        input.mediaType,
        input.model,
        input.providerApi,
        callbackToken,
        input.generationRound,
        input.prompt,
        JSON.stringify(input.referenceUrls),
      ],
      client,
    );
    const candidate = rows[0];
    if (!candidate) throw new Error('Premium media candidate insert did not return a row');
    return { candidate, created: true };
  });
}

export async function bindCandidateProviderFunding(input: {
  workspaceId: string;
  candidateId: string;
  reservationId: string | null;
  fundingMode: 'CUSTOMER_PREPAID' | 'PLATFORM_FUNDED';
  variant: KieCostVariant;
}) {
  const { rows } = await query<PremiumMediaCandidate>(
    `UPDATE premium_media_candidates SET reservation_id=$3::uuid,funding_mode=$4::text,
       provider_submission_state='RESERVED',billing_resolution=$5,
       billing_duration_seconds=$6,billing_max_credits=$7
      WHERE workspace_id=$1 AND id=$2 AND provider_submission_state='UNRESERVED'
        AND ($4::text='PLATFORM_FUNDED' OR $3::uuid IS NOT NULL)
      RETURNING ${candidateSelect}`,
    [input.workspaceId, input.candidateId, input.reservationId, input.fundingMode,
      input.variant.resolution, input.variant.durationSeconds, input.variant.maximumCredits],
  );
  return rows[0] ?? null;
}

export async function markCandidateSubmissionStarted(workspaceId: string, candidateId: string) {
  const { rows } = await query<PremiumMediaCandidate>(
    `UPDATE premium_media_candidates SET provider_submission_state='SUBMITTING'
      WHERE workspace_id=$1 AND id=$2 AND status='SUBMITTING' AND provider_submission_state='RESERVED'
      RETURNING ${candidateSelect}`,
    [workspaceId, candidateId],
  );
  return rows[0] ?? null;
}

export async function markCandidateSubmitted(workspaceId: string, candidateId: string, taskId: string, payload: Record<string, unknown>) {
  const { rows } = await query<PremiumMediaCandidate>(
    `UPDATE premium_media_candidates SET provider_task_id=$2,status='SUBMITTED',provider_payload=$3::jsonb,
       provider_submission_state='SUBMITTED',submitted_at=NOW(),error_code=NULL,error_message=NULL
      WHERE workspace_id=$1 AND id=$4 AND status='SUBMITTING'
        AND provider_submission_state IN ('SUBMITTING','AMBIGUOUS') RETURNING ${candidateSelect}`,
    [workspaceId, taskId, JSON.stringify(payload), candidateId],
  );
  return rows[0] ?? null;
}

export async function markCandidateSubmissionRejected(workspaceId: string, candidateId: string, code: string, message: string) {
  const { rows } = await query<PremiumMediaCandidate>(
    `UPDATE premium_media_candidates SET status='FAILED',provider_submission_state='REJECTED',
       usage_recorded=TRUE,error_code=$3,error_message=$4,completed_at=NOW()
      WHERE workspace_id=$1 AND id=$2 AND status='SUBMITTING'
        AND provider_submission_state IN ('UNRESERVED','RESERVED','SUBMITTING')
      RETURNING ${candidateSelect}`,
    [workspaceId, candidateId, code.slice(0, 120), message.slice(0, 2_000)],
  );
  return rows[0] ?? null;
}

export async function markCandidateSubmissionAmbiguous(workspaceId: string, candidateId: string, code: string, message: string) {
  const { rows } = await query<PremiumMediaCandidate>(
    `UPDATE premium_media_candidates SET provider_submission_state='AMBIGUOUS',
       error_code=$3,error_message=$4
      WHERE workspace_id=$1 AND id=$2 AND status IN ('SUBMITTING','SUBMITTED','PROVIDER_SUCCEEDED','FAILED')
        AND provider_submission_state IN ('SUBMITTING','SUBMITTED','AMBIGUOUS')
      RETURNING ${candidateSelect}`,
    [workspaceId, candidateId, code.slice(0, 120), message.slice(0, 2_000)],
  );
  return rows[0] ?? null;
}

export async function applyProviderResult(input: {
  candidateId?: string;
  callbackToken?: string;
  providerTaskId?: string | null;
  state: 'pending' | 'success' | 'failed';
  resultUrls: string[];
  creditsConsumed: number | null;
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
         WHEN status='PROVIDER_SUCCEEDED' AND $3 IN ('SUBMITTED','FAILED') THEN status
         ELSE $3
       END,
       provider_submission_state=CASE
         WHEN provider_submission_state='REJECTED' THEN 'REJECTED'
         WHEN $3 IN ('PROVIDER_SUCCEEDED','FAILED') AND (
           (status IN ('PROVIDER_SUCCEEDED','FAILED') AND status<>$3)
           OR (credits_consumed IS NOT NULL AND $5::numeric>0 AND credits_consumed<>$5::numeric)
         ) THEN 'AMBIGUOUS'
         WHEN provider_submission_state='SETTLED' THEN 'SETTLED'
         WHEN $3 IN ('PROVIDER_SUCCEEDED','FAILED')
           AND credits_consumed IS NULL AND COALESCE($5::numeric,0)<=0 THEN 'AMBIGUOUS'
         ELSE 'SUBMITTED'
       END,
       result_urls=CASE WHEN jsonb_array_length($4::jsonb)>0 THEN $4::jsonb ELSE result_urls END,
       credits_consumed=CASE WHEN credits_consumed IS NULL AND $5::numeric>0 THEN $5::numeric ELSE credits_consumed END,
       provider_payload=provider_payload || $6::jsonb,
       error_code=CASE
         WHEN $3 IN ('PROVIDER_SUCCEEDED','FAILED') AND status IN ('PROVIDER_SUCCEEDED','FAILED') AND status<>$3
           THEN 'KIE_TERMINAL_STATE_CONFLICT'
         WHEN $3 IN ('PROVIDER_SUCCEEDED','FAILED') AND credits_consumed IS NOT NULL
           AND $5::numeric>0 AND credits_consumed<>$5::numeric THEN 'KIE_CREDITS_CONFLICT'
         WHEN status NOT IN ('ACCEPTED','REJECTED','FAILED') AND $3='FAILED' THEN $7
         ELSE error_code
       END,
       error_message=CASE
         WHEN $3 IN ('PROVIDER_SUCCEEDED','FAILED') AND status IN ('PROVIDER_SUCCEEDED','FAILED') AND status<>$3
           THEN 'Kie.ai returned contradictory terminal states for the same provider task.'
         WHEN $3 IN ('PROVIDER_SUCCEEDED','FAILED') AND credits_consumed IS NOT NULL
           AND $5::numeric>0 AND credits_consumed<>$5::numeric
           THEN 'Kie.ai returned contradictory exact credit amounts for the same provider task.'
         WHEN status NOT IN ('ACCEPTED','REJECTED','FAILED') AND $3='FAILED' THEN $8
         ELSE error_message
       END,
       completed_at=CASE WHEN $3 IN ('PROVIDER_SUCCEEDED','FAILED') THEN NOW() ELSE completed_at END
     WHERE ${identifierSql}
       AND ($2::text IS NULL OR provider_task_id IS NULL OR provider_task_id=$2::text)
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
        AND provider_submission_state='SUBMITTED'
        AND updated_at < NOW() - ($1::integer * INTERVAL '1 second')
      ORDER BY updated_at LIMIT $2`,
    [pollAfterSeconds, limit],
  );
  return rows;
}

export async function touchCandidate(candidateId: string) {
  await query(`UPDATE premium_media_candidates SET updated_at=NOW() WHERE id=$1 AND status='SUBMITTED'`, [candidateId]);
}

export async function listStaleSubmittingCandidates(staleSeconds: number, limit = 50) {
  const { rows } = await query<PremiumMediaCandidate>(
    `SELECT ${candidateSelect} FROM premium_media_candidates
      WHERE status='SUBMITTING' AND provider_submission_state IN ('UNRESERVED','RESERVED','SUBMITTING')
        AND updated_at < NOW() - ($1::integer * INTERVAL '1 second')
      ORDER BY updated_at LIMIT $2`,
    [staleSeconds, limit],
  );
  return rows;
}

export async function listTimedOutProviderCandidates(timeoutMinutes: number, limit = 50) {
  const { rows } = await query<PremiumMediaCandidate>(
    `SELECT ${candidateSelect} FROM premium_media_candidates
      WHERE status='SUBMITTED' AND provider_submission_state='SUBMITTED'
        AND submitted_at < NOW() - ($1::integer * INTERVAL '1 minute')
      ORDER BY submitted_at LIMIT $2`,
    [timeoutMinutes, limit],
  );
  return rows;
}

export async function claimCandidateForProcessing(workerId: string, maxAttempts: number) {
  return withTransaction(async (client) => {
    await query(
      `UPDATE premium_media_candidates SET status='FAILED',error_code='PREMIUM_MEDIA_PROCESSING_RETRY_EXHAUSTED',
         error_message='Automatic quality processing exceeded its retry limit.',worker_id=NULL,completed_at=NOW()
        WHERE status IN ('PROVIDER_SUCCEEDED','PROCESSING') AND processing_attempts >= $1
          AND provider_submission_state='SETTLED' AND usage_recorded=TRUE
          AND quality_submission_state NOT IN ('SUBMITTING','SUBMITTED','AMBIGUOUS')
          AND (worker_id IS NULL OR processing_started_at < NOW() - INTERVAL '10 minutes')`,
      [maxAttempts],
      client,
    );
    const claimedId = (await query<{ id: string }>(
      `SELECT id FROM premium_media_candidates
        WHERE status IN ('PROVIDER_SUCCEEDED','PROCESSING') AND processing_attempts < $1
          AND provider_submission_state='SETTLED' AND usage_recorded=TRUE
          AND quality_submission_state NOT IN ('SUBMITTING','AMBIGUOUS')
          AND (worker_id IS NULL OR processing_started_at < NOW() - INTERVAL '10 minutes')
        ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [maxAttempts],
      client,
    )).rows[0]?.id;
    if (!claimedId) return null;
    const { rows } = await query<PremiumMediaCandidate>(
      `UPDATE premium_media_candidates SET status='PROCESSING',worker_id=$1,
         processing_started_at=NOW(),processing_attempts=processing_attempts+1
       WHERE id=$2 RETURNING ${candidateSelect}`,
      [workerId, claimedId],
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
        AND provider_submission_state='SUBMITTED'
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
      WHERE id=$1 AND worker_id=$2 AND status='PROCESSING'
        AND quality_submission_state='SETTLED' AND quality_usage_recorded=TRUE
      RETURNING ${candidateSelect}`,
    [input.candidateId, input.workerId, input.accepted ? 'ACCEPTED' : 'REJECTED', input.score, JSON.stringify(input.report)],
  );
  return rows[0] ?? null;
}

export async function markCandidateUsageRecorded(workspaceId: string, candidateId: string) {
  const { rows } = await query<PremiumMediaCandidate>(
    `UPDATE premium_media_candidates SET usage_recorded=TRUE,provider_submission_state='SETTLED',
       error_code=CASE WHEN error_code IN ('KIE_CREDITS_MISSING','KIE_CREDITS_EXCEED_HOLD') THEN NULL ELSE error_code END,
       error_message=CASE WHEN error_code IN ('KIE_CREDITS_MISSING','KIE_CREDITS_EXCEED_HOLD') THEN NULL ELSE error_message END
      WHERE workspace_id=$1 AND id=$2 AND provider_submission_state='SUBMITTED'
        AND credits_consumed > 0 AND billing_max_credits >= credits_consumed
      RETURNING ${candidateSelect}`,
    [workspaceId, candidateId],
  );
  return rows[0] ?? null;
}

export async function bindCandidateQualityFunding(input: {
  workspaceId: string;
  candidateId: string;
  workerId: string;
  reservationId: string | null;
  fundingMode: 'CUSTOMER_PREPAID' | 'PLATFORM_FUNDED';
  variant: KieCostVariant;
}) {
  const { rows } = await query<PremiumMediaCandidate>(
    `UPDATE premium_media_candidates SET quality_reservation_id=$4::uuid,quality_funding_mode=$5::text,
       quality_submission_state='RESERVED',quality_billing_resolution=$6,
       quality_billing_duration_seconds=$7,quality_billing_max_credits=$8
      WHERE workspace_id=$1 AND id=$2 AND worker_id=$3 AND status='PROCESSING'
        AND quality_submission_state='NOT_STARTED'
        AND ($5::text='PLATFORM_FUNDED' OR $4::uuid IS NOT NULL)
      RETURNING ${candidateSelect}`,
    [input.workspaceId, input.candidateId, input.workerId, input.reservationId, input.fundingMode,
      input.variant.resolution, input.variant.durationSeconds, input.variant.maximumCredits],
  );
  return rows[0] ?? null;
}

export async function markCandidateQualitySubmitting(workspaceId: string, candidateId: string, workerId: string) {
  const { rows } = await query<PremiumMediaCandidate>(
    `UPDATE premium_media_candidates SET quality_submission_state='SUBMITTING'
      WHERE workspace_id=$1 AND id=$2 AND worker_id=$3 AND status='PROCESSING'
        AND quality_submission_state='RESERVED'
      RETURNING ${candidateSelect}`,
    [workspaceId, candidateId, workerId],
  );
  return rows[0] ?? null;
}

export async function persistCandidateQualityResponse(input: {
  workspaceId: string;
  candidateId: string;
  workerId: string;
  responseId: string;
  creditsConsumed: number;
  report: Record<string, unknown>;
}) {
  const { rows } = await query<PremiumMediaCandidate>(
    `UPDATE premium_media_candidates SET quality_submission_state=CASE
         WHEN $5 > 0 AND $5 <= quality_billing_max_credits THEN 'SUBMITTED' ELSE 'AMBIGUOUS' END,
       quality_provider_response_id=$4,quality_credits_consumed=CASE WHEN $5 > 0 THEN $5 ELSE NULL END,
       quality_score=COALESCE(($6::jsonb->>'score')::integer,0),quality_report=$6::jsonb
      WHERE workspace_id=$1 AND id=$2 AND worker_id=$3 AND status='PROCESSING'
        AND quality_submission_state IN ('SUBMITTING','SUBMITTED')
      RETURNING ${candidateSelect}`,
    [input.workspaceId, input.candidateId, input.workerId, input.responseId,
      input.creditsConsumed, JSON.stringify(input.report)],
  );
  return rows[0] ?? null;
}

export async function markCandidateQualitySettled(workspaceId: string, candidateId: string, workerId: string) {
  const { rows } = await query<PremiumMediaCandidate>(
    `UPDATE premium_media_candidates SET quality_submission_state='SETTLED',quality_usage_recorded=TRUE
      WHERE workspace_id=$1 AND id=$2 AND worker_id=$3 AND status='PROCESSING'
        AND quality_submission_state IN ('SUBMITTED','SETTLED')
        AND quality_provider_response_id IS NOT NULL AND quality_credits_consumed > 0
        AND quality_billing_max_credits >= quality_credits_consumed
      RETURNING ${candidateSelect}`,
    [workspaceId, candidateId, workerId],
  );
  return rows[0] ?? null;
}

export async function markCandidateQualityRejected(input: {
  workspaceId: string;
  candidateId: string;
  workerId: string;
  code: string;
  message: string;
}) {
  const report = { score: 0, accepted: false, summary: input.message, hardFailures: ['quality_provider_rejected'] };
  const { rows } = await query<PremiumMediaCandidate>(
    `UPDATE premium_media_candidates SET status='REJECTED',quality_submission_state='REJECTED',
       quality_usage_recorded=TRUE,quality_score=0,quality_report=$5::jsonb,
       worker_id=NULL,processing_started_at=NULL,error_code=$4,error_message=$6,completed_at=NOW()
      WHERE workspace_id=$1 AND id=$2 AND worker_id=$3 AND status='PROCESSING'
        AND quality_submission_state IN ('RESERVED','SUBMITTING')
      RETURNING ${candidateSelect}`,
    [input.workspaceId, input.candidateId, input.workerId, input.code.slice(0, 120),
      JSON.stringify(report), input.message.slice(0, 2_000)],
  );
  return rows[0] ?? null;
}

export async function markCandidateQualityAmbiguous(input: {
  workspaceId: string;
  candidateId: string;
  workerId?: string | null;
  code: string;
  message: string;
}) {
  const { rows } = await query<PremiumMediaCandidate>(
    `UPDATE premium_media_candidates SET quality_submission_state='AMBIGUOUS',
       worker_id=NULL,processing_started_at=NULL,error_code=$4,error_message=$5
      WHERE workspace_id=$1 AND id=$2 AND ($3::text IS NULL OR worker_id=$3)
        AND status='PROCESSING' AND quality_submission_state IN ('SUBMITTING','SUBMITTED','AMBIGUOUS')
      RETURNING ${candidateSelect}`,
    [input.workspaceId, input.candidateId, input.workerId ?? null,
      input.code.slice(0, 120), input.message.slice(0, 2_000)],
  );
  return rows[0] ?? null;
}

export async function listStaleQualitySubmissions(staleSeconds: number, limit = 50) {
  const { rows } = await query<PremiumMediaCandidate>(
    `SELECT ${candidateSelect} FROM premium_media_candidates
      WHERE status='PROCESSING' AND quality_submission_state='SUBMITTING'
        AND processing_started_at < NOW() - ($1::integer * INTERVAL '1 second')
      ORDER BY processing_started_at LIMIT $2`,
    [staleSeconds, limit],
  );
  return rows;
}

export async function getPremiumMediaBillingHealth() {
  const row = (await query<{
    ambiguousCount: string;
    unreservedCount: string;
    oldestUnresolvedAt: string | null;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE provider_submission_state='AMBIGUOUS' OR quality_submission_state='AMBIGUOUS')::text AS "ambiguousCount",
       COUNT(*) FILTER (WHERE funding_mode='UNRESOLVED' AND status NOT IN ('ACCEPTED','REJECTED','FAILED'))::text AS "unreservedCount",
       MIN(updated_at) FILTER (WHERE provider_submission_state IN ('SUBMITTING','SUBMITTED','AMBIGUOUS')
         OR quality_submission_state IN ('SUBMITTING','SUBMITTED','AMBIGUOUS')) AS "oldestUnresolvedAt"
       FROM premium_media_candidates`,
  )).rows[0];
  return {
    ambiguousCount: Number(row?.ambiguousCount ?? 0),
    unreservedCount: Number(row?.unreservedCount ?? 0),
    oldestUnresolvedAt: row?.oldestUnresolvedAt ?? null,
  };
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
    if (candidate.workerId !== input.workerId || candidate.status !== 'PROCESSING'
      || candidate.qualitySubmissionState !== 'SETTLED' || !candidate.qualityUsageRecorded) {
      throw new Error('Premium media candidate processing lease was lost');
    }
    const primaryType = candidate.mediaType;
    if (primaryType === 'IMAGE') {
      await query(`UPDATE product_media SET is_primary=FALSE WHERE workspace_id=$1 AND product_id=$2 AND media_type='IMAGE' AND variant_id IS NOT DISTINCT FROM $3::uuid`, [candidate.workspaceId, candidate.productId, candidate.variantId], client);
    }
    const inserted = await query<{ id: string }>(
      `INSERT INTO product_media (
         workspace_id,product_id,variant_id,media_type,storage_reference,title,alt_text,sort_order,is_primary,language
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,'en') RETURNING id`,
      [candidate.workspaceId, candidate.productId, candidate.variantId, primaryType, input.storageReference, input.title, input.altText, primaryType === 'IMAGE'],
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
      payload: { productId: candidate.productId, variantId: candidate.variantId, childType: 'media', childId: mediaId, premiumMediaJobId: candidate.jobId },
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
      WHERE id=$1 AND worker_id=$2 AND status='PROCESSING'
        AND quality_submission_state='SETTLED' AND quality_usage_recorded=TRUE
      RETURNING ${candidateSelect}`,
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
