import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';
import { AppError } from '../../utils/app-error.js';

/**
 * One durable tenant-wide automation switch.  The value is intentionally read
 * from the canonical workspace settings row so every worker and API path sees
 * the same state (and no process-local toggle can bypass it).
 */
export async function isWorkspaceAutomationPaused(workspaceId: string, client?: PoolClient) {
  const result = await query<{ paused: boolean }>(
    `SELECT COALESCE((settings->'agents'->>'paused')::boolean, FALSE) AS paused
       FROM workspace_settings WHERE workspace_id=$1`,
    [workspaceId],
    client,
  );
  return result.rows[0]?.paused === true;
}

export async function assertWorkspaceAutomationActive(workspaceId: string, client?: PoolClient): Promise<void> {
  if (await isWorkspaceAutomationPaused(workspaceId, client)) {
    throw new AppError(423, 'WORKSPACE_AUTOMATION_PAUSED', 'Automation is paused for this workspace. Turn Agents active on to continue.');
  }
}

/**
 * When the switch is turned off, request provider-side shutdown of every
 * managed Google Ads allocation.  Reconciliation remains intentionally alive
 * so it can perform the provider pause and settle the reservation safely.
 */
export async function requestWorkspaceAutomationPause(workspaceId: string, paused: boolean, client: PoolClient) {
  if (!paused) return;
  await query(
    `UPDATE workspace_google_ads_spend_allocations
        SET closure_state=CASE WHEN closure_state='OPEN' THEN 'REQUESTED' ELSE closure_state END,
            close_requested_at=CASE WHEN closure_state='OPEN' THEN NOW() ELSE close_requested_at END,
            close_reason=CASE WHEN closure_state='OPEN' THEN 'Workspace automation paused' ELSE close_reason END,
            next_reconcile_at=NOW(), updated_at=NOW()
      WHERE workspace_id=$1 AND launch_state='APPLIED' AND closure_state IN ('OPEN','REQUESTED','PAUSE_UNCERTAIN')`,
    [workspaceId],
    client,
  );
}
