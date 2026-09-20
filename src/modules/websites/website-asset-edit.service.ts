import { randomBytes, randomUUID } from 'node:crypto';
import { env, hasKie } from '../../config/env.js';
import { query, withTransaction } from '../../db/pool.js';
import { AppError, notFoundError } from '../../utils/app-error.js';
import {
  classifyKiePostFailure,
  createMarketTask,
  downloadGeneratedMedia,
  getPremiumImageModels,
  normalizeKieTask,
  uploadReferenceFile,
} from '../premium-media/kie-media.client.js';
import {
  fingerprintAiRequest,
  markAiSpendAmbiguous,
  markAiSpendSubmitted,
  markAiSpendSubmitting,
  reserveAiSpend,
} from '../api-wallet/ai-spend-reservation.repo.js';
import { recordMeteredUsage } from '../usage/usage.service.js';
import { maximumKieCustomerCostUsd, resolveKieMaximumCreditVariant } from '../premium-media/premium-media-cost-catalog.js';
import * as repo from './website.repo.js';

type WebsiteAssetEditStatus = 'QUEUED' | 'SUBMITTING' | 'SUBMITTED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
type WebsiteAssetEdit = {
  id: string;
  workspaceId: string;
  siteId: string;
  sourceAssetId: string;
  resultAssetId: string | null;
  prompt: string;
  model: string;
  status: WebsiteAssetEditStatus;
  providerTaskId: string | null;
  reservationId: string | null;
  requestedBy: string;
  creditsConsumed: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

const editSelect = `SELECT id, workspace_id AS "workspaceId", site_id AS "siteId", source_asset_id AS "sourceAssetId", result_asset_id AS "resultAssetId", requested_by AS "requestedBy", prompt, model, status, provider_task_id AS "providerTaskId", reservation_id AS "reservationId", credits_consumed AS "creditsConsumed", error_code AS "errorCode", error_message AS "errorMessage", created_at AS "createdAt", updated_at AS "updatedAt", completed_at AS "completedAt" FROM managed_website_asset_edits`;

function mapEdit(row: Record<string, unknown>): WebsiteAssetEdit {
  return {
    id: String(row.id), workspaceId: String(row.workspaceId), siteId: String(row.siteId),
    sourceAssetId: String(row.sourceAssetId), resultAssetId: row.resultAssetId ? String(row.resultAssetId) : null,
    requestedBy: String(row.requestedBy), prompt: String(row.prompt), model: String(row.model), status: String(row.status) as WebsiteAssetEditStatus,
    providerTaskId: row.providerTaskId ? String(row.providerTaskId) : null,
    reservationId: row.reservationId ? String(row.reservationId) : null,
    creditsConsumed: row.creditsConsumed === null || row.creditsConsumed === undefined ? null : Number(row.creditsConsumed),
    errorCode: row.errorCode ? String(row.errorCode) : null, errorMessage: row.errorMessage ? String(row.errorMessage) : null,
    createdAt: String(row.createdAt), updatedAt: String(row.updatedAt), completedAt: row.completedAt ? String(row.completedAt) : null,
  };
}

function callbackBaseUrl() {
  const configured = env.KIE_CALLBACK_BASE_URL ?? env.OAUTH_CALLBACK_BASE_URL;
  if (!configured) throw new AppError(503, 'KIE_CALLBACK_URL_MISSING', 'KIE_CALLBACK_BASE_URL must point to the public /api/v1 API root');
  const parsed = new URL(configured);
  if (env.NODE_ENV === 'production' && parsed.protocol !== 'https:') throw new AppError(503, 'KIE_CALLBACK_URL_INSECURE', 'Kie.ai callbacks require HTTPS in production');
  return configured.replace(/\/$/, '');
}

function callbackUrl(token: string) {
  return `${callbackBaseUrl()}/public/kie/website-asset-callback/${token}`;
}

function imageParameters(model: string, prompt: string, referenceUrl: string) {
  if (model.startsWith('seedream/')) return { image_urls: [referenceUrl], prompt, aspect_ratio: '16:9', quality: env.KIE_IMAGE_RESOLUTION === '2K' ? 'high' : 'basic', output_format: 'png', nsfw_checker: true };
  return { input_urls: [referenceUrl], prompt, aspect_ratio: '16:9', resolution: env.KIE_IMAGE_RESOLUTION, nsfw_checker: true };
}

function safePrompt(prompt: string) {
  const value = prompt.trim();
  if (value.length < 3 || value.length > 4_000) throw new AppError(422, 'WEBSITE_ASSET_EDIT_PROMPT_INVALID', 'Describe the image change in 3 to 4,000 characters.');
  return value;
}

export async function getEdit(workspaceId: string, siteId: string, editId: string) {
  const row = (await query<Record<string, unknown>>(`${editSelect} WHERE workspace_id=$1 AND site_id=$2 AND id=$3 LIMIT 1`, [workspaceId, siteId, editId])).rows[0];
  if (!row) throw notFoundError('Website image edit was not found');
  return mapEdit(row);
}

export async function startEdit(input: { workspaceId: string; siteId: string; assetId: string; userId: string; prompt: string }) {
  if (!hasKie) throw new AppError(503, 'KIE_NOT_CONFIGURED', 'Image editing requires KIE_API_KEY on the server');
  const prompt = safePrompt(input.prompt);
  const source = await repo.getManagedWebsiteAssetForEdit(input.workspaceId, input.siteId, input.assetId);
  if (!source) throw notFoundError('Website image was not found');
  const imageModels = getPremiumImageModels();
  const model = imageModels.find((value) => value.includes('image-to-image')) ?? imageModels[0];
  if (!model) throw new AppError(503, 'KIE_IMAGE_MODEL_MISSING', 'No Kie.ai image model is configured for website editing');
  const variant = resolveKieMaximumCreditVariant({ purpose: 'IMAGE_GENERATION', model, resolution: env.KIE_IMAGE_RESOLUTION });
  const referenceUrl = await uploadReferenceFile({ buffer: source.content, mimeType: source.mimeType, fileName: source.fileName });
  const callbackToken = randomBytes(32).toString('hex');
  const jobId = randomUUID();
  const parameters = imageParameters(model, prompt, referenceUrl);
  const reservation = await reserveAiSpend({
    workspaceId: input.workspaceId,
    userId: input.userId,
    requestKey: `website-asset-edit:${jobId}:provider:v1`,
    requestFingerprint: fingerprintAiRequest({ jobId, sourceAssetId: source.id, prompt, model, parameters, variant }),
    operation: 'website_asset.edit',
    maximumCustomerCostUsd: maximumKieCustomerCostUsd(variant),
    usdCnyRate: env.API_USD_CNY_RATE,
    pricingSnapshot: { catalog: 'kie-prepaid-max-v1', maximumCredits: variant.maximumCredits, resolution: variant.resolution, operation: 'website_asset.edit' },
    provider: 'kie.ai', model,
  });
  await query(
    `INSERT INTO managed_website_asset_edits(id,workspace_id,site_id,source_asset_id,requested_by,prompt,model,status,callback_token,reservation_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,'QUEUED',$8,$9)`,
    [jobId, input.workspaceId, input.siteId, source.id, input.userId, prompt, model, callbackToken, reservation.reservation?.id ?? null],
  );
  try {
    if (reservation.reservation?.id) await markAiSpendSubmitting(input.workspaceId, reservation.reservation.id);
    await query(`UPDATE managed_website_asset_edits SET status='SUBMITTING' WHERE id=$1`, [jobId]);
    const created = await createMarketTask({ model, callbackUrl: callbackUrl(callbackToken), parameters });
    await query(`UPDATE managed_website_asset_edits SET status='SUBMITTED',provider_task_id=$2,updated_at=NOW() WHERE id=$1`, [jobId, created.taskId]);
    if (reservation.reservation?.id) {
      await markAiSpendSubmitted({ workspaceId: input.workspaceId, reservationId: reservation.reservation.id, provider: 'kie.ai', model, providerRequestId: created.taskId });
    }
    return await getEdit(input.workspaceId, input.siteId, jobId);
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'KIE_WEBSITE_ASSET_EDIT_FAILED';
    const message = error instanceof Error ? error.message : 'Kie.ai image editing failed';
    if (reservation.reservation?.id) await markAiSpendAmbiguous(input.workspaceId, reservation.reservation.id, message).catch(() => undefined);
    await query(`UPDATE managed_website_asset_edits SET status='FAILED',error_code=$2,error_message=$3,updated_at=NOW() WHERE id=$1`, [jobId, code, message.slice(0, 2_000)]);
    if (classifyKiePostFailure(error) === 'DEFINITIVE_REJECTION') {
      // A provider rejection is terminal; the durable hold remains visible for
      // reconciliation if the provider did not return exact billing evidence.
    }
    throw error;
  }
}

export async function handleCallback(token: string, payload: unknown) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw notFoundError('Website image edit callback was not found');
  const jobRow = (await query<Record<string, unknown>>(`${editSelect} WHERE callback_token=$1 LIMIT 1`, [token])).rows[0];
  if (!jobRow) throw notFoundError('Website image edit callback was not found');
  const job = mapEdit(jobRow);
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) return job;
  const normalized = normalizeKieTask(payload);
  await query(`UPDATE managed_website_asset_edits SET status=$2,error_code=$3,error_message=$4,provider_payload=$5::jsonb,updated_at=NOW() WHERE id=$1`, [job.id, normalized.state === 'pending' ? 'PROCESSING' : normalized.state === 'failed' ? 'FAILED' : 'SUBMITTED', normalized.errorCode, normalized.errorMessage, JSON.stringify(normalized.payload)]);
  if (normalized.state === 'pending') return getEdit(job.workspaceId, job.siteId, job.id);
  if (normalized.state === 'failed' || !normalized.resultUrls[0] || !normalized.creditsConsumed || normalized.creditsConsumed <= 0) {
    if (job.reservationId) await markAiSpendAmbiguous(job.workspaceId, job.reservationId, normalized.errorMessage ?? 'Kie.ai did not return exact successful image-edit evidence').catch(() => undefined);
    return getEdit(job.workspaceId, job.siteId, job.id);
  }
  const downloaded = await downloadGeneratedMedia(normalized.resultUrls[0], 'IMAGE');
  const result = await withTransaction(async (client) => {
    const locked = await query<{ status: WebsiteAssetEditStatus; resultAssetId: string | null }>(
      `SELECT status,result_asset_id AS "resultAssetId" FROM managed_website_asset_edits WHERE id=$1 FOR UPDATE`,
      [job.id],
      client,
    );
    if (!locked.rows[0] || !['SUBMITTED', 'PROCESSING'].includes(locked.rows[0].status)) return null;
    const inserted = await query<{ id: string }>(
      `INSERT INTO managed_website_assets(workspace_id,site_id,uploaded_by,file_name,mime_type,size_bytes,alt_text,placement,crop,content)
       SELECT edit.workspace_id,edit.site_id,edit.requested_by,$2,$3,$4,source.alt_text,source.placement,
              jsonb_build_object('sourceAssetId',source.id,'editPrompt',$5),$6
         FROM managed_website_asset_edits edit JOIN managed_website_assets source ON source.id=edit.source_asset_id
        WHERE edit.id=$1 AND edit.status IN ('SUBMITTED','PROCESSING') RETURNING id`,
      [job.id, `edited-${job.sourceAssetId}.${downloaded.mimeType === 'image/png' ? 'png' : 'jpg'}`, downloaded.mimeType, downloaded.buffer.byteLength, job.prompt, downloaded.buffer],
      client,
    );
    const assetId = inserted.rows[0]?.id;
    if (!assetId) return null;
    await query(`UPDATE managed_website_asset_edits SET status='COMPLETED',result_asset_id=$2,credits_consumed=$3,completed_at=NOW(),updated_at=NOW() WHERE id=$1`, [job.id, assetId, normalized.creditsConsumed], client);
    return assetId;
  });
  if (!result) return getEdit(job.workspaceId, job.siteId, job.id);
  await recordMeteredUsage({
    workspaceId: job.workspaceId, userId: job.requestedBy, provider: 'kie.ai', model: job.model,
    providerCostUsd: normalized.creditsConsumed * env.KIE_CREDIT_COST_USD,
    customerCostUsd: normalized.creditsConsumed * env.KIE_CREDIT_COST_USD * env.KIE_CUSTOMER_MARKUP_MULTIPLIER,
    responseId: normalized.taskId ?? job.providerTaskId ?? job.id,
    providerRequestId: normalized.taskId ?? job.providerTaskId ?? job.id,
    reservationId: job.reservationId,
    fundingMode: job.reservationId ? 'CUSTOMER_PREPAID' : 'PLATFORM_FUNDED',
    metadata: { operation: 'website_asset.edit', creditsConsumed: normalized.creditsConsumed },
  });
  return getEdit(job.workspaceId, job.siteId, job.id);
}
