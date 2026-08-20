BEGIN;

ALTER TABLE workspace_billing_checkouts
  DROP CONSTRAINT IF EXISTS workspace_billing_checkouts_plan_key_check;

ALTER TABLE workspace_billing_checkouts
  ADD CONSTRAINT workspace_billing_checkouts_plan_key_check
  CHECK (plan_key IN ('explorer', 'starter', 'ai', 'test'));

COMMIT;

