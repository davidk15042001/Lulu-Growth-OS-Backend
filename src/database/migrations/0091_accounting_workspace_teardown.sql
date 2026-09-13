-- Operational accounting is immutable while a workspace exists, but an
-- explicit deletion of the owning workspace must still satisfy account-erasure
-- obligations. PostgreSQL executes FK cascades after the parent row is no
-- longer visible, which gives the triggers a narrow, tenant-scoped teardown
-- signal without a globally mutable session flag.

CREATE OR REPLACE FUNCTION prevent_financial_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM workspaces WHERE id = OLD.workspace_id
  ) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Financial ledger entries are append-only'
    USING ERRCODE = '55000', CONSTRAINT = 'financial_ledger_append_only';
END;
$$;

CREATE OR REPLACE FUNCTION prevent_operational_accounting_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM workspaces WHERE id = OLD.workspace_id
  ) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Operational accounting records are append-only'
    USING ERRCODE = '55000', CONSTRAINT = 'operational_accounting_append_only';
END;
$$;

-- Payments remain protected from deleting an individual invoice because the
-- workspace still exists in that case. During workspace teardown the trigger
-- above permits only that workspace's cascaded rows to be removed.
ALTER TABLE invoice_payments
  DROP CONSTRAINT IF EXISTS invoice_payments_workspace_id_invoice_id_fkey;

ALTER TABLE invoice_payments
  ADD CONSTRAINT invoice_payments_workspace_id_invoice_id_fkey
  FOREIGN KEY (workspace_id, invoice_id)
  REFERENCES invoices(workspace_id, id)
  ON DELETE CASCADE;
