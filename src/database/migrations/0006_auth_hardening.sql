-- 0006_auth_hardening.sql
-- Case-insensitive active email uniqueness and cleanup-oriented indexes.

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_active_email_lower
  ON users (lower(email))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expiry
  ON refresh_tokens (expires_at)
  WHERE revoked = FALSE;

CREATE INDEX IF NOT EXISTS idx_otp_codes_expiry
  ON otp_codes (expires_at)
  WHERE used = FALSE;
