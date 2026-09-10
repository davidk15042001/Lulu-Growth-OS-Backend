-- Repair production databases where migration history and the effective
-- workspace usage adjustment constraint drifted apart. Exact administrator
-- cost overrides need signed adjustments: positive values are credits and
-- negative values are surcharges. Zero rows are omitted by the repository.

ALTER TABLE workspace_usage_adjustments
  DROP CONSTRAINT IF EXISTS workspace_usage_adjustments_amount_usd_check;

ALTER TABLE workspace_usage_adjustments
  ADD CONSTRAINT workspace_usage_adjustments_amount_usd_check
  CHECK (amount_usd <> 0);
