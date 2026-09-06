-- One-time WeChat Pay and Alipay QR payments for PAYG API usage.
-- QR payloads are issued by Airwallex and may expire; no wallet credentials
-- or card details are ever retained by Lulu.

CREATE TABLE IF NOT EXISTS workspace_payg_qr_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  payg_period_id UUID NOT NULL REFERENCES workspace_payg_periods(id) ON DELETE CASCADE,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('wechatpay', 'alipaycn')),
  provider TEXT NOT NULL DEFAULT 'airwallex' CHECK (provider = 'airwallex'),
  provider_payment_intent_id TEXT NOT NULL UNIQUE,
  merchant_order_id TEXT NOT NULL UNIQUE,
  amount NUMERIC(18,8) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  status TEXT NOT NULL DEFAULT 'REQUIRES_CUSTOMER_ACTION'
    CHECK (status IN ('REQUIRES_CUSTOMER_ACTION', 'PENDING', 'SUCCEEDED', 'CANCELLED', 'FAILED', 'EXPIRED')),
  qr_payload TEXT,
  payment_url TEXT,
  expires_at TIMESTAMPTZ,
  provider_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  paid_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_payg_qr_payments_active
  ON workspace_payg_qr_payments (workspace_id, payg_period_id, created_at DESC)
  WHERE status IN ('REQUIRES_CUSTOMER_ACTION', 'PENDING');

DROP TRIGGER IF EXISTS trg_workspace_payg_qr_payments_set_updated_at ON workspace_payg_qr_payments;
CREATE TRIGGER trg_workspace_payg_qr_payments_set_updated_at
  BEFORE UPDATE ON workspace_payg_qr_payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
