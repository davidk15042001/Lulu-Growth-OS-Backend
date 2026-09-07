-- 0040_workspace_tax_address.sql
-- Capture the legal tax identifier and registered business address during onboarding.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS tax_id TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT;
