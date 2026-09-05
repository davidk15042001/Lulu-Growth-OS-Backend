-- Tenant-scoped operational preferences. Settings deliberately start empty so
-- the UI never presents sample configuration as a customer's real data.

CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(settings) = 'object')
);

DROP TRIGGER IF EXISTS trg_workspace_settings_set_updated_at ON workspace_settings;
CREATE TRIGGER trg_workspace_settings_set_updated_at
  BEFORE UPDATE ON workspace_settings
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
