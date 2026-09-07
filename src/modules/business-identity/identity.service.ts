import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';

export type WorkspaceBusinessIdentity = {
  workspaceId: string;
  organization: { id: string; name: string; displayName: string | null; country: string | null; status: string } | null;
  legalEntity: { id: string; legalName: string; registrationCountry: string | null; registrationNumber: string | null; legalForm: string | null; taxIdentifier: string | null; registeredAddress: string | null; status: string; verificationStatus: string } | null;
  factory: { id: string; name: string; factoryCode: string | null; country: string | null; region: string | null; city: string | null; timezone: string | null; defaultCurrency: string | null; defaultLanguage: string | null; status: string } | null;
  brands: Array<{ id: string; name: string; domain: string | null; logoUrl: string | null; status: string }>;
  locations: Array<{ id: string; type: string; country: string | null; region: string | null; city: string | null; timezone: string | null; status: string }>;
};

export async function getWorkspaceBusinessIdentity(workspaceId: string): Promise<WorkspaceBusinessIdentity> {
  const [identity, brands, locations] = await Promise.all([
    query<WorkspaceBusinessIdentity['organization'] & WorkspaceBusinessIdentity['legalEntity'] & WorkspaceBusinessIdentity['factory'] & { workspaceId: string }>(
      `SELECT w.id AS "workspaceId", o.id AS "organizationId", o.name AS "organizationName", o.display_name AS "organizationDisplayName", o.country AS "organizationCountry", o.status AS "organizationStatus",
              le.id AS "legalEntityId", le.legal_name AS "legalName", le.registration_country AS "registrationCountry", le.registration_number AS "registrationNumber", le.legal_form AS "legalForm", le.tax_identifier AS "taxIdentifier", le.registered_address AS "registeredAddress", le.status AS "legalEntityStatus", le.verification_status AS "verificationStatus",
              f.id AS "factoryId", f.name AS "factoryName", f.factory_code AS "factoryCode", f.country AS "factoryCountry", f.region AS "factoryRegion", f.city AS "factoryCity", f.timezone AS "factoryTimezone", f.default_currency AS "defaultCurrency", f.default_language AS "defaultLanguage", f.status AS "factoryStatus"
         FROM workspaces w
         LEFT JOIN organizations o ON o.id = w.organization_id
         LEFT JOIN legal_entities le ON le.organization_id = o.id
         LEFT JOIN factories f ON f.id = w.factory_id
        WHERE w.id = $1 AND w.deleted_at IS NULL`,
      [workspaceId],
    ),
    query<WorkspaceBusinessIdentity['brands'][number]>(`SELECT id,name,domain,logo_url AS "logoUrl",status FROM brands WHERE workspace_id=$1 ORDER BY created_at`, [workspaceId]),
    query<WorkspaceBusinessIdentity['locations'][number]>(`SELECT id,type,country,region,city,timezone,status FROM locations l JOIN factories f ON f.id=l.factory_id WHERE f.source_workspace_id=$1 ORDER BY l.created_at`, [workspaceId]),
  ]);
  const row = identity.rows[0] as (Record<string, unknown> & { workspaceId: string }) | undefined;
  return {
    workspaceId,
    organization: row?.organizationId ? { id: String(row.organizationId), name: String(row.organizationName ?? ''), displayName: row.organizationDisplayName ? String(row.organizationDisplayName) : null, country: row.organizationCountry ? String(row.organizationCountry) : null, status: String(row.organizationStatus ?? 'active') } : null,
    legalEntity: row?.legalEntityId ? { id: String(row.legalEntityId), legalName: String(row.legalName ?? ''), registrationCountry: row.registrationCountry ? String(row.registrationCountry) : null, registrationNumber: row.registrationNumber ? String(row.registrationNumber) : null, legalForm: row.legalForm ? String(row.legalForm) : null, taxIdentifier: row.taxIdentifier ? String(row.taxIdentifier) : null, registeredAddress: row.registeredAddress ? String(row.registeredAddress) : null, status: String(row.legalEntityStatus ?? 'active'), verificationStatus: String(row.verificationStatus ?? 'unverified') } : null,
    factory: row?.factoryId ? { id: String(row.factoryId), name: String(row.factoryName ?? ''), factoryCode: row.factoryCode ? String(row.factoryCode) : null, country: row.factoryCountry ? String(row.factoryCountry) : null, region: row.factoryRegion ? String(row.factoryRegion) : null, city: row.factoryCity ? String(row.factoryCity) : null, timezone: row.factoryTimezone ? String(row.factoryTimezone) : null, defaultCurrency: row.defaultCurrency ? String(row.defaultCurrency) : null, defaultLanguage: row.defaultLanguage ? String(row.defaultLanguage) : null, status: String(row.factoryStatus ?? 'active') } : null,
    brands: brands.rows,
    locations: locations.rows,
  };
}

/** Called by workspace creation so newly created tenants receive the same
 * identity mapping as the deterministic migration backfill. */
export async function ensureWorkspaceBusinessIdentity(input: {
  workspaceId: string;
  name: string;
  country?: string | null;
  taxIdentifier?: string | null;
  address?: string | null;
  legalForm?: string | null;
}, client: PoolClient) {
  const org = (await query<{ id: string }>(
    `INSERT INTO organizations(source_workspace_id,name,display_name,country)
     VALUES($1,$2,$2,$3)
     ON CONFLICT(source_workspace_id) DO UPDATE SET name=EXCLUDED.name, display_name=EXCLUDED.display_name, country=EXCLUDED.country
     RETURNING id`,
    [input.workspaceId, input.name, input.country ?? null], client,
  )).rows[0];
  if (!org) throw new Error('Organization identity insert did not return a row');
  await query(
    `INSERT INTO legal_entities(organization_id,legal_name,registration_country,legal_form,tax_identifier,registered_address)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (organization_id, legal_name) DO UPDATE SET
       registration_country=EXCLUDED.registration_country,
       legal_form=EXCLUDED.legal_form,
       tax_identifier=EXCLUDED.tax_identifier,
       registered_address=EXCLUDED.registered_address`,
    [org.id, input.name, input.country ?? null, input.legalForm ?? null, input.taxIdentifier ?? null, input.address ?? null], client,
  );
  const legalEntity = (await query<{ id: string }>(`SELECT id FROM legal_entities WHERE organization_id=$1 ORDER BY created_at LIMIT 1`, [org.id], client)).rows[0];
  const factory = (await query<{ id: string }>(
    `INSERT INTO factories(source_workspace_id,organization_id,legal_entity_id,name,factory_code,country,timezone,default_language)
     VALUES($1::uuid,$2::uuid,$3::uuid,$4,'WS-' || upper(substr(replace($1::text,'-',''),1,12)),$5,'UTC','en')
     ON CONFLICT(source_workspace_id) DO UPDATE SET name=EXCLUDED.name, country=EXCLUDED.country
     RETURNING id`,
    [input.workspaceId, org.id, legalEntity?.id ?? null, input.name, input.country ?? null], client,
  )).rows[0];
  if (!factory) throw new Error('Factory identity insert did not return a row');
  await query(`UPDATE workspaces SET organization_id=$2, factory_id=$3 WHERE id=$1`, [input.workspaceId, org.id, factory.id], client);
  return { organizationId: org.id, factoryId: factory.id };
}
