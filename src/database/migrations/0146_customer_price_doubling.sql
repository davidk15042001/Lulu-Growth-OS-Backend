-- Double only future Lulu customer metering rates. Historical ledger rows keep
-- their original amount so invoices, refunds, and audit evidence remain stable.
ALTER TABLE workspace_composio_usage_ledger
  DROP CONSTRAINT IF EXISTS workspace_composio_usage_ledger_amount_cny_check;
ALTER TABLE workspace_composio_usage_ledger
  ADD CONSTRAINT workspace_composio_usage_ledger_amount_cny_check CHECK (
    (billing_exempt AND amount_cny = 0.000000)
    OR (NOT billing_exempt AND amount_cny IN (0.500000, 1.000000))
  );

COMMENT ON CONSTRAINT workspace_composio_usage_ledger_amount_cny_check
  ON workspace_composio_usage_ledger IS
  'Legacy 0.50 CNY rows remain valid; new customer Composio metering is 1.00 CNY.';
