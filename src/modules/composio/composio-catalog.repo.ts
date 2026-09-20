import { query } from '../../db/pool.js';
import { isCustomerRestrictedComposioToolkit } from '../integrations/integration-access.policy.js';

export type ComposioCatalogItem = {
  toolkitSlug: string;
  displayName: string;
  logoUrl: string | null;
  customerAvailable: boolean;
  certificationStatus: string;
  publishedAt: string | null;
};

type CatalogRow = {
  toolkit_slug: string;
  display_name: string;
  logo_url: string | null;
  customer_available: boolean;
  certification_status: string;
  published_at: string | null;
};

function mapRow(row: CatalogRow): ComposioCatalogItem {
  return {
    toolkitSlug: row.toolkit_slug,
    displayName: row.display_name,
    logoUrl: row.logo_url,
    customerAvailable: row.customer_available,
    certificationStatus: row.certification_status,
    publishedAt: row.published_at,
  };
}

export async function syncDiscoveredToolkits(items: Array<{ toolkitSlug: string; displayName: string; logoUrl?: string | null }>) {
  if (items.length === 0) return;
  const values: unknown[] = [];
  const placeholders = items.map((item, index) => {
    const offset = index * 4;
    values.push(item.toolkitSlug, item.displayName, item.logoUrl ?? null, !isCustomerRestrictedComposioToolkit(item.toolkitSlug));
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
  });
  await query(
    `INSERT INTO composio_integration_catalog
      (toolkit_slug, display_name, logo_url, customer_available)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (toolkit_slug) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       logo_url = EXCLUDED.logo_url,
       updated_at = NOW()`,
    values,
  );
}

export async function listCatalogItems(toolkitSlugs?: string[]) {
  const rows = toolkitSlugs?.length
    ? (await query<CatalogRow>(
      `SELECT toolkit_slug, display_name, logo_url, customer_available,
              certification_status, published_at
         FROM composio_integration_catalog
        WHERE toolkit_slug = ANY($1::text[])
        ORDER BY display_name ASC, toolkit_slug ASC`,
      [toolkitSlugs],
    )).rows
    : (await query<CatalogRow>(
      `SELECT toolkit_slug, display_name, logo_url, customer_available,
              certification_status, published_at
         FROM composio_integration_catalog
        ORDER BY display_name ASC, toolkit_slug ASC`,
    )).rows;
  return rows.map(mapRow);
}

export async function isCustomerAvailable(toolkitSlug: string) {
  const row = (await query<{ customer_available: boolean; certification_status: string }>(
    `SELECT customer_available, certification_status
       FROM composio_integration_catalog
      WHERE toolkit_slug = $1`,
    [toolkitSlug],
  )).rows[0];
  return Boolean(row?.customer_available && row.certification_status !== 'REVOKED');
}

export async function setCustomerAvailability(input: {
  toolkitSlug: string;
  displayName: string;
  logoUrl?: string | null;
  customerAvailable: boolean;
  adminUserId: string;
}) {
  const restricted = isCustomerRestrictedComposioToolkit(input.toolkitSlug);
  const customerAvailable = restricted ? false : input.customerAvailable;
  const certificationStatus = customerAvailable ? 'PUBLISHED' : 'REVOKED';
  const row = (await query<CatalogRow>(
    `INSERT INTO composio_integration_catalog
      (toolkit_slug, display_name, logo_url, customer_available, certification_status,
       published_at, published_by_user_id, revoked_at)
     VALUES ($1, $2, $3, $4, $5,
       CASE WHEN $4 THEN NOW() ELSE NULL END,
       CASE WHEN $4 THEN $6::uuid ELSE NULL END,
       CASE WHEN $4 THEN NULL ELSE NOW() END)
     ON CONFLICT (toolkit_slug) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       logo_url = COALESCE(EXCLUDED.logo_url, composio_integration_catalog.logo_url),
       customer_available = EXCLUDED.customer_available,
       certification_status = EXCLUDED.certification_status,
       published_at = EXCLUDED.published_at,
       published_by_user_id = EXCLUDED.published_by_user_id,
       revoked_at = EXCLUDED.revoked_at,
       updated_at = NOW()
     RETURNING toolkit_slug, display_name, logo_url, customer_available,
               certification_status, published_at`,
    [input.toolkitSlug, input.displayName, input.logoUrl ?? null, customerAvailable, certificationStatus, input.adminUserId],
  )).rows[0];
  return row ? mapRow(row) : null;
}
