import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import type {
  ClaimedSocialPublication,
  SocialAccount,
  SocialAccountStatus,
  SocialActorType,
  SocialContent,
  SocialContentStatus,
  SocialContentType,
  SocialProvider,
  SocialProviderContext,
  SocialPublicationAttempt,
  SocialPublicationAttemptStatus,
  SocialPublicationJob,
  SocialPublicationStatus,
} from './social-publishing.types.js';
import { SOCIAL_EVENT_TYPES } from './social-publishing.types.js';

const accountSelect = `
  id, workspace_id AS "workspaceId", provider_connection_id AS "providerConnectionId",
  provider, display_name AS "displayName", facebook_page_id AS "facebookPageId",
  instagram_business_account_id AS "instagramBusinessAccountId",
  provider_username AS "providerUsername", status, status_reason AS "statusReason",
  verified_at AS "verifiedAt", last_error_code AS "lastErrorCode",
  last_error_message AS "lastErrorMessage", version,
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const contentSelect = `
  id, workspace_id AS "workspaceId", content_type AS "contentType", status,
  message, link_url AS "linkUrl", media_url AS "mediaUrl", alt_text AS "altText",
  metadata, version, created_by_actor_type AS "createdByActorType",
  created_by_actor_ref AS "createdByActorRef", created_at AS "createdAt", updated_at AS "updatedAt"
`;

const jobSelect = `
  id, workspace_id AS "workspaceId", social_account_id AS "socialAccountId",
  content_id AS "contentId", status, scheduled_at AS "scheduledAt",
  available_at AS "availableAt", provider_publication_id AS "providerPublicationId",
  provider_permalink AS "providerPermalink", attempt_count AS "attemptCount",
  max_attempts AS "maxAttempts", published_at AS "publishedAt", finished_at AS "finishedAt",
  block_code AS "blockCode", block_message AS "blockMessage",
  last_error_code AS "lastErrorCode", last_error_message AS "lastErrorMessage",
  version, created_by_actor_type AS "createdByActorType",
  created_by_actor_ref AS "createdByActorRef",
  execution_actor_type AS "executionActorType", execution_actor_ref AS "executionActorRef",
  last_transition_actor_type AS "lastTransitionActorType",
  last_transition_actor_ref AS "lastTransitionActorRef",
  last_transition_actor_id AS "lastTransitionActorId",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const attemptSelect = `
  id, attempt_number AS "attemptNumber", status, worker_id AS "workerId",
  request_summary AS "requestSummary", response_summary AS "responseSummary",
  provider_request_id AS "providerRequestId", error_code AS "errorCode",
  error_message AS "errorMessage", started_at AS "startedAt", finished_at AS "finishedAt"
`;

function audit(input: {
  workspaceId: string;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}, client: PoolClient) {
  return query(
    `INSERT INTO audit_log(workspace_id,actor_id,action,entity_type,entity_id,before_data,after_data)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [input.workspaceId, input.actorId ?? null, input.action, input.entityType, input.entityId,
      input.before ? JSON.stringify(input.before) : null, input.after ? JSON.stringify(input.after) : null],
    client,
  );
}

export async function getSocialProviderContext(workspaceId: string, connectionId: string, client?: PoolClient) {
  const { rows } = await query<SocialProviderContext>(
    `SELECT c.id AS "connectionId", c.provider_key AS "providerKey",
            c.status AS "connectionStatus", c.authorization_state AS "authorizationState",
            c.source_type AS "sourceType", c.granted_scopes AS "grantedScopes",
            CASE WHEN c.scope_type='WORKSPACE' THEN NULL ELSE access.granted_capabilities END
              AS "sharedGrantedCapabilities",
            CASE WHEN c.source_type='workspace_platform' THEN workspace_credential.encrypted_access_token
                 WHEN c.source_type='lulu_managed_oauth' THEN managed_credential.encrypted_access_token
                 ELSE NULL END AS "encryptedAccessToken",
            CASE WHEN c.source_type='workspace_platform' THEN workspace_credential.token_expires_at
                 WHEN c.source_type='lulu_managed_oauth' THEN managed_credential.token_expires_at
                 ELSE NULL END AS "tokenExpiresAt",
            CASE WHEN c.source_type='workspace_platform' THEN platform.connection_status
                 WHEN c.source_type='lulu_managed_oauth' THEN managed_credential.status
                 ELSE NULL END AS "credentialStatus"
       FROM provider_connections c
       LEFT JOIN provider_connection_workspace_access access
         ON access.provider_connection_id=c.id AND access.workspace_id=$1 AND access.access_status='ACTIVE'
       LEFT JOIN workspace_platforms platform
         ON c.source_type='workspace_platform' AND platform.id=c.source_id
        AND platform.workspace_id=$1 AND platform.deleted_at IS NULL
       LEFT JOIN workspace_platform_oauth_credentials workspace_credential
         ON workspace_credential.platform_id=platform.id
       LEFT JOIN lulu_managed_oauth_connections managed_credential
         ON c.source_type='lulu_managed_oauth' AND managed_credential.id=c.source_id
      WHERE c.id=$2 AND (c.workspace_id=$1 OR access.provider_connection_id IS NOT NULL)
        AND c.provider_key IN ('facebook','instagram')
      LIMIT 1`,
    [workspaceId, connectionId],
    client,
  );
  return rows[0] ?? null;
}

export async function listAccounts(workspaceId: string) {
  return (await query<SocialAccount>(
    `SELECT ${accountSelect} FROM social_accounts WHERE workspace_id=$1 ORDER BY updated_at DESC`,
    [workspaceId],
  )).rows;
}

export async function getAccount(workspaceId: string, accountId: string, client?: PoolClient) {
  const { rows } = await query<SocialAccount>(
    `SELECT ${accountSelect} FROM social_accounts WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, accountId],
    client,
  );
  return rows[0] ?? null;
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
  requestFingerprint: string;
}) {
  return withTransaction(async (client) => {
    const inserted = await query<SocialAccount & { requestFingerprint: string }>(
      `INSERT INTO social_accounts(
         workspace_id,provider_connection_id,provider,display_name,facebook_page_id,
         instagram_business_account_id,idempotency_key,request_fingerprint,created_by,updated_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       ON CONFLICT DO NOTHING
       RETURNING ${accountSelect}, request_fingerprint AS "requestFingerprint"`,
      [input.workspaceId, input.providerConnectionId, input.provider, input.displayName,
        input.facebookPageId, input.instagramBusinessAccountId, input.idempotencyKey,
        input.requestFingerprint, input.actorId],
      client,
    );
    let account = inserted.rows[0] ?? null;
    if (!account) {
      account = (await query<SocialAccount & { requestFingerprint: string }>(
        `SELECT ${accountSelect}, request_fingerprint AS "requestFingerprint"
           FROM social_accounts WHERE workspace_id=$1 AND idempotency_key=$2`,
        [input.workspaceId, input.idempotencyKey],
        client,
      )).rows[0] ?? null;
      if (!account) {
        const identity = (await query<SocialAccount & { requestFingerprint: string }>(
          `SELECT ${accountSelect},request_fingerprint AS "requestFingerprint"
             FROM social_accounts
            WHERE workspace_id=$1 AND provider=$2
              AND (($2='FACEBOOK' AND facebook_page_id=$3)
                OR ($2='INSTAGRAM' AND (facebook_page_id=$3 OR instagram_business_account_id=$4)))
            LIMIT 1`,
          [input.workspaceId, input.provider, input.facebookPageId, input.instagramBusinessAccountId], client,
        )).rows[0] ?? null;
        if (identity) return { account: identity, created: false, fingerprintMatches: false, identityConflict: true };
        throw new Error('Social account conflict could not be resolved');
      }
      return { account, created: false, fingerprintMatches: account.requestFingerprint === input.requestFingerprint };
    }
    await audit({ workspaceId: input.workspaceId, actorId: input.actorId, action: 'social.account.created', entityType: 'social_account', entityId: account.id, after: { provider: account.provider, facebookPageId: account.facebookPageId, instagramBusinessAccountId: account.instagramBusinessAccountId, status: account.status } }, client);
    await appendDomainEvent({ workspaceId: input.workspaceId, type: SOCIAL_EVENT_TYPES.ACCOUNT_CREATED, aggregateType: 'social_account', aggregateId: account.id, payload: { accountId: account.id, provider: account.provider, status: account.status }, metadata: { actorId: input.actorId, source: 'social-publishing' }, idempotencyKey: `social-account:${account.id}:created` }, client);
    return { account, created: true, fingerprintMatches: true, identityConflict: false };
  });
}

export async function updateAccountVerification(input: {
  workspaceId: string;
  accountId: string;
  actorId: string | null;
  expectedVersion: number | null;
  status: SocialAccountStatus;
  statusReason: string;
  displayName?: string | null;
  providerUsername?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  return withTransaction(async (client) => {
    const before = await getAccount(input.workspaceId, input.accountId, client);
    if (!before) return { account: null, conflict: false };
    const expected = input.expectedVersion ?? before.version;
    const { rows } = await query<SocialAccount>(
      `UPDATE social_accounts SET status=$4,status_reason=$5,
          display_name=COALESCE($6,display_name),provider_username=$7,
          verified_at=CASE WHEN $4='AVAILABLE' THEN NOW() ELSE NULL END,
          last_error_code=$8,last_error_message=$9,updated_by=$3,version=version+1
        WHERE workspace_id=$1 AND id=$2 AND version=$10
        RETURNING ${accountSelect}`,
      [input.workspaceId, input.accountId, input.actorId, input.status, input.statusReason,
        input.displayName ?? null, input.providerUsername ?? null, input.errorCode ?? null,
        input.errorMessage ?? null, expected],
      client,
    );
    const account = rows[0] ?? null;
    if (!account) return { account: null, conflict: true };
    const eventType = account.status === 'AVAILABLE' ? SOCIAL_EVENT_TYPES.ACCOUNT_VERIFIED : SOCIAL_EVENT_TYPES.ACCOUNT_BLOCKED;
    await audit({ workspaceId: input.workspaceId, actorId: input.actorId, action: eventType, entityType: 'social_account', entityId: account.id, before: { status: before.status, version: before.version }, after: { status: account.status, statusReason: account.statusReason, version: account.version } }, client);
    await appendDomainEvent({ workspaceId: input.workspaceId, type: eventType, aggregateType: 'social_account', aggregateId: account.id, payload: { accountId: account.id, provider: account.provider, status: account.status, reason: account.statusReason, version: account.version }, metadata: { actorId: input.actorId, source: 'social-publishing' }, idempotencyKey: `social-account:${account.id}:status:${account.version}` }, client);
    return { account, conflict: false };
  });
}

export async function listContent(workspaceId: string, status?: SocialContentStatus) {
  return (await query<SocialContent>(
    `SELECT ${contentSelect} FROM social_content
      WHERE workspace_id=$1 AND ($2::text IS NULL OR status=$2)
      ORDER BY updated_at DESC LIMIT 200`,
    [workspaceId, status ?? null],
  )).rows;
}

export async function getContent(workspaceId: string, contentId: string, client?: PoolClient) {
  const { rows } = await query<SocialContent>(
    `SELECT ${contentSelect} FROM social_content WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, contentId],
    client,
  );
  return rows[0] ?? null;
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
  requestFingerprint: string;
}) {
  return withTransaction(async (client) => {
    const inserted = await query<SocialContent & { requestFingerprint: string }>(
      `INSERT INTO social_content(
         workspace_id,content_type,status,message,link_url,media_url,alt_text,metadata,
         idempotency_key,request_fingerprint,created_by,updated_by,created_by_actor_type,created_by_actor_ref
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$11,$12,$13)
       ON CONFLICT(workspace_id,idempotency_key) DO NOTHING
       RETURNING ${contentSelect}, request_fingerprint AS "requestFingerprint"`,
      [input.workspaceId, input.contentType, input.status, input.message, input.linkUrl,
        input.mediaUrl, input.altText, JSON.stringify(input.metadata), input.idempotencyKey,
        input.requestFingerprint, input.actorId, input.actorType, input.actorRef],
      client,
    );
    let content = inserted.rows[0] ?? null;
    if (!content) {
      content = (await query<SocialContent & { requestFingerprint: string }>(
        `SELECT ${contentSelect},request_fingerprint AS "requestFingerprint"
           FROM social_content WHERE workspace_id=$1 AND idempotency_key=$2`,
        [input.workspaceId, input.idempotencyKey], client,
      )).rows[0] ?? null;
      if (!content) throw new Error('Social content idempotency lookup failed');
      return { content, created: false, fingerprintMatches: content.requestFingerprint === input.requestFingerprint };
    }
    await audit({ workspaceId: input.workspaceId, actorId: input.actorId, action: 'social.content.created', entityType: 'social_content', entityId: content.id, after: { contentType: content.contentType, status: content.status, actorType: content.createdByActorType } }, client);
    await appendDomainEvent({ workspaceId: input.workspaceId, type: SOCIAL_EVENT_TYPES.CONTENT_CREATED, aggregateType: 'social_content', aggregateId: content.id, payload: { contentId: content.id, contentType: content.contentType, status: content.status }, metadata: { actorId: input.actorId, actorType: input.actorType, actorRef: input.actorRef, source: 'social-publishing' }, idempotencyKey: `social-content:${content.id}:created` }, client);
    return { content, created: true, fingerprintMatches: true };
  });
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
  return withTransaction(async (client) => {
    const before = await getContent(input.workspaceId, input.contentId, client);
    if (!before) return { content: null, conflict: false, inUse: false };
    const inUse = (await query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM social_publication_jobs
        WHERE workspace_id=$1 AND content_id=$2 AND status NOT IN ('DRAFT','CANCELLED')) AS exists`,
      [input.workspaceId, input.contentId], client,
    )).rows[0]?.exists === true;
    if (inUse) return { content: null, conflict: false, inUse: true };
    const next = {
      status: input.status ?? before.status,
      message: input.message ?? before.message,
      linkUrl: input.linkUrl === undefined ? before.linkUrl : input.linkUrl,
      mediaUrl: input.mediaUrl === undefined ? before.mediaUrl : input.mediaUrl,
      altText: input.altText === undefined ? before.altText : input.altText,
      metadata: input.metadata ?? before.metadata,
    };
    const { rows } = await query<SocialContent>(
      `UPDATE social_content SET status=$4,message=$5,link_url=$6,media_url=$7,alt_text=$8,
          metadata=$9::jsonb,updated_by=$3,version=version+1
        WHERE workspace_id=$1 AND id=$2 AND version=$10 RETURNING ${contentSelect}`,
      [input.workspaceId, input.contentId, input.actorId, next.status, next.message,
        next.linkUrl, next.mediaUrl, next.altText, JSON.stringify(next.metadata), input.expectedVersion], client,
    );
    const content = rows[0] ?? null;
    if (!content) return { content: null, conflict: true, inUse: false };
    await audit({ workspaceId: input.workspaceId, actorId: input.actorId, action: 'social.content.updated', entityType: 'social_content', entityId: content.id, before: { status: before.status, version: before.version }, after: { status: content.status, version: content.version } }, client);
    await appendDomainEvent({ workspaceId: input.workspaceId, type: SOCIAL_EVENT_TYPES.CONTENT_UPDATED, aggregateType: 'social_content', aggregateId: content.id, payload: { contentId: content.id, contentType: content.contentType, status: content.status, version: content.version }, metadata: { actorId: input.actorId, source: 'social-publishing' }, idempotencyKey: `social-content:${content.id}:updated:${content.version}` }, client);
    return { content, conflict: false, inUse: false };
  });
}

export async function listPublicationJobs(workspaceId: string, status?: SocialPublicationStatus) {
  return (await query<SocialPublicationJob>(
    `SELECT ${jobSelect} FROM social_publication_jobs
      WHERE workspace_id=$1 AND ($2::text IS NULL OR status=$2)
      ORDER BY created_at DESC LIMIT 200`,
    [workspaceId, status ?? null],
  )).rows;
}

async function attemptsForJob(workspaceId: string, jobId: string, client?: PoolClient) {
  return (await query<SocialPublicationAttempt>(
    `SELECT ${attemptSelect} FROM social_publication_attempts
      WHERE workspace_id=$1 AND publication_job_id=$2 ORDER BY attempt_number DESC`,
    [workspaceId, jobId], client,
  )).rows;
}

export async function getPublicationJob(workspaceId: string, jobId: string, client?: PoolClient) {
  const job = (await query<SocialPublicationJob>(
    `SELECT ${jobSelect} FROM social_publication_jobs WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, jobId], client,
  )).rows[0] ?? null;
  if (!job) return null;
  const [account, content, attempts] = await Promise.all([
    getAccount(workspaceId, job.socialAccountId, client),
    getContent(workspaceId, job.contentId, client),
    attemptsForJob(workspaceId, job.id, client),
  ]);
  return { ...job, ...(account ? { account } : {}), ...(content ? { content } : {}), attempts };
}

export async function createPublicationJob(input: {
  workspaceId: string;
  actorId: string | null;
  actorType: SocialActorType;
  actorRef: string | null;
  socialAccountId: string;
  contentId: string;
  status: SocialPublicationStatus;
  scheduledAt: string | null;
  maxAttempts: number;
  blockCode: string | null;
  blockMessage: string | null;
  idempotencyKey: string;
  requestFingerprint: string;
}) {
  return withTransaction(async (client) => {
    const finished = ['BLOCKED','FAILED','CANCELLED','PUBLISHED'].includes(input.status);
    const inserted = await query<SocialPublicationJob & { requestFingerprint: string }>(
      `INSERT INTO social_publication_jobs(
         workspace_id,social_account_id,content_id,status,scheduled_at,available_at,max_attempts,
         block_code,block_message,finished_at,idempotency_key,request_fingerprint,
         created_by,updated_by,created_by_actor_type,created_by_actor_ref,
         execution_actor_type,execution_actor_ref,
         last_transition_actor_type,last_transition_actor_ref,last_transition_actor_id
       ) VALUES($1,$2,$3,$4,$5,COALESCE($5,NOW()),$6,$7,$8,CASE WHEN $9 THEN NOW() ELSE NULL END,$10,$11,$12,$12,$13,$14,$13,$14,$13,$14,$12)
       ON CONFLICT(workspace_id,idempotency_key) DO NOTHING
       RETURNING ${jobSelect},request_fingerprint AS "requestFingerprint"`,
      [input.workspaceId, input.socialAccountId, input.contentId, input.status,
        input.scheduledAt, input.maxAttempts, input.blockCode, input.blockMessage, finished,
        input.idempotencyKey, input.requestFingerprint, input.actorId, input.actorType, input.actorRef],
      client,
    );
    let job = inserted.rows[0] ?? null;
    if (!job) {
      job = (await query<SocialPublicationJob & { requestFingerprint: string }>(
        `SELECT ${jobSelect},request_fingerprint AS "requestFingerprint"
           FROM social_publication_jobs WHERE workspace_id=$1 AND idempotency_key=$2`,
        [input.workspaceId, input.idempotencyKey], client,
      )).rows[0] ?? null;
      if (!job) throw new Error('Social publication idempotency lookup failed');
      return { job, created: false, fingerprintMatches: job.requestFingerprint === input.requestFingerprint };
    }
    await audit({ workspaceId: input.workspaceId, actorId: input.actorId, action: 'social.publication.created', entityType: 'social_publication_job', entityId: job.id, after: { status: job.status, socialAccountId: job.socialAccountId, contentId: job.contentId } }, client);
    const actorMetadata = { actorId: input.actorId, actorType: input.actorType, actorRef: input.actorRef, source: 'social-publishing' };
    await appendDomainEvent({ workspaceId: input.workspaceId, type: SOCIAL_EVENT_TYPES.PUBLICATION_CREATED, aggregateType: 'social_publication_job', aggregateId: job.id, payload: { jobId: job.id, accountId: job.socialAccountId, contentId: job.contentId, status: job.status }, metadata: actorMetadata, idempotencyKey: `social-publication:${job.id}:created` }, client);
    if (job.status === 'QUEUED' || job.status === 'SCHEDULED') {
      await appendDomainEvent({ workspaceId: input.workspaceId, type: SOCIAL_EVENT_TYPES.PUBLICATION_QUEUED, aggregateType: 'social_publication_job', aggregateId: job.id, payload: { jobId: job.id, status: job.status, scheduledAt: job.scheduledAt }, metadata: actorMetadata, idempotencyKey: `social-publication:${job.id}:queued:${job.version}` }, client);
    }
    if (job.status === 'BLOCKED') {
      await appendDomainEvent({ workspaceId: input.workspaceId, type: SOCIAL_EVENT_TYPES.PUBLICATION_BLOCKED, aggregateType: 'social_publication_job', aggregateId: job.id, payload: { jobId: job.id, status: job.status, code: job.blockCode, message: job.blockMessage, version: job.version }, metadata: actorMetadata, idempotencyKey: `social-publication:${job.id}:blocked:${job.version}` }, client);
    }
    return { job, created: true, fingerprintMatches: true };
  });
}

export async function listExecutionPublications(
  workspaceId: string,
  actionRecordId: string,
  client: PoolClient,
) {
  return (await query<SocialPublicationJob>(
    `SELECT ${jobSelect} FROM social_publication_jobs
      WHERE workspace_id=$1 AND execution_actor_type='AI_AGENT' AND execution_actor_ref=$2
      ORDER BY id FOR UPDATE`,
    [workspaceId, actionRecordId],
    client,
  )).rows;
}

async function reconcileLinkedAgentPacketTransition(
  job: SocialPublicationJob,
  action: 'QUEUE' | 'CANCEL' | 'RETRY',
  actorId: string,
  client: PoolClient,
) {
  if (job.executionActorType !== 'AI_AGENT' || !job.executionActorRef || action === 'QUEUE') return;
  const packet = (await query<{
    id: string; status: string; stage: string | null; data: Record<string, unknown>; version: number;
  }>(
    `SELECT record.id,record.status,record.stage,record.data,record.version
       FROM workspace_records record
       JOIN agent_action_packets packet
         ON packet.workspace_id=record.workspace_id AND packet.record_id=record.id
      WHERE record.workspace_id=$1 AND record.id=$2 AND record.deleted_at IS NULL
      FOR UPDATE OF record`,
    [job.workspaceId, job.executionActorRef],
    client,
  )).rows[0];
  if (!packet) return;
  const receipt = (await query<{ id: string; status: string; stage: string | null }>(
    `SELECT id,status,stage FROM workspace_records
      WHERE workspace_id=$1 AND parent_id=$2 AND deleted_at IS NULL
        AND source='agent_executor_command'
        AND data->'commandResult'->>'publicationId'=$3
      ORDER BY created_at,id LIMIT 1 FOR UPDATE`,
    [job.workspaceId, packet.id, job.id],
    client,
  )).rows[0];
  if (!receipt) return;

  if (action === 'RETRY') {
    await query(
      `UPDATE workspace_records SET status='active',stage='waiting_for_provider',
          data=data || jsonb_build_object(
            'commandResult',COALESCE(data->'commandResult','{}'::jsonb)
              || jsonb_build_object('status',$4::text,'version',$5::integer),
            'providerError',NULL,'providerTerminalEventId',NULL,'providerCompletedAt',NULL),
          updated_by=$3,version=version+1,updated_at=NOW()
        WHERE workspace_id=$1 AND id=$2
          AND (status='failed' OR stage='provider_failed')`,
      [job.workspaceId, receipt.id, actorId, job.status, job.version],
      client,
    );
    const pending = (await query<{ operations: unknown[] }>(
      `SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'publicationId',child.data->'commandResult'->>'publicationId',
          'resultRecordId',child.id,
          'commandType',child.data->>'commandType',
          'provider',child.data->>'commandProvider'
        ) ORDER BY child.created_at,child.id),'[]'::jsonb) AS operations
       FROM workspace_records child
       WHERE child.workspace_id=$1 AND child.parent_id=$2 AND child.deleted_at IS NULL
         AND child.source='agent_executor_command' AND child.stage='waiting_for_provider'`,
      [job.workspaceId, packet.id],
      client,
    )).rows[0]?.operations ?? [];
    await query(
      `UPDATE workspace_records SET status='active',stage='waiting_for_provider',
          data=data || jsonb_build_object(
            'executionReady',false,'executionStatus','waiting_for_provider',
            'executionRetryable',false,'executionError',NULL,'executionErrorClass',NULL,
            'executionFailedAt',NULL,'executionNextAttemptAt',NULL,
            'pendingProviderOperations',$4::jsonb),
          updated_by=$3,version=version+1,updated_at=NOW()
        WHERE workspace_id=$1 AND id=$2 AND stage IN ('execution_failed','waiting_for_provider')`,
      [job.workspaceId, packet.id, actorId, JSON.stringify(pending)],
      client,
    );
    return;
  }

  await query(
    `UPDATE workspace_records SET status='cancelled',stage='execution_cancelled',
        data=data || jsonb_build_object(
          'commandResult',COALESCE(data->'commandResult','{}'::jsonb)
            || jsonb_build_object('status','CANCELLED','version',$4::integer),
          'providerError',NULL,'providerCompletedAt',NOW()),
        updated_by=$3,version=version+1,updated_at=NOW()
      WHERE workspace_id=$1 AND id=$2 AND stage IN ('waiting_for_provider','provider_failed')`,
    [job.workspaceId, receipt.id, actorId, job.version],
    client,
  );
  const waiting = (await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM workspace_records
      WHERE workspace_id=$1 AND parent_id=$2 AND deleted_at IS NULL
        AND source='agent_executor_command' AND stage='waiting_for_provider'`,
    [job.workspaceId, packet.id],
    client,
  )).rows[0]?.count ?? 0;
  if (Number(waiting) === 0) {
    await query(
      `UPDATE workspace_records SET status='cancelled',stage='execution_cancelled',
          data=data || jsonb_build_object(
            'executionReady',false,'executionStatus','cancelled',
            'executionRetryable',false,'executionError',NULL,
            'pendingProviderOperations','[]'::jsonb,'executionNextAttemptAt',NULL),
          updated_by=$3,version=version+1,updated_at=NOW()
        WHERE workspace_id=$1 AND id=$2
          AND stage IN ('waiting_for_provider','execution_failed','execution_cancelled')`,
      [job.workspaceId, packet.id, actorId],
      client,
    );
  }
}

export async function transitionPublicationJob(input: {
  workspaceId: string;
  jobId: string;
  actorId: string;
  actorType: SocialActorType;
  actorRef: string | null;
  expectedVersion: number;
  action: 'QUEUE' | 'CANCEL' | 'RETRY';
  scheduledAt?: string | null;
}, transactionClient?: PoolClient) {
  const run = async (client: PoolClient) => {
    const before = (await query<SocialPublicationJob>(
      `SELECT ${jobSelect} FROM social_publication_jobs
        WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [input.workspaceId, input.jobId], client,
    )).rows[0] ?? null;
    if (!before) return { job: null, conflict: false, invalidState: false };
    const allowed = input.action === 'CANCEL'
      ? ['DRAFT','SCHEDULED','QUEUED','FAILED','BLOCKED']
      : input.action === 'RETRY'
        ? ['FAILED','BLOCKED']
        : ['DRAFT','SCHEDULED','FAILED','BLOCKED'];
    if (!allowed.includes(before.status)) return { job: null, conflict: false, invalidState: true };
    const nextStatus: SocialPublicationStatus = input.action === 'CANCEL'
      ? 'CANCELLED'
      : input.scheduledAt && new Date(input.scheduledAt).getTime() > Date.now()
        ? 'SCHEDULED'
        : 'QUEUED';
    const humanTransition = input.actorType === 'USER' || input.actorType === 'ADMIN';
    const executionActorType = before.executionActorType === 'AI_AGENT' && humanTransition
      ? before.executionActorType : input.actorType;
    const executionActorRef = before.executionActorType === 'AI_AGENT' && humanTransition
      ? before.executionActorRef : input.actorRef;
    const { rows } = await query<SocialPublicationJob>(
      `UPDATE social_publication_jobs SET status=$5,scheduled_at=$6,
          available_at=COALESCE($6,NOW()),finished_at=CASE WHEN $5='CANCELLED' THEN NOW() ELSE NULL END,
          block_code=NULL,block_message=NULL,last_error_code=NULL,last_error_message=NULL,
          max_attempts=CASE WHEN $4='RETRY' AND attempt_count>=max_attempts THEN max_attempts+1 ELSE max_attempts END,
          execution_actor_type=$8,execution_actor_ref=$9,
          last_transition_actor_type=$10,last_transition_actor_ref=$11,last_transition_actor_id=$3,
          updated_by=$3,version=version+1
        WHERE workspace_id=$1 AND id=$2 AND version=$7 RETURNING ${jobSelect}`,
      [input.workspaceId, input.jobId, input.actorId, input.action, nextStatus,
        input.scheduledAt ?? null, input.expectedVersion, executionActorType, executionActorRef,
        input.actorType, input.actorRef], client,
    );
    const job = rows[0] ?? null;
    if (!job) return { job: null, conflict: true, invalidState: false };
    await reconcileLinkedAgentPacketTransition(job, input.action, input.actorId, client);
    const eventType = input.action === 'CANCEL' ? SOCIAL_EVENT_TYPES.PUBLICATION_CANCELLED : SOCIAL_EVENT_TYPES.PUBLICATION_QUEUED;
    await audit({ workspaceId: input.workspaceId, actorId: input.actorId, action: eventType, entityType: 'social_publication_job', entityId: job.id, before: { status: before.status, version: before.version }, after: { status: job.status, scheduledAt: job.scheduledAt, version: job.version } }, client);
    await appendDomainEvent({ workspaceId: input.workspaceId, type: eventType, aggregateType: 'social_publication_job', aggregateId: job.id, payload: { jobId: job.id, status: job.status, scheduledAt: job.scheduledAt, version: job.version }, metadata: { actorId: input.actorId, actorType: job.executionActorType, actorRef: job.executionActorRef, transitionActorType: input.actorType, transitionActorRef: input.actorRef, source: 'social-publishing' }, idempotencyKey: `social-publication:${job.id}:${input.action.toLowerCase()}:${job.version}` }, client);
    return { job, conflict: false, invalidState: false };
  };
  return transactionClient ? run(transactionClient) : withTransaction(run);
}

export async function blockStalePublishingJobs(leaseSeconds: number) {
  return withTransaction(async (client) => {
    const { rows } = await query<{ id: string; workspaceId: string; attemptCount: number; version: number; executionActorType: SocialActorType; executionActorRef: string | null }>(
      `UPDATE social_publication_jobs SET status='BLOCKED',block_code='META_PUBLISH_RESULT_UNKNOWN',
          block_message='The worker lease expired after provider delivery began. Manual reconciliation is required to prevent a duplicate post.',
          last_error_code='WORKER_LEASE_EXPIRED',last_error_message='Publication outcome is unknown.',
          finished_at=NOW(),locked_at=NULL,locked_by=NULL,version=version+1
        WHERE status='PUBLISHING' AND locked_at < NOW()-($1::integer*INTERVAL '1 second')
        RETURNING id,workspace_id AS "workspaceId",attempt_count AS "attemptCount",version,
          execution_actor_type AS "executionActorType",execution_actor_ref AS "executionActorRef"`,
      [leaseSeconds], client,
    );
    for (const row of rows) {
      await query(
        `UPDATE social_publication_attempts SET status='BLOCKED',error_code='WORKER_LEASE_EXPIRED',
            error_message='Publication outcome is unknown.',finished_at=NOW()
          WHERE workspace_id=$1 AND publication_job_id=$2 AND attempt_number=$3 AND status='RUNNING'`,
        [row.workspaceId, row.id, row.attemptCount], client,
      );
      await audit({ workspaceId: row.workspaceId, action: 'social.publication.blocked', entityType: 'social_publication_job', entityId: row.id, before: { status: 'PUBLISHING', attemptCount: row.attemptCount }, after: { status: 'BLOCKED', code: 'META_PUBLISH_RESULT_UNKNOWN' } }, client);
      await appendDomainEvent({ workspaceId: row.workspaceId, type: SOCIAL_EVENT_TYPES.PUBLICATION_BLOCKED, aggregateType: 'social_publication_job', aggregateId: row.id, payload: { jobId: row.id, status: 'BLOCKED', code: 'META_PUBLISH_RESULT_UNKNOWN', version: row.version }, metadata: { actorType: row.executionActorType, actorRef: row.executionActorRef, source: 'social-publishing.worker' }, idempotencyKey: `social-publication:${row.id}:lease-expired:${row.attemptCount}` }, client);
    }
    return rows.length;
  });
}

export async function claimNextPublication(workerId: string) {
  return withTransaction(async (client) => {
    const { rows } = await query<SocialPublicationJob>(
      `WITH candidate AS (
         SELECT id AS candidate_id FROM social_publication_jobs
          WHERE ((status='QUEUED' AND available_at<=NOW())
             OR (status='SCHEDULED' AND scheduled_at<=NOW()))
            AND NOT COALESCE((SELECT (settings->'agents'->>'paused')::boolean FROM workspace_settings WHERE workspace_id=social_publication_jobs.workspace_id), FALSE)
          ORDER BY COALESCE(scheduled_at,available_at),created_at
          LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       UPDATE social_publication_jobs job SET status='PUBLISHING',attempt_count=attempt_count+1,
          locked_at=NOW(),locked_by=$1,finished_at=NULL,last_error_code=NULL,last_error_message=NULL,
          version=version+1
       FROM candidate WHERE job.id=candidate.candidate_id RETURNING ${jobSelect}`,
      [workerId], client,
    );
    const job = rows[0];
    if (!job) return null;
    const [account, content] = await Promise.all([
      getAccount(job.workspaceId, job.socialAccountId, client),
      getContent(job.workspaceId, job.contentId, client),
    ]);
    if (!account || !content) throw new Error('Claimed social publication references missing canonical data');
    const attempt = (await query<{ id: string }>(
      `INSERT INTO social_publication_attempts(
         workspace_id,publication_job_id,attempt_number,status,worker_id,request_summary
       ) VALUES($1,$2,$3,'RUNNING',$4,$5::jsonb) RETURNING id`,
      [job.workspaceId, job.id, job.attemptCount, workerId, JSON.stringify({ provider: account.provider, accountId: account.id, contentId: content.id, contentType: content.contentType })], client,
    )).rows[0];
    if (!attempt) throw new Error('Social publication attempt could not be created');
    return { ...job, workerId, attemptId: attempt.id, account, content } satisfies ClaimedSocialPublication;
  });
}

export async function completePublication(input: {
  job: ClaimedSocialPublication;
  providerPublicationId: string;
  providerPermalink: string | null;
  providerRequestId: string | null;
  responseSummary: Record<string, unknown>;
}) {
  return withTransaction(async (client) => {
    const { rows } = await query<SocialPublicationJob>(
      `UPDATE social_publication_jobs SET status='PUBLISHED',provider_publication_id=$4,
          provider_permalink=$5,published_at=NOW(),finished_at=NOW(),locked_at=NULL,locked_by=NULL,
          block_code=NULL,block_message=NULL,last_error_code=NULL,last_error_message=NULL,version=version+1
        WHERE workspace_id=$1 AND id=$2 AND status='PUBLISHING' AND locked_by=$3
        RETURNING ${jobSelect}`,
      [input.job.workspaceId, input.job.id, input.job.workerId, input.providerPublicationId, input.providerPermalink], client,
    );
    const job = rows[0] ?? null;
    if (!job) return null;
    await query(
      `UPDATE social_publication_attempts SET status='SUCCEEDED',response_summary=$3::jsonb,
          provider_request_id=$4,finished_at=NOW()
        WHERE workspace_id=$1 AND id=$2 AND status='RUNNING'`,
      [job.workspaceId, input.job.attemptId, JSON.stringify(input.responseSummary), input.providerRequestId], client,
    );
    await audit({ workspaceId: job.workspaceId, action: 'social.publication.published', entityType: 'social_publication_job', entityId: job.id, before: { status: 'PUBLISHING', attemptCount: job.attemptCount }, after: { status: job.status, providerPublicationId: job.providerPublicationId, version: job.version } }, client);
    await appendDomainEvent({ workspaceId: job.workspaceId, type: SOCIAL_EVENT_TYPES.PUBLICATION_PUBLISHED, aggregateType: 'social_publication_job', aggregateId: job.id, payload: { jobId: job.id, accountId: job.socialAccountId, contentId: job.contentId, providerPublicationId: job.providerPublicationId, providerPermalink: job.providerPermalink, status: job.status, version: job.version }, metadata: { actorType: job.executionActorType, actorRef: job.executionActorRef, source: 'social-publishing.worker' }, idempotencyKey: `social-publication:${job.id}:published` }, client);
    return job;
  });
}

export async function failPublication(input: {
  job: ClaimedSocialPublication;
  status: 'QUEUED' | 'FAILED' | 'BLOCKED';
  attemptStatus: SocialPublicationAttemptStatus;
  code: string;
  message: string;
  retryAt?: Date | null;
  providerRequestId?: string | null;
  responseSummary?: Record<string, unknown> | null;
}) {
  return withTransaction(async (client) => {
    const terminal = input.status !== 'QUEUED';
    const { rows } = await query<SocialPublicationJob>(
      `UPDATE social_publication_jobs SET status=$4,available_at=COALESCE($5,NOW()),
          finished_at=CASE WHEN $6 THEN NOW() ELSE NULL END,
          block_code=CASE WHEN $4='BLOCKED' THEN $7 ELSE NULL END,
          block_message=CASE WHEN $4='BLOCKED' THEN $8 ELSE NULL END,
          last_error_code=$7,last_error_message=$8,locked_at=NULL,locked_by=NULL,version=version+1
        WHERE workspace_id=$1 AND id=$2 AND status='PUBLISHING' AND locked_by=$3
        RETURNING ${jobSelect}`,
      [input.job.workspaceId, input.job.id, input.job.workerId, input.status,
        input.retryAt ?? null, terminal, input.code, input.message.slice(0, 2000)], client,
    );
    const job = rows[0] ?? null;
    if (!job) return null;
    await query(
      `UPDATE social_publication_attempts SET status=$3,response_summary=$4::jsonb,
          provider_request_id=$5,error_code=$6,error_message=$7,finished_at=NOW()
        WHERE workspace_id=$1 AND id=$2 AND status='RUNNING'`,
      [job.workspaceId, input.job.attemptId, input.attemptStatus,
        input.responseSummary ? JSON.stringify(input.responseSummary) : null,
        input.providerRequestId ?? null, input.code, input.message.slice(0, 2000)], client,
    );
    const eventType = input.status === 'QUEUED'
      ? SOCIAL_EVENT_TYPES.PUBLICATION_RETRY_SCHEDULED
      : input.status === 'BLOCKED'
        ? SOCIAL_EVENT_TYPES.PUBLICATION_BLOCKED
        : SOCIAL_EVENT_TYPES.PUBLICATION_FAILED;
    await audit({ workspaceId: job.workspaceId, action: eventType, entityType: 'social_publication_job', entityId: job.id, before: { status: 'PUBLISHING', attemptCount: job.attemptCount }, after: { status: job.status, errorCode: input.code, version: job.version } }, client);
    await appendDomainEvent({ workspaceId: job.workspaceId, type: eventType, aggregateType: 'social_publication_job', aggregateId: job.id, payload: { jobId: job.id, status: job.status, code: input.code, message: input.message, attemptCount: job.attemptCount, availableAt: job.availableAt, version: job.version }, metadata: { actorType: job.executionActorType, actorRef: job.executionActorRef, source: 'social-publishing.worker' }, idempotencyKey: `social-publication:${job.id}:${job.status.toLowerCase()}:${job.attemptCount}` }, client);
    return job;
  });
}
