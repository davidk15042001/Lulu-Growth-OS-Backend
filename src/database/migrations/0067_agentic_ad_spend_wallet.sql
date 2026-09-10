-- Paid-media authority is represented by prepaid funds, never by per-action approvals.
-- The 4% Lulu service fee is charged on top and is not credited to the ad wallet.
CREATE TABLE IF NOT EXISTS workspace_ad_spend_wallets (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  currency VARCHAR(3) NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  available_amount NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (available_amount >= 0),
  reserved_amount NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
  spent_amount NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (spent_amount >= 0),
  refunded_amount NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  total_funded_amount NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (total_funded_amount >= 0),
  total_fee_amount NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (total_fee_amount >= 0),
  fee_basis_points INTEGER NOT NULL DEFAULT 400 CHECK (fee_basis_points = 400),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_ad_spend_topups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  net_amount NUMERIC(20,2) NOT NULL CHECK (net_amount > 0),
  fee_basis_points INTEGER NOT NULL DEFAULT 400 CHECK (fee_basis_points = 400),
  fee_amount NUMERIC(20,2) NOT NULL CHECK (fee_amount >= 0),
  total_amount NUMERIC(20,2) NOT NULL CHECK (total_amount = net_amount + fee_amount),
  currency VARCHAR(3) NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('card','alipaycn','wechatpay')),
  provider VARCHAR(30) NOT NULL DEFAULT 'airwallex' CHECK (provider = 'airwallex'),
  status VARCHAR(40) NOT NULL DEFAULT 'CREATED' CHECK (status IN (
    'CREATED','PENDING_PAYMENT','REQUIRES_CUSTOMER_ACTION','SUCCEEDED','CANCELLED',
    'FAILED','EXPIRED','REFUNDED','CHARGEBACK'
  )),
  merchant_order_id VARCHAR(200) NOT NULL UNIQUE,
  provider_invoice_id VARCHAR(200),
  provider_payment_intent_id VARCHAR(200),
  checkout_url TEXT,
  qr_payload TEXT,
  expires_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  credited_at TIMESTAMPTZ,
  provider_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code VARCHAR(120),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_ad_spend_topups_invoice_uidx
  ON workspace_ad_spend_topups(provider_invoice_id) WHERE provider_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_ad_spend_topups_intent_uidx
  ON workspace_ad_spend_topups(provider_payment_intent_id) WHERE provider_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workspace_ad_spend_topups_workspace_created_idx
  ON workspace_ad_spend_topups(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_ad_spend_topups_pending_idx
  ON workspace_ad_spend_topups(status, expires_at)
  WHERE status IN ('CREATED','PENDING_PAYMENT','REQUIRES_CUSTOMER_ACTION');

CREATE TABLE IF NOT EXISTS workspace_ad_spend_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  topup_id UUID REFERENCES workspace_ad_spend_topups(id) ON DELETE SET NULL,
  entry_type VARCHAR(30) NOT NULL CHECK (entry_type IN (
    'TOPUP_CREDIT','RESERVE','RELEASE','SPEND','REFUND','ADJUSTMENT'
  )),
  amount_delta NUMERIC(20,2) NOT NULL CHECK (amount_delta <> 0),
  balance_after NUMERIC(20,2) NOT NULL CHECK (balance_after >= 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  idempotency_key VARCHAR(240) NOT NULL UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workspace_ad_spend_ledger_workspace_created_idx
  ON workspace_ad_spend_ledger(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_ad_spend_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  amount NUMERIC(20,2) NOT NULL CHECK (amount > 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  status VARCHAR(20) NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED','CONSUMED','RELEASED','EXPIRED')),
  platform VARCHAR(80),
  campaign_id VARCHAR(200),
  idempotency_key VARCHAR(240) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workspace_ad_spend_reservations_workspace_status_idx
  ON workspace_ad_spend_reservations(workspace_id, status, created_at DESC);

DROP TRIGGER IF EXISTS workspace_ad_spend_wallets_set_updated_at ON workspace_ad_spend_wallets;
CREATE TRIGGER workspace_ad_spend_wallets_set_updated_at
BEFORE UPDATE ON workspace_ad_spend_wallets
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS workspace_ad_spend_topups_set_updated_at ON workspace_ad_spend_topups;
CREATE TRIGGER workspace_ad_spend_topups_set_updated_at
BEFORE UPDATE ON workspace_ad_spend_topups
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS workspace_ad_spend_reservations_set_updated_at ON workspace_ad_spend_reservations;
CREATE TRIGGER workspace_ad_spend_reservations_set_updated_at
BEFORE UPDATE ON workspace_ad_spend_reservations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Existing commercial policies become autonomous. Customer acceptance and prepaid
-- budget remain the external authorization boundaries.
UPDATE commercial_policies
SET automatic_quote_enabled=TRUE,
    automatic_quote_send_enabled=TRUE,
    require_approval_for_custom_terms=FALSE,
    updated_at=NOW()
WHERE automatic_quote_enabled=FALSE
   OR automatic_quote_send_enabled=FALSE
   OR require_approval_for_custom_terms=TRUE;

UPDATE quotes
SET handling_mode='AUTONOMOUS', updated_at=NOW()
WHERE handling_mode IN ('LIMITED_AUTONOMOUS','USER_AUTHORIZATION_REQUIRED');

ALTER TABLE commercial_policies ALTER COLUMN automatic_quote_enabled SET DEFAULT TRUE;
ALTER TABLE commercial_policies ALTER COLUMN automatic_quote_send_enabled SET DEFAULT TRUE;
ALTER TABLE commercial_policies ALTER COLUMN require_approval_for_custom_terms SET DEFAULT FALSE;
ALTER TABLE quotes ALTER COLUMN handling_mode SET DEFAULT 'AUTONOMOUS';

-- Release legacy agent waits. Their exact immutable packets remain intact and are
-- still revalidated by the backend before execution; only the obsolete human gate
-- is removed. New media money continues to enter exclusively through the wallet.
UPDATE approval_requests
SET status='cancelled', decision_note='Superseded by autonomous execution policy; paid-media funding uses the ad spend wallet.', decided_at=NOW(), updated_at=NOW()
WHERE status='pending' AND action_type IN ('agent_tool','agent_packet','agent_assistant_action');

UPDATE workspace_records r
SET stage='queued_for_execution',
    data=r.data || '{"executionReady":true,"executionStatus":"queued","approvalStatus":"not_required"}'::jsonb,
    version=r.version+1,
    updated_at=NOW()
FROM agent_action_packets p
WHERE p.record_id=r.id AND p.workspace_id=r.workspace_id
  AND r.stage='waiting_approval' AND r.deleted_at IS NULL;

UPDATE agent_run_steps
SET status='pending', updated_at=NOW()
WHERE status='waiting_approval' AND approval_id IN (
  SELECT id FROM approval_requests WHERE action_type IN ('agent_tool','agent_packet') AND status='cancelled'
);

UPDATE agent_runs r
SET status='queued', updated_at=NOW()
WHERE status='waiting_approval'
  AND EXISTS (SELECT 1 FROM agent_run_steps s WHERE s.run_id=r.id AND s.status='pending');

UPDATE assistant_action_requests
SET status='ready', updated_at=NOW()
WHERE status='pending_approval' AND approval_id IN (
  SELECT id FROM approval_requests WHERE action_type='agent_assistant_action' AND status='cancelled'
);
