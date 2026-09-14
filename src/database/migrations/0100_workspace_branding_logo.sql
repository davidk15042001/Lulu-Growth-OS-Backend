-- Company branding used by the profile and canonical commercial documents.
-- The binary remains in R2; the workspace stores only its tenant-scoped key
-- and presentation metadata.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS logo_storage_reference TEXT,
  ADD COLUMN IF NOT EXISTS logo_mime_type TEXT,
  ADD COLUMN IF NOT EXISTS logo_file_name TEXT,
  ADD COLUMN IF NOT EXISTS logo_updated_at TIMESTAMPTZ;

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_logo_mime_type_check;

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_logo_mime_type_check
  CHECK (logo_mime_type IS NULL OR logo_mime_type IN ('image/png', 'image/jpeg', 'image/webp'));
