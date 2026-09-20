CREATE TABLE IF NOT EXISTS composio_integration_catalog (
  toolkit_slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  logo_url TEXT,
  customer_available BOOLEAN NOT NULL DEFAULT FALSE,
  certification_status TEXT NOT NULL DEFAULT 'DISCOVERED'
    CHECK (certification_status IN ('DISCOVERED', 'CERTIFIED', 'PUBLISHED', 'DEGRADED', 'REVOKED')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  published_at TIMESTAMPTZ,
  published_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS composio_integration_catalog_customer_available_idx
  ON composio_integration_catalog (customer_available, toolkit_slug);

CREATE INDEX IF NOT EXISTS composio_integration_catalog_status_idx
  ON composio_integration_catalog (certification_status, toolkit_slug);
