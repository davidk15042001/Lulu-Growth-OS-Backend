-- Public website contact requests, including optional visitor contact details and one attachment.
CREATE TABLE IF NOT EXISTS storefront_contact_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES workspace_sites(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  checkout_session_id UUID REFERENCES storefront_checkout_sessions(id) ON DELETE SET NULL,
  customer_email TEXT NOT NULL,
  website_url TEXT,
  whatsapp_number TEXT,
  note TEXT NOT NULL DEFAULT '',
  attachment_file_name TEXT,
  attachment_mime_type TEXT,
  attachment_size_bytes INTEGER,
  attachment_content BYTEA,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','IN_PROGRESS','RESOLVED','SPAM')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (attachment_size_bytes IS NULL OR attachment_size_bytes > 0),
  CHECK ((attachment_file_name IS NULL) = (attachment_content IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_storefront_contact_requests_workspace
  ON storefront_contact_requests(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_storefront_contact_requests_checkout
  ON storefront_contact_requests(checkout_session_id);

DROP TRIGGER IF EXISTS trg_storefront_contact_requests_set_updated_at ON storefront_contact_requests;
CREATE TRIGGER trg_storefront_contact_requests_set_updated_at
  BEFORE UPDATE ON storefront_contact_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
