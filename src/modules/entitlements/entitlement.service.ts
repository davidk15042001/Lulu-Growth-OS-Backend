import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/pool.js';
import { badRequest, notFoundError } from '../../utils/app-error.js';
import { recordSecurityEvent } from '../security/security-event.service.js';
import { ENTITLEMENT_KEYS, type EffectiveEntitlement, type EntitlementKey } from './entitlement.types.js';

type EntitlementRow = { key: EntitlementKey; valueType: 'boolean' | 'limit'; enabled: boolean; limitValue: string | null; source: 'plan' | 'override' | 'restriction'; reason: string };

export async function resolveWorkspaceEntitlements(workspaceId: string, client?: PoolClient): Promise<Record<EntitlementKey, EffectiveEntitlement>> {
  const rows = (await query<EntitlementRow>(
    `WITH plan_values AS (
       SELECT d.key, d.value_type AS "valueType", COALESCE(pe.enabled, FALSE) AS enabled,
              pe.limit_value AS "limitValue", 'plan'::text AS source,
              'Subscription plan'::text AS reason
         FROM entitlement_definitions d
         LEFT JOIN workspace_subscriptions ws ON ws.workspace_id = $1
         LEFT JOIN plan_entitlements pe ON pe.plan_key = COALESCE(ws.plan_key, 'starter') AND pe.entitlement_key = d.key
     ), overrides AS (
       SELECT DISTINCT ON (entitlement_key) entitlement_key AS key, NULL::text AS "valueType",
              COALESCE(enabled, TRUE) AS enabled, limit_value AS "limitValue", 'override'::text AS source,
              reason
         FROM workspace_entitlement_overrides
        WHERE workspace_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY entitlement_key, created_at DESC
     ), restrictions AS (
       SELECT DISTINCT ON (entitlement_key) entitlement_key AS key, NULL::text AS "valueType",
              enabled, limit_value AS "limitValue", 'restriction'::text AS source,
              reason
         FROM workspace_entitlement_restrictions
        WHERE workspace_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
        ORDER BY entitlement_key, created_at DESC
     )
     SELECT p.key, p."valueType",
            CASE
              WHEN r.key IS NOT NULL AND r.enabled = FALSE THEN FALSE
              ELSE COALESCE(o.enabled, p.enabled)
            END AS enabled,
            CASE
              WHEN r.key IS NOT NULL AND r."limitValue" IS NOT NULL
                THEN LEAST(r."limitValue", COALESCE(o."limitValue", p."limitValue", r."limitValue"))
              WHEN o.key IS NOT NULL THEN o."limitValue"
              ELSE p."limitValue"
            END AS "limitValue",
            COALESCE(r.source, o.source, p.source) AS source,
            COALESCE(r.reason, o.reason, p.reason) AS reason
       FROM plan_values p
       LEFT JOIN overrides o ON o.key = p.key
       LEFT JOIN restrictions r ON r.key = p.key`,
    [workspaceId],
    client,
  )).rows;
  const result = {} as Record<EntitlementKey, EffectiveEntitlement>;
  for (const key of ENTITLEMENT_KEYS) {
    const row = rows.find((item) => item.key === key);
    result[key] = {
      key,
      enabled: Boolean(row?.enabled),
      limit: row?.limitValue ?? null,
      source: row?.source ?? 'default',
      reason: row?.reason ?? 'No entitlement is configured',
    };
  }
  return result;
}

export async function hasWorkspaceEntitlement(workspaceId: string, key: EntitlementKey, client?: PoolClient) {
  const effective = await resolveWorkspaceEntitlements(workspaceId, client);
  return effective[key]?.enabled === true;
}

export async function addWorkspaceOverride(input: { workspaceId: string; entitlementKey: string; enabled?: boolean | undefined; limitValue?: number | null | undefined; reason: string; actorId: string; expiresAt?: string | null | undefined }) {
  if (!ENTITLEMENT_KEYS.includes(input.entitlementKey as EntitlementKey)) throw badRequest('Unknown entitlement key');
  if (input.enabled === undefined && input.limitValue === undefined) throw badRequest('An entitlement override needs enabled or limitValue');
  const definition = (await query<{ valueType: 'boolean' | 'limit' }>(`SELECT value_type AS "valueType" FROM entitlement_definitions WHERE key=$1`, [input.entitlementKey])).rows[0];
  if (!definition) throw badRequest('Unknown entitlement key');
  if (definition.valueType === 'boolean' && input.limitValue !== undefined) throw badRequest('Boolean entitlements cannot receive a numeric limit');
  if (definition.valueType === 'limit' && input.limitValue === undefined) throw badRequest('Limit entitlements require a numeric limit');
  const inserted = await withTransaction(async (client) => {
    const row = (await query<{ id: string }>(
      `INSERT INTO workspace_entitlement_overrides(workspace_id, entitlement_key, enabled, limit_value, reason, created_by, expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.workspaceId, input.entitlementKey, input.enabled ?? null, input.limitValue ?? null, input.reason, input.actorId, input.expiresAt ?? null],
      client,
    )).rows[0];
    if (!row) throw new Error('Entitlement override insert did not return a row');
    await recordSecurityEvent({ eventType: 'ENTITLEMENT_OVERRIDE_ADDED', workspaceId: input.workspaceId, userId: input.actorId, metadata: { targetId: row.id, capability: input.entitlementKey, reason: input.reason } }, client);
    return row;
  });
  return inserted;
}

export async function removeWorkspaceOverride(workspaceId: string, overrideId: string, actorId: string) {
  return withTransaction(async (client) => {
    const row = (await query<{ id: string }>(`DELETE FROM workspace_entitlement_overrides WHERE id=$1 AND workspace_id=$2 RETURNING id`, [overrideId, workspaceId], client)).rows[0];
    if (!row) throw notFoundError('Entitlement override not found');
    await recordSecurityEvent({ eventType: 'ENTITLEMENT_OVERRIDE_REMOVED', workspaceId, userId: actorId, metadata: { targetId: overrideId } }, client);
    return row;
  });
}
