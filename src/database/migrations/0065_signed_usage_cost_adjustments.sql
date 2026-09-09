-- Administrators can set the effective API/AI and storage/infrastructure
-- charges to an exact value. Negative adjustments represent an audited
-- surcharge; positive adjustments remain credits.

ALTER TABLE workspace_usage_adjustments
  DROP CONSTRAINT IF EXISTS workspace_usage_adjustments_amount_usd_check;

ALTER TABLE workspace_usage_adjustments
  ADD CONSTRAINT workspace_usage_adjustments_amount_usd_check
  CHECK (amount_usd <> 0);
