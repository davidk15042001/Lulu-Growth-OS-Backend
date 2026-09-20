-- Keep already-migrated installations compatible with zero-cost platform
-- admin usage rows introduced after the initial fixed-price Composio meter.
ALTER TABLE workspace_composio_usage_ledger
  ADD COLUMN IF NOT EXISTS billing_exempt BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE workspace_composio_usage_ledger
  DROP CONSTRAINT IF EXISTS workspace_composio_usage_ledger_amount_cny_check;
ALTER TABLE workspace_composio_usage_ledger
  ADD CONSTRAINT workspace_composio_usage_ledger_amount_cny_check CHECK (
    (billing_exempt AND amount_cny = 0.000000)
    OR (NOT billing_exempt AND amount_cny = 0.500000)
  );
