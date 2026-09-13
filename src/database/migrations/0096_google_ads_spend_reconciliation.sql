-- Google Ads accepts a campaign cap; it does not spend that cap at mutation
-- time. Keep the original customer authorization and wallet amount reserved,
-- then settle only provider-observed campaign cost deltas. The final remainder
-- stays held until both the provider campaign and its billing evidence are
-- conclusively closed.

ALTER TABLE workspace_ad_spend_reservations
  ADD COLUMN IF NOT EXISTS settled_amount NUMERIC(20,2) NOT NULL DEFAULT 0;

ALTER TABLE workspace_ad_spend_reservations
  DROP CONSTRAINT IF EXISTS workspace_ad_spend_reservations_settled_amount_check;
ALTER TABLE workspace_ad_spend_reservations
  ADD CONSTRAINT workspace_ad_spend_reservations_settled_amount_check
  CHECK (settled_amount >= 0 AND settled_amount <= amount);

ALTER TABLE workspace_ad_spend_reservations
  DROP CONSTRAINT IF EXISTS workspace_ad_spend_reservations_workspace_id_key;
ALTER TABLE workspace_ad_spend_reservations
  ADD CONSTRAINT workspace_ad_spend_reservations_workspace_id_key UNIQUE (workspace_id,id);

-- A RESERVED Google operation from the old implementation may already have
-- reached the provider after an ambiguous network outcome. It has no durable
-- allocation record, so it must never be mistaken for a safely releasable
-- post-migration initialization orphan.
UPDATE workspace_ad_spend_reservations
SET metadata=metadata||'{"legacyPreReconciliation":true}'::jsonb
WHERE platform='google-ads' AND status='RESERVED';

CREATE TABLE IF NOT EXISTS workspace_google_ads_spend_allocations (
  reservation_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  authorization_id UUID NOT NULL,
  customer_id VARCHAR(32) NOT NULL CHECK (customer_id ~ '^[0-9]+$'),
  campaign_id VARCHAR(32) NOT NULL CHECK (campaign_id ~ '^[0-9]+$'),
  campaign_budget_resource_name VARCHAR(240) NOT NULL,
  login_customer_id VARCHAR(32) NOT NULL CHECK (login_customer_id ~ '^[0-9]+$'),
  currency VARCHAR(3) NOT NULL CHECK (currency = 'CNY'),
  cap_micros BIGINT NOT NULL CHECK (cap_micros > 0),
  baseline_cost_micros BIGINT NOT NULL CHECK (baseline_cost_micros >= 0),
  desired_total_budget_micros BIGINT NOT NULL CHECK (desired_total_budget_micros > 0),
  last_observed_cost_micros BIGINT NOT NULL CHECK (last_observed_cost_micros >= 0),
  settled_cost_micros BIGINT NOT NULL DEFAULT 0 CHECK (settled_cost_micros >= 0),
  over_cap_micros BIGINT NOT NULL DEFAULT 0 CHECK (over_cap_micros >= 0),
  launch_state VARCHAR(24) NOT NULL DEFAULT 'PENDING'
    CHECK (launch_state IN ('PENDING','APPLIED','UNCERTAIN','REJECTED')),
  closure_state VARCHAR(32) NOT NULL DEFAULT 'OPEN'
    CHECK (closure_state IN ('OPEN','REQUESTED','PAUSE_UNCERTAIN','PROVIDER_PAUSED','AWAITING_BILLING','FINALIZED')),
  provider_campaign_status VARCHAR(32),
  provider_request_id VARCHAR(240),
  billing_setup_resource_name VARCHAR(240) NOT NULL,
  payments_account_id VARCHAR(32) NOT NULL CHECK (payments_account_id ~ '^[0-9]+$'),
  payments_profile_id VARCHAR(32) NOT NULL CHECK (payments_profile_id ~ '^[0-9]+$'),
  launched_at TIMESTAMPTZ,
  close_requested_at TIMESTAMPTZ,
  close_reason TEXT,
  provider_paused_at TIMESTAMPTZ,
  last_observed_at TIMESTAMPTZ,
  last_cost_changed_at TIMESTAMPTZ,
  stable_observation_count INTEGER NOT NULL DEFAULT 0 CHECK (stable_observation_count >= 0),
  billing_evidence_at TIMESTAMPTZ,
  billing_evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(billing_evidence) = 'object'),
  finalized_at TIMESTAMPTZ,
  next_reconcile_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner VARCHAR(240),
  lease_expires_at TIMESTAMPTZ,
  last_error_code VARCHAR(120),
  last_error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id,reservation_id),
  FOREIGN KEY (workspace_id,reservation_id)
    REFERENCES workspace_ad_spend_reservations(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,authorization_id)
    REFERENCES workspace_ad_budget_authorizations(workspace_id,id) ON DELETE CASCADE,
  CHECK (desired_total_budget_micros = baseline_cost_micros + cap_micros),
  CHECK ((closure_state = 'FINALIZED') = (finalized_at IS NOT NULL)),
  CHECK (billing_evidence_at IS NULL OR jsonb_typeof(billing_evidence) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_google_ads_open_campaign_uidx
  ON workspace_google_ads_spend_allocations(workspace_id,customer_id,campaign_id)
  WHERE launch_state <> 'REJECTED' AND closure_state <> 'FINALIZED';

CREATE INDEX IF NOT EXISTS workspace_google_ads_reconcile_ready_idx
  ON workspace_google_ads_spend_allocations(next_reconcile_at,created_at)
  WHERE launch_state <> 'REJECTED' AND closure_state <> 'FINALIZED';

CREATE INDEX IF NOT EXISTS workspace_google_ads_lease_idx
  ON workspace_google_ads_spend_allocations(lease_expires_at)
  WHERE lease_expires_at IS NOT NULL AND closure_state <> 'FINALIZED';

CREATE TABLE IF NOT EXISTS workspace_google_ads_spend_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  reservation_id UUID NOT NULL,
  source VARCHAR(32) NOT NULL CHECK (source IN ('CAMPAIGN_METRICS','BILLING_INVOICE')),
  idempotency_key VARCHAR(240) NOT NULL,
  provider_request_id VARCHAR(240),
  provider_cost_micros BIGINT CHECK (provider_cost_micros IS NULL OR provider_cost_micros >= 0),
  provider_campaign_status VARCHAR(32),
  provider_budget_total_micros BIGINT CHECK (provider_budget_total_micros IS NULL OR provider_budget_total_micros >= 0),
  billing_setup_resource_name VARCHAR(240),
  payments_account_id VARCHAR(32),
  payments_profile_id VARCHAR(32),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id,idempotency_key),
  FOREIGN KEY (workspace_id,reservation_id)
    REFERENCES workspace_google_ads_spend_allocations(workspace_id,reservation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS workspace_google_ads_observations_allocation_idx
  ON workspace_google_ads_spend_observations(workspace_id,reservation_id,observed_at DESC);

CREATE TABLE IF NOT EXISTS workspace_google_ads_spend_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  reservation_id UUID NOT NULL,
  observation_id UUID NOT NULL REFERENCES workspace_google_ads_spend_observations(id) ON DELETE CASCADE,
  idempotency_key VARCHAR(240) NOT NULL,
  previous_settled_cost_micros BIGINT NOT NULL CHECK (previous_settled_cost_micros >= 0),
  settled_cost_micros BIGINT NOT NULL CHECK (settled_cost_micros >= 0),
  delta_cost_micros BIGINT NOT NULL CHECK (delta_cost_micros <> 0),
  amount_delta NUMERIC(20,2) NOT NULL CHECK (amount_delta <> 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id,idempotency_key),
  FOREIGN KEY (workspace_id,reservation_id)
    REFERENCES workspace_google_ads_spend_allocations(workspace_id,reservation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS workspace_google_ads_settlements_allocation_idx
  ON workspace_google_ads_spend_settlements(workspace_id,reservation_id,created_at DESC);

DROP TRIGGER IF EXISTS workspace_google_ads_spend_allocations_set_updated_at
  ON workspace_google_ads_spend_allocations;
CREATE TRIGGER workspace_google_ads_spend_allocations_set_updated_at
BEFORE UPDATE ON workspace_google_ads_spend_allocations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
