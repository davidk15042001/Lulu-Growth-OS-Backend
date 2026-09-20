-- Durable prompt edits for Lulu-managed website assets.
-- An edit is a provider-backed operation, not an in-browser fake.
CREATE TABLE IF NOT EXISTS managed_website_asset_edits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES workspace_sites(id) ON DELETE CASCADE,
  source_asset_id UUID NOT NULL REFERENCES managed_website_assets(id) ON DELETE RESTRICT,
  result_asset_id UUID REFERENCES managed_website_assets(id) ON DELETE SET NULL,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  prompt TEXT NOT NULL CHECK (char_length(trim(prompt)) BETWEEN 3 AND 4000),
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SUBMITTING','SUBMITTED','PROCESSING','COMPLETED','FAILED','CANCELLED')),
  provider_task_id TEXT,
  callback_token TEXT NOT NULL UNIQUE,
  reservation_id UUID,
  provider_api TEXT NOT NULL DEFAULT 'MARKET' CHECK (provider_api IN ('MARKET')),
  credits_consumed NUMERIC(20,6),
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_payload) = 'object'),
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_website_asset_edits_workspace
  ON managed_website_asset_edits (workspace_id, site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_website_asset_edits_provider
  ON managed_website_asset_edits (status, provider_task_id, updated_at);

DROP TRIGGER IF EXISTS trg_managed_website_asset_edits_set_updated_at ON managed_website_asset_edits;
CREATE TRIGGER trg_managed_website_asset_edits_set_updated_at
  BEFORE UPDATE ON managed_website_asset_edits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
