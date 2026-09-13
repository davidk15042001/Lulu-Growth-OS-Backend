-- A refunded or charged-back AI top-up can already have funded provider usage.
-- Keep that shortfall explicit and block further prepaid execution until later
-- credits settle it; never make a reversed balance silently reusable.

ALTER TABLE workspace_api_wallets
  ADD COLUMN IF NOT EXISTS reversal_debt_amount NUMERIC(20,6) NOT NULL DEFAULT 0
    CHECK (reversal_debt_amount >= 0);
