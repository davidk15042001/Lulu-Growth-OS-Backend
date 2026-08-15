-- Move new onboarding document bytes to Amazon S3 while preserving legacy BYTEA rows.
ALTER TABLE onboarding_documents
  ADD COLUMN IF NOT EXISTS storage_key TEXT;

ALTER TABLE onboarding_documents
  ALTER COLUMN content DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_documents_storage_key
  ON onboarding_documents (storage_key)
  WHERE storage_key IS NOT NULL;
