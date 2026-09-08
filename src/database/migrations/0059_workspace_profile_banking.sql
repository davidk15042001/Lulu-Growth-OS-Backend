-- Additional legal, contact and bank profile fields for workspace administrators.
-- Keep these fields separate from the regular workspace list response: they are
-- exposed only through the admin-authorized profile endpoint.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS bank_account_number TEXT,
  ADD COLUMN IF NOT EXISTS bank_opening_bank TEXT,
  ADD COLUMN IF NOT EXISTS bank_branch TEXT,
  ADD COLUMN IF NOT EXISTS legal_representative TEXT,
  ADD COLUMN IF NOT EXISTS phone_number TEXT,
  ADD COLUMN IF NOT EXISTS bank_code TEXT;

