-- Ensure every field used by the protected workspace profile exists on older
-- production databases as well.  This migration is intentionally additive and
-- idempotent so it is safe to run after a partially applied deployment.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS industry TEXT,
  ADD COLUMN IF NOT EXISTS country_region TEXT,
  ADD COLUMN IF NOT EXISTS tax_id TEXT,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS legal_form TEXT,
  ADD COLUMN IF NOT EXISTS legal_representative TEXT,
  ADD COLUMN IF NOT EXISTS phone_number TEXT,
  ADD COLUMN IF NOT EXISTS bank_account_number TEXT,
  ADD COLUMN IF NOT EXISTS bank_opening_bank TEXT,
  ADD COLUMN IF NOT EXISTS bank_branch TEXT,
  ADD COLUMN IF NOT EXISTS bank_code TEXT;
