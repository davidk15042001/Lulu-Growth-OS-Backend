-- Audited, per-workspace subscription price overrides.
-- The override is intentionally separate from the plan catalog: it changes
-- only what this workspace is charged for future checkout creation and never
-- rewrites an already issued invoice or an active provider subscription.
ALTER TABLE workspace_subscriptions
  ADD COLUMN IF NOT EXISTS custom_price_minor BIGINT,
  ADD COLUMN IF NOT EXISTS custom_price_currency TEXT NOT NULL DEFAULT 'CNY',
  ADD COLUMN IF NOT EXISTS custom_price_reason TEXT,
  ADD COLUMN IF NOT EXISTS custom_price_set_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS custom_price_set_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS custom_price_provider_price_id TEXT;

ALTER TABLE workspace_subscriptions
  DROP CONSTRAINT IF EXISTS workspace_subscriptions_custom_price_check;

ALTER TABLE workspace_subscriptions
  ADD CONSTRAINT workspace_subscriptions_custom_price_check
  CHECK (custom_price_minor IS NULL OR custom_price_minor >= 0);

ALTER TABLE workspace_subscriptions
  DROP CONSTRAINT IF EXISTS workspace_subscriptions_custom_currency_check;

ALTER TABLE workspace_subscriptions
  ADD CONSTRAINT workspace_subscriptions_custom_currency_check
  CHECK (custom_price_currency = 'CNY');

CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_custom_price
  ON workspace_subscriptions (custom_price_set_at DESC)
  WHERE custom_price_minor IS NOT NULL;
