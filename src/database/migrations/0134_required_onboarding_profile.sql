-- Step 3 onboarding profile requires a distinct business classification
-- field.  The existing bank_branch column remains the bank-office branch
-- used by commercial documents.
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS branch TEXT;
