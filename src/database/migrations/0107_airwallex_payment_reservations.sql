-- Airwallex payment lifecycle hardening.
-- A payment is not usable credit until Airwallex confirms it.  The wallet
-- therefore keeps payment deposits separate from both spendable credit and
-- in-flight execution/campaign reservations.

ALTER TABLE workspace_api_wallets
  ADD COLUMN IF NOT EXISTS payment_reserved_amount NUMERIC(20,6) NOT NULL DEFAULT 0
    CHECK (payment_reserved_amount >= 0);

ALTER TABLE workspace_ad_spend_wallets
  ADD COLUMN IF NOT EXISTS payment_reserved_amount NUMERIC(20,2) NOT NULL DEFAULT 0
    CHECK (payment_reserved_amount >= 0);

ALTER TABLE workspace_api_topups
  ADD COLUMN IF NOT EXISTS provider_status VARCHAR(80),
  ADD COLUMN IF NOT EXISTS payment_status VARCHAR(32) NOT NULL DEFAULT 'PENDING'
    CHECK (payment_status IN ('PENDING','SUCCEEDED','FAILED','CANCELLED','EXPIRED','REFUNDED','CHARGEBACK','UNKNOWN')),
  ADD COLUMN IF NOT EXISTS credit_status VARCHAR(32) NOT NULL DEFAULT 'NOT_CREDITED'
    CHECK (credit_status IN ('NOT_CREDITED','AVAILABLE','REVERSED')),
  ADD COLUMN IF NOT EXISTS settlement_status VARCHAR(32) NOT NULL DEFAULT 'PENDING'
    CHECK (settlement_status IN ('PENDING','COMPLETED','NOT_APPLICABLE')),
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;

ALTER TABLE workspace_ad_spend_topups
  ADD COLUMN IF NOT EXISTS provider_status VARCHAR(80),
  ADD COLUMN IF NOT EXISTS payment_status VARCHAR(32) NOT NULL DEFAULT 'PENDING'
    CHECK (payment_status IN ('PENDING','SUCCEEDED','FAILED','CANCELLED','EXPIRED','REFUNDED','CHARGEBACK','UNKNOWN')),
  ADD COLUMN IF NOT EXISTS credit_status VARCHAR(32) NOT NULL DEFAULT 'NOT_CREDITED'
    CHECK (credit_status IN ('NOT_CREDITED','AVAILABLE','REVERSED')),
  ADD COLUMN IF NOT EXISTS settlement_status VARCHAR(32) NOT NULL DEFAULT 'PENDING'
    CHECK (settlement_status IN ('PENDING','COMPLETED','NOT_APPLICABLE')),
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;

-- Make the new lifecycle columns truthful for payments that were already
-- processed before this migration existed.
UPDATE workspace_api_topups
SET provider_status = COALESCE(provider_status, status),
    payment_status = CASE
      WHEN status = 'SUCCEEDED' THEN 'SUCCEEDED'
      WHEN status IN ('FAILED','CANCELLED','EXPIRED','REFUNDED','CHARGEBACK') THEN status
      WHEN status = 'CREATED' OR status = 'PENDING_PAYMENT' OR status = 'REQUIRES_CUSTOMER_ACTION' THEN 'PENDING'
      ELSE 'UNKNOWN'
    END,
    settlement_status = CASE
      WHEN status = 'SUCCEEDED' THEN 'COMPLETED'
      WHEN status IN ('REFUNDED','CHARGEBACK') AND credited_at IS NOT NULL THEN 'COMPLETED'
      WHEN status IN ('FAILED','CANCELLED','EXPIRED','REFUNDED','CHARGEBACK') THEN 'NOT_APPLICABLE'
      ELSE 'PENDING'
    END,
    credit_status = CASE
      WHEN credited_at IS NOT NULL AND status IN ('SUCCEEDED','REFUNDED','CHARGEBACK') THEN CASE WHEN status = 'SUCCEEDED' THEN 'AVAILABLE' ELSE 'REVERSED' END
      ELSE 'NOT_CREDITED'
    END,
    confirmed_at = CASE WHEN status = 'SUCCEEDED' THEN COALESCE(confirmed_at, paid_at, credited_at) ELSE confirmed_at END,
    settled_at = CASE WHEN status = 'SUCCEEDED' OR (status IN ('REFUNDED','CHARGEBACK') AND credited_at IS NOT NULL) THEN COALESCE(settled_at, paid_at, credited_at) ELSE settled_at END,
    cancelled_at = CASE WHEN status IN ('FAILED','CANCELLED','EXPIRED','REFUNDED','CHARGEBACK') THEN COALESCE(cancelled_at, updated_at) ELSE cancelled_at END;

UPDATE workspace_ad_spend_topups
SET provider_status = COALESCE(provider_status, status),
    payment_status = CASE
      WHEN status = 'SUCCEEDED' THEN 'SUCCEEDED'
      WHEN status IN ('FAILED','CANCELLED','EXPIRED','REFUNDED','CHARGEBACK') THEN status
      WHEN status = 'CREATED' OR status = 'PENDING_PAYMENT' OR status = 'REQUIRES_CUSTOMER_ACTION' THEN 'PENDING'
      ELSE 'UNKNOWN'
    END,
    settlement_status = CASE
      WHEN status = 'SUCCEEDED' THEN 'COMPLETED'
      WHEN status IN ('REFUNDED','CHARGEBACK') AND credited_at IS NOT NULL THEN 'COMPLETED'
      WHEN status IN ('FAILED','CANCELLED','EXPIRED','REFUNDED','CHARGEBACK') THEN 'NOT_APPLICABLE'
      ELSE 'PENDING'
    END,
    credit_status = CASE
      WHEN credited_at IS NOT NULL AND status IN ('SUCCEEDED','REFUNDED','CHARGEBACK') THEN CASE WHEN status = 'SUCCEEDED' THEN 'AVAILABLE' ELSE 'REVERSED' END
      ELSE 'NOT_CREDITED'
    END,
    confirmed_at = CASE WHEN status = 'SUCCEEDED' THEN COALESCE(confirmed_at, paid_at, credited_at) ELSE confirmed_at END,
    settled_at = CASE WHEN status = 'SUCCEEDED' OR (status IN ('REFUNDED','CHARGEBACK') AND credited_at IS NOT NULL) THEN COALESCE(settled_at, paid_at, credited_at) ELSE settled_at END,
    cancelled_at = CASE WHEN status IN ('FAILED','CANCELLED','EXPIRED','REFUNDED','CHARGEBACK') THEN COALESCE(cancelled_at, updated_at) ELSE cancelled_at END;

-- Pending deposits from the old schema were already awaiting confirmation.
-- Carry them into the explicit payment reserve without making them spendable.
INSERT INTO workspace_api_wallets(workspace_id)
SELECT DISTINCT workspace_id FROM workspace_api_topups
ON CONFLICT DO NOTHING;
WITH pending AS (
  SELECT workspace_id, SUM(amount) AS amount
  FROM workspace_api_topups
  WHERE credited_at IS NULL AND status IN ('CREATED','PENDING_PAYMENT','REQUIRES_CUSTOMER_ACTION')
  GROUP BY workspace_id
)
UPDATE workspace_api_wallets w
SET payment_reserved_amount = p.amount
FROM pending p
WHERE w.workspace_id = p.workspace_id;

INSERT INTO workspace_ad_spend_wallets(workspace_id)
SELECT DISTINCT workspace_id FROM workspace_ad_spend_topups
ON CONFLICT DO NOTHING;
WITH pending AS (
  SELECT workspace_id, SUM(net_amount) AS amount
  FROM workspace_ad_spend_topups
  WHERE credited_at IS NULL AND status IN ('CREATED','PENDING_PAYMENT','REQUIRES_CUSTOMER_ACTION')
  GROUP BY workspace_id
)
UPDATE workspace_ad_spend_wallets w
SET payment_reserved_amount = p.amount
FROM pending p
WHERE w.workspace_id = p.workspace_id;

ALTER TABLE workspace_api_wallet_ledger
  ADD COLUMN IF NOT EXISTS reserved_after NUMERIC(20,6) NOT NULL DEFAULT 0;
ALTER TABLE workspace_api_wallet_ledger
  DROP CONSTRAINT IF EXISTS workspace_api_wallet_ledger_amount_delta_check;
ALTER TABLE workspace_api_wallet_ledger
  ADD CONSTRAINT workspace_api_wallet_ledger_amount_delta_check
  CHECK (amount_delta <> 0 OR entry_type IN ('USAGE_RELEASE','USAGE_DEBIT','REFUND','DEPOSIT_RESERVED','RESERVATION_RELEASED'));
ALTER TABLE workspace_api_wallet_ledger
  DROP CONSTRAINT IF EXISTS workspace_api_wallet_ledger_entry_type_check;
ALTER TABLE workspace_api_wallet_ledger
  ADD CONSTRAINT workspace_api_wallet_ledger_entry_type_check
  CHECK (entry_type IN ('TOPUP_CREDIT','USAGE_RESERVE','USAGE_RELEASE','USAGE_DEBIT','REFUND','ADJUSTMENT','DEPOSIT_RESERVED','RESERVATION_RELEASED'));

ALTER TABLE workspace_ad_spend_ledger
  ADD COLUMN IF NOT EXISTS reserved_after NUMERIC(20,2) NOT NULL DEFAULT 0;
ALTER TABLE workspace_ad_spend_ledger
  DROP CONSTRAINT IF EXISTS workspace_ad_spend_ledger_amount_delta_check;
ALTER TABLE workspace_ad_spend_ledger
  ADD CONSTRAINT workspace_ad_spend_ledger_amount_delta_check
  CHECK (amount_delta <> 0 OR entry_type IN ('DEPOSIT_RESERVED','RESERVATION_RELEASED'));
ALTER TABLE workspace_ad_spend_ledger
  DROP CONSTRAINT IF EXISTS workspace_ad_spend_ledger_entry_type_check;
ALTER TABLE workspace_ad_spend_ledger
  ADD CONSTRAINT workspace_ad_spend_ledger_entry_type_check
  CHECK (entry_type IN ('TOPUP_CREDIT','RESERVE','RELEASE','SPEND','REFUND','ADJUSTMENT','DEPOSIT_RESERVED','RESERVATION_RELEASED'));

CREATE INDEX IF NOT EXISTS workspace_api_topups_payment_status_idx
  ON workspace_api_topups(payment_status, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_api_topups_provider_status_idx
  ON workspace_api_topups(provider_status, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_ad_spend_topups_payment_status_idx
  ON workspace_ad_spend_topups(payment_status, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_ad_spend_topups_provider_status_idx
  ON workspace_ad_spend_topups(provider_status, created_at DESC);
