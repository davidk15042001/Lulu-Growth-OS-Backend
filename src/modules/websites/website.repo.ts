import { randomBytes } from 'node:crypto';
import { query } from '../../db/pool.js';
import type { WebsiteDomain, WebsiteGenerationJob, WebsiteGenerationWorkItem, WebsiteSite } from './website.types.js';

function mapSite(row: any, domains: WebsiteDomain[] = []): WebsiteSite {
  return { id: row.id, workspaceId: row.workspaceId, provider: row.provider, ownershipMode: row.ownershipMode, name: row.name, externalSiteId: row.externalSiteId ?? null, externalSiteUrl: row.externalSiteUrl ?? null, status: row.status, settings: row.settings ?? {}, domains, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
function mapDomain(row: any): WebsiteDomain { return { id: row.id, siteId: row.siteId, hostname: row.hostname, verificationToken: row.verificationToken, verificationMethod: row.verificationMethod, status: row.status, verifiedAt: row.verifiedAt ?? null, lastError: row.lastError ?? null, createdAt: row.createdAt, updatedAt: row.updatedAt }; }
function mapJob(row: any): WebsiteGenerationJob {
  return {
    id: row.id,
    siteId: row.siteId,
    prompt: row.prompt,
    status: row.status,
    plan: row.plan ?? {},
    preview: row.preview ?? {},
    providerResult: row.providerResult ?? {},
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    createdBy: row.createdBy ?? null,
    requestedLanguage: row.requestedLanguage ?? null,
    autoPublish: Boolean(row.autoPublish),
    attemptCount: Number(row.attemptCount ?? 0),
    heartbeatAt: row.heartbeatAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const siteSelect = `SELECT id, workspace_id AS "workspaceId", provider, ownership_mode AS "ownershipMode", name, external_site_id AS "externalSiteId", external_site_url AS "externalSiteUrl", status, settings, created_at AS "createdAt", updated_at AS "updatedAt" FROM workspace_sites`;
const domainSelect = `SELECT id, site_id AS "siteId", hostname, verification_token AS "verificationToken", verification_method AS "verificationMethod", status, verified_at AS "verifiedAt", last_error AS "lastError", created_at AS "createdAt", updated_at AS "updatedAt" FROM workspace_site_domains`;
const jobSelect = `SELECT id, site_id AS "siteId", prompt, status, plan, preview, provider_result AS "providerResult", error_code AS "errorCode", error_message AS "errorMessage", created_by AS "createdBy", requested_language AS "requestedLanguage", auto_publish AS "autoPublish", attempt_count AS "attemptCount", heartbeat_at AS "heartbeatAt", created_at AS "createdAt", updated_at AS "updatedAt" FROM website_generation_jobs`;

export async function listSites(workspaceId: string) {
  const [sites, domains] = await Promise.all([
    query<any>(`${siteSelect} WHERE workspace_id = $1 ORDER BY updated_at DESC`, [workspaceId]),
    query<any>(`${domainSelect} WHERE site_id IN (SELECT id FROM workspace_sites WHERE workspace_id = $1) AND status <> 'removed' ORDER BY created_at`, [workspaceId]),
  ]);
  const domainMap = new Map<string, WebsiteDomain[]>();
  for (const row of domains.rows) { const value = domainMap.get(row.siteId) ?? []; value.push(mapDomain(row)); domainMap.set(row.siteId, value); }
  return sites.rows.map((row: any) => mapSite(row, domainMap.get(row.id) ?? []));
}
export async function findSiteByExternalSiteId(workspaceId: string, provider: string, externalSiteId: string) {
  const result = await query<any>(`${siteSelect} WHERE workspace_id = $1 AND provider = $2 AND external_site_id = $3 LIMIT 1`, [workspaceId, provider, externalSiteId]);
  if (!result.rows[0]) return null;
  const domains = await query<any>(`${domainSelect} WHERE site_id = $1 AND status <> 'removed' ORDER BY created_at`, [result.rows[0].id]);
  return mapSite(result.rows[0], domains.rows.map(mapDomain));
}

export async function deleteSitesByProvider(workspaceId: string, provider: string) {
  const result = await query(`DELETE FROM workspace_sites WHERE workspace_id = $1 AND provider = $2`, [workspaceId, provider]);
  return result.rowCount ?? 0;
}

export async function deleteSitesByProviderExcept(workspaceId: string, provider: string, externalSiteIds: string[]) {
  if (externalSiteIds.length === 0) return deleteSitesByProvider(workspaceId, provider);
  const result = await query(
    `DELETE FROM workspace_sites
     WHERE workspace_id = $1 AND provider = $2
       AND (external_site_id IS NULL OR NOT (external_site_id = ANY($3::text[])))`,
    [workspaceId, provider, externalSiteIds],
  );
  return result.rowCount ?? 0;
}

export async function updateSiteExternalDetails(workspaceId: string, siteId: string, name: string, externalSiteUrl?: string) {
  const result = await query<any>(
    `UPDATE workspace_sites SET name = $3, external_site_url = COALESCE($4, external_site_url), updated_at = NOW()
     WHERE workspace_id = $1 AND id = $2 RETURNING id`,
    [workspaceId, siteId, name.trim(), externalSiteUrl ?? null],
  );
  return result.rowCount ? getSite(workspaceId, siteId) : null;
}

export async function updateSiteStatus(workspaceId: string, siteId: string, status: string) {
  const result = await query<any>(`UPDATE workspace_sites SET status = $3 WHERE workspace_id = $1 AND id = $2 RETURNING id`, [workspaceId, siteId, status]);
  return result.rowCount ? getSite(workspaceId, siteId) : null;
}

export async function updateSiteSettings(workspaceId: string, siteId: string, settings: Record<string, unknown>) {
  const result = await query<any>(`UPDATE workspace_sites SET settings = COALESCE(settings, '{}'::jsonb) || $3::jsonb WHERE workspace_id = $1 AND id = $2 RETURNING id`, [workspaceId, siteId, JSON.stringify(settings)]);
  return result.rowCount ? getSite(workspaceId, siteId) : null;
}

export async function getSite(workspaceId: string, siteId: string) {
  const site = await query<any>(`${siteSelect} WHERE workspace_id = $1 AND id = $2 LIMIT 1`, [workspaceId, siteId]);
  if (!site.rows[0]) return null;
  const domains = await query<any>(`${domainSelect} WHERE site_id = $1 AND status <> 'removed' ORDER BY created_at`, [siteId]);
  return mapSite(site.rows[0], domains.rows.map(mapDomain));
}
export async function createSite(input: { workspaceId: string; provider: string; ownershipMode: string; name: string; externalSiteId?: string | undefined; externalSiteUrl?: string | undefined }) {
  const result = await query<any>(`INSERT INTO workspace_sites (workspace_id, provider, ownership_mode, name, external_site_id, external_site_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [input.workspaceId, input.provider, input.ownershipMode, input.name.trim(), input.externalSiteId ?? null, input.externalSiteUrl ?? null]);
  return getSite(input.workspaceId, result.rows[0].id);
}
export async function createDomain(siteId: string, hostname: string) {
  const token = `lulu-site=${randomBytes(18).toString('hex')}`;
  const result = await query<any>(`INSERT INTO workspace_site_domains (site_id, hostname, verification_token) VALUES ($1, lower($2), $3) RETURNING id`, [siteId, hostname.trim(), token]);
  const domain = await query<any>(`${domainSelect} WHERE id = $1`, [result.rows[0].id]);
  return mapDomain(domain.rows[0]);
}
export async function markDomainVerified(siteId: string, domainId: string) {
  const result = await query<any>(`UPDATE workspace_site_domains SET status = 'verified', verified_at = NOW(), last_error = NULL WHERE id = $1 AND site_id = $2 RETURNING id`, [domainId, siteId]);
  return result.rowCount ? true : false;
}
export async function createJob(input: { siteId: string; prompt: string; createdBy: string; requestedLanguage?: string; autoPublish?: boolean }) {
  const result = await query<any>(
    `INSERT INTO website_generation_jobs (site_id, prompt, created_by, requested_language, auto_publish)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (site_id) WHERE status IN ('queued','planning','generated','preview','publishing') DO NOTHING
     RETURNING id`,
    [input.siteId, input.prompt.trim(), input.createdBy, input.requestedLanguage ?? null, input.autoPublish ?? false],
  );
  if (result.rows[0]) return { job: await getJob(input.siteId, result.rows[0].id), created: true };
  return { job: await findActiveJob(input.siteId), created: false };
}
export async function findActiveJob(siteId: string) {
  const result = await query<any>(`${jobSelect} WHERE site_id = $1 AND status IN ('queued','planning','generated','preview','publishing') ORDER BY created_at DESC LIMIT 1`, [siteId]);
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

export async function failExhaustedJobs(maxAttempts: number, leaseSeconds: number, siteId?: string) {
  await query(
    `UPDATE website_generation_jobs
     SET status = 'failed',
         error_code = 'WEBSITE_GENERATION_RETRY_EXHAUSTED',
         error_message = 'Website generation was interrupted repeatedly and could not be resumed.',
         worker_id = NULL,
         locked_at = NULL,
         heartbeat_at = NOW()
     WHERE status IN ('planning','publishing','generated','preview')
       AND (status NOT IN ('generated','preview') OR auto_publish = TRUE)
       AND attempt_count >= $1
       AND COALESCE(heartbeat_at, locked_at, updated_at) < NOW() - ($2::int * INTERVAL '1 second')
       AND ($3::uuid IS NULL OR site_id = $3::uuid)`,
    [maxAttempts, leaseSeconds, siteId ?? null],
  );
}

export async function getJob(siteId: string, jobId: string) {
  const result = await query<any>(`${jobSelect} WHERE site_id = $1 AND id = $2 LIMIT 1`, [siteId, jobId]);
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}
export async function updateJob(siteId: string, jobId: string, patch: { status?: string; plan?: Record<string, unknown>; preview?: Record<string, unknown>; providerResult?: Record<string, unknown>; errorCode?: string | null; errorMessage?: string | null }) {
  const result = await query<any>(
    `UPDATE website_generation_jobs
     SET status = COALESCE($3,status),
         plan = COALESCE($4,plan),
         preview = COALESCE($5,preview),
         provider_result = COALESCE($6,provider_result),
         error_code = $7,
         error_message = $8,
         worker_id = CASE WHEN $3 IN ('published','failed','cancelled') THEN NULL ELSE worker_id END,
         locked_at = CASE WHEN $3 IN ('published','failed','cancelled') THEN NULL ELSE locked_at END,
         heartbeat_at = CASE WHEN $3 IS NOT NULL THEN NOW() ELSE heartbeat_at END
     WHERE site_id = $1 AND id = $2
       AND (status <> 'cancelled' OR $3 IS NULL OR $3 = 'cancelled')
     RETURNING id`,
    [siteId, jobId, patch.status ?? null, patch.plan ? JSON.stringify(patch.plan) : null, patch.preview ? JSON.stringify(patch.preview) : null, patch.providerResult ? JSON.stringify(patch.providerResult) : null, patch.errorCode ?? null, patch.errorMessage ?? null],
  );
  return result.rowCount ? getJob(siteId, jobId) : null;
}

export async function findLatestCancelledJob(siteId: string) {
  const result = await query<any>(`${jobSelect} WHERE site_id = $1 AND status = 'cancelled' ORDER BY updated_at DESC LIMIT 1`, [siteId]);
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

export async function cancelJob(siteId: string, jobId: string) {
  const result = await query(
    `UPDATE website_generation_jobs
     SET status = 'cancelled',
         preview = jsonb_set(
           COALESCE(preview, '{}'::jsonb),
           '{progress}',
           COALESCE(preview->'progress', '{}'::jsonb) || '{"phase":"cancelled"}'::jsonb,
           TRUE
         ),
         error_code = 'WEBSITE_GENERATION_CANCELLED',
         error_message = 'Website generation was cancelled by the user.',
         worker_id = NULL,
         locked_at = NULL,
         heartbeat_at = NOW()
     WHERE site_id = $1 AND id = $2
       AND status IN ('queued','planning','generated','preview','publishing','cancelled')
     RETURNING id`,
    [siteId, jobId],
  );
  const job = await getJob(siteId, jobId);
  return { job, cancelled: (result.rowCount ?? 0) > 0 };
}

export async function resumeJob(siteId: string, jobId: string) {
  const result = await query(
    `UPDATE website_generation_jobs
     SET status = 'queued',
         preview = jsonb_set(
           COALESCE(preview, '{}'::jsonb),
           '{progress}',
           COALESCE(preview->'progress', '{}'::jsonb) || '{"phase":"resuming"}'::jsonb,
           TRUE
         ),
         error_code = NULL,
         error_message = NULL,
         attempt_count = 0,
         worker_id = NULL,
         locked_at = NULL,
         heartbeat_at = NOW()
     WHERE site_id = $1 AND id = $2 AND status = 'cancelled'
     RETURNING id`,
    [siteId, jobId],
  );
  const job = await getJob(siteId, jobId);
  return { job, resumed: (result.rowCount ?? 0) > 0 };
}

export async function claimNextGenerationJob(workerId: string, leaseSeconds: number, maxAttempts: number): Promise<WebsiteGenerationWorkItem | null> {
  const result = await query<any>(
    `WITH candidate AS (
       SELECT job.id
       FROM website_generation_jobs AS job
       WHERE (
         job.status = 'queued'
         OR (
           job.status IN ('planning','publishing')
           AND job.attempt_count < $3
           AND COALESCE(job.heartbeat_at, job.locked_at, job.updated_at) < NOW() - ($2::int * INTERVAL '1 second')
         )
         OR (
           job.status IN ('generated','preview')
           AND job.auto_publish = TRUE
           AND job.attempt_count < $3
           AND (job.worker_id IS NULL OR COALESCE(job.heartbeat_at, job.locked_at, job.updated_at) < NOW() - ($2::int * INTERVAL '1 second'))
         )
       )
       ORDER BY job.created_at
       FOR UPDATE OF job SKIP LOCKED
       LIMIT 1
     )
     UPDATE website_generation_jobs AS job
     SET status = CASE
           WHEN job.auto_publish = TRUE AND job.status IN ('generated','preview','publishing') THEN 'publishing'
           ELSE 'planning'
         END,
         attempt_count = job.attempt_count + 1,
         worker_id = $1,
         locked_at = NOW(),
         heartbeat_at = NOW(),
         error_code = NULL,
         error_message = NULL
     FROM candidate, workspace_sites AS site
     WHERE job.id = candidate.id AND site.id = job.site_id
     RETURNING job.id, job.site_id AS "siteId", job.prompt, job.status, job.plan, job.preview,
       job.provider_result AS "providerResult", job.error_code AS "errorCode", job.error_message AS "errorMessage",
       job.created_by AS "createdBy", job.requested_language AS "requestedLanguage", job.auto_publish AS "autoPublish",
       job.attempt_count AS "attemptCount", job.heartbeat_at AS "heartbeatAt", job.created_at AS "createdAt",
       job.updated_at AS "updatedAt", site.workspace_id AS "workspaceId", site.provider, site.ownership_mode AS "ownershipMode"`,
    [workerId, leaseSeconds, maxAttempts],
  );
  if (!result.rows[0]) return null;
  return { ...mapJob(result.rows[0]), workspaceId: result.rows[0].workspaceId, provider: result.rows[0].provider, ownershipMode: result.rows[0].ownershipMode };
}

export async function heartbeatJob(siteId: string, jobId: string, workerId: string) {
  const result = await query(
    `UPDATE website_generation_jobs
     SET heartbeat_at = NOW()
     WHERE site_id = $1 AND id = $2 AND worker_id = $3 AND status IN ('planning','generated','preview','publishing')`,
    [siteId, jobId, workerId],
  );
  return result.rowCount > 0;
}

export async function releaseJob(siteId: string, jobId: string, workerId: string) {
  await query(
    `UPDATE website_generation_jobs
     SET worker_id = NULL, locked_at = NULL, heartbeat_at = NOW()
     WHERE site_id = $1 AND id = $2 AND worker_id = $3`,
    [siteId, jobId, workerId],
  );
}
