-- Central OAuth credentials used by Lulu-managed provider integrations.
-- These connections are intentionally not linked to a customer workspace.
-- Provider tokens remain encrypted at rest and are never returned by the API.

CREATE TABLE IF NOT EXISTS lulu_managed_oauth_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL UNIQUE CHECK (provider IN ('google-ads', 'google-analytics', 'meta', 'linkedin', 'tiktok-ads')),
  display_name TEXT NOT NULL,
  external_account_id TEXT,
  granted_scopes TEXT[] NOT NULL DEFAULT '{}',
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'reauthorization_required', 'disconnected')),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  connected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lulu_managed_oauth_provider_status
  ON lulu_managed_oauth_connections (provider, status);

DROP TRIGGER IF EXISTS trg_lulu_managed_oauth_connections_set_updated_at ON lulu_managed_oauth_connections;
CREATE TRIGGER trg_lulu_managed_oauth_connections_set_updated_at
  BEFORE UPDATE ON lulu_managed_oauth_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
