ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS impersonated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS impersonated_by_email TEXT;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_impersonated_by_user
  ON refresh_tokens (impersonated_by_user_id)
  WHERE impersonated_by_user_id IS NOT NULL;
