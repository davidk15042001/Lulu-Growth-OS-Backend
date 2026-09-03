import { query, withTransaction } from '../../db/pool.js';
import type { PoolClient } from 'pg';
import type { CalendarAccount, CalendarAccountCredential, CalendarEvent, CalendarSyncJob, CalendarProvider, ProviderCalendarEvent } from './calendar.types.js';
import type { ListEventsQuery } from './calendar.validator.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';

const accountSelect = `
  id, workspace_id AS "workspaceId", provider, external_account_id AS "externalAccountId",
  email_address AS "emailAddress", display_name AS "displayName", base_url AS "baseUrl",
  settings, status, last_sync_at AS "lastSyncAt", last_error_code AS "lastErrorCode",
  last_error_message AS "lastErrorMessage", created_at AS "createdAt", updated_at AS "updatedAt"`;

const credentialSelect = `${accountSelect},
  connected_by AS "connectedBy", encrypted_access_token AS "encryptedAccessToken",
  encrypted_refresh_token AS "encryptedRefreshToken", token_expires_at AS "tokenExpiresAt",
  encrypted_api_key AS "encryptedApiKey"`;

const syncJobSelect = `
  id, workspace_id AS "workspaceId", account_id AS "accountId", status,
  events_synced AS "eventsSynced", error_code AS "errorCode", error_message AS "errorMessage",
  started_at AS "startedAt", finished_at AS "finishedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

function normalizeEmail(value?: string | null) {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || null;
}

async function findExistingAccount(client: PoolClient, workspaceId: string, provider: CalendarProvider, externalAccountId?: string | null, emailAddress?: string | null) {
  const normalizedEmail = normalizeEmail(emailAddress);
  const { rows } = await query<{ id: string }>(
    `SELECT id
       FROM calendar_accounts
      WHERE workspace_id = $1
        AND provider = $2
        AND (
          ($3::text IS NOT NULL AND external_account_id = $3)
          OR ($4::text IS NOT NULL AND lower(email_address) = $4)
        )
      ORDER BY updated_at DESC
      LIMIT 1`,
    [workspaceId, provider, externalAccountId ?? null, normalizedEmail],
    client,
  );
  return rows[0]?.id ?? null;
}

async function appendCalendarConnectedEvent(
  client: PoolClient,
  input: { workspaceId: string; userId: string; provider: CalendarProvider },
  account: CalendarAccount,
) {
  await appendDomainEvent({
    workspaceId: input.workspaceId,
    type: DOMAIN_EVENT_TYPES.INTEGRATION_CONNECTED,
    aggregateType: 'calendar_account',
    aggregateId: account.id,
    payload: { accountId: account.id, provider: input.provider, category: 'calendar' },
    metadata: { actorId: input.userId, source: 'calendar.connection' },
  }, client);
  return account;
}

export async function listAccounts(workspaceId: string) {
  const { rows } = await query<CalendarAccount>(
    `SELECT ${accountSelect}
       FROM calendar_accounts
      WHERE workspace_id = $1 AND status <> 'disconnected'
      ORDER BY created_at ASC`,
    [workspaceId],
  );
  return rows;
}

export async function findAccount(workspaceId: string, accountId: string) {
  const { rows } = await query<CalendarAccountCredential>(
    `SELECT ${credentialSelect}
       FROM calendar_accounts
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, accountId],
  );
  return rows[0] ?? null;
}

export async function upsertOAuthAccount(input: {
  workspaceId: string;
  userId: string;
  provider: Extract<CalendarProvider, 'google' | 'microsoft'>;
  externalAccountId?: string | null;
  emailAddress?: string | null;
  displayName?: string | null;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string | null;
  tokenExpiresAt?: string | null;
  settings?: Record<string, unknown>;
}) {
  return withTransaction(async (client) => {
    const accountId = await findExistingAccount(client, input.workspaceId, input.provider, input.externalAccountId, input.emailAddress);
    const params = [
      input.workspaceId,
      input.userId,
      input.provider,
      input.externalAccountId ?? null,
      normalizeEmail(input.emailAddress),
      input.displayName ?? null,
      input.encryptedAccessToken,
      input.encryptedRefreshToken ?? null,
      input.tokenExpiresAt ?? null,
      JSON.stringify(input.settings ?? {}),
    ];
    if (accountId) {
      const { rows } = await query<CalendarAccount>(
        `UPDATE calendar_accounts
            SET connected_by = $2,
                external_account_id = $4,
                email_address = $5,
                display_name = $6,
                encrypted_access_token = $7,
                encrypted_refresh_token = COALESCE($8, encrypted_refresh_token),
                token_expires_at = $9,
                settings = $10::jsonb,
                encrypted_api_key = NULL,
                base_url = NULL,
                status = 'connected',
                last_error_code = NULL,
                last_error_message = NULL
          WHERE workspace_id = $1 AND id = $11
        RETURNING ${accountSelect}`,
        [...params, accountId],
        client,
      );
      return appendCalendarConnectedEvent(client, input, rows[0]!);
    }
    const { rows } = await query<CalendarAccount>(
      `INSERT INTO calendar_accounts (
         workspace_id, connected_by, provider, external_account_id, email_address,
         display_name, encrypted_access_token, encrypted_refresh_token, token_expires_at,
         settings, status
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'connected')
       RETURNING ${accountSelect}`,
      params,
      client,
    );
    return appendCalendarConnectedEvent(client, input, rows[0]!);
  });
}

export async function upsertTokenAccount(input: {
  workspaceId: string;
  userId: string;
  provider: Extract<CalendarProvider, 'calendly' | 'calcom'>;
  externalAccountId?: string | null;
  emailAddress?: string | null;
  displayName?: string | null;
  encryptedApiKey: string;
  baseUrl?: string | null;
  settings?: Record<string, unknown>;
}) {
  return withTransaction(async (client) => {
    const accountId = await findExistingAccount(client, input.workspaceId, input.provider, input.externalAccountId, input.emailAddress);
    const params = [
      input.workspaceId,
      input.userId,
      input.provider,
      input.externalAccountId ?? null,
      normalizeEmail(input.emailAddress),
      input.displayName ?? null,
      input.encryptedApiKey,
      input.baseUrl ?? null,
      JSON.stringify(input.settings ?? {}),
    ];
    if (accountId) {
      const { rows } = await query<CalendarAccount>(
        `UPDATE calendar_accounts
            SET connected_by = $2,
                external_account_id = $4,
                email_address = $5,
                display_name = $6,
                encrypted_api_key = $7,
                base_url = $8,
                settings = $9::jsonb,
                encrypted_access_token = NULL,
                encrypted_refresh_token = NULL,
                token_expires_at = NULL,
                status = 'connected',
                last_error_code = NULL,
                last_error_message = NULL
          WHERE workspace_id = $1 AND id = $10
        RETURNING ${accountSelect}`,
        [...params, accountId],
        client,
      );
      return appendCalendarConnectedEvent(client, input, rows[0]!);
    }
    const { rows } = await query<CalendarAccount>(
      `INSERT INTO calendar_accounts (
         workspace_id, connected_by, provider, external_account_id, email_address,
         display_name, encrypted_api_key, base_url, settings, status
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'connected')
       RETURNING ${accountSelect}`,
      params,
      client,
    );
    return appendCalendarConnectedEvent(client, input, rows[0]!);
  });
}

export async function updateOAuthTokens(accountId: string, encryptedAccessToken: string, encryptedRefreshToken: string | null, tokenExpiresAt: string | null) {
  await query(
    `UPDATE calendar_accounts
        SET encrypted_access_token = $2,
            encrypted_refresh_token = COALESCE($3, encrypted_refresh_token),
            token_expires_at = $4,
            status = 'connected',
            last_error_code = NULL,
            last_error_message = NULL
      WHERE id = $1`,
    [accountId, encryptedAccessToken, encryptedRefreshToken, tokenExpiresAt],
  );
}

export async function updateAccountIdentity(accountId: string, input: {
  externalAccountId?: string | null;
  emailAddress?: string | null;
  displayName?: string | null;
  settings?: Record<string, unknown>;
}) {
  await query(
    `UPDATE calendar_accounts
        SET external_account_id = COALESCE($2, external_account_id),
            email_address = COALESCE($3, email_address),
            display_name = COALESCE($4, display_name),
            settings = CASE
              WHEN $5::jsonb = '{}'::jsonb THEN settings
              ELSE settings || $5::jsonb
            END
      WHERE id = $1`,
    [accountId, input.externalAccountId ?? null, normalizeEmail(input.emailAddress), input.displayName ?? null, JSON.stringify(input.settings ?? {})],
  );
}

export async function disconnectAccount(workspaceId: string, accountId: string) {
  const result = await query(
    `UPDATE calendar_accounts
        SET status = 'disconnected',
            encrypted_access_token = NULL,
            encrypted_refresh_token = NULL,
            encrypted_api_key = NULL,
            token_expires_at = NULL
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, accountId],
  );
  return result.rowCount > 0;
}

export async function setAccountStatus(accountId: string, status: string, errorCode?: string | null, errorMessage?: string | null) {
  await query(
    `UPDATE calendar_accounts
        SET status = $2,
            last_error_code = $3,
            last_error_message = $4
      WHERE id = $1`,
    [accountId, status, errorCode ?? null, errorMessage?.slice(0, 2000) ?? null],
  );
}

export async function completeAccountSync(accountId: string) {
  await query(
    `UPDATE calendar_accounts
        SET status = 'connected',
            last_sync_at = NOW(),
            last_error_code = NULL,
            last_error_message = NULL
      WHERE id = $1`,
    [accountId],
  );
}

export async function saveProviderData(accountId: string, events: ProviderCalendarEvent[]) {
  await withTransaction(async (client) => {
    await query(`DELETE FROM calendar_events WHERE account_id = $1`, [accountId], client);
    for (const event of events) {
      await query(
        `INSERT INTO calendar_events (
           account_id, provider_event_id, source_id, source_name, title, description,
           start_at, end_at, timezone, status, location, meeting_url,
           organizer_name, organizer_email, attendee_count, attendees, raw_data, last_synced_at
         )
         VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,NOW()
         )`,
        [
          accountId,
          event.providerEventId,
          event.sourceId ?? null,
          event.sourceName ?? null,
          event.title,
          event.description ?? null,
          event.startAt,
          event.endAt,
          event.timezone ?? null,
          event.status ?? 'confirmed',
          event.location ?? null,
          event.meetingUrl ?? null,
          event.organizerName ?? null,
          normalizeEmail(event.organizerEmail),
          event.attendees?.length ?? 0,
          JSON.stringify(event.attendees ?? []),
          JSON.stringify(event.rawData ?? {}),
        ],
        client,
      );
    }
  });
}

export async function listEvents(workspaceId: string, filters: ListEventsQuery) {
  const values: unknown[] = [workspaceId];
  const where = [`a.workspace_id = $1`, `a.status <> 'disconnected'`];
  if (filters.accountId) where.push(`e.account_id = $${values.push(filters.accountId)}`);
  if (filters.from) where.push(`e.end_at >= $${values.push(filters.from)}`);
  if (filters.to) where.push(`e.start_at <= $${values.push(filters.to)}`);
  if (filters.q) {
    values.push(`%${filters.q}%`);
    where.push(`(e.title ILIKE $${values.length} OR COALESCE(e.description, '') ILIKE $${values.length} OR COALESCE(e.source_name, '') ILIKE $${values.length})`);
  }
  const limitIndex = values.push(filters.limit);
  const { rows } = await query<CalendarEvent>(
    `SELECT
       e.id,
       e.account_id AS "accountId",
       a.provider,
       e.provider_event_id AS "providerEventId",
       e.source_id AS "sourceId",
       e.source_name AS "sourceName",
       e.title,
       e.description,
       e.start_at AS "startAt",
       e.end_at AS "endAt",
       e.timezone,
       e.status,
       e.location,
       e.meeting_url AS "meetingUrl",
       e.organizer_name AS "organizerName",
       e.organizer_email AS "organizerEmail",
       e.attendee_count AS "attendeeCount",
       e.attendees,
       e.raw_data AS "rawData",
       e.last_synced_at AS "lastSyncedAt",
       e.created_at AS "createdAt",
       e.updated_at AS "updatedAt",
       a.email_address AS "accountEmail",
       a.display_name AS "accountDisplayName"
     FROM calendar_events e
     JOIN calendar_accounts a ON a.id = e.account_id
     WHERE ${where.join(' AND ')}
     ORDER BY e.start_at ASC
     LIMIT $${limitIndex}`,
    values,
  );
  return rows;
}

export async function createSyncJob(workspaceId: string, accountId: string, userId: string | null) {
  return withTransaction(async (client) => {
    const { rows } = await query<CalendarSyncJob>(
      `WITH stale_jobs AS (
         UPDATE calendar_sync_jobs
            SET status = 'failed',
                error_code = 'CALENDAR_SYNC_INTERRUPTED',
                error_message = 'Synchronization was interrupted and can be retried.',
                finished_at = NOW()
          WHERE account_id = $2
            AND status IN ('queued', 'running')
            AND COALESCE(started_at, created_at) < NOW() - INTERVAL '15 minutes'
       )
       INSERT INTO calendar_sync_jobs (workspace_id, account_id, requested_by)
       SELECT $1, $2, $3
        WHERE EXISTS (
          SELECT 1
            FROM calendar_accounts
           WHERE workspace_id = $1
             AND id = $2
             AND status <> 'disconnected'
        )
       ON CONFLICT DO NOTHING
       RETURNING ${syncJobSelect}`,
      [workspaceId, accountId, userId],
      client,
    );
    const created = rows[0];
    if (created) {
      await appendDomainEvent({
        workspaceId,
        type: DOMAIN_EVENT_TYPES.CALENDAR_SYNC_REQUESTED,
        aggregateType: 'calendar_sync_job',
        aggregateId: created.id,
        payload: { jobId: created.id, accountId },
        metadata: { actorId: userId, source: 'calendar' },
        idempotencyKey: `calendar-sync:${created.id}:requested:v1`,
      }, client);
      return created;
    }
    const existing = await query<CalendarSyncJob>(
      `SELECT ${syncJobSelect}
         FROM calendar_sync_jobs
        WHERE workspace_id = $1 AND account_id = $2 AND status IN ('queued', 'running')
        ORDER BY created_at DESC
        LIMIT 1`,
      [workspaceId, accountId],
      client,
    );
    return existing.rows[0] ?? null;
  });
}

export async function startSyncJob(jobId: string) {
  const { rows } = await query<{ id: string }>(
    `UPDATE calendar_sync_jobs
        SET status = 'running',
            started_at = NOW(),
            error_code = NULL,
            error_message = NULL
      WHERE id = $1 AND status = 'queued'
      RETURNING id`,
    [jobId],
  );
  return Boolean(rows[0]);
}

export async function listQueuedSyncJobs(limit = 10) {
  const { rows } = await query<CalendarSyncJob>(
    `SELECT ${syncJobSelect}
       FROM calendar_sync_jobs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function dueAccountIds(intervalMinutes: number) {
  const { rows } = await query<{ id: string; workspaceId: string }>(
    `SELECT id, workspace_id AS "workspaceId"
       FROM calendar_accounts
      WHERE (
        status IN ('connected', 'error')
        OR (status = 'syncing' AND updated_at < NOW() - INTERVAL '15 minutes')
      )
        AND (last_sync_at IS NULL OR last_sync_at < NOW() - ($1::integer * INTERVAL '1 minute'))
      ORDER BY COALESCE(last_sync_at, to_timestamp(0)) ASC
      LIMIT 20`,
    [intervalMinutes],
  );
  return rows;
}

export async function getSyncJob(workspaceId: string, accountId: string, jobId: string) {
  const { rows } = await query<CalendarSyncJob>(
    `SELECT ${syncJobSelect}
       FROM calendar_sync_jobs
      WHERE workspace_id = $1 AND account_id = $2 AND id = $3`,
    [workspaceId, accountId, jobId],
  );
  return rows[0] ?? null;
}

export async function finishSyncJob(jobId: string, eventsSynced: number) {
  await withTransaction(async (client) => {
    const { rows } = await query<{ workspaceId: string; accountId: string }>(
      `UPDATE calendar_sync_jobs
          SET status = 'succeeded',
              events_synced = $2,
              finished_at = NOW()
        WHERE id = $1
        RETURNING workspace_id AS "workspaceId", account_id AS "accountId"`,
      [jobId, eventsSynced],
      client,
    );
    const job = rows[0];
    if (job) await appendDomainEvent({
      workspaceId: job.workspaceId,
      type: DOMAIN_EVENT_TYPES.CALENDAR_SYNC_COMPLETED,
      aggregateType: 'calendar_sync_job',
      aggregateId: jobId,
      payload: { jobId, accountId: job.accountId, eventsSynced },
      metadata: { source: 'calendar' },
      idempotencyKey: `calendar-sync:${jobId}:completed:v1`,
    }, client);
  });
}

export async function failSyncJob(jobId: string, code: string, message: string) {
  await withTransaction(async (client) => {
    const { rows } = await query<{ workspaceId: string; accountId: string }>(
      `UPDATE calendar_sync_jobs
          SET status = 'failed',
              error_code = $2,
              error_message = $3,
              finished_at = NOW()
        WHERE id = $1
        RETURNING workspace_id AS "workspaceId", account_id AS "accountId"`,
      [jobId, code, message.slice(0, 2000)],
      client,
    );
    const job = rows[0];
    if (job) await appendDomainEvent({
      workspaceId: job.workspaceId,
      type: DOMAIN_EVENT_TYPES.CALENDAR_SYNC_FAILED,
      aggregateType: 'calendar_sync_job',
      aggregateId: jobId,
      payload: { jobId, accountId: job.accountId, code, message: message.slice(0, 2000) },
      metadata: { source: 'calendar' },
      idempotencyKey: `calendar-sync:${jobId}:failed:v1`,
    }, client);
  });
}
