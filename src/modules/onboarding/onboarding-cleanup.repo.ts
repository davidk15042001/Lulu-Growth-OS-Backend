import { query, withTransaction } from '../../db/pool.js';

export type OnboardingCleanupWorkspace = {
  workspaceId: string;
};

export type OnboardingCleanupDocument = {
  id: string;
  storageKey: string | null;
};

export const claimExpiredOnboardingWorkspaceSql = `
  WITH candidate AS (
    SELECT w.id
    FROM workspaces w
    WHERE w.deleted_at IS NULL
      AND w.onboarding_completed_at IS NULL
      AND w.onboarding_files_expires_at <= NOW()
      AND (
        w.onboarding_file_cleanup_started_at IS NULL
        OR w.onboarding_file_cleanup_started_at < NOW() - ($1::int * INTERVAL '1 minute')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM workspace_subscriptions s
        WHERE s.workspace_id = w.id AND s.status = 'active'
      )
    ORDER BY w.onboarding_files_expires_at, w.id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE workspaces w
  SET onboarding_file_cleanup_started_at = NOW()
  FROM candidate
  WHERE w.id = candidate.id
  RETURNING w.id AS "workspaceId"
`;

export const finishOnboardingFileCleanupSql = `
  UPDATE workspaces
  SET onboarding_step = 'business_description',
      onboarding_file_reupload_required = TRUE,
      onboarding_files_purged_at = NOW(),
      onboarding_files_expires_at = NOW() + ($2::int * INTERVAL '1 day'),
      onboarding_file_cleanup_started_at = NULL
  WHERE id = $1
    AND deleted_at IS NULL
    AND onboarding_completed_at IS NULL
`;

export async function claimExpiredOnboardingWorkspace(leaseMinutes: number) {
  const { rows } = await query<OnboardingCleanupWorkspace>(claimExpiredOnboardingWorkspaceSql, [leaseMinutes]);
  return rows[0] ?? null;
}

export async function listOnboardingCleanupDocuments(workspaceId: string) {
  const { rows } = await query<OnboardingCleanupDocument>(
    `SELECT id, storage_key AS "storageKey"
     FROM onboarding_documents
     WHERE workspace_id = $1
     ORDER BY created_at, id`,
    [workspaceId],
  );
  return rows;
}

export async function finishOnboardingFileCleanup(
  workspaceId: string,
  documentIds: string[],
  retentionDays: number,
) {
  await withTransaction(async (client) => {
    if (documentIds.length > 0) {
      await query(
        `DELETE FROM onboarding_documents
         WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
        [workspaceId, documentIds],
        client,
      );
    }
    await query(finishOnboardingFileCleanupSql, [workspaceId, retentionDays], client);
  });
}

export async function releaseOnboardingFileCleanupClaim(workspaceId: string) {
  await query(
    `UPDATE workspaces
     SET onboarding_file_cleanup_started_at = NULL
     WHERE id = $1 AND onboarding_completed_at IS NULL`,
    [workspaceId],
  );
}
