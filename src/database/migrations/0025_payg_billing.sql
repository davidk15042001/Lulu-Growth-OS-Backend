-- Usage-based API and server billing in fixed 14-day periods.
CREATE TABLE IF NOT EXISTS workspace_payg_profiles (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  interval_days INTEGER NOT NULL DEFAULT 14 CHECK (interval_days = 14),
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_period_end TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
  collection_method TEXT NOT NULL DEFAULT 'CHARGE_ON_CHECKOUT'
    CHECK (collection_method IN ('AUTO_CHARGE', 'CHARGE_ON_CHECKOUT')),
  provider_payment_source_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (current_period_end > current_period_start)
);

CREATE TABLE IF NOT EXISTS workspace_payg_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'payment_due', 'paid', 'skipped', 'failed', 'voided')),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  api_cost_usd NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (api_cost_usd >= 0),
  server_cost_usd NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (server_cost_usd >= 0),
  total_cost_usd NUMERIC(18,8) GENERATED ALWAYS AS (api_cost_usd + server_cost_usd) STORED,
  provider_invoice_id TEXT UNIQUE,
  hosted_invoice_url TEXT,
  invoice_pdf_url TEXT,
  line_items_added_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  processing_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error_code TEXT,
  last_error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, period_start, period_end),
  CHECK (period_end > period_start)
);

ALTER TABLE ai_usage_ledger
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE ai_usage_ledger
  ADD COLUMN IF NOT EXISTS payg_period_id UUID REFERENCES workspace_payg_periods(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ai_usage_ledger_payg_unbilled
  ON ai_usage_ledger (workspace_id, created_at)
  WHERE payg_period_id IS NULL;

CREATE TABLE IF NOT EXISTS workspace_server_usage_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  provider_cost_usd NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (provider_cost_usd >= 0),
  customer_cost_usd NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (customer_cost_usd >= 0),
  payg_period_id UUID REFERENCES workspace_payg_periods(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_server_usage_payg_unbilled
  ON workspace_server_usage_ledger (workspace_id, created_at)
  WHERE payg_period_id IS NULL;

INSERT INTO workspace_payg_profiles (
  workspace_id, current_period_start, current_period_end
)
SELECT ws.workspace_id, NOW(), NOW() + INTERVAL '14 days'
FROM workspace_subscriptions ws
WHERE ws.provider = 'airwallex'
  AND ws.status = 'active'
  AND ws.plan_key IN ('starter', 'ai')
ON CONFLICT (workspace_id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_workspace_payg_profiles_set_updated_at ON workspace_payg_profiles;
CREATE TRIGGER trg_workspace_payg_profiles_set_updated_at
  BEFORE UPDATE ON workspace_payg_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_workspace_payg_periods_set_updated_at ON workspace_payg_periods;
CREATE TRIGGER trg_workspace_payg_periods_set_updated_at
  BEFORE UPDATE ON workspace_payg_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
