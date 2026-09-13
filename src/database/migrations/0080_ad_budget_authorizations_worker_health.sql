-- A prepaid wallet proves that funds exist. It does not authorize Lulu to
-- assign those funds to a campaign. Customer budget authorizations are a
-- separate, campaign-specific, time-bounded policy object.
CREATE TABLE IF NOT EXISTS workspace_ad_budget_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider VARCHAR(80) NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  account_id VARCHAR(200) NOT NULL CHECK (length(trim(account_id)) > 0),
  campaign_id VARCHAR(200) NOT NULL CHECK (length(trim(campaign_id)) > 0),
  currency VARCHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  authorized_amount NUMERIC(20,2) NOT NULL CHECK (authorized_amount > 0),
  reserved_amount NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
  consumed_amount NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (consumed_amount >= 0),
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','REVOKED','EXHAUSTED','EXPIRED')),
  idempotency_key VARCHAR(240) NOT NULL,
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  revoked_by UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  CHECK (starts_at < ends_at),
  CHECK (reserved_amount + consumed_amount <= authorized_amount),
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_ad_budget_authorizations_active_campaign_uidx
  ON workspace_ad_budget_authorizations(workspace_id, provider, account_id, campaign_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS workspace_ad_budget_authorizations_workspace_idx
  ON workspace_ad_budget_authorizations(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workspace_ad_budget_authorizations_active_idx
  ON workspace_ad_budget_authorizations(workspace_id, ends_at)
  WHERE status = 'ACTIVE';

DROP TRIGGER IF EXISTS workspace_ad_budget_authorizations_set_updated_at ON workspace_ad_budget_authorizations;
CREATE TRIGGER workspace_ad_budget_authorizations_set_updated_at
BEFORE UPDATE ON workspace_ad_budget_authorizations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE workspace_ad_spend_reservations
  ADD COLUMN IF NOT EXISTS authorization_id UUID,
  ADD COLUMN IF NOT EXISTS account_id VARCHAR(200);

ALTER TABLE workspace_ad_spend_reservations
  DROP CONSTRAINT IF EXISTS workspace_ad_spend_reservations_authorization_fk;
ALTER TABLE workspace_ad_spend_reservations
  ADD CONSTRAINT workspace_ad_spend_reservations_authorization_fk
  FOREIGN KEY (workspace_id, authorization_id)
  REFERENCES workspace_ad_budget_authorizations(workspace_id, id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS workspace_ad_spend_reservations_authorization_idx
  ON workspace_ad_spend_reservations(authorization_id, status, created_at DESC);

-- Old reservations predate the campaign-authorization policy and remain only
-- as immutable financial history. No new reservation is accepted without an
-- authorization_id by the application layer.

-- Autonomous reply retries must be independently schedulable after the
-- originating message event has been acknowledged or dead-lettered.
ALTER TABLE omni_ai_reply_jobs
  ADD COLUMN IF NOT EXISTS available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

DROP INDEX IF EXISTS idx_omni_ai_reply_jobs_ready;
CREATE INDEX idx_omni_ai_reply_jobs_ready
  ON omni_ai_reply_jobs(status, available_at, updated_at)
  WHERE status IN ('PENDING','PROCESSING','WAITING_FUNDS');

-- Persistent supervisor heartbeats let readiness distinguish a configured
-- worker flag from a worker process that is actually alive.
CREATE TABLE IF NOT EXISTS runtime_worker_heartbeats (
  worker_group VARCHAR(100) NOT NULL,
  instance_id VARCHAR(200) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','STOPPED')),
  registered_workers TEXT[] NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stopped_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  PRIMARY KEY (worker_group, instance_id)
);

CREATE INDEX IF NOT EXISTS runtime_worker_heartbeats_live_idx
  ON runtime_worker_heartbeats(worker_group, heartbeat_at DESC)
  WHERE status = 'RUNNING';
