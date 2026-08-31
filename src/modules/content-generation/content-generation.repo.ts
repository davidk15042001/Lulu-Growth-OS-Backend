import { query } from '../../db/pool.js';

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
  const { rows } = await query(`INSERT INTO workspace_content_refresh_jobs (workspace_id, requested_by, modules, status, current_phase, progress) VALUES ($1,$2,$3::jsonb,'queued','snapshot',0) RETURNING ${jobSelect}`, [workspaceId, requestedBy, JSON.stringify(modules)]);
  return rows[0];
}

export async function updateJob(workspaceId: string, jobId: string, patch: Record<string, unknown>) {
  const keys = Object.keys(patch);
  if (!keys.length) return getJob(workspaceId, jobId);
  const assignments = keys.map((key, index) => `${key}=$${index + 3}`).join(', ');
  const values = keys.map((key) => patch[key]);
  const { rows } = await query(`UPDATE workspace_content_refresh_jobs SET ${assignments}, updated_at=NOW() WHERE workspace_id=$1 AND id=$2 RETURNING ${jobSelect}`, [workspaceId, jobId, ...values]);
  return rows[0] ?? null;
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
