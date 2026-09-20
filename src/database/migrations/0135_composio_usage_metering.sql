-- Composio usage is prepaid from the workspace AI wallet. The price is a
-- fixed CNY amount so no provider response can create an unbounded charge.
CREATE TABLE IF NOT EXISTS workspace_composio_usage_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  usage_type VARCHAR(24) NOT NULL CHECK (usage_type IN ('TOOL_CALL','TRIGGER')),
  amount_cny NUMERIC(20,6) NOT NULL CHECK (amount_cny = 0.500000),
  toolkit_slug VARCHAR(80) NOT NULL,
  tool_slug VARCHAR(200),
  trigger_slug VARCHAR(200),
  provider_event_id VARCHAR(240),
  idempotency_key VARCHAR(240) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'CHARGED'
    CHECK (status IN ('CHARGED','SUCCEEDED','FAILED','AMBIGUOUS')),
  provider_log_id VARCHAR(240),
  error_code VARCHAR(120),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (usage_type = 'TOOL_CALL'
      AND tool_slug IS NOT NULL
      AND trigger_slug IS NULL
      AND provider_event_id IS NULL)
    OR
    (usage_type = 'TRIGGER'
      AND tool_slug IS NULL
      AND trigger_slug IS NOT NULL
      AND provider_event_id IS NOT NULL)
  ),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_composio_usage_event_uidx
  ON workspace_composio_usage_ledger(workspace_id, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workspace_composio_usage_workspace_idx
  ON workspace_composio_usage_ledger(workspace_id, created_at DESC, id);

ALTER TABLE workspace_api_wallet_ledger
  ADD COLUMN IF NOT EXISTS composio_usage_id UUID;

ALTER TABLE workspace_api_wallet_ledger
  DROP CONSTRAINT IF EXISTS workspace_api_wallet_ledger_entry_type_check;
ALTER TABLE workspace_api_wallet_ledger
  ADD CONSTRAINT workspace_api_wallet_ledger_entry_type_check CHECK (entry_type IN (
    'TOPUP_CREDIT','USAGE_RESERVE','USAGE_RELEASE','USAGE_DEBIT','REFUND',
    'ADJUSTMENT','DEPOSIT_RESERVED','RESERVATION_RELEASED',
    'COMPOSIO_TOOL_CALL','COMPOSIO_TRIGGER'
  ));

ALTER TABLE workspace_api_wallet_ledger
  DROP CONSTRAINT IF EXISTS workspace_api_wallet_ledger_amount_delta_check;
ALTER TABLE workspace_api_wallet_ledger
  ADD CONSTRAINT workspace_api_wallet_ledger_amount_delta_check CHECK (
    amount_delta <> 0 OR entry_type IN (
      'USAGE_RELEASE','USAGE_DEBIT','REFUND','DEPOSIT_RESERVED',
      'RESERVATION_RELEASED'
    )
  );

DO $$
BEGIN
  ALTER TABLE workspace_api_wallet_ledger
    ADD CONSTRAINT workspace_api_wallet_ledger_composio_usage_fk
    FOREIGN KEY (workspace_id, composio_usage_id)
    REFERENCES workspace_composio_usage_ledger(workspace_id, id)
    ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DROP TRIGGER IF EXISTS workspace_composio_usage_ledger_set_updated_at
  ON workspace_composio_usage_ledger;
CREATE TRIGGER workspace_composio_usage_ledger_set_updated_at
BEFORE UPDATE ON workspace_composio_usage_ledger
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
