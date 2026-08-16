CREATE TABLE IF NOT EXISTS workspace_platform_oauth_credentials (
  platform_id UUID PRIMARY KEY REFERENCES workspace_platforms(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_platform_oauth_provider
  ON workspace_platform_oauth_credentials (provider);

DROP TRIGGER IF EXISTS trg_workspace_platform_oauth_credentials_set_updated_at ON workspace_platform_oauth_credentials;
CREATE TRIGGER trg_workspace_platform_oauth_credentials_set_updated_at
  BEFORE UPDATE ON workspace_platform_oauth_credentials
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
