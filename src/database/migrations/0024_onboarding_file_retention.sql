-- 0024_onboarding_file_retention.sql
-- Remove onboarding uploads for accounts that remain unpaid for five days.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS onboarding_files_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_file_cleanup_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_files_purged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_file_reupload_required BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE workspaces
SET onboarding_files_expires_at = created_at + INTERVAL '5 days'
WHERE onboarding_files_expires_at IS NULL;

ALTER TABLE workspaces
  ALTER COLUMN onboarding_files_expires_at SET DEFAULT (NOW() + INTERVAL '5 days'),
  ALTER COLUMN onboarding_files_expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspaces_onboarding_file_expiry
  ON workspaces (onboarding_files_expires_at)
  WHERE deleted_at IS NULL AND onboarding_completed_at IS NULL;

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_onboarding_step_check;

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_onboarding_step_check
  CHECK (onboarding_step IN (
    'company_information',
    'business_description',
    'products_services',
    'existing_platforms',
    'integrations',
    'ai_preferences',
    'billing',
    'setup_complete'
  ));
