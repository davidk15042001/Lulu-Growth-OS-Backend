-- Hosted customer payments for Lulu-managed storefronts and durable payout
-- requests. Provider IDs are references only; Lulu remains authoritative for
-- order, approval, tenant and reconciliation state.

ALTER TABLE storefront_checkout_sessions
  ADD COLUMN IF NOT EXISTS payment_url TEXT,
  ADD COLUMN IF NOT EXISTS provider_payment_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_status TEXT,
  ADD COLUMN IF NOT EXISTS failure_code TEXT,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_storefront_checkout_payment_link
  ON storefront_checkout_sessions(payment_provider, provider_session_id)
  WHERE payment_provider IS NOT NULL AND provider_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_payout_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'airwallex',
  provider_beneficiary_id TEXT NOT NULL,
  label TEXT NOT NULL,
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (workspace_id, provider, provider_beneficiary_id),
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_payout_accounts_workspace
  ON workspace_payout_accounts(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  payout_account_id UUID NOT NULL,
  provider TEXT NOT NULL DEFAULT 'airwallex',
  provider_transfer_id TEXT,
  idempotency_key TEXT NOT NULL,
  amount NUMERIC(20,4) NOT NULL CHECK (amount > 0),
  currency CHAR(3) NOT NULL,
  reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'REQUESTED'
    CHECK (status IN ('REQUESTED','SUBMITTING','SUBMISSION_UNKNOWN','SUBMITTED','PROCESSING','PAID','FAILED','CANCELLED')),
  provider_status TEXT,
  failure_code TEXT,
  provider_payload JSONB NOT NULL DEFAULT '{}',
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(provider_payload) = 'object'),
  FOREIGN KEY (workspace_id, payout_account_id)
    REFERENCES workspace_payout_accounts(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_payout_provider_transfer
  ON workspace_payouts(workspace_id, provider, provider_transfer_id)
  WHERE provider_transfer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_payouts_workspace_created
  ON workspace_payouts(workspace_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_payouts_provider_status
  ON workspace_payouts(provider, provider_transfer_id, status)
  WHERE provider_transfer_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_workspace_payout_accounts_set_updated_at ON workspace_payout_accounts;
CREATE TRIGGER trg_workspace_payout_accounts_set_updated_at
  BEFORE UPDATE ON workspace_payout_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_workspace_payouts_set_updated_at ON workspace_payouts;
CREATE TRIGGER trg_workspace_payouts_set_updated_at
  BEFORE UPDATE ON workspace_payouts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
