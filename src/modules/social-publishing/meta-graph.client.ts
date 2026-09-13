import { isIP } from 'node:net';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;

export type MetaFailureKind = 'BLOCKED' | 'UNAVAILABLE' | 'TRANSIENT' | 'AMBIGUOUS';

export class MetaGraphError extends AppError {
  constructor(
    code: string,
    message: string,
    public readonly kind: MetaFailureKind,
    public readonly httpStatus: number | null = null,
    public readonly providerCode: number | null = null,
    public readonly providerRequestId: string | null = null,
  ) {
    super(kind === 'BLOCKED' ? 400 : kind === 'AMBIGUOUS' ? 409 : 503, code, message, {
      provider: 'meta',
      kind,
      ...(httpStatus === null ? {} : { providerHttpStatus: httpStatus }),
      ...(providerCode === null ? {} : { providerCode }),
      ...(providerRequestId === null ? {} : { providerRequestId }),
    });
    this.name = 'MetaGraphError';
  }

  get retryable() { return this.kind === 'TRANSIENT'; }
  get ambiguous() { return this.kind === 'AMBIGUOUS'; }
}

function graphErrorDetails(payload: JsonObject) {
  const error = payload.error && typeof payload.error === 'object'
    ? payload.error as JsonObject
    : {};
  const providerCode = Number.isFinite(Number(error.code)) ? Number(error.code) : null;
  const message = typeof error.message === 'string' ? error.message.slice(0, 1000) : 'Meta rejected the request.';
  return { providerCode, message };
}

function classifyHttpFailure(status: number, providerCode: number | null): MetaFailureKind {
  if (status === 429 || status >= 500 || [1, 2, 4, 17, 32, 341, 613].includes(providerCode ?? -1)) return 'TRANSIENT';
  if (status === 401 || providerCode === 190) return 'UNAVAILABLE';
  return 'BLOCKED';
}

export function assertSafePublicHttpsUrl(value: string, field = 'mediaUrl') {
  let url: URL;
  try { url = new URL(value); } catch { throw new MetaGraphError('SOCIAL_MEDIA_URL_INVALID', `${field} must be a valid URL.`, 'BLOCKED'); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
    throw new MetaGraphError('SOCIAL_MEDIA_URL_NOT_PUBLIC', `${field} must be a public HTTPS URL without credentials, a custom port or fragment.`, 'BLOCKED');
  }
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || isIP(hostname) !== 0) {
    throw new MetaGraphError('SOCIAL_MEDIA_URL_NOT_PUBLIC', `${field} must use a public DNS hostname.`, 'BLOCKED');
  }
  return url.toString();
}

export function assertSafePublicLinkUrl(value: string) {
  return assertSafePublicHttpsUrl(value, 'linkUrl');
}

async function jsonResponse(response: Response) {
  try {
    const value: unknown = await response.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
  } catch {
    return {};
  }
}

export function createMetaGraphClient(options: {
  fetchImpl?: FetchLike;
  graphVersion?: string;
  timeoutMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
} = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const graphVersion = options.graphVersion ?? env.META_GRAPH_VERSION;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const sleepImpl = options.sleepImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const baseUrl = `https://graph.facebook.com/${graphVersion}`;

  async function request(input: {
    path: string;
    accessToken: string;
    method?: 'GET' | 'POST';
    query?: Record<string, string>;
    form?: Record<string, string>;
    write?: boolean;
  }) {
    const url = new URL(`${baseUrl}/${input.path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, value);
    const body = input.form ? new URLSearchParams(input.form) : undefined;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: input.method ?? 'GET',
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Network request failed.';
      throw new MetaGraphError(
        input.write ? 'META_PUBLISH_RESULT_UNKNOWN' : 'META_GRAPH_UNREACHABLE',
        input.write
          ? 'Meta did not return a response. Lulu stopped to prevent a duplicate publication.'
          : `Meta could not be reached: ${message}`,
        input.write ? 'AMBIGUOUS' : 'TRANSIENT',
      );
    }
    const payload = await jsonResponse(response);
    const requestId = response.headers.get('x-fb-trace-id') ?? response.headers.get('x-fb-request-id');
    if (!response.ok || payload.error) {
      const failure = graphErrorDetails(payload);
      throw new MetaGraphError(
        `META_GRAPH_${failure.providerCode ?? response.status}`,
        failure.message,
        input.write && response.status >= 500 ? 'AMBIGUOUS' : classifyHttpFailure(response.status, failure.providerCode),
        response.status,
        failure.providerCode,
        requestId,
      );
    }
    return { payload, requestId };
  }

  async function verifyPage(input: {
    accessToken: string;
    facebookPageId: string;
    expectedInstagramBusinessAccountId?: string | null;
  }) {
    const { payload, requestId } = await request({
      path: input.facebookPageId,
      accessToken: input.accessToken,
      query: { fields: 'id,name,access_token,instagram_business_account{id,username}' },
    });
    const pageId = typeof payload.id === 'string' ? payload.id : '';
    if (pageId !== input.facebookPageId) {
      throw new MetaGraphError('META_PAGE_ID_MISMATCH', 'Meta returned a different Facebook Page than requested.', 'BLOCKED', null, null, requestId);
    }
    const pageAccessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
    if (!pageAccessToken) throw new MetaGraphError('META_PAGE_TOKEN_MISSING', 'Meta did not provide a Page access token for this connection.', 'UNAVAILABLE', null, null, requestId);
    const instagram = payload.instagram_business_account && typeof payload.instagram_business_account === 'object'
      ? payload.instagram_business_account as JsonObject
      : null;
    const instagramId = typeof instagram?.id === 'string' ? instagram.id : null;
    if (input.expectedInstagramBusinessAccountId && instagramId !== input.expectedInstagramBusinessAccountId) {
      throw new MetaGraphError('META_INSTAGRAM_ACCOUNT_MISMATCH', 'The requested Instagram Business account is not connected to this Facebook Page.', 'BLOCKED', null, null, requestId);
    }
    return {
      pageId,
      pageName: typeof payload.name === 'string' ? payload.name : null,
      pageAccessToken,
      instagramBusinessAccountId: instagramId,
      instagramUsername: typeof instagram?.username === 'string' ? instagram.username : null,
      providerRequestId: requestId,
    };
  }

  async function publishFacebook(input: {
    pageAccessToken: string;
    facebookPageId: string;
    contentType: 'TEXT' | 'LINK' | 'IMAGE';
    message: string;
    linkUrl?: string | null;
    mediaUrl?: string | null;
  }) {
    const isImage = input.contentType === 'IMAGE';
    const path = `${input.facebookPageId}/${isImage ? 'photos' : 'feed'}`;
    const form: Record<string, string> = isImage
      ? { url: assertSafePublicHttpsUrl(String(input.mediaUrl ?? '')), caption: input.message, published: 'true' }
      : { message: input.message };
    if (input.contentType === 'LINK') form.link = assertSafePublicLinkUrl(String(input.linkUrl ?? ''));
    const { payload, requestId } = await request({ path, accessToken: input.pageAccessToken, method: 'POST', form, write: true });
    const id = typeof payload.post_id === 'string' ? payload.post_id : typeof payload.id === 'string' ? payload.id : '';
    if (!id) throw new MetaGraphError('META_PUBLICATION_ID_MISSING', 'Meta accepted the request without returning a publication id.', 'AMBIGUOUS', null, null, requestId);
    return { providerPublicationId: id, providerRequestId: requestId };
  }

  async function publishInstagramImage(input: {
    pageAccessToken: string;
    instagramBusinessAccountId: string;
    message: string;
    mediaUrl: string;
  }) {
    const mediaUrl = assertSafePublicHttpsUrl(input.mediaUrl);
    const container = await request({
      path: `${input.instagramBusinessAccountId}/media`,
      accessToken: input.pageAccessToken,
      method: 'POST',
      form: { image_url: mediaUrl, caption: input.message },
      write: true,
    });
    const containerId = typeof container.payload.id === 'string' ? container.payload.id : '';
    if (!containerId) throw new MetaGraphError('META_CONTAINER_ID_MISSING', 'Meta did not return an Instagram media container id.', 'AMBIGUOUS', null, null, container.requestId);

    let ready = false;
    for (let poll = 0; poll < 5; poll += 1) {
      const status = await request({ path: containerId, accessToken: input.pageAccessToken, query: { fields: 'status_code,status' } });
      const code = typeof status.payload.status_code === 'string' ? status.payload.status_code : '';
      if (code === 'FINISHED') { ready = true; break; }
      if (code === 'ERROR' || code === 'EXPIRED') {
        throw new MetaGraphError('META_MEDIA_UNAVAILABLE', 'Meta could not retrieve or process the Instagram image.', 'BLOCKED', null, null, status.requestId);
      }
      if (poll < 4) await sleepImpl(500 * (poll + 1));
    }
    if (!ready) throw new MetaGraphError('META_MEDIA_PROCESSING_TIMEOUT', 'Instagram media is still processing; the job can be retried safely before publishing.', 'TRANSIENT');

    const published = await request({
      path: `${input.instagramBusinessAccountId}/media_publish`,
      accessToken: input.pageAccessToken,
      method: 'POST',
      form: { creation_id: containerId },
      write: true,
    });
    const id = typeof published.payload.id === 'string' ? published.payload.id : '';
    if (!id) throw new MetaGraphError('META_PUBLICATION_ID_MISSING', 'Meta accepted the request without returning a publication id.', 'AMBIGUOUS', null, null, published.requestId);
    return { providerPublicationId: id, providerRequestId: published.requestId, containerId };
  }

  return { verifyPage, publishFacebook, publishInstagramImage };
}

export type MetaGraphClient = ReturnType<typeof createMetaGraphClient>;
