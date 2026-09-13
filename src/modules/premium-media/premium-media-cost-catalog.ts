import { env } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import type { PremiumMediaPurpose, PremiumMediaType } from './premium-media.types.js';

export type KieBillablePurpose = PremiumMediaPurpose | 'QUALITY_AUDIT';

export type KieCostVariant = {
  purpose: KieBillablePurpose;
  model: string;
  resolution: string;
  durationSeconds: number | null;
  maximumCredits: number;
};

type CatalogEntry = KieCostVariant & {
  mediaType?: PremiumMediaType;
};

/**
 * Billing safety catalogue, not a display-price table.
 *
 * Each ceiling deliberately exceeds the currently observed Kie charge for the
 * exact, server-generated request variant.  Changing a model, resolution,
 * duration or finishing factor therefore requires a reviewed code change; an
 * environment variable can never silently introduce an unreserved provider
 * charge.  Exact provider credits are still used for final settlement.
 */
const KIE_MAXIMUM_CREDIT_CATALOG: readonly CatalogEntry[] = [
  { purpose: 'IMAGE_GENERATION', model: 'flux-2/pro-image-to-image', resolution: '1K', durationSeconds: null, maximumCredits: 50 },
  { purpose: 'IMAGE_GENERATION', model: 'flux-2/pro-image-to-image', resolution: '2K', durationSeconds: null, maximumCredits: 100 },
  { purpose: 'IMAGE_GENERATION', model: 'flux-2/pro-text-to-image', resolution: '1K', durationSeconds: null, maximumCredits: 50 },
  { purpose: 'IMAGE_GENERATION', model: 'flux-2/pro-text-to-image', resolution: '2K', durationSeconds: null, maximumCredits: 100 },
  { purpose: 'IMAGE_GENERATION', model: 'seedream/5-pro-image-to-image', resolution: '1K', durationSeconds: null, maximumCredits: 80 },
  { purpose: 'IMAGE_GENERATION', model: 'seedream/5-pro-image-to-image', resolution: '2K', durationSeconds: null, maximumCredits: 160 },
  { purpose: 'IMAGE_GENERATION', model: 'seedream/5-pro-text-to-image', resolution: '1K', durationSeconds: null, maximumCredits: 80 },
  { purpose: 'IMAGE_GENERATION', model: 'seedream/5-pro-text-to-image', resolution: '2K', durationSeconds: null, maximumCredits: 160 },

  { purpose: 'IMAGE_UPSCALE', model: 'topaz/image-upscale', resolution: '2x', durationSeconds: null, maximumCredits: 100 },
  { purpose: 'IMAGE_UPSCALE', model: 'topaz/image-upscale', resolution: '3x', durationSeconds: null, maximumCredits: 225 },
  { purpose: 'IMAGE_UPSCALE', model: 'topaz/image-upscale', resolution: '4x', durationSeconds: null, maximumCredits: 400 },

  { purpose: 'VIDEO_GENERATION', model: 'kling/v3-turbo-image-to-video', resolution: '720p', durationSeconds: 5, maximumCredits: 500 },
  { purpose: 'VIDEO_GENERATION', model: 'kling/v3-turbo-image-to-video', resolution: '1080p', durationSeconds: 5, maximumCredits: 1_000 },
  { purpose: 'VIDEO_GENERATION', model: 'veo3', resolution: '1080p', durationSeconds: 8, maximumCredits: 1_000 },

  { purpose: 'VIDEO_UPSCALE', model: 'topaz/video-upscale', resolution: '2x', durationSeconds: 5, maximumCredits: 1_500 },
  { purpose: 'VIDEO_UPSCALE', model: 'topaz/video-upscale', resolution: '3x', durationSeconds: 5, maximumCredits: 3_000 },
  { purpose: 'VIDEO_UPSCALE', model: 'topaz/video-upscale', resolution: '4x', durationSeconds: 5, maximumCredits: 5_000 },

  // The synchronous multimodal audit returns exact credits_consumed. These
  // ceilings cover the bounded prompt, at most five references and one result.
  { purpose: 'QUALITY_AUDIT', model: 'gemini-3-pro', mediaType: 'IMAGE', resolution: 'IMAGE', durationSeconds: null, maximumCredits: 500 },
  { purpose: 'QUALITY_AUDIT', model: 'gemini-3-pro', mediaType: 'VIDEO', resolution: 'VIDEO', durationSeconds: 5, maximumCredits: 1_000 },
] as const;

function normalized(value: string) {
  return value.trim().toLowerCase();
}

export function resolveKieMaximumCreditVariant(input: {
  purpose: KieBillablePurpose;
  model: string;
  resolution: string;
  durationSeconds?: number | null;
  mediaType?: PremiumMediaType;
}): KieCostVariant {
  const durationSeconds = input.durationSeconds ?? null;
  const entry = KIE_MAXIMUM_CREDIT_CATALOG.find((candidate) => (
    candidate.purpose === input.purpose
    && normalized(candidate.model) === normalized(input.model)
    && normalized(candidate.resolution) === normalized(input.resolution)
    && candidate.durationSeconds === durationSeconds
    && (!candidate.mediaType || candidate.mediaType === input.mediaType)
  ));
  if (!entry) {
    throw new AppError(
      503,
      'KIE_BILLING_VARIANT_UNAPPROVED',
      'The configured Kie model variant has no reviewed prepaid credit ceiling.',
      {
        purpose: input.purpose,
        model: input.model,
        resolution: input.resolution,
        durationSeconds,
        mediaType: input.mediaType ?? null,
      },
    );
  }
  const { mediaType: _mediaType, ...variant } = entry;
  return { ...variant };
}

function configuredModels(value: string) {
  return [...new Set(value.split(',').map((model) => model.trim()).filter(Boolean))];
}

export function getKieBillingCatalogReadiness() {
  const checks: Array<Parameters<typeof resolveKieMaximumCreditVariant>[0]> = [];
  for (const model of configuredModels(env.KIE_PREMIUM_IMAGE_MODELS)) {
    checks.push({ purpose: 'IMAGE_GENERATION', model, resolution: env.KIE_IMAGE_RESOLUTION });
  }
  for (const model of configuredModels(env.KIE_PREMIUM_TEXT_IMAGE_MODELS)) {
    checks.push({ purpose: 'IMAGE_GENERATION', model, resolution: env.KIE_IMAGE_RESOLUTION });
  }
  for (const model of configuredModels(env.KIE_PREMIUM_VIDEO_MODELS)) {
    checks.push(model === 'veo3'
      ? { purpose: 'VIDEO_GENERATION', model, resolution: '1080p', durationSeconds: 8 }
      : { purpose: 'VIDEO_GENERATION', model, resolution: env.KIE_VIDEO_RESOLUTION, durationSeconds: 5 });
  }
  checks.push(
    { purpose: 'IMAGE_UPSCALE', model: 'topaz/image-upscale', resolution: `${env.KIE_IMAGE_UPSCALE_FACTOR}x` },
    { purpose: 'VIDEO_UPSCALE', model: 'topaz/video-upscale', resolution: `${env.KIE_VIDEO_UPSCALE_FACTOR}x`, durationSeconds: 5 },
    { purpose: 'QUALITY_AUDIT', model: env.KIE_QUALITY_MODEL, mediaType: 'IMAGE', resolution: 'IMAGE' },
    { purpose: 'QUALITY_AUDIT', model: env.KIE_QUALITY_MODEL, mediaType: 'VIDEO', resolution: 'VIDEO', durationSeconds: 5 },
  );

  const unknownVariants: Array<Record<string, unknown>> = [];
  for (const check of checks) {
    try {
      resolveKieMaximumCreditVariant(check);
    } catch (error) {
      unknownVariants.push(error instanceof AppError && error.details && typeof error.details === 'object'
        ? error.details as Record<string, unknown>
        : check);
    }
  }
  const priceConfigured = Number.isFinite(env.KIE_CREDIT_COST_USD)
    && env.KIE_CREDIT_COST_USD > 0
    && Number.isFinite(env.KIE_CUSTOMER_MARKUP_MULTIPLIER)
    && env.KIE_CUSTOMER_MARKUP_MULTIPLIER >= 1
    && Number.isFinite(env.API_USD_CNY_RATE)
    && env.API_USD_CNY_RATE > 0;
  return {
    ready: unknownVariants.length === 0 && priceConfigured,
    catalogVersion: 'kie-prepaid-max-v1',
    priceConfigured,
    unknownVariants,
  };
}

export function maximumKieCustomerCostUsd(variant: KieCostVariant) {
  const amount = variant.maximumCredits * env.KIE_CREDIT_COST_USD * env.KIE_CUSTOMER_MARKUP_MULTIPLIER;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError(503, 'KIE_BILLING_PRICE_INVALID', 'Kie prepaid pricing must be a positive server-owned amount.');
  }
  return amount;
}
