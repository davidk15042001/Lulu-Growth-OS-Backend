-- Customer supplied operation keys are idempotent within a workspace. A
-- global uniqueness constraint lets one tenant collide with another tenant's
-- key and is therefore an avoidable cross-tenant denial-of-service boundary.

ALTER TABLE workspace_ad_spend_reservations
  DROP CONSTRAINT IF EXISTS workspace_ad_spend_reservations_idempotency_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_ad_spend_reservations_workspace_key_uidx
  ON workspace_ad_spend_reservations(workspace_id,idempotency_key);
