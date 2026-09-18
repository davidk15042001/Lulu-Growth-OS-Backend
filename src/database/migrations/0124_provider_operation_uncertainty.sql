-- Preserve ambiguous external writes instead of replaying them blindly.
-- A timeout or provider-side 5xx can happen after the remote system accepted
-- the request. UNCERTAIN therefore blocks automatic replay until discovery or
-- an explicit operator reconciliation resolves the outcome.

ALTER TABLE provider_operations
  DROP CONSTRAINT IF EXISTS provider_operations_status_check;

ALTER TABLE provider_operations
  ADD CONSTRAINT provider_operations_status_check
  CHECK (status IN ('PENDING','SUCCEEDED','FAILED','CANCELLED','UNCERTAIN'));

CREATE INDEX IF NOT EXISTS idx_provider_operations_uncertain
  ON provider_operations (workspace_id, updated_at DESC)
  WHERE status = 'UNCERTAIN';
