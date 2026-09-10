ALTER TABLE document_deliveries
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE document_deliveries
  DROP CONSTRAINT IF EXISTS document_deliveries_attempt_count_check;

ALTER TABLE document_deliveries
  ADD CONSTRAINT document_deliveries_attempt_count_check CHECK (attempt_count >= 0);

CREATE INDEX IF NOT EXISTS idx_document_deliveries_retry_queue
  ON document_deliveries(next_attempt_at, created_at)
  WHERE status IN ('QUEUED', 'FAILED') AND attempt_count < 8;

-- Assistant and agent execution is autonomous. Historical approval requests
-- must never become executable after this migration.
UPDATE assistant_action_requests
SET status = 'cancelled',
    error_code = 'ASSISTANT_APPROVALS_REMOVED',
    error_message = 'Per-action approvals were removed; submit a new autonomous action.',
    completed_at = COALESCE(completed_at, NOW())
WHERE status = 'pending_approval';

UPDATE agent_run_steps
SET status = 'pending',
    approval_id = NULL,
    updated_at = NOW()
WHERE status = 'waiting_approval';

UPDATE agent_runs
SET status = 'queued',
    updated_at = NOW()
WHERE status = 'waiting_approval';

UPDATE workspace_records
SET stage = 'queued_for_execution',
    data = data || '{"executionReady":true,"executionStatus":"queued","approvalId":null,"approvalStatus":"not_required"}'::jsonb,
    version = version + 1,
    updated_at = NOW()
WHERE stage = 'waiting_approval'
  AND source = 'page_agent'
  AND deleted_at IS NULL;

UPDATE approval_requests
SET status = 'cancelled',
    decision_note = COALESCE(decision_note, 'Per-action agent approvals were removed.'),
    decided_at = COALESCE(decided_at, NOW()),
    updated_at = NOW()
WHERE status = 'pending';

UPDATE commercial_policies
SET require_approval_for_custom_terms = FALSE,
    updated_at = NOW()
WHERE require_approval_for_custom_terms = TRUE;

-- Legacy document states are retained in old constraints for compatibility,
-- but no commercial document remains parked for a human decision.
UPDATE quote_versions
SET status = 'READY'
WHERE status = 'AWAITING_APPROVAL';

UPDATE quotes
SET status = 'READY',
    updated_at = NOW()
WHERE status = 'AWAITING_APPROVAL';

UPDATE invoices
SET status = 'READY',
    updated_at = NOW()
WHERE status = 'AWAITING_APPROVAL';
