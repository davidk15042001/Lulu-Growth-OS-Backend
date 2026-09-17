import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';

export type IntegrationSyncJob = {
  id: string;
  workspaceId: string;
  platformId: string;
  runId: string;
  integrationKey: string | null;
  platformName: string;
  connectionStatus: string;
  externalAccountId: string | null;
  attempts: number;
  maxAttempts: number;
};

export type IntegrationSyncFinishInput = {
  job: IntegrationSyncJob;
  workerId: string;
  status: 'succeeded' | 'failed';
  recordsProcessed?: number;
  recordsFailed?: number;
  result?: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
  retryable?: boolean;
};

function boundedCount(value: number | undefined) {
  return Math.max(0, Math.min(2_147_483_647, Math.trunc(value ?? 0)));
}

function retryDelaySeconds(attempt: number) {
  return Math.min(300, 5 * (2 ** Math.max(0, attempt - 1)));
}

async function terminalizeExhaustedJobs(client: PoolClient, leaseSeconds: number) {
  const exhausted = await query<{ id: string; workspaceId: string; platformId: string; attempts: number }>(
    `WITH exhausted AS (
       SELECT job.id,
              job.workspace_id AS "workspaceId",
              job.payload->>'platformId' AS "platformId",
              job.attempts
         FROM background_jobs job
        WHERE job.job_type='integration.sync'
          AND job.status IN ('queued','running')
          AND job.attempts >= job.max_attempts
          AND (
            job.status='queued'
            OR COALESCE(job.heartbeat_at, job.started_at, job.updated_at)
              < NOW() - ($1::integer * INTERVAL '1 second')
          )
        FOR UPDATE SKIP LOCKED
     )
     UPDATE background_jobs job
        SET status='failed', completed_at=NOW(), worker_id=NULL, heartbeat_at=NULL,
            error_message='Integration sync exceeded the retry limit',
            result=jsonb_build_object('code','INTEGRATION_SYNC_RETRY_LIMIT','attempts',job.attempts),
            updated_at=NOW()
       FROM exhausted
      WHERE job.id=exhausted.id
      RETURNING exhausted.id, exhausted."workspaceId", exhausted."platformId", exhausted.attempts`,
    [leaseSeconds],
    client,
  );
  for (const job of exhausted.rows) {
    await query(
      `UPDATE integration_sync_runs
          SET status='failed', completed_at=NOW(), records_failed=GREATEST(records_failed, 1),
              error_details=jsonb_build_object('code','INTEGRATION_SYNC_RETRY_LIMIT','attempts',$2)
        WHERE job_id=$1 AND status IN ('queued','running')`,
      [job.id, job.attempts],
      client,
    );
    if (job.platformId) {
      await query(
        `UPDATE workspace_platforms
            SET connection_status='error', last_error='Integration sync exceeded the retry limit', updated_at=NOW()
          WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`,
        [job.platformId, job.workspaceId],
        client,
      );
    }
    await appendDomainEvent({
      workspaceId: job.workspaceId,
      type: DOMAIN_EVENT_TYPES.INTEGRATION_SYNC_FAILED,
      aggregateType: 'workspace_platform',
      aggregateId: job.platformId,
      payload: { jobId: job.id, code: 'INTEGRATION_SYNC_RETRY_LIMIT', attempts: job.attempts, retrying: false },
      metadata: { source: 'integration-sync.worker' },
      idempotencyKey: `integration-sync:${job.id}:failed:${job.attempts}`,
    }, client);
  }
}

export async function claimNextIntegrationSyncJob(workerId: string, leaseSeconds: number) {
  return withTransaction(async (client) => {
    await terminalizeExhaustedJobs(client, leaseSeconds);
    const { rows } = await query<IntegrationSyncJob>(
      `WITH candidate AS (
         SELECT job.id
           FROM background_jobs job
          WHERE job.job_type='integration.sync'
            AND job.attempts < job.max_attempts
            AND (
              (job.status='queued' AND job.scheduled_at <= NOW())
              OR (job.status='running' AND COALESCE(job.heartbeat_at, job.started_at, job.updated_at)
                < NOW() - ($1::integer * INTERVAL '1 second'))
            )
          ORDER BY job.scheduled_at ASC, job.created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE background_jobs job
          SET status='running', attempts=job.attempts+1, started_at=NOW(), heartbeat_at=NOW(),
              worker_id=$2, completed_at=NULL, error_message=NULL, updated_at=NOW()
         FROM candidate
        WHERE job.id=candidate.id
      RETURNING job.id, job.workspace_id AS "workspaceId",
                job.payload->>'platformId' AS "platformId",
                job.attempts, job.max_attempts AS "maxAttempts"`,
      [leaseSeconds, workerId],
      client,
    );
    const claimed = rows[0];
    if (!claimed?.platformId) return null;
    const details = await query<IntegrationSyncJob>(
      `SELECT job.id,
              job.workspace_id AS "workspaceId",
              platform.id AS "platformId",
              run.id AS "runId",
              platform.integration_key AS "integrationKey",
              platform.name AS "platformName",
              platform.connection_status AS "connectionStatus",
              platform.external_account_id AS "externalAccountId",
              job.attempts,
              job.max_attempts AS "maxAttempts"
         FROM background_jobs job
         JOIN integration_sync_runs run ON run.job_id=job.id
         JOIN workspace_platforms platform
           ON platform.id::text=job.payload->>'platformId'
          AND platform.workspace_id=job.workspace_id
        WHERE job.id=$1
          AND platform.deleted_at IS NULL
        ORDER BY run.created_at DESC
        LIMIT 1`,
      [claimed.id],
      client,
    );
    const job = details.rows[0];
    if (!job) {
      await query(
        `UPDATE background_jobs
            SET status='failed', completed_at=NOW(), worker_id=NULL, heartbeat_at=NULL,
                error_message='Integration platform or sync run no longer exists',
                result=jsonb_build_object('code','INTEGRATION_PLATFORM_NOT_FOUND'), updated_at=NOW()
          WHERE id=$1 AND worker_id=$2 AND status='running'`,
        [claimed.id, workerId],
        client,
      );
      return null;
    }
    await query(
      `UPDATE integration_sync_runs
          SET status='running', started_at=COALESCE(started_at,NOW()), error_details=NULL
        WHERE id=$1 AND platform_id=$2`,
      [job.runId, job.platformId],
      client,
    );
    await query(
      `UPDATE workspace_platforms SET connection_status='syncing', last_error=NULL, updated_at=NOW()
        WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`,
      [job.platformId, job.workspaceId],
      client,
    );
    return job;
  });
}

export async function heartbeatIntegrationSyncJob(jobId: string, workerId: string) {
  await query(
    `UPDATE background_jobs SET heartbeat_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND job_type='integration.sync' AND worker_id=$2 AND status='running'`,
    [jobId, workerId],
  );
}

export async function finishIntegrationSyncJob(input: IntegrationSyncFinishInput) {
  const recordsProcessed = boundedCount(input.recordsProcessed);
  const recordsFailed = boundedCount(input.recordsFailed);
  const errorMessage = input.errorMessage ? input.errorMessage.slice(0, 2_000) : null;
  const errorCode = input.errorCode?.slice(0, 120) ?? null;
  const retrying = input.status === 'failed' && input.retryable === true && input.job.attempts < input.job.maxAttempts;
  const nextRunStatus = input.status === 'succeeded' ? (recordsFailed > 0 ? 'partial' : 'succeeded') : retrying ? 'queued' : 'failed';
  const delaySeconds = retryDelaySeconds(input.job.attempts);

  const applied = await withTransaction(async (client) => {
    const updated = await query(
      `UPDATE background_jobs
          SET status=$4::text,
              scheduled_at=CASE WHEN $4='queued' THEN NOW()+($5::integer * INTERVAL '1 second') ELSE scheduled_at END,
              completed_at=CASE WHEN $4='queued' THEN NULL ELSE NOW() END,
              heartbeat_at=NULL, worker_id=NULL,
              error_message=$6,
              result=$7::jsonb,
              updated_at=NOW()
        WHERE id=$1 AND workspace_id=$2 AND job_type='integration.sync'
          AND worker_id=$3 AND status='running'`,
      [input.job.id, input.job.workspaceId, input.workerId, retrying ? 'queued' : input.status, delaySeconds, errorMessage, JSON.stringify({
        ...(input.result ?? {}),
        ...(errorCode ? { code: errorCode } : {}),
        ...(input.status === 'failed' ? { retrying, attempts: input.job.attempts } : {}),
      })],
      client,
    );
    if (updated.rowCount !== 1) return false;
    await query(
      `UPDATE integration_sync_runs
          SET status=$3::text, records_processed=$4, records_failed=$5,
              completed_at=CASE WHEN $3 IN ('succeeded','partial','failed') THEN NOW() ELSE NULL END,
              error_details=$6::jsonb
        WHERE id=$1 AND platform_id=$2`,
      [input.job.runId, input.job.platformId, nextRunStatus, recordsProcessed, recordsFailed, JSON.stringify(errorMessage || errorCode ? { code: errorCode, message: errorMessage, retrying } : null)],
      client,
    );
    await query(
      `UPDATE workspace_platforms
          SET connection_status=$3,
              last_synced_at=CASE WHEN $3='connected' THEN NOW() ELSE last_synced_at END,
              last_error=$4, updated_at=NOW()
        WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL`,
      [input.job.platformId, input.job.workspaceId, input.status === 'succeeded' ? 'connected' : 'error', errorMessage],
      client,
    );
    const eventType = input.status === 'succeeded' ? DOMAIN_EVENT_TYPES.INTEGRATION_SYNC_COMPLETED : DOMAIN_EVENT_TYPES.INTEGRATION_SYNC_FAILED;
    await appendDomainEvent({
      workspaceId: input.job.workspaceId,
      type: eventType,
      aggregateType: 'workspace_platform',
      aggregateId: input.job.platformId,
      payload: {
        jobId: input.job.id,
        runId: input.job.runId,
        integrationKey: input.job.integrationKey,
        recordsProcessed,
        recordsFailed,
        ...(errorCode ? { code: errorCode } : {}),
        ...(errorMessage ? { message: errorMessage } : {}),
        ...(input.status === 'failed' ? { retrying } : {}),
      },
      metadata: { source: 'integration-sync.worker', attempt: input.job.attempts },
      idempotencyKey: `integration-sync:${input.job.id}:${input.status}:${input.job.attempts}`,
    }, client);
    return true;
  });
  return { applied, retrying };
}
