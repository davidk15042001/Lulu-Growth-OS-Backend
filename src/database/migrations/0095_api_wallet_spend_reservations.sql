-- A customer-funded AI request must reserve its maximum customer charge before
-- any metered provider request is submitted.  available_amount remains the
-- immediately spendable balance; reserved_amount is the total of durable holds.
ALTER TABLE workspace_api_wallets
  ADD COLUMN IF NOT EXISTS reserved_amount NUMERIC(20,6) NOT NULL DEFAULT 0
    CHECK (reserved_amount >= 0);

CREATE TABLE IF NOT EXISTS ai_spend_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_key VARCHAR(240) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  operation VARCHAR(120) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'RESERVED' CHECK (status IN (
    'RESERVED','SUBMITTING','SUBMITTED','AMBIGUOUS','SETTLED','RELEASED'
  )),
  reserved_amount NUMERIC(20,6) NOT NULL CHECK (reserved_amount > 0),
  settled_amount NUMERIC(20,6) CHECK (settled_amount >= 0),
  maximum_customer_cost_usd NUMERIC(20,8) NOT NULL CHECK (maximum_customer_cost_usd > 0),
  actual_customer_cost_usd NUMERIC(20,8) CHECK (actual_customer_cost_usd >= 0),
  usd_cny_rate NUMERIC(18,8) NOT NULL CHECK (usd_cny_rate > 0),
  pricing_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider VARCHAR(80),
  model VARCHAR(200),
  provider_request_id VARCHAR(240),
  usage_ledger_id UUID,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ambiguity_reason TEXT,
  submitted_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (settled_amount IS NULL OR settled_amount <= reserved_amount),
  CHECK (
    (status = 'SETTLED'
      AND settled_amount IS NOT NULL
      AND actual_customer_cost_usd IS NOT NULL
      AND usage_ledger_id IS NOT NULL
      AND settled_at IS NOT NULL
      AND released_at IS NULL)
    OR
    (status = 'RELEASED'
      AND settled_amount IS NULL
      AND actual_customer_cost_usd IS NULL
      AND usage_ledger_id IS NULL
      AND settled_at IS NULL
      AND released_at IS NOT NULL)
    OR
    (status NOT IN ('SETTLED','RELEASED')
      AND settled_amount IS NULL
      AND actual_customer_cost_usd IS NULL
      AND usage_ledger_id IS NULL
      AND settled_at IS NULL
      AND released_at IS NULL)
  ),
  UNIQUE (workspace_id, request_key),
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS ai_spend_reservations_recovery_idx
  ON ai_spend_reservations(status, updated_at)
  WHERE status IN ('RESERVED','SUBMITTING','SUBMITTED','AMBIGUOUS');
CREATE INDEX IF NOT EXISTS ai_spend_reservations_workspace_idx
  ON ai_spend_reservations(workspace_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_spend_reservation_provider_request
  ON ai_spend_reservations(workspace_id, provider, provider_request_id)
  WHERE provider IS NOT NULL AND provider_request_id IS NOT NULL;

ALTER TABLE ai_usage_ledger
  ADD COLUMN IF NOT EXISTS reservation_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_usage_ledger_workspace_id
  ON ai_usage_ledger(workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_usage_ledger_reservation
  ON ai_usage_ledger(workspace_id, reservation_id)
  WHERE reservation_id IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE ai_usage_ledger
    ADD CONSTRAINT ai_usage_ledger_reservation_fk
    FOREIGN KEY (workspace_id, reservation_id)
    REFERENCES ai_spend_reservations(workspace_id, id)
    ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE ai_spend_reservations
    ADD CONSTRAINT ai_spend_reservation_usage_fk
    FOREIGN KEY (workspace_id, usage_ledger_id)
    REFERENCES ai_usage_ledger(workspace_id, id)
    ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE workspace_api_wallet_ledger
  DROP CONSTRAINT IF EXISTS workspace_api_wallet_ledger_entry_type_check;
ALTER TABLE workspace_api_wallet_ledger
  ADD CONSTRAINT workspace_api_wallet_ledger_entry_type_check CHECK (entry_type IN (
    'TOPUP_CREDIT','USAGE_RESERVE','USAGE_RELEASE','USAGE_DEBIT','REFUND','ADJUSTMENT'
  ));
ALTER TABLE workspace_api_wallet_ledger
  DROP CONSTRAINT IF EXISTS workspace_api_wallet_ledger_check;
ALTER TABLE workspace_api_wallet_ledger
  DROP CONSTRAINT IF EXISTS workspace_api_wallet_ledger_amount_delta_check;
ALTER TABLE workspace_api_wallet_ledger
  ADD CONSTRAINT workspace_api_wallet_ledger_amount_delta_check CHECK (
    amount_delta <> 0 OR entry_type IN ('USAGE_RELEASE','USAGE_DEBIT','REFUND')
  );

ALTER TABLE workspace_api_wallet_ledger
  ADD COLUMN IF NOT EXISTS reservation_id UUID;

DO $$
BEGIN
  ALTER TABLE workspace_api_wallet_ledger
    ADD CONSTRAINT workspace_api_wallet_ledger_reservation_fk
    FOREIGN KEY (workspace_id, reservation_id)
    REFERENCES ai_spend_reservations(workspace_id, id)
    ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE workspace_api_wallet_ledger
  DROP CONSTRAINT IF EXISTS workspace_api_wallet_ledger_idempotency_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_api_wallet_ledger_idempotency
  ON workspace_api_wallet_ledger(workspace_id, idempotency_key);

DROP TRIGGER IF EXISTS ai_spend_reservations_set_updated_at ON ai_spend_reservations;
CREATE TRIGGER ai_spend_reservations_set_updated_at
BEFORE UPDATE ON ai_spend_reservations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
