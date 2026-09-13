-- Preserve pooled advertising-wallet accounting across refunds and chargebacks.
-- A provider reversal may exceed liquid funds because part of the top-up is
-- reserved or already spent.  The shortfall is an explicit debt; unrelated
-- reservations remain intact and new spend stays blocked until later credits
-- or reservation releases settle that debt.

ALTER TABLE workspace_ad_spend_wallets
  ADD COLUMN IF NOT EXISTS reversal_debt_amount NUMERIC(20,2) NOT NULL DEFAULT 0
    CHECK (reversal_debt_amount >= 0);
