import { query, withTransaction } from '../db/pool.js';

const R2_PROVIDER_STORAGE_USD_PER_GB_MONTH = 0.015;
const R2_PROVIDER_CLASS_A_USD_PER_MILLION = 4.5;
const R2_PROVIDER_CLASS_B_USD_PER_MILLION = 0.36;
const R2_CUSTOMER_STORAGE_USD_PER_GB_MONTH = 0.2165;
const R2_CUSTOMER_CLASS_A_USD_PER_MILLION = 4.95;
const R2_CUSTOMER_CLASS_B_USD_PER_MILLION = 0.396;

function workspaceIdFromKey(key: string) {
  return /^workspaces\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/|$)/i.exec(key)?.[1]?.toLowerCase() ?? null;
}

const ledgerCostSql = `
  provider_cost_usd=(storage_gb_month * ${R2_PROVIDER_STORAGE_USD_PER_GB_MONTH}
    + class_a_operations / 1000000 * ${R2_PROVIDER_CLASS_A_USD_PER_MILLION}
    + class_b_operations / 1000000 * ${R2_PROVIDER_CLASS_B_USD_PER_MILLION}),
  customer_cost_usd=(storage_gb_month * ${R2_CUSTOMER_STORAGE_USD_PER_GB_MONTH}
    + class_a_operations / 1000000 * ${R2_CUSTOMER_CLASS_A_USD_PER_MILLION}
    + class_b_operations / 1000000 * ${R2_CUSTOMER_CLASS_B_USD_PER_MILLION})`;

async function refreshDailySnapshot(workspaceId: string) {
  await query(
    `INSERT INTO workspace_r2_usage_ledger (
       workspace_id, usage_date, storage_gb_month, metadata
     )
     SELECT $1, CURRENT_DATE,
            COALESCE(SUM(size_bytes), 0)::numeric / 1000000000
              / EXTRACT(DAY FROM (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')),
            jsonb_build_object(
              'storageBytes', COALESCE(SUM(size_bytes), 0),
              'pricing', 'r2_standard_no_free_tier_plus_10_percent_plus_0_20_usd_per_gb_month',
              'sampledAt', NOW()
            )
     FROM workspace_storage_objects
     WHERE workspace_id=$1 AND deleted_at IS NULL
     ON CONFLICT (workspace_id,usage_date) DO UPDATE SET
       storage_gb_month=EXCLUDED.storage_gb_month,
       metadata=workspace_r2_usage_ledger.metadata || EXCLUDED.metadata`,
    [workspaceId],
  );
  await query(
    `UPDATE workspace_r2_usage_ledger SET ${ledgerCostSql}
     WHERE workspace_id=$1 AND usage_date=CURRENT_DATE`,
    [workspaceId],
  );
}

async function incrementOperation(workspaceId: string, operationClass: 'A' | 'B') {
  await query(
    `INSERT INTO workspace_r2_usage_ledger (
       workspace_id,usage_date,class_a_operations,class_b_operations,metadata
     ) VALUES ($1,CURRENT_DATE,
       CASE WHEN $2='A' THEN 1 ELSE 0 END,
       CASE WHEN $2='B' THEN 1 ELSE 0 END,
       jsonb_build_object('pricing','r2_standard_no_free_tier_plus_10_percent_plus_0_20_usd_per_gb_month'))
     ON CONFLICT (workspace_id,usage_date) DO UPDATE SET
       class_a_operations=workspace_r2_usage_ledger.class_a_operations + CASE WHEN $2='A' THEN 1 ELSE 0 END,
       class_b_operations=workspace_r2_usage_ledger.class_b_operations + CASE WHEN $2='B' THEN 1 ELSE 0 END`,
    [workspaceId, operationClass],
  );
}

export async function recordR2Put(input: { key: string; sizeBytes: number; contentType: string }) {
  const workspaceId = workspaceIdFromKey(input.key);
  if (!workspaceId) return;
  await withTransaction(async client => {
    await query(
      `INSERT INTO workspace_storage_objects(object_key,workspace_id,size_bytes,content_type,deleted_at)
       VALUES($1,$2,$3,$4,NULL)
       ON CONFLICT(object_key) DO UPDATE SET
         workspace_id=EXCLUDED.workspace_id,size_bytes=EXCLUDED.size_bytes,
         content_type=EXCLUDED.content_type,deleted_at=NULL`,
      [input.key, workspaceId, input.sizeBytes, input.contentType], client,
    );
    await query(
      `INSERT INTO workspace_r2_usage_ledger(workspace_id,usage_date,class_a_operations,metadata)
       VALUES($1,CURRENT_DATE,1,jsonb_build_object('pricing','r2_standard_no_free_tier_plus_10_percent_plus_0_20_usd_per_gb_month'))
       ON CONFLICT(workspace_id,usage_date) DO UPDATE SET
         class_a_operations=workspace_r2_usage_ledger.class_a_operations+1`,
      [workspaceId], client,
    );
  });
  await refreshDailySnapshot(workspaceId);
}

export async function recordR2Get(key: string) {
  const workspaceId = workspaceIdFromKey(key);
  if (!workspaceId) return;
  await incrementOperation(workspaceId, 'B');
  await refreshDailySnapshot(workspaceId);
}

export async function recordR2Delete(key: string) {
  const workspaceId = workspaceIdFromKey(key);
  if (!workspaceId) return;
  await query(
    `UPDATE workspace_storage_objects SET deleted_at=NOW()
     WHERE object_key=$1 AND workspace_id=$2`,
    [key, workspaceId],
  );
  await refreshDailySnapshot(workspaceId);
}

/** Reconciles objects that existed before metering was enabled, or that were
 * written through a provider-side process. The scan timestamp prevents a
 * concurrent upload/delete from being overwritten by an older inventory. */
export async function reconcileR2Inventory(
  objects: Array<{ key: string; sizeBytes: number }>,
  scanStartedAt: Date,
) {
  const normalized = objects.flatMap((object) => {
    const workspaceId = workspaceIdFromKey(object.key);
    return workspaceId && Number.isSafeInteger(object.sizeBytes) && object.sizeBytes >= 0
      ? [{ ...object, workspaceId }]
      : [];
  });
  const scannedKeys = normalized.map((object) => object.key);
  await withTransaction(async (client) => {
    await query(
      `UPDATE workspace_storage_objects
       SET deleted_at=NOW()
       WHERE deleted_at IS NULL AND updated_at < $1
         AND NOT (object_key = ANY($2::text[]))`,
      [scanStartedAt.toISOString(), scannedKeys], client,
    );
    for (let offset = 0; offset < normalized.length; offset += 1_000) {
      const batch = normalized.slice(offset, offset + 1_000);
      await query(
        `INSERT INTO workspace_storage_objects(object_key,workspace_id,size_bytes,content_type,deleted_at)
         SELECT source.object_key,source.workspace_id,source.size_bytes,NULL,NULL
         FROM unnest($1::text[],$2::uuid[],$3::bigint[])
           AS source(object_key,workspace_id,size_bytes)
         JOIN workspaces w ON w.id=source.workspace_id AND w.deleted_at IS NULL
         ON CONFLICT(object_key) DO UPDATE SET
           workspace_id=EXCLUDED.workspace_id,size_bytes=EXCLUDED.size_bytes,deleted_at=NULL
         WHERE workspace_storage_objects.updated_at < $4
            OR workspace_storage_objects.deleted_at IS NULL`,
        [batch.map((object) => object.key), batch.map((object) => object.workspaceId),
          batch.map((object) => object.sizeBytes), scanStartedAt.toISOString()], client,
      );
    }
  });
  return normalized.length;
}

export async function snapshotAllR2Storage() {
  const { rows } = await query<{ workspaceId: string }>(
    `SELECT DISTINCT workspace_id AS "workspaceId"
     FROM workspace_storage_objects
     WHERE deleted_at IS NULL`,
  );
  for (const row of rows) await refreshDailySnapshot(row.workspaceId);
  return rows.length;
}
