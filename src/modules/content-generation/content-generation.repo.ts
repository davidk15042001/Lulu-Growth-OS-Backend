import { query, withTransaction } from '../../db/pool.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';

export const CONTENT_MODULES = ['website', 'seo', 'marketing', 'advertisement', 'email', 'analytics', 'competitors', 'knowledge'] as const;
export type ContentModule = typeof CONTENT_MODULES[number];

const jobSelect = `id, workspace_id AS "workspaceId", snapshot_id AS "snapshotId", requested_by AS "requestedBy", status, current_phase AS "currentPhase", progress, modules, module_status AS "moduleStatus", error_message AS "errorMessage", attempt_count AS "attemptCount", worker_id AS "workerId", heartbeat_at AS "heartbeatAt", started_at AS "startedAt", completed_at AS "completedAt", created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function getActiveJob(workspaceId: string) {
  const { rows } = await query(`SELECT ${jobSelect} FROM workspace_content_refresh_jobs WHERE workspace_id=$1 AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`, [workspaceId]);
  return rows[0] ?? null;
}

export async function getJob(workspaceId: string, jobId: string) {
  const { rows } = await query(`SELECT ${jobSelect} FROM workspace_content_refresh_jobs WHERE workspace_id=$1 AND id=$2`, [workspaceId, jobId]);
  return rows[0] ?? null;
}

export async function createJob(workspaceId: string, requestedBy: string, modules: readonly string[]) {
  return withTransaction(async (client) => {
    const { rows } = await query(`INSERT INTO workspace_content_refresh_jobs (workspace_id, requested_by, modules, status, current_phase, progress) VALUES ($1,$2,$3::jsonb,'queued','snapshot',0) RETURNING ${jobSelect}`, [workspaceId, requestedBy, JSON.stringify(modules)], client);
    const job = rows[0];
    if (job) await appendDomainEvent({
      workspaceId,
      type: DOMAIN_EVENT_TYPES.CONTENT_REFRESH_REQUESTED,
      aggregateType: 'content_refresh_job',
      aggregateId: String(job.id),
      payload: { jobId: job.id, modules },
      metadata: { actorId: requestedBy, source: 'content-generation' },
      idempotencyKey: `content-refresh:${job.id}:requested:v1`,
    }, client);
    return job;
  });
}

export async function updateJob(workspaceId: string, jobId: string, patch: Record<string, unknown>) {
  const keys = Object.keys(patch);
  if (!keys.length) return getJob(workspaceId, jobId);
  const assignments = keys.map((key, index) => `${key}=$${index + 3}`).join(', ');
  const values = keys.map((key) => patch[key]);
  return withTransaction(async (client) => {
    const { rows } = await query(`UPDATE workspace_content_refresh_jobs SET ${assignments}, updated_at=NOW() WHERE workspace_id=$1 AND id=$2 RETURNING ${jobSelect}`, [workspaceId, jobId, ...values], client);
    const job = rows[0] ?? null;
    const status = typeof patch.status === 'string' ? patch.status : null;
    if (job && (status === 'completed' || status === 'failed')) await appendDomainEvent({
      workspaceId,
      type: status === 'completed' ? DOMAIN_EVENT_TYPES.CONTENT_REFRESH_COMPLETED : DOMAIN_EVENT_TYPES.CONTENT_REFRESH_FAILED,
      aggregateType: 'content_refresh_job',
      aggregateId: jobId,
      payload: { jobId, status, attemptCount: job.attemptCount },
      metadata: { source: 'content-generation' },
      idempotencyKey: `content-refresh:${jobId}:${status}:attempt:${job.attemptCount}:v1`,
    }, client);
    return job;
  });
}

export async function claimNextJob(workerId: string, leaseSeconds: number, maxAttempts: number) {
  return withTransaction(async (client) => {
    const exhausted = await query<{ id: string; workspaceId: string; attemptCount: number }>(
      `UPDATE workspace_content_refresh_jobs
       SET status='failed', current_phase='failed', completed_at=NOW(),
           error_message='The content refresh exceeded its crash-recovery retry limit.',
           worker_id=NULL, heartbeat_at=NULL
       WHERE status IN ('queued','running') AND attempt_count >= $2
         AND (worker_id IS NULL OR COALESCE(heartbeat_at, updated_at) < NOW() - ($1::integer * INTERVAL '1 second'))
       RETURNING id, workspace_id AS "workspaceId", attempt_count AS "attemptCount"`,
      [leaseSeconds, maxAttempts],
      client,
    );
    for (const job of exhausted.rows) {
      await appendDomainEvent({
        workspaceId: job.workspaceId,
        type: DOMAIN_EVENT_TYPES.CONTENT_REFRESH_FAILED,
        aggregateType: 'content_refresh_job',
        aggregateId: job.id,
        payload: { jobId: job.id, status: 'failed', code: 'CONTENT_REFRESH_RETRY_EXHAUSTED', attemptCount: job.attemptCount },
        metadata: { source: 'content-generation.worker' },
        idempotencyKey: `content-refresh:${job.id}:failed:attempt:${job.attemptCount}:v1`,
      }, client);
    }
    const { rows } = await query(
      `WITH candidate AS (
         SELECT id AS candidate_id
         FROM workspace_content_refresh_jobs
         WHERE status IN ('queued','running') AND attempt_count < $3
           AND (worker_id IS NULL OR COALESCE(heartbeat_at, updated_at) < NOW() - ($2::integer * INTERVAL '1 second'))
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE workspace_content_refresh_jobs AS job
       SET status='running', worker_id=$1, heartbeat_at=NOW(), attempt_count=job.attempt_count + 1,
           started_at=COALESCE(job.started_at, NOW()), error_message=NULL
       FROM candidate
       WHERE job.id=candidate.candidate_id
       RETURNING ${jobSelect}`,
      [workerId, leaseSeconds, maxAttempts],
      client,
    );
    return rows[0] ?? null;
  });
}

export async function heartbeatJob(jobId: string, workerId: string) {
  await query(`UPDATE workspace_content_refresh_jobs SET heartbeat_at=NOW() WHERE id=$1 AND worker_id=$2 AND status='running'`, [jobId, workerId]);
}

export async function releaseJobLease(jobId: string, workerId: string) {
  await query(`UPDATE workspace_content_refresh_jobs SET worker_id=NULL, heartbeat_at=NULL WHERE id=$1 AND worker_id=$2`, [jobId, workerId]);
}

export async function createAsset(input: { workspaceId: string; snapshotId?: string | null; module: ContentModule; title: string; content: Record<string, unknown>; sourceManifest?: Record<string, unknown> }) {
  const { rows } = await query(`INSERT INTO workspace_content_assets (workspace_id, snapshot_id, module, asset_type, language, title, content, status, version, source_manifest, generated_at) VALUES ($1,$2,$3,$4,'en',$5,$6::jsonb,'draft',COALESCE((SELECT MAX(version)+1 FROM workspace_content_assets WHERE workspace_id=$1 AND module=$3),1),$7::jsonb,NOW()) RETURNING id, workspace_id AS "workspaceId", snapshot_id AS "snapshotId", module, asset_type AS "assetType", language, title, content, status, version, source_manifest AS "sourceManifest", generated_at AS "generatedAt", updated_at AS "updatedAt"`, [input.workspaceId, input.snapshotId ?? null, input.module, 'ai_generated_module_result', input.title, JSON.stringify(input.content), JSON.stringify(input.sourceManifest ?? {})]);
  return rows[0] ?? null;
}

export async function listLatestAssets(workspaceId: string, module?: ContentModule) {
  const values: unknown[] = [workspaceId];
  const where = module ? 'AND module=$2' : '';
  if (module) values.push(module);
  const { rows } = await query(`SELECT id, workspace_id AS "workspaceId", snapshot_id AS "snapshotId", module, asset_type AS "assetType", language, title, content, status, version, source_manifest AS "sourceManifest", generated_at AS "generatedAt", approved_at AS "approvedAt", updated_at AS "updatedAt" FROM workspace_content_assets WHERE workspace_id=$1 ${where} AND status <> 'superseded' ORDER BY module, updated_at DESC`, values);
  return rows;
}
