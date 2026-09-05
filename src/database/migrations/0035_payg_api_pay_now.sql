-- A customer may settle accrued API usage before the weekly PAYG cycle closes.
-- Server/storage allocations remain in the weekly cycle and are never moved by
-- an API-only settlement.
ALTER TABLE workspace_payg_periods
  ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'weekly'
    CHECK (billing_mode IN ('weekly', 'api_pay_now'));

CREATE INDEX IF NOT EXISTS idx_workspace_payg_periods_api_pay_now_open
  ON workspace_payg_periods (workspace_id, created_at DESC)
  WHERE billing_mode = 'api_pay_now'
    AND status IN ('processing', 'payment_due', 'payment_failed', 'failed');
