-- Allow administrators to opt individual workspaces into customer-owned
-- OAuth connections for providers that otherwise use Lulu's central account.

ALTER TABLE lulu_managed_oauth_connections
  DROP CONSTRAINT IF EXISTS lulu_managed_oauth_connections_provider_check;

ALTER TABLE lulu_managed_oauth_connections
  ADD CONSTRAINT lulu_managed_oauth_connections_provider_check
  CHECK (provider IN (
    'google-ads', 'google-analytics', 'meta', 'facebook', 'instagram',
    'whatsapp', 'linkedin', 'tiktok-ads'
  ));

CREATE TABLE IF NOT EXISTS workspace_oauth_self_service_permissions (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN (
    'google-ads', 'google-analytics', 'meta', 'facebook', 'instagram',
    'whatsapp', 'linkedin', 'tiktok-ads'
  )),
  allowed BOOLEAN NOT NULL DEFAULT TRUE,
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_workspace_oauth_self_service_allowed
  ON workspace_oauth_self_service_permissions (workspace_id, allowed);

DROP TRIGGER IF EXISTS trg_workspace_oauth_self_service_set_updated_at
  ON workspace_oauth_self_service_permissions;
CREATE TRIGGER trg_workspace_oauth_self_service_set_updated_at
  BEFORE UPDATE ON workspace_oauth_self_service_permissions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO provider_registry
  (provider_key, display_name, category, implementation_status, default_mode)
VALUES
  ('facebook', 'Facebook', 'MESSAGING', 'PARTIAL', 'LULU_MANAGED'),
  ('instagram', 'Instagram', 'MESSAGING', 'PARTIAL', 'LULU_MANAGED'),
  ('whatsapp', 'WhatsApp', 'MESSAGING', 'PARTIAL', 'LULU_MANAGED')
ON CONFLICT (provider_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  implementation_status = EXCLUDED.implementation_status,
  default_mode = EXCLUDED.default_mode,
  updated_at = NOW();
