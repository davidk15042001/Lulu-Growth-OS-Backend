-- PAYG payment-method configuration. Lulu stores only Airwallex token IDs;
-- card details continue to be collected exclusively by Airwallex's hosted flow.

ALTER TABLE workspace_payg_profiles
  ADD COLUMN IF NOT EXISTS preferred_payment_method TEXT
    CHECK (preferred_payment_method IN ('card', 'wechatpay', 'alipaycn')),
  ADD COLUMN IF NOT EXISTS payment_method_configured_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS workspace_payg_payment_setups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('card', 'wechatpay', 'alipaycn')),
  provider TEXT NOT NULL DEFAULT 'airwallex' CHECK (provider = 'airwallex'),
  provider_checkout_id TEXT NOT NULL UNIQUE,
  provider_customer_id TEXT NOT NULL,
  provider_payment_source_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED')),
  checkout_url TEXT,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_payg_payment_setups_workspace
  ON workspace_payg_payment_setups (workspace_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_workspace_payg_payment_setups_set_updated_at ON workspace_payg_payment_setups;
CREATE TRIGGER trg_workspace_payg_payment_setups_set_updated_at
  BEFORE UPDATE ON workspace_payg_payment_setups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
