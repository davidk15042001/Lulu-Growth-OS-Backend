-- Customer-managed media for Lulu-owned websites.
-- Binary data stays tenant-scoped and is served only through the published
-- asset projection; crop metadata is kept alongside the immutable upload.
CREATE TABLE IF NOT EXISTS managed_website_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES workspace_sites(id) ON DELETE CASCADE,
  uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  file_name TEXT NOT NULL CHECK (char_length(trim(file_name)) BETWEEN 1 AND 255),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg','image/png','image/webp','image/gif')),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  alt_text TEXT NOT NULL DEFAULT '' CHECK (char_length(alt_text) <= 500),
  placement TEXT NOT NULL DEFAULT 'website' CHECK (placement IN ('website','hero','product','logo','gallery')),
  crop JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(crop) = 'object'),
  content BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_managed_website_assets_site
  ON managed_website_assets (workspace_id, site_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_managed_website_assets_public
  ON managed_website_assets (site_id, placement, created_at DESC);
