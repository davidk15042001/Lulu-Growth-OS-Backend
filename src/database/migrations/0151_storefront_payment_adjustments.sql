-- Storefront refund/dispute evidence. A paid checkout is not necessarily
-- withdrawable revenue: provider reversals reduce the net proceeds balance.

CREATE TABLE IF NOT EXISTS storefront_payment_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  checkout_id UUID NOT NULL REFERENCES storefront_checkout_sessions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_adjustment_id TEXT NOT NULL,
  provider_payment_intent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('REFUND','DISPUTE')),
  status TEXT NOT NULL CHECK (status IN ('PENDING','ACTIVE','RELEASED','FAILED')),
  amount NUMERIC(20,4) NOT NULL CHECK (amount >= 0),
  currency CHAR(3) NOT NULL,
  provider_status TEXT NOT NULL,
  provider_payload JSONB NOT NULL DEFAULT '{}',
  source_event_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(provider_payload) = 'object'),
  UNIQUE (workspace_id, provider, provider_adjustment_id),
  UNIQUE (provider, source_event_id)
);

CREATE INDEX IF NOT EXISTS idx_storefront_payment_adjustments_checkout
  ON storefront_payment_adjustments(workspace_id, checkout_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_storefront_payment_adjustments_payment_intent
  ON storefront_payment_adjustments(workspace_id, provider, provider_payment_intent_id)
  WHERE provider_payment_intent_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_storefront_payment_adjustments_set_updated_at ON storefront_payment_adjustments;
CREATE TRIGGER trg_storefront_payment_adjustments_set_updated_at
  BEFORE UPDATE ON storefront_payment_adjustments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
