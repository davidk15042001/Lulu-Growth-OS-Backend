-- Link invoices to the canonical commerce order without reusing the legacy
-- workspace-record reference. Both columns remain during the compatibility
-- window, but a single invoice can point to only one order representation.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS commerce_order_id UUID;

ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_workspace_commerce_order_fk;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_workspace_commerce_order_fk
  FOREIGN KEY (workspace_id, commerce_order_id)
  REFERENCES commerce_orders(workspace_id, id)
  ON DELETE SET NULL (commerce_order_id);

ALTER TABLE invoices
  DROP CONSTRAINT IF EXISTS invoices_single_order_source_check;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_single_order_source_check
  CHECK (NOT (order_record_id IS NOT NULL AND commerce_order_id IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_from_canonical_order_stage
  ON invoices(workspace_id, commerce_order_id, invoice_type, COALESCE(issue_stage, ''))
  WHERE commerce_order_id IS NOT NULL AND status NOT IN ('CANCELLED','VOID');

CREATE INDEX IF NOT EXISTS idx_invoices_workspace_commerce_order
  ON invoices(workspace_id, commerce_order_id)
  WHERE commerce_order_id IS NOT NULL;
