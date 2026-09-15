-- Manual, off-platform funding adjustments for verified administrators.
-- These records never create or mutate an Airwallex top-up. They only add a
-- canonical wallet ledger entry (AI/ads) or a PAYG storage credit (storage).

ALTER TABLE workspace_usage_adjustments
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(240),
  ADD COLUMN IF NOT EXISTS source VARCHAR(40) NOT NULL DEFAULT 'payg_credit',
  ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(240);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_usage_adjustments_idempotency_idx
  ON workspace_usage_adjustments(workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE workspace_usage_adjustments
  DROP CONSTRAINT IF EXISTS workspace_usage_adjustments_source_check;

ALTER TABLE workspace_usage_adjustments
  ADD CONSTRAINT workspace_usage_adjustments_source_check
  CHECK (source IN ('payg_credit', 'admin_manual_offline'));
