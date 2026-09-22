ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS mfa_secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS mfa_recovery_code_hashes JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_mfa_recovery_code_hashes_object;
ALTER TABLE users
  ADD CONSTRAINT users_mfa_recovery_code_hashes_array
  CHECK (jsonb_typeof(mfa_recovery_code_hashes) = 'array');

CREATE TABLE IF NOT EXISTS auth_mfa_setups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  secret_encrypted TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_mfa_setups_expiry ON auth_mfa_setups (expires_at);

CREATE TABLE IF NOT EXISTS auth_mfa_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_mfa_challenges_user ON auth_mfa_challenges (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_mfa_challenges_expiry ON auth_mfa_challenges (expires_at) WHERE used_at IS NULL;
