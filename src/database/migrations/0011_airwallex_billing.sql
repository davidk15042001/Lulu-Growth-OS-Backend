-- Airwallex billing checkout and webhook state.

CREATE TABLE IF NOT EXISTS workspace_billing_checkouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_key TEXT NOT NULL CHECK (plan_key IN ('explorer', 'starter', 'ai')),
  provider TEXT NOT NULL DEFAULT 'airwallex',
  provider_checkout_id TEXT NOT NULL UNIQUE,
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  provider_invoice_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED')),
  checkout_url TEXT,
  amount_minor BIGINT,
  currency TEXT NOT NULL DEFAULT 'CNY',
  raw_response JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(raw_response) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_workspace_billing_checkouts_workspace
  ON workspace_billing_checkouts (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS airwallex_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_airwallex_webhook_events_type_created
  ON airwallex_webhook_events (event_type, created_at DESC);

DROP TRIGGER IF EXISTS trg_workspace_billing_checkouts_set_updated_at ON workspace_billing_checkouts;
CREATE TRIGGER trg_workspace_billing_checkouts_set_updated_at
  BEFORE UPDATE ON workspace_billing_checkouts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
