import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { getObject, premiumProductMediaKey, productReferenceKey, putObject } from '../../storage/s3.service.js';
import { AppError, notFoundError } from '../../utils/app-error.js';
import { assertAiBillingAccess } from '../billing/payg-billing.repo.js';
import {
  fingerprintAiRequest,
  markAiSpendAmbiguous,
  markAiSpendSubmitted,
  markAiSpendSubmitting,
  releaseAiSpend,
  reserveAiSpend,
} from '../api-wallet/ai-spend-reservation.repo.js';
import { recordMeteredUsage } from '../usage/usage.service.js';
import {
  classifyKiePostFailure,
  createMarketTask,
  createVeoTask,
  downloadGeneratedMedia,
  evaluateMediaQuality,
  extensionForMimeType,
  getKieCredits,
  getKieTask,
  getPremiumImageModels,
  getPremiumTextImageModels,
  getPremiumVideoModels,
  isKieMediaConfigured,
  normalizeKieTask,
  uploadReferenceFile,
  uploadReferenceUrl,
} from './kie-media.client.js';
import {
  getKieBillingCatalogReadiness,
  maximumKieCustomerCostUsd,
  resolveKieMaximumCreditVariant,
  type KieCostVariant,
} from './premium-media-cost-catalog.js';
import * as repo from './premium-media.repo.js';
import type { CreatePremiumMediaInput } from './premium-media.validator.js';
import type {
  KieProviderApi,
  PremiumMediaCandidate,
  PremiumMediaJob,
  PremiumMediaJobStatus,
  PremiumMediaJobView,
  PremiumMediaPurpose,
  PremiumMediaReference,
  PremiumMediaType,
} from './premium-media.types.js';

type UploadedReference = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
};

const TERMINAL_CANDIDATE_STATUSES = new Set(['ACCEPTED', 'REJECTED', 'FAILED']);
const SUPPORTED_REFERENCE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function callbackBaseUrl() {
  const configured = env.KIE_CALLBACK_BASE_URL ?? env.OAUTH_CALLBACK_BASE_URL;
  if (!configured) {
    throw new AppError(503, 'KIE_CALLBACK_URL_MISSING', 'KIE_CALLBACK_BASE_URL must point to the public /api/v1 API root');
  }
  const parsed = new URL(configured);
  if (env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new AppError(503, 'KIE_CALLBACK_URL_INSECURE', 'Kie.ai callbacks require HTTPS in production');
  }
  return configured.replace(/\/$/, '');
}

function callbackUrl(token: string) {
  return `${callbackBaseUrl()}/public/kie/media-callback/${token}`;
}

function filenamePart(value: string) {
  return value.normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'product-reference';
}

function mimeFromStorageReference(reference: string) {
  const clean = reference.split('?')[0]?.toLowerCase() ?? '';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

function productDescription(product: repo.ProductMediaContext) {
  return product.longDescription?.trim() || product.shortDescription?.trim() || product.name;
}

export function buildPremiumImagePrompt(
  product: Pick<repo.ProductMediaContext, 'name' | 'shortDescription' | 'longDescription'>,
  creativeDirection?: string | null,
  retryFeedback?: string | null,
  hasReferences = true,
) {
  return [
    `Create an ultra-premium, globally campaign-ready commercial product photograph for ${product.name}.`,
    `Product context: ${product.longDescription?.trim() || product.shortDescription?.trim() || product.name}.`,
    hasReferences
      ? 'Use the supplied product photographs as the absolute source of truth.'
      : 'Establish one definitive, physically plausible product identity from the brief and keep it suitable for consistent reuse across a global campaign.',
    hasReferences
      ? 'Preserve the exact product silhouette, proportions, materials, colors, components, packaging, logo, label text, typography and brand marks.'
      : 'Do not invent logos, brand marks, label copy, unsupported product claims or incoherent components.',
    'Do not invent, remove, rewrite or distort any product feature or readable text.',
    creativeDirection?.trim() || 'Create sophisticated art direction, realistic materials, controlled premium lighting, natural shadows and a high-end advertising composition.',
    'The result must be photorealistic, sharp, clean, original, free of watermarks and immediately usable in a global luxury campaign.',
    retryFeedback ? `Correct every issue found by the independent quality audit: ${retryFeedback}` : '',
  ].filter(Boolean).join('\n');
}

export function buildPremiumVideoPrompt(
  product: Pick<repo.ProductMediaContext, 'name' | 'shortDescription' | 'longDescription'>,
  creativeDirection?: string | null,
  retryFeedback?: string | null,
) {
  return [
    `Create a cinematic premium product advertisement for ${product.name}.`,
    `Product context: ${product.longDescription?.trim() || product.shortDescription?.trim() || product.name}.`,
    'The supplied image is the exact product and must remain visually identical in every frame.',
    'Use restrained, physically realistic product motion and sophisticated camera movement with stable geometry, consistent packaging, exact logos and unchanged label text.',
    creativeDirection?.trim() || 'Use luxury commercial lighting, deliberate pacing, realistic reflections, shallow depth of field and a confident global-brand aesthetic.',
    'No morphing, flicker, warped text, duplicate parts, invented features, watermarks, jump cuts or unstable backgrounds.',
    'Deliver a coherent campaign-ready sequence with polished synchronized ambient sound and no spoken claims.',
    retryFeedback ? `Correct every issue found by the independent quality audit: ${retryFeedback}` : '',
  ].filter(Boolean).join('\n');
}

function qualityFeedback(candidates: PremiumMediaCandidate[]) {
  return candidates
    .map((candidate) => {
      const report = candidate.qualityReport ?? {};
      const summary = typeof report.summary === 'string' ? report.summary : '';
      const failures = Array.isArray(report.hardFailures)
        ? report.hardFailures.filter((value): value is string => typeof value === 'string').join('; ')
        : '';
      return [summary, failures].filter(Boolean).join('; ');
    })
    .filter(Boolean)
    .join(' | ')
    .slice(0, 3_000);
}

async function persistUploadedReference(
  workspaceId: string,
  productId: string,
  productName: string,
  file: UploadedReference,
): Promise<PremiumMediaReference> {
  if (!SUPPORTED_REFERENCE_TYPES.has(file.mimetype.toLowerCase())) {
    throw new AppError(415, 'PREMIUM_MEDIA_REFERENCE_TYPE_UNSUPPORTED', 'Product references must be JPEG, PNG or WebP images');
  }
  if (file.buffer.byteLength > 10 * 1024 * 1024) {
    throw new AppError(413, 'PREMIUM_MEDIA_REFERENCE_TOO_LARGE', 'Each product reference must be 10 MB or smaller');
  }
  const referenceId = randomUUID();
  const extension = extensionForMimeType(file.mimetype);
  const key = productReferenceKey(workspaceId, productId, referenceId, extension);
  await putObject({ key, content: file.buffer, mimeType: file.mimetype, fileName: filenamePart(file.originalname) });
  await repo.addOriginalReferenceMedia({
    workspaceId,
    productId,
    storageReference: key,
    title: `Original reference · ${productName}`,
    altText: `Authoritative original product reference for ${productName}`,
  });
  const providerUrl = await uploadReferenceFile({
    buffer: file.buffer,
    mimeType: file.mimetype,
    fileName: `${referenceId}.${extension}`,
  });
  return { source: 'upload', providerUrl, storageReference: key, mimeType: file.mimetype };
}

async function prepareExistingReference(
  workspaceId: string,
  productId: string,
  media: repo.ProductMediaContext['media'][number],
): Promise<PremiumMediaReference | null> {
  const externalUrl = media.externalUrl?.trim()
    || (/^https:\/\//i.test(media.storageReference) ? media.storageReference : null);
  const fileName = `${productId}-${media.id}.${extensionForMimeType(mimeFromStorageReference(media.storageReference))}`;
  if (externalUrl) {
    if (!externalUrl.startsWith('https://')) return null;
    const providerUrl = await uploadReferenceUrl(externalUrl, fileName);
    return { source: 'product_media', providerUrl, originalUrl: externalUrl, storageReference: media.storageReference };
  }
  try {
    const buffer = await getObject(media.storageReference);
    const mimeType = media.mimeType ?? mimeFromStorageReference(media.storageReference);
    const providerUrl = await uploadReferenceFile({ buffer, mimeType, fileName });
    return { source: 'product_media', providerUrl, storageReference: media.storageReference, mimeType };
  } catch (error) {
    logger.warn({ error, workspaceId, productId, mediaId: media.id }, 'Product reference could not be prepared for Kie.ai');
    return null;
  }
}

async function prepareReferences(input: {
  workspaceId: string;
  product: repo.ProductMediaContext;
  files: UploadedReference[];
  externalUrls: string[];
}) {
  const references: PremiumMediaReference[] = [];
  for (const file of input.files.slice(0, 4)) {
    references.push(await persistUploadedReference(input.workspaceId, input.product.id, input.product.name, file));
  }
  for (const [index, url] of input.externalUrls.entries()) {
    if (references.length >= 4) break;
    const providerUrl = await uploadReferenceUrl(url, `${input.product.id}-external-${index + 1}.jpg`);
    references.push({ source: 'external', providerUrl, originalUrl: url });
  }
  for (const media of input.product.media) {
    if (references.length >= 4) break;
    const reference = await prepareExistingReference(input.workspaceId, input.product.id, media);
    if (reference && !references.some((candidate) => candidate.storageReference && candidate.storageReference === reference.storageReference)) {
      references.push(reference);
    }
  }
  return references;
}

async function assertRuntimeReady() {
  if (!isKieMediaConfigured()) {
    throw new AppError(503, 'KIE_NOT_CONFIGURED', 'Premium media generation requires KIE_API_KEY on the server');
  }
  if (!env.AWS_S3_BUCKET) {
    throw new AppError(503, 'PREMIUM_MEDIA_STORAGE_NOT_CONFIGURED', 'Premium product media requires permanent S3 storage');
  }
  callbackBaseUrl();
  getPremiumImageModels();
  getPremiumTextImageModels();
  getPremiumVideoModels();
  const billingCatalog = getKieBillingCatalogReadiness();
  if (!billingCatalog.ready) {
    throw new AppError(503, 'KIE_BILLING_CATALOG_UNREADY', 'Premium media is blocked until every configured Kie variant has a reviewed prepaid credit ceiling.', billingCatalog);
  }
  const credits = await getKieCredits();
  if (credits <= 0) {
    throw new AppError(503, 'KIE_CREDITS_REQUIRED', 'The Kie.ai platform balance must be funded before premium production can start');
  }
}

function marketImageParameters(model: string, prompt: string, urls: string[], aspectRatio: string) {
  if (model.startsWith('flux-2/')) {
    return { ...(urls.length ? { input_urls: urls } : {}), prompt, aspect_ratio: aspectRatio, resolution: env.KIE_IMAGE_RESOLUTION, nsfw_checker: true };
  }
  if (model.startsWith('seedream/')) {
    return { ...(urls.length ? { image_urls: urls } : {}), prompt, aspect_ratio: aspectRatio,
      quality: env.KIE_IMAGE_RESOLUTION === '2K' ? 'high' : 'basic', output_format: 'png', nsfw_checker: true };
  }
  return { ...(urls.length ? { input_urls: urls } : {}), prompt, aspect_ratio: aspectRatio, resolution: env.KIE_IMAGE_RESOLUTION, output_format: 'png', nsfw_checker: true };
}

export function marketVideoParameters(model: string, prompt: string, imageUrl: string, aspectRatio: string) {
  if (model === 'kling/v3-turbo-image-to-video') {
    return {
      image_urls: [imageUrl],
      prompt,
      duration: '5',
      resolution: env.KIE_VIDEO_RESOLUTION,
    };
  }
  return {
    prompt,
    image_urls: [imageUrl],
    customize_multi_shots: true,
    audio: true,
    resolution: env.KIE_VIDEO_RESOLUTION,
    aspect_ratio: aspectRatio,
    duration: 5,
    elements: [],
  };
}

function candidateBillingVariant(input: {
  purpose: PremiumMediaPurpose;
  model: string;
}) {
  if (input.purpose === 'IMAGE_GENERATION') {
    return resolveKieMaximumCreditVariant({ purpose: input.purpose, model: input.model, resolution: env.KIE_IMAGE_RESOLUTION });
  }
  if (input.purpose === 'IMAGE_UPSCALE') {
    return resolveKieMaximumCreditVariant({ purpose: input.purpose, model: input.model, resolution: `${env.KIE_IMAGE_UPSCALE_FACTOR}x` });
  }
  if (input.purpose === 'VIDEO_GENERATION') {
    return resolveKieMaximumCreditVariant(input.model === 'veo3'
      ? { purpose: input.purpose, model: input.model, resolution: '1080p', durationSeconds: 8 }
      : { purpose: input.purpose, model: input.model, resolution: env.KIE_VIDEO_RESOLUTION, durationSeconds: 5 });
  }
  return resolveKieMaximumCreditVariant({
    purpose: input.purpose,
    model: input.model,
    resolution: `${env.KIE_VIDEO_UPSCALE_FACTOR}x`,
    durationSeconds: 5,
  });
}

async function releaseProviderHold(
  candidate: PremiumMediaCandidate,
  reason: string,
  disposition: 'BEFORE_SUBMISSION' | 'DEFINITIVE_REJECTION',
) {
  if (!candidate.reservationId) return;
  await releaseAiSpend({ workspaceId: candidate.workspaceId, reservationId: candidate.reservationId, disposition, reason });
}

async function submitCandidate(input: {
  job: PremiumMediaJob;
  purpose: PremiumMediaPurpose;
  mediaType: PremiumMediaType;
  model: string;
  providerApi: KieProviderApi;
  generationRound: number;
  prompt: string;
  qualityReferenceUrls: string[];
  parameters?: Record<string, unknown>;
  veoImageUrls?: string[];
}) {
  const billingVariant = candidateBillingVariant(input);
  const candidateResult = await repo.createCandidate({
    job: input.job,
    purpose: input.purpose,
    mediaType: input.mediaType,
    model: input.model,
    providerApi: input.providerApi,
    generationRound: input.generationRound,
    prompt: input.prompt,
    referenceUrls: input.qualityReferenceUrls,
  });
  if (!candidateResult.created) {
    return !['REJECTED', 'AMBIGUOUS'].includes(candidateResult.candidate.providerSubmissionState);
  }
  let candidate = candidateResult.candidate;
  try {
    const reservation = await reserveAiSpend({
      workspaceId: input.job.workspaceId,
      userId: input.job.requestedBy,
      requestKey: `premium-media:${candidate.id}:provider:v1`,
      requestFingerprint: fingerprintAiRequest({
        candidateId: candidate.id,
        jobId: input.job.id,
        purpose: input.purpose,
        model: input.model,
        providerApi: input.providerApi,
        prompt: input.prompt,
        parameters: input.parameters ?? null,
        veoImageUrls: input.veoImageUrls ?? null,
        variant: billingVariant,
      }),
      operation: `premium_media.${input.purpose.toLowerCase()}`,
      maximumCustomerCostUsd: maximumKieCustomerCostUsd(billingVariant),
      usdCnyRate: env.API_USD_CNY_RATE,
      pricingSnapshot: {
        catalog: 'kie-prepaid-max-v1',
        maximumCredits: billingVariant.maximumCredits,
        providerCreditCostUsd: env.KIE_CREDIT_COST_USD,
        customerMarkupMultiplier: env.KIE_CUSTOMER_MARKUP_MULTIPLIER,
        resolution: billingVariant.resolution,
        durationSeconds: billingVariant.durationSeconds,
      },
      provider: 'kie.ai',
      model: input.model,
    });
    const bound = await repo.bindCandidateProviderFunding({
      workspaceId: candidate.workspaceId,
      candidateId: candidate.id,
      reservationId: reservation.reservation?.id ?? null,
      fundingMode: reservation.funding.mode,
      variant: billingVariant,
    });
    if (!bound) {
      if (reservation.reservation) {
        await releaseAiSpend({
          workspaceId: candidate.workspaceId,
          reservationId: reservation.reservation.id,
          disposition: 'BEFORE_SUBMISSION',
          reason: 'premium_media_candidate_binding_failed',
        });
      }
      throw new AppError(409, 'PREMIUM_MEDIA_FUNDING_BIND_FAILED', 'Premium media funding could not be bound to the candidate.');
    }
    candidate = bound;
  } catch (error) {
    await repo.markCandidateSubmissionRejected(
      candidate.workspaceId,
      candidate.id,
      error instanceof AppError ? error.code : 'PREMIUM_MEDIA_RESERVATION_FAILED',
      error instanceof Error ? error.message : 'Premium media funding reservation failed',
    );
    throw error;
  }

  const submitting = await repo.markCandidateSubmissionStarted(candidate.workspaceId, candidate.id);
  if (!submitting) {
    await releaseProviderHold(candidate, 'premium_media_provider_dispatch_not_started', 'BEFORE_SUBMISSION').catch(() => undefined);
    await repo.markCandidateSubmissionRejected(candidate.workspaceId, candidate.id, 'KIE_SUBMISSION_STATE_CONFLICT', 'The premium media provider dispatch state changed before submission.');
    return false;
  }
  candidate = submitting;
  if (candidate.reservationId) {
    try {
      const marked = await markAiSpendSubmitting(candidate.workspaceId, candidate.reservationId);
      if (!marked) throw new Error('AI reservation was not in a dispatchable state');
    } catch (error) {
      await releaseProviderHold(candidate, 'premium_media_provider_dispatch_not_started', 'BEFORE_SUBMISSION').catch(() => undefined);
      await repo.markCandidateSubmissionRejected(candidate.workspaceId, candidate.id, 'AI_RESERVATION_STATE_CONFLICT', error instanceof Error ? error.message : 'AI reservation state conflict');
      return false;
    }
  }
  try {
    const created = input.providerApi === 'VEO'
      ? await createVeoTask({
          prompt: input.prompt,
          imageUrls: input.veoImageUrls ?? input.qualityReferenceUrls.slice(-1),
          callbackUrl: callbackUrl(candidate.callbackToken),
          aspectRatio: input.job.aspectRatio === '9:16' ? '9:16' : '16:9',
        })
      : await createMarketTask({
          model: input.model,
          callbackUrl: callbackUrl(candidate.callbackToken),
          parameters: input.parameters ?? {},
        });
    const submitted = await repo.markCandidateSubmitted(candidate.workspaceId, candidate.id, created.taskId, created.payload);
    if (!submitted) {
      if (candidate.reservationId) {
        await markAiSpendAmbiguous(candidate.workspaceId, candidate.reservationId, 'provider accepted task but candidate state could not persist').catch(() => undefined);
      }
      await repo.markCandidateSubmissionAmbiguous(candidate.workspaceId, candidate.id, 'KIE_SUBMISSION_PERSISTENCE_AMBIGUOUS', 'Kie.ai accepted a task but Lulu could not persist its task identity.');
      return false;
    }
    if (candidate.reservationId) {
      await markAiSpendSubmitted({
        workspaceId: candidate.workspaceId,
        reservationId: candidate.reservationId,
        provider: 'kie.ai',
        model: input.model,
        providerRequestId: created.taskId,
      }).catch(async (error) => {
        await markAiSpendAmbiguous(candidate.workspaceId, candidate.reservationId!, `provider task ${created.taskId} persisted; reservation transition failed: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
        logger.error({ error, candidateId: candidate.id, reservationId: candidate.reservationId, providerTaskId: created.taskId }, 'Kie reservation submission state could not be persisted');
      });
    }
    return true;
  } catch (error) {
    const disposition = classifyKiePostFailure(error);
    const code = error instanceof AppError ? error.code : 'KIE_SUBMISSION_FAILED';
    const message = error instanceof Error ? error.message : 'Kie.ai task submission failed';
    if (disposition === 'DEFINITIVE_REJECTION') {
      try {
        await releaseProviderHold(candidate, `kie_definitive_rejection:${code}`, 'DEFINITIVE_REJECTION');
        await repo.markCandidateSubmissionRejected(candidate.workspaceId, candidate.id, code, message);
      } catch (releaseError) {
        if (candidate.reservationId) await markAiSpendAmbiguous(candidate.workspaceId, candidate.reservationId, `definitive provider rejection but hold release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`).catch(() => undefined);
        await repo.markCandidateSubmissionAmbiguous(candidate.workspaceId, candidate.id, 'KIE_REJECTION_RELEASE_AMBIGUOUS', 'Kie.ai rejected the request, but Lulu could not safely release the prepaid hold.');
      }
    } else {
      if (candidate.reservationId) await markAiSpendAmbiguous(candidate.workspaceId, candidate.reservationId, message).catch(() => undefined);
      await repo.markCandidateSubmissionAmbiguous(candidate.workspaceId, candidate.id, code, message);
    }
    logger.error({ error, disposition, candidateId: candidate.id, model: input.model, reservationId: candidate.reservationId }, 'Premium media candidate submission failed');
    return false;
  }
}

async function submitImageRound(job: PremiumMediaJob, product: repo.ProductMediaContext, feedback = '') {
  const urls = job.referenceAssets.map((reference) => reference.providerUrl).filter(Boolean);
  const prompt = buildPremiumImagePrompt(product, job.creativeDirection, feedback, urls.length > 0);
  const models = urls.length ? getPremiumImageModels() : getPremiumTextImageModels();
  const results = await Promise.all(models.map((model) => submitCandidate({
    job,
    purpose: 'IMAGE_GENERATION',
    mediaType: 'IMAGE',
    model,
    providerApi: 'MARKET',
    generationRound: job.imageRound,
    prompt,
    qualityReferenceUrls: urls,
    parameters: marketImageParameters(model, prompt, urls, job.aspectRatio),
  })));
  await repo.setJobStage(job.id, 'GENERATING_IMAGES');
  if (!results.some(Boolean)) logger.warn({ jobId: job.id, round: job.imageRound }, 'No premium image candidate could be submitted');
}

async function submitImageUpscale(job: PremiumMediaJob, selected: PremiumMediaCandidate) {
  const imageUrl = selected.resultUrls[0];
  if (!imageUrl) throw new AppError(502, 'PREMIUM_IMAGE_RESULT_MISSING', 'The selected image candidate has no result URL');
  await submitCandidate({
    job,
    purpose: 'IMAGE_UPSCALE',
    mediaType: 'IMAGE',
    model: 'topaz/image-upscale',
    providerApi: 'MARKET',
    generationRound: job.imageRound,
    prompt: selected.prompt,
    qualityReferenceUrls: selected.referenceUrls,
    parameters: { image_url: imageUrl, upscale_factor: String(env.KIE_IMAGE_UPSCALE_FACTOR) },
  });
  await repo.setJobStage(job.id, 'UPSCALING_IMAGE');
}

async function submitVideoRound(
  job: PremiumMediaJob,
  product: repo.ProductMediaContext,
  image: PremiumMediaCandidate,
  feedback = '',
) {
  const imageUrl = image.resultUrls[0];
  if (!imageUrl) throw new AppError(502, 'PREMIUM_IMAGE_RESULT_MISSING', 'The final image candidate has no result URL for video production');
  const prompt = buildPremiumVideoPrompt(product, job.creativeDirection, feedback);
  const qualityReferences = [
    ...job.referenceAssets.map((reference) => reference.providerUrl),
    imageUrl,
  ].slice(0, 5);
  const videoAspect = job.aspectRatio === '1:1' ? '16:9' : job.aspectRatio;
  const results = await Promise.all(getPremiumVideoModels().map((model) => {
    const providerApi: KieProviderApi = model === 'veo3' ? 'VEO' : 'MARKET';
    return submitCandidate({
      job,
      purpose: 'VIDEO_GENERATION',
      mediaType: 'VIDEO',
      model,
      providerApi,
      generationRound: job.videoRound,
      prompt,
      qualityReferenceUrls: qualityReferences,
      veoImageUrls: [imageUrl],
      ...(providerApi === 'MARKET' ? { parameters: marketVideoParameters(model, prompt, imageUrl, videoAspect) } : {}),
    });
  }));
  await repo.setJobStage(job.id, 'GENERATING_VIDEOS');
  if (!results.some(Boolean)) logger.warn({ jobId: job.id, round: job.videoRound }, 'No premium video candidate could be submitted');
}

async function submitVideoUpscale(job: PremiumMediaJob, selected: PremiumMediaCandidate) {
  const videoUrl = selected.resultUrls[0];
  if (!videoUrl) throw new AppError(502, 'PREMIUM_VIDEO_RESULT_MISSING', 'The selected video candidate has no result URL');
  await submitCandidate({
    job,
    purpose: 'VIDEO_UPSCALE',
    mediaType: 'VIDEO',
    model: 'topaz/video-upscale',
    providerApi: 'MARKET',
    generationRound: job.videoRound,
    prompt: selected.prompt,
    qualityReferenceUrls: selected.referenceUrls,
    parameters: { video_url: videoUrl, upscale_factor: String(env.KIE_VIDEO_UPSCALE_FACTOR) },
  });
  await repo.setJobStage(job.id, 'UPSCALING_VIDEO');
}

async function createAndLaunch(input: {
  workspaceId: string;
  product: repo.ProductMediaContext;
  requestedBy?: string | null;
  request: CreatePremiumMediaInput;
  references: PremiumMediaReference[];
}) {
  const existing = await repo.getActiveJob(input.workspaceId, input.product.id);
  if (existing) return { job: await jobView(existing), reused: true };
  let job: PremiumMediaJob;
  try {
    job = await repo.createJob({
      workspaceId: input.workspaceId,
      productId: input.product.id,
      requestedBy: input.requestedBy ?? null,
      aspectRatio: input.request.aspectRatio,
      creativeDirection: input.request.creativeDirection ?? null,
      referenceAssets: input.references,
      deliverImage: input.request.deliverImage,
      deliverVideo: input.request.deliverVideo,
      maxRounds: env.KIE_MEDIA_MAX_ROUNDS,
      imageQualityThreshold: env.KIE_IMAGE_QUALITY_THRESHOLD,
      videoQualityThreshold: env.KIE_VIDEO_QUALITY_THRESHOLD,
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      const active = await repo.getActiveJob(input.workspaceId, input.product.id);
      if (active) return { job: await jobView(active), reused: true };
    }
    throw error;
  }
  await submitImageRound(job, input.product);
  const current = await repo.getJob(input.workspaceId, job.id) ?? job;
  return { job: await jobView(current), reused: false };
}

export async function startPremiumMedia(
  workspaceId: string,
  productId: string,
  userId: string,
  request: CreatePremiumMediaInput,
  files: UploadedReference[] = [],
) {
  await assertAiBillingAccess(workspaceId, userId);
  const product = await repo.getProductMediaContext(workspaceId, productId);
  if (!product) throw notFoundError('Product not found');
  const active = await repo.getActiveJob(workspaceId, productId);
  if (active) return { job: await jobView(active), reused: true };
  await assertRuntimeReady();
  const references = await prepareReferences({
    workspaceId,
    product,
    files,
    externalUrls: request.referenceImageUrls,
  });
  if (!references.length) {
    throw new AppError(409, 'PREMIUM_MEDIA_REFERENCE_REQUIRED', 'Add at least one authoritative product image before premium production can start');
  }
  return createAndLaunch({ workspaceId, product, requestedBy: userId, request, references });
}

export async function ensurePremiumMediaRuntimeReady() {
  await assertRuntimeReady();
}

export async function startPremiumMediaFromProductBrief(
  workspaceId: string,
  productId: string,
  userId: string,
  runtimeAlreadyVerified = false,
  deliverVideo = true,
) {
  await assertAiBillingAccess(workspaceId, userId);
  const product = await repo.getProductMediaContext(workspaceId, productId);
  if (!product) throw notFoundError('Product not found');
  const active = await repo.getActiveJob(workspaceId, productId);
  if (active) return { job: await jobView(active), reused: true };
  if (!runtimeAlreadyVerified) await assertRuntimeReady();
  return createAndLaunch({
    workspaceId,
    product,
    requestedBy: userId,
    request: { aspectRatio: '1:1', deliverImage: true, deliverVideo, referenceImageUrls: [] },
    references: [],
  });
}

export async function maybeStartAutonomousPremiumMedia(workspaceId: string, productId: string, userId?: string | null) {
  if (!isKieMediaConfigured() || !env.AWS_S3_BUCKET) return null;
  const active = await repo.getActiveJob(workspaceId, productId);
  if (active) return active;
  const product = await repo.getProductMediaContext(workspaceId, productId);
  if (!product || !product.media.length) return null;
  try {
    await assertAiBillingAccess(workspaceId, userId ?? null);
    await assertRuntimeReady();
    const references = await prepareReferences({ workspaceId, product, files: [], externalUrls: [] });
    if (!references.length) return null;
    return createAndLaunch({
      workspaceId,
      product,
      requestedBy: userId ?? null,
      request: { aspectRatio: '1:1', deliverImage: true, deliverVideo: true, referenceImageUrls: [] },
      references,
    });
  } catch (error) {
    logger.warn({ error, workspaceId, productId }, 'Autonomous premium media production could not start');
    return null;
  }
}

function publicCandidate(candidate: PremiumMediaCandidate): PremiumMediaJobView['candidates'][number] {
  const { callbackToken: _callbackToken, providerPayload: _providerPayload, referenceUrls: _referenceUrls, resultUrls, ...safe } = candidate;
  return { ...safe, resultCount: resultUrls.length };
}

async function jobView(job: PremiumMediaJob): Promise<PremiumMediaJobView> {
  const candidates = await repo.listCandidates(job.workspaceId, job.id);
  const { referenceAssets: _referenceAssets, ...safe } = job;
  return { ...safe, referenceCount: job.referenceAssets.length, candidates: candidates.map(publicCandidate) };
}

export async function getPremiumMediaJob(workspaceId: string, productId: string, jobId: string) {
  const job = await repo.getJob(workspaceId, jobId);
  if (!job || job.productId !== productId) throw notFoundError('Premium media job not found');
  return jobView(job);
}

export async function getLatestPremiumMediaJob(workspaceId: string, productId: string) {
  const job = await repo.getLatestJob(workspaceId, productId);
  return job ? jobView(job) : null;
}

export async function handleKieCallback(token: string, payload: unknown) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw notFoundError('Premium media callback not found');
  const normalized = normalizeKieTask(payload);
  const candidate = await repo.applyProviderResult({
    callbackToken: token,
    providerTaskId: normalized.taskId,
    state: normalized.state,
    resultUrls: normalized.resultUrls,
    creditsConsumed: normalized.creditsConsumed,
    payload: normalized.payload,
    errorCode: normalized.errorCode,
    errorMessage: normalized.errorMessage,
  });
  if (candidate && normalized.state !== 'pending') await settleCandidateProviderUsage(candidate);
  return candidate;
}

export async function pollCandidate(candidate: PremiumMediaCandidate) {
  if (!candidate.providerTaskId) return;
  const task = await getKieTask(candidate.providerApi, candidate.providerTaskId);
  if (task.state === 'pending') {
    await repo.touchCandidate(candidate.id);
    return;
  }
  const updated = await repo.applyProviderResult({
    candidateId: candidate.id,
    providerTaskId: task.taskId,
    state: task.state,
    resultUrls: task.resultUrls,
    creditsConsumed: task.creditsConsumed,
    payload: task.payload,
    errorCode: task.errorCode,
    errorMessage: task.errorMessage,
  });
  if (updated) await settleCandidateProviderUsage(updated);
}

export async function recoverStalePremiumMediaSubmissions(staleSeconds: number, providerTimeoutMinutes: number) {
  const stale = await repo.listStaleSubmittingCandidates(staleSeconds);
  for (const candidate of stale) {
    if (candidate.providerSubmissionState === 'SUBMITTING') {
      const message = 'Kie provider submission became stale after dispatch began; its prepaid hold remains for reconciliation.';
      if (candidate.reservationId) await markAiSpendAmbiguous(candidate.workspaceId, candidate.reservationId, message).catch(() => undefined);
      await repo.markCandidateSubmissionAmbiguous(candidate.workspaceId, candidate.id, 'KIE_SUBMISSION_TIMEOUT_AMBIGUOUS', message);
      continue;
    }
    try {
      await releaseProviderHold(candidate, 'premium_media_submission_not_dispatched', 'BEFORE_SUBMISSION');
      await repo.markCandidateSubmissionRejected(candidate.workspaceId, candidate.id, 'KIE_SUBMISSION_NOT_DISPATCHED', 'The stale Kie candidate was safely cancelled before provider dispatch.');
    } catch (error) {
      const message = `The pre-dispatch Kie hold could not be released safely: ${error instanceof Error ? error.message : String(error)}`;
      if (candidate.reservationId) await markAiSpendAmbiguous(candidate.workspaceId, candidate.reservationId, message).catch(() => undefined);
      // RESERVED proves no provider call began, but a failed wallet release still
      // requires operator reconciliation instead of pretending the funds moved.
      await repo.markCandidateSubmissionStarted(candidate.workspaceId, candidate.id).catch(() => undefined);
      await repo.markCandidateSubmissionAmbiguous(candidate.workspaceId, candidate.id, 'KIE_PRE_DISPATCH_RELEASE_AMBIGUOUS', message);
    }
  }

  const timedOut = await repo.listTimedOutProviderCandidates(providerTimeoutMinutes);
  for (const candidate of timedOut) {
    const message = 'The accepted Kie task exceeded Lulu\'s provider deadline without exact terminal credit evidence.';
    if (candidate.reservationId) await markAiSpendAmbiguous(candidate.workspaceId, candidate.reservationId, message).catch(() => undefined);
    await repo.markCandidateSubmissionAmbiguous(candidate.workspaceId, candidate.id, 'KIE_TASK_TIMEOUT_AMBIGUOUS', message);
  }

  const staleQuality = await repo.listStaleQualitySubmissions(Math.max(staleSeconds, 600));
  for (const candidate of staleQuality) {
    const message = 'Kie quality-audit submission became stale after dispatch began; its prepaid hold remains for reconciliation.';
    if (candidate.qualityReservationId) await markAiSpendAmbiguous(candidate.workspaceId, candidate.qualityReservationId, message).catch(() => undefined);
    await repo.markCandidateQualityAmbiguous({ workspaceId: candidate.workspaceId, candidateId: candidate.id,
      workerId: null, code: 'KIE_QUALITY_TIMEOUT_AMBIGUOUS', message });
  }
  return { staleSubmissions: stale.length, timedOutTasks: timedOut.length, staleQualitySubmissions: staleQuality.length };
}

async function recordKieCost(input: {
  workspaceId: string;
  userId: string | null;
  model: string;
  responseId: string;
  providerRequestId: string;
  credits: number;
  operation: string;
  reservationId?: string | null;
  fundingMode: 'CUSTOMER_PREPAID' | 'PLATFORM_FUNDED';
}) {
  if (!Number.isFinite(input.credits) || input.credits <= 0) {
    throw new AppError(409, 'KIE_EXACT_CREDITS_REQUIRED', 'Kie.ai usage cannot be settled without a strictly positive exact credit amount.');
  }
  const providerCostUsd = input.credits * env.KIE_CREDIT_COST_USD;
  const usage = await recordMeteredUsage({
    workspaceId: input.workspaceId,
    userId: input.userId,
    provider: 'kie.ai',
    model: input.model,
    providerCostUsd,
    customerCostUsd: providerCostUsd * env.KIE_CUSTOMER_MARKUP_MULTIPLIER,
    responseId: input.responseId,
    providerRequestId: input.providerRequestId,
    reservationId: input.reservationId ?? null,
    fundingMode: input.fundingMode,
    metadata: { creditsConsumed: input.credits, operation: input.operation, meteringEvidence: 'kie_exact_credits' },
  });
  if (!usage) throw new AppError(409, 'KIE_USAGE_LEDGER_CONFLICT', 'Kie usage could not be correlated to its prepaid reservation.');
}

async function markProviderBillingAmbiguous(candidate: PremiumMediaCandidate, code: string, message: string) {
  if (candidate.reservationId) {
    await markAiSpendAmbiguous(candidate.workspaceId, candidate.reservationId, message).catch(() => undefined);
  }
  await repo.markCandidateSubmissionAmbiguous(candidate.workspaceId, candidate.id, code, message);
}

async function settleCandidateProviderUsage(candidate: PremiumMediaCandidate) {
  if (candidate.usageRecorded || candidate.providerSubmissionState === 'REJECTED') return true;
  if (!candidate.providerTaskId) {
    await markProviderBillingAmbiguous(candidate, 'KIE_TASK_ID_MISSING', 'Kie.ai completed a candidate without a durable provider task identity.');
    return false;
  }
  const credits = Number(candidate.creditsConsumed);
  const maximumCredits = Number(candidate.billingMaxCredits);
  if (!Number.isFinite(credits) || credits <= 0) {
    await markProviderBillingAmbiguous(candidate, 'KIE_CREDITS_MISSING', 'Kie.ai returned a terminal task without a strictly positive exact creditsConsumed value.');
    return false;
  }
  if (!Number.isFinite(maximumCredits) || maximumCredits <= 0 || credits > maximumCredits) {
    await markProviderBillingAmbiguous(candidate, 'KIE_CREDITS_EXCEED_HOLD', 'Kie.ai reported credits outside the reviewed prepaid ceiling; the customer hold remains for reconciliation.');
    return false;
  }
  if (candidate.fundingMode === 'UNRESOLVED'
    || (candidate.fundingMode === 'CUSTOMER_PREPAID' && !candidate.reservationId)) {
    await markProviderBillingAmbiguous(candidate, 'KIE_FUNDING_UNRESOLVED', 'The Kie task has no provable funding decision from before provider submission.');
    return false;
  }
  await recordKieCost({
    workspaceId: candidate.workspaceId,
    userId: (await repo.getJobById(candidate.jobId))?.requestedBy ?? null,
    model: candidate.model,
    responseId: `kie-task:${candidate.providerTaskId}`,
    providerRequestId: candidate.providerTaskId,
    credits,
    operation: candidate.purpose.toLowerCase(),
    reservationId: candidate.reservationId,
    fundingMode: candidate.fundingMode,
  });
  const recorded = await repo.markCandidateUsageRecorded(candidate.workspaceId, candidate.id);
  if (!recorded) throw new AppError(409, 'KIE_USAGE_STATE_CONFLICT', 'Kie usage was recorded, but the candidate settlement state could not be finalized.');
  return true;
}

async function storeFinalCandidate(
  candidate: PremiumMediaCandidate,
  job: PremiumMediaJob,
  product: repo.ProductMediaContext,
  workerId: string,
  report: Record<string, unknown>,
  score: number,
) {
  const resultUrl = candidate.resultUrls[0];
  if (!resultUrl) throw new AppError(502, 'PREMIUM_MEDIA_RESULT_MISSING', 'The accepted premium candidate has no result URL');
  const downloaded = await downloadGeneratedMedia(resultUrl, candidate.mediaType);
  const extension = extensionForMimeType(downloaded.mimeType);
  const key = premiumProductMediaKey(job.workspaceId, job.productId, job.id, candidate.id, extension);
  await putObject({
    key,
    content: downloaded.buffer,
    mimeType: downloaded.mimeType,
    fileName: `${filenamePart(product.name)}-premium.${extension}`,
  });
  const title = `${product.name} · Premium ${candidate.mediaType === 'IMAGE' ? 'product image' : 'product video'}`;
  const mediaId = await repo.attachAcceptedCandidate({
    candidate,
    workerId,
    storageReference: key,
    mimeType: downloaded.mimeType,
    title,
    altText: `${candidate.mediaType === 'IMAGE' ? 'Premium campaign image' : 'Premium campaign video'} for ${product.name}`,
  });
  return repo.finishStoredCandidate({
    candidateId: candidate.id,
    workerId,
    mediaId,
    score,
    report,
    storageReference: key,
    mimeType: downloaded.mimeType,
  });
}

function qualityBillingVariant(candidate: PremiumMediaCandidate) {
  return resolveKieMaximumCreditVariant({
    purpose: 'QUALITY_AUDIT',
    model: env.KIE_QUALITY_MODEL,
    mediaType: candidate.mediaType,
    resolution: candidate.mediaType,
    durationSeconds: candidate.mediaType === 'VIDEO' ? 5 : null,
  });
}

function persistedQualityReport(candidate: PremiumMediaCandidate) {
  const report = candidate.qualityReport;
  if (!report || typeof report !== 'object') {
    throw new AppError(409, 'KIE_QUALITY_EVIDENCE_MISSING', 'The persisted Kie quality response is missing its report.');
  }
  const score = Number(report.score);
  return {
    report,
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
    accepted: report.accepted === true,
  };
}

async function settleCandidateQualityUsage(candidate: PremiumMediaCandidate, job: PremiumMediaJob, workerId: string) {
  if (candidate.qualitySubmissionState === 'SETTLED' && candidate.qualityUsageRecorded) return candidate;
  const responseId = candidate.qualityProviderResponseId?.trim();
  const credits = Number(candidate.qualityCreditsConsumed);
  const maximumCredits = Number(candidate.qualityBillingMaxCredits);
  if (!responseId || !Number.isFinite(credits) || credits <= 0
    || !Number.isFinite(maximumCredits) || maximumCredits <= 0 || credits > maximumCredits
    || candidate.qualityFundingMode === 'UNRESOLVED'
    || (candidate.qualityFundingMode === 'CUSTOMER_PREPAID' && !candidate.qualityReservationId)) {
    const message = credits > maximumCredits
      ? 'Kie.ai quality-audit credits exceeded the reviewed prepaid ceiling.'
      : 'Kie.ai quality audit did not return complete, exact funding and credit evidence.';
    if (candidate.qualityReservationId) await markAiSpendAmbiguous(candidate.workspaceId, candidate.qualityReservationId, message).catch(() => undefined);
    await repo.markCandidateQualityAmbiguous({
      workspaceId: candidate.workspaceId,
      candidateId: candidate.id,
      workerId,
      code: credits > maximumCredits ? 'KIE_QUALITY_CREDITS_EXCEED_HOLD' : 'KIE_QUALITY_METERING_AMBIGUOUS',
      message,
    });
    return null;
  }
  await recordKieCost({
    workspaceId: candidate.workspaceId,
    userId: job.requestedBy,
    model: env.KIE_QUALITY_MODEL,
    responseId: `kie-quality:${responseId}`,
    providerRequestId: responseId,
    credits,
    operation: `${candidate.mediaType.toLowerCase()}_quality_gate`,
    reservationId: candidate.qualityReservationId,
    fundingMode: candidate.qualityFundingMode,
  });
  const settled = await repo.markCandidateQualitySettled(candidate.workspaceId, candidate.id, workerId);
  if (!settled) throw new AppError(409, 'KIE_QUALITY_SETTLEMENT_STATE_CONFLICT', 'Kie quality usage was recorded, but its candidate state could not be finalized.');
  return settled;
}

async function finishSettledQuality(
  candidate: PremiumMediaCandidate,
  job: PremiumMediaJob,
  product: repo.ProductMediaContext,
  workerId: string,
) {
  const quality = persistedQualityReport(candidate);
  const finalPurpose = candidate.purpose === 'IMAGE_UPSCALE' || candidate.purpose === 'VIDEO_UPSCALE';
  if (quality.accepted && finalPurpose) {
    await storeFinalCandidate(candidate, job, product, workerId, quality.report, quality.score);
    return;
  }
  await repo.finishCandidateQuality({
    candidateId: candidate.id,
    workerId,
    accepted: quality.accepted,
    score: quality.score,
    report: quality.report,
  });
}

async function reserveQualityAudit(candidate: PremiumMediaCandidate, job: PremiumMediaJob, workerId: string, variant: KieCostVariant) {
  const resultUrl = candidate.resultUrls[0];
  const reservation = await reserveAiSpend({
    workspaceId: candidate.workspaceId,
    userId: job.requestedBy,
    requestKey: `premium-media:${candidate.id}:quality:v1`,
    requestFingerprint: fingerprintAiRequest({
      candidateId: candidate.id,
      providerTaskId: candidate.providerTaskId,
      resultUrl,
      model: env.KIE_QUALITY_MODEL,
      prompt: candidate.prompt,
      referenceUrls: candidate.referenceUrls,
      variant,
    }),
    operation: `premium_media.${candidate.mediaType.toLowerCase()}_quality_gate`,
    maximumCustomerCostUsd: maximumKieCustomerCostUsd(variant),
    usdCnyRate: env.API_USD_CNY_RATE,
    pricingSnapshot: {
      catalog: 'kie-prepaid-max-v1',
      maximumCredits: variant.maximumCredits,
      providerCreditCostUsd: env.KIE_CREDIT_COST_USD,
      customerMarkupMultiplier: env.KIE_CUSTOMER_MARKUP_MULTIPLIER,
      resolution: variant.resolution,
      durationSeconds: variant.durationSeconds,
    },
    provider: 'kie.ai',
    model: env.KIE_QUALITY_MODEL,
  });
  const bound = await repo.bindCandidateQualityFunding({
    workspaceId: candidate.workspaceId,
    candidateId: candidate.id,
    workerId,
    reservationId: reservation.reservation?.id ?? null,
    fundingMode: reservation.funding.mode,
    variant,
  });
  if (!bound) {
    if (reservation.reservation) {
      await releaseAiSpend({
        workspaceId: candidate.workspaceId,
        reservationId: reservation.reservation.id,
        disposition: 'BEFORE_SUBMISSION',
        reason: 'premium_media_quality_binding_failed',
      });
    }
    throw new AppError(409, 'KIE_QUALITY_FUNDING_BIND_FAILED', 'Quality-audit funding could not be bound to its media candidate.');
  }
  return bound;
}

export async function processCandidate(candidate: PremiumMediaCandidate, workerId: string) {
  const job = await repo.getJobById(candidate.jobId);
  if (!job || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) {
    await repo.failClaimedCandidate(candidate.id, workerId, 'PREMIUM_MEDIA_JOB_INACTIVE', 'The owning premium media job is no longer active');
    return;
  }
  const product = await repo.getProductMediaContext(job.workspaceId, job.productId);
  if (!product) throw notFoundError('Product not found');
  const resultUrl = candidate.resultUrls[0];
  if (!resultUrl) {
    await repo.finishCandidateQuality({
      candidateId: candidate.id,
      workerId,
      accepted: false,
      score: 0,
      report: { summary: 'Provider completed without a media result URL', hardFailures: ['missing_result_url'] },
    });
    return;
  }

  if (!candidate.usageRecorded || candidate.providerSubmissionState !== 'SETTLED') {
    const settled = await settleCandidateProviderUsage(candidate);
    if (!settled) return;
  }

  if (candidate.qualitySubmissionState === 'SETTLED') {
    await finishSettledQuality(candidate, job, product, workerId);
    return;
  }
  if (candidate.qualitySubmissionState === 'SUBMITTED') {
    const settled = await settleCandidateQualityUsage(candidate, job, workerId);
    if (settled) await finishSettledQuality(settled, job, product, workerId);
    return;
  }
  if (candidate.qualitySubmissionState === 'AMBIGUOUS' || candidate.qualitySubmissionState === 'SUBMITTING') {
    if (candidate.qualityReservationId) await markAiSpendAmbiguous(candidate.workspaceId, candidate.qualityReservationId, 'Quality audit submission has no safely replayable terminal evidence.').catch(() => undefined);
    await repo.markCandidateQualityAmbiguous({
      workspaceId: candidate.workspaceId,
      candidateId: candidate.id,
      workerId,
      code: 'KIE_QUALITY_SUBMISSION_AMBIGUOUS',
      message: 'Quality audit submission has no safely replayable terminal evidence; the prepaid hold remains.',
    });
    return;
  }

  const variant = qualityBillingVariant(candidate);
  if (candidate.qualitySubmissionState === 'NOT_STARTED') {
    await reserveQualityAudit(candidate, job, workerId, variant);
  }
  const submitting = await repo.markCandidateQualitySubmitting(candidate.workspaceId, candidate.id, workerId);
  if (!submitting) throw new AppError(409, 'KIE_QUALITY_SUBMISSION_STATE_CONFLICT', 'Quality-audit submission state changed before provider dispatch.');
  if (submitting.qualityReservationId) {
    const marked = await markAiSpendSubmitting(submitting.workspaceId, submitting.qualityReservationId);
    if (!marked) {
      await releaseAiSpend({
        workspaceId: submitting.workspaceId,
        reservationId: submitting.qualityReservationId,
        disposition: 'BEFORE_SUBMISSION',
        reason: 'premium_media_quality_dispatch_not_started',
      });
      throw new AppError(409, 'KIE_QUALITY_RESERVATION_STATE_CONFLICT', 'Quality-audit reservation was not dispatchable.');
    }
  }

  const threshold = candidate.mediaType === 'IMAGE' ? job.imageQualityThreshold : job.videoQualityThreshold;
  try {
    const quality = await evaluateMediaQuality({
      mediaType: candidate.mediaType,
      productName: product.name.slice(0, 300),
      productDescription: productDescription(product).slice(0, 5_000),
      prompt: candidate.prompt.slice(0, 5_000),
      referenceUrls: candidate.referenceUrls.slice(0, 5),
      candidateUrl: resultUrl,
      threshold,
    });
    if (!quality.responseId || !quality.creditsConsumed || quality.creditsConsumed <= 0) {
      const message = 'Kie.ai returned a quality result without a response ID and strictly positive exact creditsConsumed value.';
      if (submitting.qualityReservationId) await markAiSpendAmbiguous(submitting.workspaceId, submitting.qualityReservationId, message).catch(() => undefined);
      await repo.markCandidateQualityAmbiguous({
        workspaceId: submitting.workspaceId,
        candidateId: submitting.id,
        workerId,
        code: 'KIE_QUALITY_METERING_MISSING',
        message,
      });
      return;
    }
    const persisted = await repo.persistCandidateQualityResponse({
      workspaceId: submitting.workspaceId,
      candidateId: submitting.id,
      workerId,
      responseId: quality.responseId,
      creditsConsumed: quality.creditsConsumed,
      report: quality.report as unknown as Record<string, unknown>,
    });
    if (!persisted || persisted.qualitySubmissionState === 'AMBIGUOUS') {
      const message = 'Kie.ai quality usage exceeded or could not be bound to its prepaid ceiling.';
      if (submitting.qualityReservationId) await markAiSpendAmbiguous(submitting.workspaceId, submitting.qualityReservationId, message).catch(() => undefined);
      await repo.markCandidateQualityAmbiguous({
        workspaceId: submitting.workspaceId,
        candidateId: submitting.id,
        workerId,
        code: 'KIE_QUALITY_RESPONSE_AMBIGUOUS',
        message,
      });
      return;
    }
    if (persisted.qualityReservationId) {
      await markAiSpendSubmitted({
        workspaceId: persisted.workspaceId,
        reservationId: persisted.qualityReservationId,
        provider: 'kie.ai',
        model: env.KIE_QUALITY_MODEL,
        providerRequestId: quality.responseId,
      });
    }
    const settled = await settleCandidateQualityUsage(persisted, job, workerId);
    if (settled) await finishSettledQuality(settled, job, product, workerId);
  } catch (error) {
    const disposition = classifyKiePostFailure(error);
    const message = error instanceof Error ? error.message : 'Kie.ai quality-audit submission failed';
    const code = error instanceof AppError ? error.code : 'KIE_QUALITY_SUBMISSION_FAILED';
    if (disposition === 'DEFINITIVE_REJECTION') {
      try {
        if (submitting.qualityReservationId) {
          await releaseAiSpend({
            workspaceId: submitting.workspaceId,
            reservationId: submitting.qualityReservationId,
            disposition: 'DEFINITIVE_REJECTION',
            reason: `kie_quality_definitive_rejection:${code}`,
          });
        }
        await repo.markCandidateQualityRejected({ workspaceId: submitting.workspaceId, candidateId: submitting.id, workerId, code, message });
      } catch (releaseError) {
        if (submitting.qualityReservationId) await markAiSpendAmbiguous(submitting.workspaceId, submitting.qualityReservationId, `quality rejection release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`).catch(() => undefined);
        await repo.markCandidateQualityAmbiguous({ workspaceId: submitting.workspaceId, candidateId: submitting.id, workerId,
          code: 'KIE_QUALITY_REJECTION_RELEASE_AMBIGUOUS', message: 'The quality request was rejected, but Lulu could not safely release its prepaid hold.' });
      }
      return;
    }
    if (submitting.qualityReservationId) await markAiSpendAmbiguous(submitting.workspaceId, submitting.qualityReservationId, message).catch(() => undefined);
    await repo.markCandidateQualityAmbiguous({ workspaceId: submitting.workspaceId, candidateId: submitting.id, workerId, code, message });
  }
}

export async function recordCandidateProviderUsage(candidate: PremiumMediaCandidate) {
  await settleCandidateProviderUsage(candidate);
}

function currentCandidates(candidates: PremiumMediaCandidate[], purpose: PremiumMediaPurpose, round: number) {
  return candidates.filter((candidate) => candidate.purpose === purpose && candidate.generationRound === round);
}

function allTerminal(candidates: PremiumMediaCandidate[]) {
  return candidates.length > 0 && candidates.every((candidate) => (
    TERMINAL_CANDIDATE_STATUSES.has(candidate.status)
    && ['REJECTED', 'SETTLED'].includes(candidate.providerSubmissionState)
  ));
}

function bestAccepted(candidates: PremiumMediaCandidate[]) {
  return candidates
    .filter((candidate) => candidate.status === 'ACCEPTED')
    .sort((left, right) => (right.qualityScore ?? 0) - (left.qualityScore ?? 0))[0] ?? null;
}

function statusMatches(status: PremiumMediaJobStatus, values: PremiumMediaJobStatus[]) {
  return values.includes(status);
}

export async function advancePremiumMediaJob(job: PremiumMediaJob) {
  const product = await repo.getProductMediaContext(job.workspaceId, job.productId);
  if (!product) {
    await repo.failJob(job, 'PRODUCT_NOT_FOUND', 'The product was removed before premium media production completed');
    return;
  }
  const candidates = await repo.listCandidates(job.workspaceId, job.id);

  if (statusMatches(job.status, ['SUBMITTING_IMAGES', 'GENERATING_IMAGES'])) {
    const round = currentCandidates(candidates, 'IMAGE_GENERATION', job.imageRound);
    if (job.status === 'SUBMITTING_IMAGES' && round.length === 0) {
      await submitImageRound(job, product);
      return;
    }
    if (!allTerminal(round)) return;
    const selected = bestAccepted(round);
    if (selected) {
      const transitioned = await repo.transitionJob({
        jobId: job.id,
        expected: ['SUBMITTING_IMAGES', 'GENERATING_IMAGES'],
        status: 'SUBMITTING_IMAGE_UPSCALE',
        selectedImageCandidateId: selected.id,
      });
      if (transitioned) await submitImageUpscale(transitioned, selected);
      return;
    }
    if (job.imageRound < job.maxRounds) {
      const transitioned = await repo.transitionJob({
        jobId: job.id,
        expected: ['SUBMITTING_IMAGES', 'GENERATING_IMAGES'],
        status: 'SUBMITTING_IMAGES',
        imageRound: job.imageRound + 1,
      });
      if (transitioned) await submitImageRound(transitioned, product, qualityFeedback(round));
      return;
    }
    await repo.failJob(job, 'PREMIUM_IMAGE_QUALITY_REJECTED', 'No generated image passed the premium product-identity quality gate');
    return;
  }

  if (statusMatches(job.status, ['SUBMITTING_IMAGE_UPSCALE', 'UPSCALING_IMAGE'])) {
    const upscales = candidates.filter((candidate) => candidate.purpose === 'IMAGE_UPSCALE');
    if (job.status === 'SUBMITTING_IMAGE_UPSCALE' && upscales.length === 0) {
      const selected = candidates.find((candidate) => candidate.id === job.selectedImageCandidateId);
      if (!selected) throw new AppError(500, 'PREMIUM_IMAGE_SELECTION_MISSING', 'Selected premium image candidate is missing');
      await submitImageUpscale(job, selected);
      return;
    }
    if (!allTerminal(upscales)) return;
    const finalImage = bestAccepted(upscales);
    if (finalImage?.productMediaId) {
      if (!job.deliverVideo) {
        await repo.completeJob(job, finalImage.productMediaId, null);
        return;
      }
      const transitioned = await repo.transitionJob({
        jobId: job.id,
        expected: ['SUBMITTING_IMAGE_UPSCALE', 'UPSCALING_IMAGE'],
        status: 'SUBMITTING_VIDEOS',
        videoRound: 1,
      });
      if (transitioned) await submitVideoRound(transitioned, product, finalImage);
      return;
    }
    if (upscales.length < job.maxRounds) {
      const selected = candidates.find((candidate) => candidate.id === job.selectedImageCandidateId);
      if (!selected) throw new AppError(500, 'PREMIUM_IMAGE_SELECTION_MISSING', 'Selected premium image candidate is missing');
      const transitioned = await repo.transitionJob({
        jobId: job.id,
        expected: ['SUBMITTING_IMAGE_UPSCALE', 'UPSCALING_IMAGE'],
        status: 'SUBMITTING_IMAGE_UPSCALE',
      });
      if (transitioned) await submitImageUpscale(transitioned, selected);
      return;
    }
    await repo.failJob(job, 'PREMIUM_IMAGE_FINISHING_FAILED', 'Premium image finishing did not pass the independent quality gate');
    return;
  }

  if (statusMatches(job.status, ['SUBMITTING_VIDEOS', 'GENERATING_VIDEOS'])) {
    const round = currentCandidates(candidates, 'VIDEO_GENERATION', job.videoRound);
    if (job.status === 'SUBMITTING_VIDEOS' && round.length === 0) {
      const finalImage = candidates
        .filter((candidate) => candidate.purpose === 'IMAGE_UPSCALE' && candidate.status === 'ACCEPTED')
        .sort((left, right) => (right.qualityScore ?? 0) - (left.qualityScore ?? 0))[0];
      if (!finalImage) throw new AppError(500, 'PREMIUM_FINAL_IMAGE_MISSING', 'Premium video production has no verified source image');
      await submitVideoRound(job, product, finalImage);
      return;
    }
    if (!allTerminal(round)) return;
    const selected = bestAccepted(round);
    if (selected) {
      const transitioned = await repo.transitionJob({
        jobId: job.id,
        expected: ['SUBMITTING_VIDEOS', 'GENERATING_VIDEOS'],
        status: 'SUBMITTING_VIDEO_UPSCALE',
        selectedVideoCandidateId: selected.id,
      });
      if (transitioned) await submitVideoUpscale(transitioned, selected);
      return;
    }
    if (job.videoRound < job.maxRounds) {
      const finalImage = candidates
        .filter((candidate) => candidate.purpose === 'IMAGE_UPSCALE' && candidate.status === 'ACCEPTED')
        .sort((left, right) => (right.qualityScore ?? 0) - (left.qualityScore ?? 0))[0];
      if (!finalImage) throw new AppError(500, 'PREMIUM_FINAL_IMAGE_MISSING', 'The premium video retry has no verified source image');
      const transitioned = await repo.transitionJob({
        jobId: job.id,
        expected: ['SUBMITTING_VIDEOS', 'GENERATING_VIDEOS'],
        status: 'SUBMITTING_VIDEOS',
        videoRound: job.videoRound + 1,
      });
      if (transitioned) await submitVideoRound(transitioned, product, finalImage, qualityFeedback(round));
      return;
    }
    await repo.failJob(job, 'PREMIUM_VIDEO_QUALITY_REJECTED', 'No generated video passed the premium temporal and product-identity quality gate');
    return;
  }

  if (statusMatches(job.status, ['SUBMITTING_VIDEO_UPSCALE', 'UPSCALING_VIDEO'])) {
    const upscales = candidates.filter((candidate) => candidate.purpose === 'VIDEO_UPSCALE');
    if (job.status === 'SUBMITTING_VIDEO_UPSCALE' && upscales.length === 0) {
      const selected = candidates.find((candidate) => candidate.id === job.selectedVideoCandidateId);
      if (!selected) throw new AppError(500, 'PREMIUM_VIDEO_SELECTION_MISSING', 'Selected premium video candidate is missing');
      await submitVideoUpscale(job, selected);
      return;
    }
    if (!allTerminal(upscales)) return;
    const finalVideo = bestAccepted(upscales);
    if (finalVideo?.productMediaId) {
      const finalImage = candidates
        .filter((candidate) => candidate.purpose === 'IMAGE_UPSCALE' && candidate.status === 'ACCEPTED' && candidate.productMediaId)
        .sort((left, right) => (right.qualityScore ?? 0) - (left.qualityScore ?? 0))[0];
      await repo.completeJob(job, job.deliverImage ? finalImage?.productMediaId ?? null : null, finalVideo.productMediaId);
      return;
    }
    if (upscales.length < job.maxRounds) {
      const selected = candidates.find((candidate) => candidate.id === job.selectedVideoCandidateId);
      if (!selected) throw new AppError(500, 'PREMIUM_VIDEO_SELECTION_MISSING', 'Selected premium video candidate is missing');
      const transitioned = await repo.transitionJob({
        jobId: job.id,
        expected: ['SUBMITTING_VIDEO_UPSCALE', 'UPSCALING_VIDEO'],
        status: 'SUBMITTING_VIDEO_UPSCALE',
      });
      if (transitioned) await submitVideoUpscale(transitioned, selected);
      return;
    }
    await repo.failJob(job, 'PREMIUM_VIDEO_FINISHING_FAILED', 'Premium video finishing did not pass the independent quality gate');
  }
}

export async function getPremiumMediaAsset(workspaceId: string, productId: string, candidateId: string) {
  const asset = await repo.getStoredCandidateAsset(workspaceId, productId, candidateId);
  if (!asset) throw notFoundError('Premium media asset not found');
  return { ...asset, buffer: await getObject(asset.storageReference) };
}

export function premiumMediaConfiguration() {
  const requirements = {
    apiKey: isKieMediaConfigured(),
    storage: Boolean(env.AWS_S3_BUCKET),
    callback: Boolean(env.KIE_CALLBACK_BASE_URL ?? env.OAUTH_CALLBACK_BASE_URL),
  };
  return {
    configured: Object.values(requirements).every(Boolean),
    requirements,
    mode: 'premium_only' as const,
    imageModels: getPremiumImageModels(),
    textImageModels: getPremiumTextImageModels(),
    videoModels: getPremiumVideoModels(),
    finishingModels: ['topaz/image-upscale', 'topaz/video-upscale'],
    qualityModel: env.KIE_QUALITY_MODEL,
    thresholds: { image: env.KIE_IMAGE_QUALITY_THRESHOLD, video: env.KIE_VIDEO_QUALITY_THRESHOLD },
    approvalsRequired: false,
  };
}
