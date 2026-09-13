-- Durable request-contract ledger for invoice creation.
--
-- A client operation key represents exactly one normalized create request.
-- Keeping this separate from delivery idempotency lets invoice creation use the
-- same STARTED -> COMPLETED contract as canonical commerce operations while
-- retaining the older delivery table unchanged.

CREATE TABLE IF NOT EXISTS commercial_document_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL CHECK (char_length(trim(operation_key)) BETWEEN 1 AND 200),
  operation_type TEXT NOT NULL CHECK (operation_type IN ('invoice.create')),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'STARTED' CHECK (status IN ('STARTED','COMPLETED')),
  document_id UUID,
  result JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('USER','AI_AGENT','WORKFLOW','SYSTEM','ADMIN')),
  actor_ref TEXT,
  correlation_id TEXT,
  causation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (workspace_id, operation_key),
  FOREIGN KEY (workspace_id, document_id)
    REFERENCES invoices(workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_commercial_document_operations_document
  ON commercial_document_operations(workspace_id, document_id, operation_type)
  WHERE status = 'COMPLETED' AND document_id IS NOT NULL;
