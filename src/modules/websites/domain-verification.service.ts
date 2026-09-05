import { Resolver } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { query, withTransaction } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/app-error.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import { getSite } from './website.repo.js';

type Domain = { id: string; hostname: string; verification_token: string; expires_at: string; status: string; updated_at: string; ownership_verified_at: string | null };
type Context = { workspaceId: string; siteId: string; domainId: string; userId: string };
const scoped = 'id=$1 AND site_id=$2 AND site_id IN (SELECT id FROM workspace_sites WHERE workspace_id=$3) AND status<>\'removed\'';
const params = (input: Context) => [input.domainId,input.siteId,input.workspaceId];
export async function checkDnsChallenge(hostname: string, token: string, expiresAt: string, resolveTxt: (name: string) => Promise<string[][]>) {
  if (new Date(expiresAt).getTime() <= Date.now()) return 'DNS_CHALLENGE_EXPIRED';
  try {
    const records = await resolveTxt(`_lulu-verification.${hostname}`);
    return records.some(parts => parts.join('') === token) ? null : 'DNS_CHALLENGE_NOT_FOUND';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENODATA' || code === 'ENOTFOUND' ? 'DNS_CHALLENGE_NOT_FOUND' : 'DNS_LOOKUP_FAILED';
  }
}

export async function verifyDomainOwnership(input: Context, resolveTxt = (name: string) => new Resolver({ timeout: 3000, tries: 2 }).resolveTxt(name)) {
  const domain = await withTransaction(async client => {
    const row = (await query<Domain>(`SELECT * FROM workspace_site_domains WHERE ${scoped} FOR UPDATE`,params(input),client)).rows[0];
    if (!row) throw new AppError(404,'WEBSITE_DOMAIN_NOT_FOUND','Website domain was not found');
    if (row.status==='verified' && row.ownership_verified_at) return null;
    if (['verifying','failed'].includes(row.status) && new Date(row.updated_at).getTime() > Date.now()-30_000) throw new AppError(429,'DNS_RETRY_RATE_LIMITED','Please wait 30 seconds before checking again');
    await query(`UPDATE workspace_site_domains SET status='verifying',updated_at=NOW() WHERE ${scoped}`,params(input),client);
    return row;
  });
  if (!domain) return getSite(input.workspaceId,input.siteId);
  const reason = await checkDnsChallenge(domain.hostname,domain.verification_token,domain.expires_at,resolveTxt);
  await withTransaction(async client => {
    // Compare challenge and expiry again after network I/O; renewal/deletion wins the race.
    const result = await query(`UPDATE workspace_site_domains SET
      status=CASE WHEN expires_at<=NOW() THEN 'expired' WHEN $5::text IS NULL THEN 'verified' ELSE 'failed' END,
      verified_at=CASE WHEN $5::text IS NULL AND expires_at>NOW() THEN NOW() ELSE NULL END,
      ownership_verified_at=CASE WHEN $5::text IS NULL AND expires_at>NOW() THEN NOW() ELSE NULL END,
      last_error=CASE WHEN expires_at<=NOW() THEN 'DNS_CHALLENGE_EXPIRED' ELSE $5 END,updated_at=NOW()
      WHERE ${scoped} AND verification_token=$4 AND status='verifying' RETURNING status,last_error`,
      [...params(input),domain.verification_token,reason],client);
    const row=result.rows[0] as {status:string;last_error:string|null}|undefined;
    if(row) await recordSecurityEvent({eventType:row.status==='verified'?'DOMAIN_VERIFIED':'DOMAIN_VERIFICATION_FAILED',workspaceId:input.workspaceId,userId:input.userId,
      metadata:{domainId:input.domainId,siteId:input.siteId,reason:row.last_error??'dns_txt_matched'}},client);
  });
  return getSite(input.workspaceId,input.siteId);
}

export async function renewDomainChallenge(input: Context) {
  await withTransaction(async client => {
    const row=(await query<Domain>(`SELECT * FROM workspace_site_domains WHERE ${scoped} FOR UPDATE`,params(input),client)).rows[0];
    if(!row) throw new AppError(404,'WEBSITE_DOMAIN_NOT_FOUND','Website domain was not found');
    if(row.status==='verified' && row.ownership_verified_at) return;
    if(new Date(row.updated_at).getTime()>Date.now()-60_000) throw new AppError(429,'DNS_RETRY_RATE_LIMITED','Please wait 60 seconds before renewing');
    await query(`UPDATE workspace_site_domains SET verification_token=$4, verification_method='dns_txt', expires_at=NOW()+$5*INTERVAL '1 hour',status='pending',last_error=NULL,verified_at=NULL,ownership_verified_at=NULL,updated_at=NOW() WHERE ${scoped}`,
      [...params(input),`lulu-site=${randomBytes(24).toString('hex')}`,env.DOMAIN_VERIFICATION_TTL_HOURS],client);
    await recordSecurityEvent({eventType:'DOMAIN_VERIFICATION_ISSUED',workspaceId:input.workspaceId,userId:input.userId,metadata:{domainId:input.domainId,action:'renewed'}},client);
  });
  return getSite(input.workspaceId,input.siteId);
}
