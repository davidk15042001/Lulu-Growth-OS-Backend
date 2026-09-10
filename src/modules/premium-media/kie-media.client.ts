import { env, hasKie } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';

type JsonRecord = Record<string, unknown>;

export type NormalizedKieTask = {
  taskId: string | null;
  state: 'pending' | 'success' | 'failed';
  resultUrls: string[];
  creditsConsumed: number;
  errorCode: string | null;
  errorMessage: string | null;
  payload: JsonRecord;
};

export type MediaQualityReport = {
  score: number;
  accepted: boolean;
  summary: string;
  hardFailures: string[];
  metrics: {
    productIdentity: number;
    logoAndText: number;
    geometry: number;
    artifacts: number;
    commercialReadiness: number;
  };
  model: string;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function parseJsonRecord(value: unknown): JsonRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
  if (typeof value !== 'string') return {};
  try { return asRecord(JSON.parse(value)); } catch { return {}; }
}

function collectUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && /^https:\/\//i.test(item)))];
}

export function normalizeKieTask(payload: unknown): NormalizedKieTask {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const info = asRecord(data.info);
  const response = asRecord(data.response);
  const resultJson = parseJsonRecord(data.resultJson ?? root.resultJson);
  const taskId = stringValue(data.taskId ?? data.task_id ?? root.taskId ?? root.task_id);
  const resultUrls = [
    ...collectUrls(info.resultUrls ?? info.result_urls),
    ...collectUrls(response.resultUrls ?? response.result_urls ?? response.fullResultUrls),
    ...collectUrls(data.resultUrls ?? data.result_urls),
    ...collectUrls(resultJson.resultUrls ?? resultJson.result_urls),
    ...collectUrls(root.resultUrls ?? root.result_urls),
  ].filter((value, index, values) => values.indexOf(value) === index);

  const stateText = String(data.state ?? root.state ?? '').toLowerCase();
  const successFlag = Number(data.successFlag ?? root.successFlag);
  const code = Number(root.code);
  const explicitFailure = ['fail', 'failed', 'error'].includes(stateText)
    || successFlag === 2
    || successFlag === 3
    || (Number.isFinite(code) && code >= 400 && code !== 505);
  const explicitSuccess = stateText === 'success' || successFlag === 1 || (code === 200 && resultUrls.length > 0);
  const errorCode = stringValue(data.failCode ?? data.errorCode ?? root.errorCode ?? root.code);
  const errorMessage = stringValue(data.failMsg ?? data.errorMessage ?? root.errorMessage ?? root.msg);

  return {
    taskId,
    state: explicitFailure ? 'failed' : explicitSuccess ? 'success' : 'pending',
    resultUrls,
    creditsConsumed: numberValue(data.creditsConsumed ?? data.credits_consumed ?? root.creditsConsumed ?? root.credits_consumed),
    errorCode: explicitFailure ? errorCode : null,
    errorMessage: explicitFailure ? errorMessage : null,
    payload: root,
  };
}

function configuredKey(): string {
  if (!hasKie || !env.KIE_API_KEY) {
    throw new AppError(503, 'KIE_NOT_CONFIGURED', 'Premium media generation requires KIE_API_KEY on the server');
  }
  return env.KIE_API_KEY;
}

async function pause(delayMs: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function requestJson(
  url: URL,
  init: RequestInit = {},
  options: { retries?: number; timeoutMs?: number } = {},
): Promise<JsonRecord> {
  const retries = options.retries ?? env.AI_MAX_RETRIES;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${configuredKey()}`,
          Accept: 'application/json',
          ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? env.AI_REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      let body: JsonRecord = {};
      try { body = asRecord(text ? JSON.parse(text) : {}); } catch { body = { raw: text.slice(0, 2_000) }; }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < retries) {
          await pause(250 * (2 ** attempt));
          continue;
        }
        const code = response.status === 402 ? 'KIE_CREDITS_REQUIRED' : 'KIE_REQUEST_FAILED';
        throw new AppError(response.status === 402 ? 503 : 502, code, 'Kie.ai rejected the premium media request', {
          providerStatus: response.status,
          providerCode: body.code ?? null,
          providerMessage: body.msg ?? null,
        });
      }
      return body;
    } catch (error) {
      if (error instanceof AppError) throw error;
      lastError = error;
      if (attempt < retries) {
        await pause(250 * (2 ** attempt));
        continue;
      }
    }
  }
  throw new AppError(502, 'KIE_NETWORK_ERROR', 'Kie.ai could not be reached', {
    reason: lastError instanceof Error ? lastError.message : 'Unknown provider error',
  });
}

function apiUrl(path: string, baseUrl = env.KIE_BASE_URL) {
  return new URL(path, `${baseUrl.replace(/\/$/, '')}/`);
}

export function getPremiumImageModels() {
  return premiumModels(env.KIE_PREMIUM_IMAGE_MODELS, 'image');
}

export function getPremiumTextImageModels() {
  return premiumModels(env.KIE_PREMIUM_TEXT_IMAGE_MODELS, 'text-to-image');
}

export function getPremiumVideoModels() {
  return premiumModels(env.KIE_PREMIUM_VIDEO_MODELS, 'video');
}

function premiumModels(value: string, mediaType: string) {
  const models = [...new Set(value.split(',').map((model) => model.trim()).filter(Boolean))];
  if (!models.length) throw new AppError(503, 'KIE_PREMIUM_MODELS_MISSING', `No premium ${mediaType} models are configured`);
  const approvedTurboModels = new Set(['kling/v3-turbo-image-to-video']);
  const nonPremium = models.find((model) => (
    /(?:^|[-_/])(fast|lite|turbo|standard)(?:$|[-_/])/i.test(model)
    && !approvedTurboModels.has(model.toLowerCase())
  ));
  if (nonPremium) {
    throw new AppError(503, 'KIE_NON_PREMIUM_MODEL_BLOCKED', `Non-premium model is not allowed: ${nonPremium}`);
  }
  return models;
}

export function isKieMediaConfigured() {
  return hasKie;
}

export async function getKieCredits(): Promise<number> {
  const payload = await requestJson(apiUrl('/api/v1/chat/credit'), { method: 'GET' });
  return numberValue(payload.data);
}

export async function uploadReferenceFile(input: { buffer: Buffer; mimeType: string; fileName: string }) {
  const payload = await requestJson(
    apiUrl('/api/file-base64-upload', env.KIE_UPLOAD_BASE_URL),
    {
      method: 'POST',
      body: JSON.stringify({
        base64Data: `data:${input.mimeType};base64,${input.buffer.toString('base64')}`,
        uploadPath: 'lulu/product-references',
        fileName: input.fileName,
      }),
    },
  );
  const data = asRecord(payload.data);
  const url = stringValue(data.downloadUrl ?? data.fileUrl);
  if (!url) throw new AppError(502, 'KIE_UPLOAD_EMPTY', 'Kie.ai did not return a reference URL');
  return url;
}

export async function uploadReferenceUrl(sourceUrl: string, fileName: string) {
  const payload = await requestJson(
    apiUrl('/api/file-url-upload', env.KIE_UPLOAD_BASE_URL),
    {
      method: 'POST',
      body: JSON.stringify({ fileUrl: sourceUrl, uploadPath: 'lulu/product-references', fileName }),
    },
  );
  const data = asRecord(payload.data);
  const url = stringValue(data.downloadUrl ?? data.fileUrl);
  if (!url) throw new AppError(502, 'KIE_UPLOAD_EMPTY', 'Kie.ai did not return a reference URL');
  return url;
}

export async function createMarketTask(input: {
  model: string;
  callbackUrl: string;
  parameters: JsonRecord;
}) {
  const payload = await requestJson(apiUrl('/api/v1/jobs/createTask'), {
    method: 'POST',
    body: JSON.stringify({ model: input.model, callBackUrl: input.callbackUrl, input: input.parameters }),
  });
  const task = normalizeKieTask(payload);
  if (!task.taskId) throw new AppError(502, 'KIE_TASK_ID_MISSING', 'Kie.ai did not return a task ID');
  return { taskId: task.taskId, payload };
}

export async function createVeoTask(input: {
  prompt: string;
  imageUrls: string[];
  callbackUrl: string;
  aspectRatio: '16:9' | '9:16';
}) {
  const payload = await requestJson(apiUrl('/api/v1/veo/generate'), {
    method: 'POST',
    body: JSON.stringify({
      prompt: input.prompt,
      imageUrls: input.imageUrls.slice(0, 3),
      model: 'veo3',
      callBackUrl: input.callbackUrl,
      aspect_ratio: input.aspectRatio,
      enableFallback: false,
      enableTranslation: true,
      generationType: 'FIRST_AND_LAST_FRAMES_2_VIDEO',
    }),
  });
  const task = normalizeKieTask(payload);
  if (!task.taskId) throw new AppError(502, 'KIE_TASK_ID_MISSING', 'Kie.ai did not return a Veo task ID');
  return { taskId: task.taskId, payload };
}

export async function getKieTask(providerApi: 'MARKET' | 'VEO', taskId: string) {
  const path = providerApi === 'VEO' ? '/api/v1/veo/record-info' : '/api/v1/jobs/recordInfo';
  const url = apiUrl(path);
  url.searchParams.set('taskId', taskId);
  return normalizeKieTask(await requestJson(url, { method: 'GET' }));
}

function clampScore(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
}

function extractAssistantText(payload: JsonRecord) {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const message = asRecord(asRecord(choices[0]).message);
  return stringValue(message.content) ?? '';
}

function parseQualityJson(text: string) {
  const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
  try { return asRecord(JSON.parse(candidate)); } catch {
    throw new AppError(502, 'KIE_QUALITY_RESPONSE_INVALID', 'The premium quality auditor returned invalid JSON');
  }
}

export async function evaluateMediaQuality(input: {
  mediaType: 'IMAGE' | 'VIDEO';
  productName: string;
  productDescription: string;
  prompt: string;
  referenceUrls: string[];
  candidateUrl: string;
  threshold: number;
}) {
  const content: JsonRecord[] = [{
    type: 'text',
    text: [
      'Act as a strict premium commercial product-media quality auditor.',
      `Product: ${input.productName}`,
      `Description: ${input.productDescription}`,
      `Intended creative direction: ${input.prompt}`,
      input.referenceUrls.length
        ? `The first ${input.referenceUrls.length} media items are authoritative product references. The last item is the generated ${input.mediaType.toLowerCase()} candidate.`
        : `No visual reference exists for this new product concept. Judge the generated ${input.mediaType.toLowerCase()} candidate against the product brief and require a coherent, repeatable product identity.`,
      'Reject any changed logo, label text, product geometry, color, material, missing part, added product feature, visible artifact, watermark, low resolution, unsafe content, or result that is not globally campaign-ready.',
      'Return JSON only with score, summary, hardFailures, and metrics.productIdentity/logoAndText/geometry/artifacts/commercialReadiness. Every score is 0-100.',
    ].join('\n'),
  }];
  for (const url of input.referenceUrls) content.push({ type: 'image_url', image_url: { url } });
  content.push({ type: 'text', text: `Generated ${input.mediaType.toLowerCase()} candidate follows:` });
  content.push({ type: 'image_url', image_url: { url: input.candidateUrl } });

  const payload = await requestJson(apiUrl(env.KIE_QUALITY_MODEL_PATH), {
    method: 'POST',
    body: JSON.stringify({
      model: env.KIE_QUALITY_MODEL,
      stream: false,
      reasoning_effort: 'high',
      messages: [
        { role: 'system', content: 'You are Lulu\'s independent premium media quality gate. Never approve uncertainty. Output valid JSON only.' },
        { role: 'user', content },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'premium_media_quality',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['score', 'summary', 'hardFailures', 'metrics'],
            properties: {
              score: { type: 'integer', minimum: 0, maximum: 100 },
              summary: { type: 'string' },
              hardFailures: { type: 'array', items: { type: 'string' } },
              metrics: {
                type: 'object',
                additionalProperties: false,
                required: ['productIdentity', 'logoAndText', 'geometry', 'artifacts', 'commercialReadiness'],
                properties: {
                  productIdentity: { type: 'integer', minimum: 0, maximum: 100 },
                  logoAndText: { type: 'integer', minimum: 0, maximum: 100 },
                  geometry: { type: 'integer', minimum: 0, maximum: 100 },
                  artifacts: { type: 'integer', minimum: 0, maximum: 100 },
                  commercialReadiness: { type: 'integer', minimum: 0, maximum: 100 },
                },
              },
            },
          },
        },
      },
    }),
  }, { retries: 1 });
  const parsed = parseQualityJson(extractAssistantText(payload));
  const metricsRaw = asRecord(parsed.metrics);
  const hardFailures = Array.isArray(parsed.hardFailures)
    ? parsed.hardFailures.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : [];
  const metrics = {
    productIdentity: clampScore(metricsRaw.productIdentity),
    logoAndText: clampScore(metricsRaw.logoAndText),
    geometry: clampScore(metricsRaw.geometry),
    artifacts: clampScore(metricsRaw.artifacts),
    commercialReadiness: clampScore(metricsRaw.commercialReadiness),
  };
  const score = clampScore(parsed.score);
  const accepted = hardFailures.length === 0
    && score >= input.threshold
    && metrics.productIdentity >= input.threshold
    && metrics.logoAndText >= input.threshold
    && metrics.geometry >= input.threshold;
  const report: MediaQualityReport = {
    score,
    accepted,
    summary: stringValue(parsed.summary) ?? 'No quality summary returned',
    hardFailures,
    metrics,
    model: env.KIE_QUALITY_MODEL,
  };
  const responseId = stringValue(payload.id);
  const creditsConsumed = numberValue(payload.credits_consumed ?? payload.creditsConsumed);
  return { report, responseId, creditsConsumed };
}

function allowedDownloadHost(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return env.KIE_MEDIA_ALLOWED_DOWNLOAD_HOSTS
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean)
    .some((host) => normalized === host || normalized.endsWith(`.${host}`));
}

async function readBodyWithLimit(response: Response, maxBytes: number) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AppError(413, 'KIE_MEDIA_TOO_LARGE', 'Generated media exceeds the configured download limit');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new AppError(413, 'KIE_MEDIA_TOO_LARGE', 'Generated media exceeds the configured download limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export async function downloadGeneratedMedia(originalUrl: string, mediaType: 'IMAGE' | 'VIDEO') {
  const resolved = await requestJson(apiUrl('/api/v1/common/download-url'), {
    method: 'POST',
    body: JSON.stringify({ url: originalUrl }),
  });
  const downloadUrl = stringValue(resolved.data);
  if (!downloadUrl) throw new AppError(502, 'KIE_DOWNLOAD_URL_MISSING', 'Kie.ai did not return a secure media download URL');
  const parsed = new URL(downloadUrl);
  if (parsed.protocol !== 'https:' || !allowedDownloadHost(parsed.hostname)) {
    throw new AppError(502, 'KIE_DOWNLOAD_HOST_REJECTED', 'Kie.ai returned an untrusted media download host');
  }
  const response = await fetch(parsed, { redirect: 'error', signal: AbortSignal.timeout(env.AI_REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new AppError(502, 'KIE_MEDIA_DOWNLOAD_FAILED', 'Generated media could not be downloaded from Kie.ai');
  const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() || '';
  const validMime = mediaType === 'IMAGE' ? mimeType.startsWith('image/') : mimeType.startsWith('video/');
  if (!validMime) throw new AppError(502, 'KIE_MEDIA_TYPE_INVALID', `Kie.ai returned an invalid ${mediaType.toLowerCase()} content type`);
  const buffer = await readBodyWithLimit(response, env.KIE_MEDIA_MAX_DOWNLOAD_MB * 1024 * 1024);
  if (!buffer.length) throw new AppError(502, 'KIE_MEDIA_DOWNLOAD_EMPTY', 'Kie.ai returned an empty media file');
  return { buffer, mimeType };
}

export function extensionForMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'video/webm') return 'webm';
  if (normalized === 'video/quicktime') return 'mov';
  if (normalized === 'video/mp4') return 'mp4';
  return normalized.startsWith('image/') ? 'img' : normalized.startsWith('video/') ? 'mp4' : 'bin';
}
