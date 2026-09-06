-- Durable de-duplication for irreversible admin account deletion jobs.
CREATE UNIQUE INDEX IF NOT EXISTS idx_background_jobs_unique_admin_user_deletion
  ON background_jobs ((payload->>'targetUserId'))
  WHERE job_type = 'admin.user.delete'
    AND status IN ('queued', 'running');
