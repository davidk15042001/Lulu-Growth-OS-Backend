-- 0007_workspace_application.sql
-- Application-level workspace collaboration, billing and idempotency state.

CREATE TABLE IF NOT EXISTS workspace_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('admin', 'member', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  accepted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_invitations_pending_email
  ON workspace_invitations (workspace_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_expiry
  ON workspace_invitations (expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS workspace_subscriptions (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'internal',
  provider_customer_id TEXT,
  provider_subscription_id TEXT,
  plan_key TEXT NOT NULL DEFAULT 'starter',
  status TEXT NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
  seats INTEGER NOT NULL DEFAULT 1 CHECK (seats > 0),
  trial_ends_at TIMESTAMPTZ,
  current_period_starts_at TIMESTAMPTZ,
  current_period_ends_at TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_subscriptions_provider_customer
  ON workspace_subscriptions (provider, provider_customer_id)
  WHERE provider_customer_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_subscriptions_provider_subscription
  ON workspace_subscriptions (provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

INSERT INTO workspace_subscriptions (
  workspace_id, plan_key, status, seats, trial_ends_at,
  current_period_starts_at, current_period_ends_at
)
SELECT id, 'starter', 'trialing', 1, NOW() + INTERVAL '14 days', NOW(), NOW() + INTERVAL '1 month'
FROM workspaces
WHERE deleted_at IS NULL
ON CONFLICT (workspace_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS workspace_usage_counters (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  metric_key TEXT NOT NULL CHECK (metric_key ~ '^[a-z][a-z0-9_]*$'),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  quantity NUMERIC(30, 8) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  metadata JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, metric_key, period_start),
  CHECK (period_end >= period_start),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_workspace_usage_period
  ON workspace_usage_counters (workspace_id, period_start DESC, metric_key);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, key),
  CHECK (response_body IS NULL OR jsonb_typeof(response_body) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expiry
  ON idempotency_keys (expires_at);

DROP TRIGGER IF EXISTS trg_workspace_invitations_set_updated_at ON workspace_invitations;
CREATE TRIGGER trg_workspace_invitations_set_updated_at
  BEFORE UPDATE ON workspace_invitations
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_workspace_subscriptions_set_updated_at ON workspace_subscriptions;
CREATE TRIGGER trg_workspace_subscriptions_set_updated_at
  BEFORE UPDATE ON workspace_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
