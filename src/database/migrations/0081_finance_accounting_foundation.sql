-- Operational accounting subledger: immutable balanced journals and canonical
-- invoice receipts. This is intentionally not a statutory/tax ledger.

CREATE TABLE IF NOT EXISTS financial_journals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  journal_type TEXT NOT NULL CHECK (journal_type ~ '^[A-Z][A-Z0-9_.-]{1,80}$'),
  occurred_at TIMESTAMPTZ NOT NULL,
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_debits_minor BIGINT NOT NULL CHECK (total_debits_minor BETWEEN 1 AND 9007199254740991),
  total_credits_minor BIGINT NOT NULL CHECK (total_credits_minor BETWEEN 1 AND 9007199254740991),
  reference_type TEXT,
  reference_id TEXT,
  idempotency_key TEXT NOT NULL CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 180),
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  CHECK (total_debits_minor = total_credits_minor),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_financial_journals_workspace_occurred
  ON financial_journals(workspace_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_financial_journals_workspace_reference
  ON financial_journals(workspace_id, reference_type, reference_id, occurred_at DESC);

-- Legacy entries predate journal headers. line_key remains nullable so those
-- immutable rows do not need to be rewritten; every new balanced journal sets it.
ALTER TABLE financial_ledger_entries
  ADD COLUMN IF NOT EXISTS line_key TEXT;

ALTER TABLE financial_ledger_entries
  DROP CONSTRAINT IF EXISTS financial_ledger_entries_line_key_check;
ALTER TABLE financial_ledger_entries
  ADD CONSTRAINT financial_ledger_entries_line_key_check
  CHECK (line_key IS NULL OR line_key ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$');

CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_ledger_journal_line
  ON financial_ledger_entries(workspace_id, entry_group_id, line_key)
  WHERE line_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS invoice_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  invoice_id UUID NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor BETWEEN 1 AND 9007199254740991),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('BANK_TRANSFER','CARD','ALIPAY','WECHAT_PAY','CASH','OTHER')),
  payment_reference TEXT,
  received_at TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 180),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, invoice_id) REFERENCES invoices(workspace_id, id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice
  ON invoice_payments(workspace_id, invoice_id, received_at DESC, id DESC);

CREATE OR REPLACE FUNCTION prevent_operational_accounting_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Operational accounting records are append-only'
    USING ERRCODE = '55000', CONSTRAINT = 'operational_accounting_append_only';
END;
$$;

DROP TRIGGER IF EXISTS trg_financial_journals_append_only ON financial_journals;
CREATE TRIGGER trg_financial_journals_append_only
  BEFORE UPDATE OR DELETE ON financial_journals
  FOR EACH ROW EXECUTE FUNCTION prevent_operational_accounting_mutation();

DROP TRIGGER IF EXISTS trg_invoice_payments_append_only ON invoice_payments;
CREATE TRIGGER trg_invoice_payments_append_only
  BEFORE UPDATE OR DELETE ON invoice_payments
  FOR EACH ROW EXECUTE FUNCTION prevent_operational_accounting_mutation();
