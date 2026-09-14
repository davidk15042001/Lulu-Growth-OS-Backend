-- Add the smaller AI wallet packages used for low-cost testing and onboarding.
-- The API validator and every wallet overview expose the same package catalog.

ALTER TABLE workspace_api_topups
  DROP CONSTRAINT IF EXISTS workspace_api_topups_amount_check;

ALTER TABLE workspace_api_topups
  ADD CONSTRAINT workspace_api_topups_amount_check
  CHECK (amount IN (1, 250, 500, 1000, 2500, 5000, 9000));
