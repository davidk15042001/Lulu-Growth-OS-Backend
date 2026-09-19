import { createHash } from 'node:crypto';
import { decryptSecret } from '../../utils/secret-box.js';
import { AppError } from '../../utils/app-error.js';
import {
  assertSafePublicHttpsUrl,
  assertSafePublicLinkUrl,
  createMetaGraphClient,
  MetaGraphError,
} from './meta-graph.client.js';
import * as repo from './social-publishing.repo.js';
import type {
  ClaimedSocialPublication,
  SocialActorType,
  SocialContent,
  SocialContentStatus,
  SocialContentType,
  SocialProvider,
  SocialProviderContext,
} from './social-publishing.types.js';
import { assertWorkspaceAutomationActive } from '../workspaces/workspace-automation.service.js';

type MetaClient = ReturnType<typeof createMetaGraphClient>;

const REQUIRED_SCOPES: Record<SocialProvider, readonly string[]> = {
  FACEBOOK: ['pages_manage_posts', 'pages_read_engagement'],
  INSTAGRAM: ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement'],
};

const CAPABILITY: Record<SocialProvider, string> = {
  FACEBOOK: 'facebook.pages.publish',
  INSTAGRAM: 'instagram.content.publish',
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

function fingerprint(value: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function notFound(code: string, message: string) { return new AppError(404, code, message); }
function conflict(code: string, message: string, details?: Record<string, unknown>) { return new AppError(409, code, message, details); }

function assertContentShape(input: {
  contentType: SocialContentType;
  message: string;
  linkUrl: string | null;
  mediaUrl: string | null;
}) {
  if (input.contentType === 'TEXT') {
    if (!input.message.trim() || input.linkUrl || input.mediaUrl) throw new AppError(400, 'SOCIAL_CONTENT_INVALID', 'Text content requires a message and cannot include link or media URLs.');
  } else if (input.contentType === 'LINK') {
    if (!input.message.trim() || !input.linkUrl || input.mediaUrl) throw new AppError(400, 'SOCIAL_CONTENT_INVALID', 'Link content requires a message and one public HTTPS link URL.');
    assertSafePublicLinkUrl(input.linkUrl);
  } else {
    if (!input.mediaUrl || input.linkUrl) throw new AppError(400, 'SOCIAL_CONTENT_INVALID', 'Image content requires one public HTTPS media URL and cannot include a link URL.');
    assertSafePublicHttpsUrl(input.mediaUrl);
  }
}

function providerConnectionIssue(context: SocialProviderContext | null, provider: SocialProvider) {
  if (!context) return { code: 'SOCIAL_PROVIDER_CONNECTION_UNAVAILABLE', message: 'The provider connection is not available to this workspace.' };
  if (context.providerKey !== provider.toLowerCase()) return { code: 'SOCIAL_PROVIDER_MISMATCH', message: 'The social account does not match its provider connection.' };
  if (context.connectionStatus !== 'CONNECTED' || context.authorizationState !== 'AUTHORIZED') return { code: 'SOCIAL_PROVIDER_NOT_CONNECTED', message: 'The provider connection is not connected and authorized.' };
  if (!context.encryptedAccessToken || !context.credentialStatus || !['connected','CONNECTED'].includes(context.credentialStatus)) return { code: 'SOCIAL_PROVIDER_CREDENTIAL_UNAVAILABLE', message: 'The provider credential is unavailable.' };
  if (context.tokenExpiresAt && new Date(context.tokenExpiresAt).getTime() <= Date.now() + 60_000) return { code: 'SOCIAL_PROVIDER_TOKEN_EXPIRED', message: 'The provider access token has expired and must be reauthorized.' };
  const missingScopes = REQUIRED_SCOPES[provider].filter((scope) => !context.grantedScopes.includes(scope));
  if (missingScopes.length > 0) return { code: 'SOCIAL_PROVIDER_SCOPE_MISSING', message: `The provider connection is missing required scopes: ${missingScopes.join(', ')}.` };
  if (context.sharedGrantedCapabilities && !context.sharedGrantedCapabilities.includes(CAPABILITY[provider])) return { code: 'SOCIAL_PROVIDER_CAPABILITY_NOT_GRANTED', message: 'This shared provider connection has not granted social publishing to the workspace.' };
  return null;
}

async function providerContext(workspaceId: string, connectionId: string, provider: SocialProvider) {
  const context = await repo.getSocialProviderContext(workspaceId, connectionId);
  const issue = providerConnectionIssue(context, provider);
  return { context, issue };
}

function tokenFrom(context: SocialProviderContext) {
  try { return decryptSecret(context.encryptedAccessToken!); }
  catch { throw new MetaGraphError('SOCIAL_PROVIDER_CREDENTIAL_INVALID', 'The provider credential could not be decrypted.', 'UNAVAILABLE'); }
}

export async function listAccounts(workspaceId: string) { return repo.listAccounts(workspaceId); }
export async function getAccount(workspaceId: string, accountId: string) {
  const account = await repo.getAccount(workspaceId, accountId);
  if (!account) throw notFound('SOCIAL_ACCOUNT_NOT_FOUND', 'The social account was not found.');
  return account;
}

export async function createAccount(input: {
  workspaceId: string;
  actorId: string;
  providerConnectionId: string;
  provider: SocialProvider;
  displayName: string;
  facebookPageId: string;
  instagramBusinessAccountId: string | null;
  idempotencyKey: string;
}) {
  const { context } = await providerContext(input.workspaceId, input.providerConnectionId, input.provider);
  if (!context) throw notFound('SOCIAL_PROVIDER_CONNECTION_NOT_FOUND', 'The social provider connection was not found in this workspace.');
  const requestFingerprint = fingerprint({ providerConnectionId: input.providerConnectionId, provider: input.provider, displayName: input.displayName, facebookPageId: input.facebookPageId, instagramBusinessAccountId: input.instagramBusinessAccountId });
  const result = await repo.createAccount({ ...input, requestFingerprint });
  if (result.identityConflict) throw conflict('SOCIAL_ACCOUNT_ALREADY_EXISTS', 'This Facebook Page or Instagram Business account is already configured in the workspace.', { accountId: result.account.id });
  if (!result.fingerprintMatches) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with different social account data.');
  return result;
}

export async function verifyAccount(input: {
  workspaceId: string;
  accountId: string;
  actorId: string;
  expectedVersion: number;
  graphClient?: MetaClient;
}) {
  const account = await repo.getAccount(input.workspaceId, input.accountId);
  if (!account) throw notFound('SOCIAL_ACCOUNT_NOT_FOUND', 'The social account was not found.');
  if (account.version !== input.expectedVersion) throw conflict('SOCIAL_VERSION_CONFLICT', 'The social account changed. Reload it before retrying.', { currentVersion: account.version });
  const { context, issue } = await providerContext(account.workspaceId, account.providerConnectionId, account.provider);
  if (issue || !context) {
    const result = await repo.updateAccountVerification({ workspaceId: account.workspaceId, accountId: account.id, actorId: input.actorId, expectedVersion: input.expectedVersion, status: 'UNAVAILABLE', statusReason: issue?.message ?? 'Provider connection unavailable.', errorCode: issue?.code ?? 'SOCIAL_PROVIDER_CONNECTION_UNAVAILABLE', errorMessage: issue?.message ?? 'Provider connection unavailable.' });
    if (result.conflict) throw conflict('SOCIAL_VERSION_CONFLICT', 'The social account changed. Reload it before retrying.');
    return result.account;
  }
  try {
    const verified = await (input.graphClient ?? createMetaGraphClient()).verifyPage({
      accessToken: tokenFrom(context),
      facebookPageId: account.facebookPageId,
      ...(account.provider === 'INSTAGRAM' ? { expectedInstagramBusinessAccountId: account.instagramBusinessAccountId } : {}),
    });
    const result = await repo.updateAccountVerification({
      workspaceId: account.workspaceId,
      accountId: account.id,
      actorId: input.actorId,
      expectedVersion: input.expectedVersion,
      status: 'AVAILABLE',
      statusReason: 'Provider identity and publishing credential verified.',
      ...(verified.pageName ? { displayName: verified.pageName } : {}),
      providerUsername: account.provider === 'INSTAGRAM' ? verified.instagramUsername : null,
      errorCode: null,
      errorMessage: null,
    });
    if (result.conflict) throw conflict('SOCIAL_VERSION_CONFLICT', 'The social account changed during verification. Reload it before retrying.');
    return result.account;
  } catch (error) {
    if (!(error instanceof MetaGraphError)) throw error;
    const status = error.kind === 'UNAVAILABLE' ? 'UNAVAILABLE' as const : 'BLOCKED' as const;
    const result = await repo.updateAccountVerification({ workspaceId: account.workspaceId, accountId: account.id, actorId: input.actorId, expectedVersion: input.expectedVersion, status, statusReason: error.message, errorCode: error.code, errorMessage: error.message });
    if (result.conflict) throw conflict('SOCIAL_VERSION_CONFLICT', 'The social account changed during verification. Reload it before retrying.');
    return result.account;
  }
}

export async function listContent(workspaceId: string, status?: SocialContentStatus) { return repo.listContent(workspaceId, status); }
export async function getContent(workspaceId: string, contentId: string) {
  const content = await repo.getContent(workspaceId, contentId);
  if (!content) throw notFound('SOCIAL_CONTENT_NOT_FOUND', 'The social content was not found.');
  return content;
}

export async function createContent(input: {
  workspaceId: string;
  actorId: string | null;
  actorType: SocialActorType;
  actorRef: string | null;
  contentType: SocialContentType;
  status: SocialContentStatus;
  message: string;
  linkUrl: string | null;
  mediaUrl: string | null;
  altText: string | null;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
}) {
  assertContentShape(input);
  const requestFingerprint = fingerprint({ contentType: input.contentType, status: input.status, message: input.message, linkUrl: input.linkUrl, mediaUrl: input.mediaUrl, altText: input.altText, metadata: input.metadata });
  const result = await repo.createContent({ ...input, requestFingerprint });
  if (!result.fingerprintMatches) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with different social content.');
  return result;
}

export async function updateContent(input: {
  workspaceId: string;
  contentId: string;
  actorId: string;
  expectedVersion: number;
  status?: SocialContentStatus;
  message?: string;
  linkUrl?: string | null;
  mediaUrl?: string | null;
  altText?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const current = await repo.getContent(input.workspaceId, input.contentId);
  if (!current) throw notFound('SOCIAL_CONTENT_NOT_FOUND', 'The social content was not found.');
  assertContentShape({ contentType: current.contentType, message: input.message ?? current.message, linkUrl: input.linkUrl === undefined ? current.linkUrl : input.linkUrl, mediaUrl: input.mediaUrl === undefined ? current.mediaUrl : input.mediaUrl });
  const result = await repo.updateContent(input);
  if (result.inUse) throw conflict('SOCIAL_CONTENT_IMMUTABLE', 'Content cannot be changed after a publication has been queued. Create a new content version instead.');
  if (result.conflict) throw conflict('SOCIAL_VERSION_CONFLICT', 'The social content changed. Reload it before retrying.', { currentVersion: current.version });
  if (!result.content) throw notFound('SOCIAL_CONTENT_NOT_FOUND', 'The social content was not found.');
  return result.content;
}

function publicationIssue(account: Awaited<ReturnType<typeof repo.getAccount>>, content: SocialContent | null) {
  if (!account) return { code: 'SOCIAL_ACCOUNT_NOT_FOUND', message: 'The social account was not found.' };
  if (!content) return { code: 'SOCIAL_CONTENT_NOT_FOUND', message: 'The social content was not found.' };
  if (account.status !== 'AVAILABLE') return { code: 'SOCIAL_ACCOUNT_NOT_AVAILABLE', message: `The social account is ${account.status.toLowerCase()}: ${account.statusReason}` };
  if (content.status !== 'READY') return { code: 'SOCIAL_CONTENT_NOT_READY', message: 'Only ready social content can be published.' };
  if (account.provider === 'INSTAGRAM' && content.contentType !== 'IMAGE') return { code: 'SOCIAL_MEDIA_UNSUPPORTED', message: 'Instagram publishing currently supports verified single-image content only.' };
  if (account.provider === 'INSTAGRAM' && content.message.length > 2200) return { code: 'SOCIAL_INSTAGRAM_CAPTION_TOO_LONG', message: 'Instagram captions cannot exceed 2,200 characters.' };
  try { assertContentShape(content); } catch (error) { return { code: error instanceof MetaGraphError ? error.code : 'SOCIAL_CONTENT_INVALID', message: error instanceof Error ? error.message : 'Social content is invalid.' }; }
  return null;
}

async function runtimePublicationIssue(account: NonNullable<Awaited<ReturnType<typeof repo.getAccount>>>, content: SocialContent) {
  const issue = publicationIssue(account, content);
  if (issue) return { issue, context: null };
  const provider = await providerContext(account.workspaceId, account.providerConnectionId, account.provider);
  return { issue: provider.issue, context: provider.context };
}

export async function listPublicationJobs(workspaceId: string, status?: Parameters<typeof repo.listPublicationJobs>[1]) { return repo.listPublicationJobs(workspaceId, status); }
export async function getPublicationJob(workspaceId: string, jobId: string) {
  const job = await repo.getPublicationJob(workspaceId, jobId);
  if (!job) throw notFound('SOCIAL_PUBLICATION_NOT_FOUND', 'The social publication was not found.');
  return job;
}

export async function createPublication(input: {
  workspaceId: string;
  actorId: string | null;
  actorType: SocialActorType;
  actorRef: string | null;
  socialAccountId: string;
  contentId: string;
  execution: 'DRAFT' | 'QUEUE';
  scheduledAt: string | null;
  maxAttempts: number;
  idempotencyKey: string;
}) {
  await assertWorkspaceAutomationActive(input.workspaceId);
  const [account, content] = await Promise.all([
    repo.getAccount(input.workspaceId, input.socialAccountId),
    repo.getContent(input.workspaceId, input.contentId),
  ]);
  if (!account) throw notFound('SOCIAL_ACCOUNT_NOT_FOUND', 'The social account was not found.');
  if (!content) throw notFound('SOCIAL_CONTENT_NOT_FOUND', 'The social content was not found.');
  let issue = publicationIssue(account, content);
  if (!issue && input.execution === 'QUEUE') issue = (await providerContext(input.workspaceId, account.providerConnectionId, account.provider)).issue;
  const isFuture = input.scheduledAt ? new Date(input.scheduledAt).getTime() > Date.now() : false;
  const status = input.execution === 'DRAFT'
    ? 'DRAFT' as const
    : issue
      ? 'BLOCKED' as const
      : isFuture
        ? 'SCHEDULED' as const
        : 'QUEUED' as const;
  const requestFingerprint = fingerprint({ socialAccountId: input.socialAccountId, contentId: input.contentId, execution: input.execution, scheduledAt: input.scheduledAt, maxAttempts: input.maxAttempts });
  const result = await repo.createPublicationJob({ ...input, status, requestFingerprint, blockCode: issue?.code ?? null, blockMessage: issue?.message ?? null });
  if (!result.fingerprintMatches) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with a different social publication.');
  return result;
}

export async function transitionPublication(input: {
  workspaceId: string;
  jobId: string;
  actorId: string;
  actorType: SocialActorType;
  actorRef: string | null;
  expectedVersion: number;
  action: 'QUEUE' | 'CANCEL' | 'RETRY';
  scheduledAt?: string | null;
}) {
  if (input.action !== 'CANCEL') await assertWorkspaceAutomationActive(input.workspaceId);
  if (input.action !== 'CANCEL') {
    const job = await getPublicationJob(input.workspaceId, input.jobId);
    if (!job.account || !job.content) throw conflict('SOCIAL_PUBLICATION_BROKEN_REFERENCE', 'The publication no longer has its canonical account or content.');
    const runtime = await runtimePublicationIssue(job.account, job.content);
    if (runtime.issue) throw conflict(runtime.issue.code, runtime.issue.message);
  }
  const result = await repo.transitionPublicationJob(input);
  if (result.conflict) throw conflict('SOCIAL_VERSION_CONFLICT', 'The social publication changed. Reload it before retrying.');
  if (result.invalidState) throw conflict('SOCIAL_PUBLICATION_STATE_INVALID', `The requested ${input.action.toLowerCase()} transition is not allowed from the current state.`);
  if (!result.job) throw notFound('SOCIAL_PUBLICATION_NOT_FOUND', 'The social publication was not found.');
  return result.job;
}

function retryDelayMs(attempt: number) { return Math.min(15 * 60_000, 2_000 * (2 ** Math.max(0, attempt - 1))); }

export async function processClaimedPublication(job: ClaimedSocialPublication, options: { graphClient?: MetaClient } = {}) {
  await assertWorkspaceAutomationActive(job.workspaceId);
  const runtime = await runtimePublicationIssue(job.account, job.content);
  if (runtime.issue || !runtime.context) {
    return repo.failPublication({ job, status: 'BLOCKED', attemptStatus: 'BLOCKED', code: runtime.issue?.code ?? 'SOCIAL_PROVIDER_UNAVAILABLE', message: runtime.issue?.message ?? 'The provider is unavailable.' });
  }
  const graphClient = options.graphClient ?? createMetaGraphClient();
  try {
    const verified = await graphClient.verifyPage({
      accessToken: tokenFrom(runtime.context),
      facebookPageId: job.account.facebookPageId,
      ...(job.account.provider === 'INSTAGRAM' ? { expectedInstagramBusinessAccountId: job.account.instagramBusinessAccountId } : {}),
    });
    const result = job.account.provider === 'FACEBOOK'
      ? await graphClient.publishFacebook({
          pageAccessToken: verified.pageAccessToken,
          facebookPageId: job.account.facebookPageId,
          contentType: job.content.contentType,
          message: job.content.message,
          linkUrl: job.content.linkUrl,
          mediaUrl: job.content.mediaUrl,
        })
      : await graphClient.publishInstagramImage({
          pageAccessToken: verified.pageAccessToken,
          instagramBusinessAccountId: job.account.instagramBusinessAccountId!,
          message: job.content.message,
          mediaUrl: job.content.mediaUrl!,
        });
    return repo.completePublication({ job, providerPublicationId: result.providerPublicationId, providerPermalink: null, providerRequestId: result.providerRequestId, responseSummary: { provider: job.account.provider, providerPublicationId: result.providerPublicationId } });
  } catch (error) {
    const failure = error instanceof MetaGraphError
      ? error
      : new MetaGraphError('SOCIAL_PROVIDER_FAILURE', error instanceof Error ? error.message : 'Social provider failure.', 'BLOCKED');
    if (failure.kind === 'UNAVAILABLE') {
      await repo.updateAccountVerification({ workspaceId: job.workspaceId, accountId: job.account.id, actorId: null, expectedVersion: null, status: 'UNAVAILABLE', statusReason: failure.message, errorCode: failure.code, errorMessage: failure.message });
    }
    if (failure.retryable && job.attemptCount < job.maxAttempts) {
      return repo.failPublication({ job, status: 'QUEUED', attemptStatus: 'FAILED', code: failure.code, message: failure.message, retryAt: new Date(Date.now() + retryDelayMs(job.attemptCount)), providerRequestId: failure.providerRequestId });
    }
    if (failure.ambiguous || failure.kind === 'BLOCKED' || failure.kind === 'UNAVAILABLE') {
      return repo.failPublication({ job, status: 'BLOCKED', attemptStatus: 'BLOCKED', code: failure.code, message: failure.message, providerRequestId: failure.providerRequestId });
    }
    return repo.failPublication({ job, status: 'FAILED', attemptStatus: 'DEAD_LETTER', code: failure.code, message: failure.message, providerRequestId: failure.providerRequestId });
  }
}
