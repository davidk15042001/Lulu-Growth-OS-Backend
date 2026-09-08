-- Extend audited administrator usage credits to storage.
-- Storage is settled together with the existing server/infrastructure charge;
-- it does not mutate raw upload bytes or usage ledger entries.
ALTER TABLE workspace_usage_adjustments
  DROP CONSTRAINT IF EXISTS workspace_usage_adjustments_metric_check;

ALTER TABLE workspace_usage_adjustments
  ADD CONSTRAINT workspace_usage_adjustments_metric_check
  CHECK (metric IN ('api', 'server', 'storage'));
