import { randomBytes } from 'node:crypto';
import { query } from '../../db/pool.js';
import type { WebsiteDomain, WebsiteGenerationJob, WebsiteSite } from './website.types.js';

function mapSite(row: any, domains: WebsiteDomain[] = []): WebsiteSite {
  return { id: row.id, workspaceId: row.workspaceId, provider: row.provider, ownershipMode: row.ownershipMode, name: row.name, externalSiteId: row.externalSiteId ?? null, externalSiteUrl: row.externalSiteUrl ?? null, status: row.status, settings: row.settings ?? {}, domains, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
function mapDomain(row: any): WebsiteDomain { return { id: row.id, siteId: row.siteId, hostname: row.hostname, verificationToken: row.verificationToken, verificationMethod: row.verificationMethod, status: row.status, verifiedAt: row.verifiedAt ?? null, lastError: row.lastError ?? null, createdAt: row.createdAt, updatedAt: row.updatedAt }; }
function mapJob(row: any): WebsiteGenerationJob { return { id: row.id, siteId: row.siteId, prompt: row.prompt, status: row.status, plan: row.plan ?? {}, preview: row.preview ?? {}, providerResult: row.providerResult ?? {}, errorCode: row.errorCode ?? null, errorMessage: row.errorMessage ?? null, createdBy: row.createdBy ?? null, createdAt: row.createdAt, updatedAt: row.updatedAt }; }

const siteSelect = `SELECT id, workspace_id AS "workspaceId", provider, ownership_mode AS "ownershipMode", name, external_site_id AS "externalSiteId", external_site_url AS "externalSiteUrl", status, settings, created_at AS "createdAt", updated_at AS "updatedAt" FROM workspace_sites`;
const domainSelect = `SELECT id, site_id AS "siteId", hostname, verification_token AS "verificationToken", verification_method AS "verificationMethod", status, verified_at AS "verifiedAt", last_error AS "lastError", created_at AS "createdAt", updated_at AS "updatedAt" FROM workspace_site_domains`;

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
export async function createJob(input: { siteId: string; prompt: string; createdBy: string }) {
  const result = await query<any>(`INSERT INTO website_generation_jobs (site_id, prompt, created_by) VALUES ($1,$2,$3) RETURNING id`, [input.siteId, input.prompt.trim(), input.createdBy]);
  return getJob(input.siteId, result.rows[0].id);
}
export async function findActiveJob(siteId: string) {
  const result = await query<any>(`SELECT id, site_id AS "siteId", prompt, status, plan, preview, provider_result AS "providerResult", error_code AS "errorCode", error_message AS "errorMessage", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt" FROM website_generation_jobs WHERE site_id = $1 AND status IN ('queued','planning','generated','preview','publishing') ORDER BY created_at DESC LIMIT 1`, [siteId]);
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

export async function getJob(siteId: string, jobId: string) {
  const result = await query<any>(`SELECT id, site_id AS "siteId", prompt, status, plan, preview, provider_result AS "providerResult", error_code AS "errorCode", error_message AS "errorMessage", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt" FROM website_generation_jobs WHERE site_id = $1 AND id = $2 LIMIT 1`, [siteId, jobId]);
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}
export async function updateJob(siteId: string, jobId: string, patch: { status?: string; plan?: Record<string, unknown>; preview?: Record<string, unknown>; providerResult?: Record<string, unknown>; errorCode?: string | null; errorMessage?: string | null }) {
  const result = await query<any>(`UPDATE website_generation_jobs SET status = COALESCE($3,status), plan = COALESCE($4,plan), preview = COALESCE($5,preview), provider_result = COALESCE($6,provider_result), error_code = $7, error_message = $8 WHERE site_id = $1 AND id = $2 RETURNING id`, [siteId, jobId, patch.status ?? null, patch.plan ? JSON.stringify(patch.plan) : null, patch.preview ? JSON.stringify(patch.preview) : null, patch.providerResult ? JSON.stringify(patch.providerResult) : null, patch.errorCode ?? null, patch.errorMessage ?? null]);
  return result.rowCount ? getJob(siteId, jobId) : null;
}
