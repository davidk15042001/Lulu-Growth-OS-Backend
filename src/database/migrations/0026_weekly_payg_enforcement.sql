-- Align usage billing to Berlin Mondays and enforce payment before further AI use.
ALTER TABLE workspace_payg_profiles
  DROP CONSTRAINT IF EXISTS workspace_payg_profiles_interval_days_check;

ALTER TABLE workspace_payg_profiles
  ALTER COLUMN interval_days SET DEFAULT 7;

ALTER TABLE workspace_payg_profiles
  ADD COLUMN IF NOT EXISTS ai_access_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS block_reason TEXT,
  ADD COLUMN IF NOT EXISTS blocked_period_id UUID REFERENCES workspace_payg_periods(id) ON DELETE SET NULL;

UPDATE workspace_payg_profiles p
SET interval_days = 7,
    current_period_end = (
      date_trunc('week', NOW() AT TIME ZONE 'Europe/Berlin') + INTERVAL '7 days'
    ) AT TIME ZONE 'Europe/Berlin'
WHERE NOT EXISTS (
  SELECT 1
  FROM workspace_payg_periods pp
  WHERE pp.workspace_id = p.workspace_id
    AND pp.period_start = p.current_period_start
    AND pp.period_end = p.current_period_end
    AND pp.status IN ('processing', 'payment_due', 'paid', 'skipped')
);

ALTER TABLE workspace_payg_profiles
  ADD CONSTRAINT workspace_payg_profiles_interval_days_check CHECK (interval_days = 7);

ALTER TABLE workspace_payg_periods
  DROP CONSTRAINT IF EXISTS workspace_payg_periods_status_check;

ALTER TABLE workspace_payg_periods
  ADD CONSTRAINT workspace_payg_periods_status_check
  CHECK (status IN ('processing', 'payment_due', 'payment_failed', 'paid', 'skipped', 'failed', 'voided'));

CREATE INDEX IF NOT EXISTS idx_workspace_payg_profiles_ai_blocked
  ON workspace_payg_profiles (workspace_id)
  WHERE ai_access_blocked = TRUE;

-- Reprice only still-unbilled usage. Finalized historical invoices remain immutable.
UPDATE ai_usage_ledger
SET customer_cost_usd = (input_tokens::numeric / 1000000) * 5
                      + (output_tokens::numeric / 1000000) * 10
WHERE payg_period_id IS NULL;

UPDATE workspace_server_usage_ledger
SET customer_cost_usd = provider_cost_usd * 2
WHERE payg_period_id IS NULL;

-- Test workspaces are usage-billed too. Customer provisioning is completed by
-- the billing worker because it requires an idempotent Airwallex API call.
INSERT INTO workspace_payg_profiles (
  workspace_id, interval_days, current_period_start, current_period_end
)
SELECT ws.workspace_id,
       7,
       date_trunc('week', NOW() AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'Europe/Berlin',
       (date_trunc('week', NOW() AT TIME ZONE 'Europe/Berlin') + INTERVAL '7 days') AT TIME ZONE 'Europe/Berlin'
FROM workspace_subscriptions ws
WHERE ws.status = 'active'
  AND ws.plan_key = 'test'
ON CONFLICT (workspace_id) DO UPDATE SET enabled = TRUE, interval_days = 7;

UPDATE workspace_payg_profiles p
SET ai_access_blocked = TRUE,
    blocked_at = COALESCE(p.blocked_at, NOW()),
    block_reason = 'PAYMENT_SOURCE_SETUP_REQUIRED'
FROM workspace_subscriptions s
WHERE s.workspace_id = p.workspace_id
  AND s.plan_key = 'test'
  AND s.status = 'active'
  AND p.provider_payment_source_id IS NULL
  AND NULLIF(s.metadata->>'paymentSourceId', '') IS NULL;
