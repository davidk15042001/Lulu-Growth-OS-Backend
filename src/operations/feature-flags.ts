import crypto from 'node:crypto';
import { query } from '../db/pool.js';

export function rolloutBucket(workspaceId: string, flagKey: string) {
  const digest = crypto.createHash('sha256').update(`${flagKey}:${workspaceId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

export function enabledForRollout(workspaceId: string, flagKey: string, enabled: boolean, rolloutPercent: number) {
  return enabled || (rolloutPercent > 0 && rolloutBucket(workspaceId, flagKey) < rolloutPercent);
}

export async function isFeatureEnabled(workspaceId: string, flagKey: string) {
  const result = await query<{
    defaultEnabled: boolean;
    defaultRolloutPercent: number;
    enabled: boolean | null;
    rolloutPercent: number | null;
  }>(
    `SELECT f.default_enabled AS "defaultEnabled",
            f.default_rollout_percent AS "defaultRolloutPercent",
            w.enabled,
            w.rollout_percent AS "rolloutPercent"
     FROM feature_flags f
     LEFT JOIN workspace_feature_flags w
       ON w.flag_key = f.key AND w.workspace_id = $1
     WHERE f.key = $2`,
    [workspaceId, flagKey],
  );
  const state = result.rows[0];
  if (!state) return false;
  const enabled = state.enabled ?? state.defaultEnabled;
  const rolloutPercent = state.rolloutPercent ?? state.defaultRolloutPercent;
  if (enabled) return true;
  if (rolloutPercent <= 0) return false;
  return enabledForRollout(workspaceId, flagKey, false, rolloutPercent);
}
