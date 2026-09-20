-- Allow customers to remove website media without breaking prompt-edit history.
-- Deleted assets remain auditable but are excluded from editor and storefront projections.
ALTER TABLE managed_website_assets
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_managed_website_assets_active_site
  ON managed_website_assets (workspace_id, site_id, created_at DESC)
  WHERE deleted_at IS NULL;
