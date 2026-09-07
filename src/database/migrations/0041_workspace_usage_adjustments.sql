-- 0041_workspace_usage_adjustments.sql
-- Audited, one-time PAYG credits that administrators can grant for offers,
-- goodwill, or support resolutions. Adjustments never mutate raw usage and
-- only apply to the not-yet-invoiced PAYG period captured below.

CREATE TABLE IF NOT EXISTS workspace_usage_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('api', 'server')),
  amount_usd NUMERIC(18,8) NOT NULL CHECK (amount_usd > 0),
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) BETWEEN 1 AND 500),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  payg_period_id UUID REFERENCES workspace_payg_periods(id) ON DELETE SET NULL,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (period_end > period_start)
);

CREATE INDEX IF NOT EXISTS idx_workspace_usage_adjustments_pending
  ON workspace_usage_adjustments (workspace_id, period_start, period_end)
  WHERE payg_period_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_usage_adjustments_history
  ON workspace_usage_adjustments (workspace_id, created_at DESC);
