-- Persist provider-side refund and dispute lifecycles independently from the
-- top-up status.  A single top-up can have several partial reversals and each
-- provider resource may emit multiple, duplicated or out-of-order webhooks.

CREATE TABLE IF NOT EXISTS airwallex_wallet_reversals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  wallet_type VARCHAR(20) NOT NULL CHECK (wallet_type IN ('API','AD_SPEND')),
  api_topup_id UUID REFERENCES workspace_api_topups(id) ON DELETE CASCADE,
  ad_spend_topup_id UUID REFERENCES workspace_ad_spend_topups(id) ON DELETE CASCADE,
  provider VARCHAR(30) NOT NULL DEFAULT 'airwallex' CHECK (provider='airwallex'),
  provider_reversal_kind VARCHAR(20) NOT NULL CHECK (provider_reversal_kind IN ('REFUND','DISPUTE')),
  provider_reversal_id VARCHAR(240) NOT NULL,
  provider_payment_intent_id VARCHAR(240),
  provider_invoice_id VARCHAR(240),
  provider_status VARCHAR(80) NOT NULL,
  provider_stage VARCHAR(80),
  currency VARCHAR(3) NOT NULL CHECK (currency='CNY'),
  provider_amount NUMERIC(20,6) NOT NULL CHECK (provider_amount > 0),
  wallet_amount NUMERIC(20,6) NOT NULL CHECK (wallet_amount >= 0),
  fee_amount NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  applied_wallet_amount NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (applied_wallet_amount >= 0),
  applied_fee_amount NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (applied_fee_amount >= 0),
  movement_sequence INTEGER NOT NULL DEFAULT 0 CHECK (movement_sequence >= 0),
  provider_updated_at TIMESTAMPTZ,
  last_event_created_at TIMESTAMPTZ,
  last_event_id VARCHAR(240) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (wallet_type='API' AND api_topup_id IS NOT NULL AND ad_spend_topup_id IS NULL)
    OR
    (wallet_type='AD_SPEND' AND api_topup_id IS NULL AND ad_spend_topup_id IS NOT NULL)
  ),
  CHECK (provider_amount = wallet_amount + fee_amount),
  UNIQUE(provider,provider_reversal_kind,provider_reversal_id)
);

CREATE INDEX IF NOT EXISTS airwallex_wallet_reversals_api_topup_idx
  ON airwallex_wallet_reversals(api_topup_id,created_at)
  WHERE api_topup_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS airwallex_wallet_reversals_ad_topup_idx
  ON airwallex_wallet_reversals(ad_spend_topup_id,created_at)
  WHERE ad_spend_topup_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS airwallex_wallet_reversals_workspace_idx
  ON airwallex_wallet_reversals(workspace_id,created_at DESC);

DROP TRIGGER IF EXISTS airwallex_wallet_reversals_set_updated_at ON airwallex_wallet_reversals;
CREATE TRIGGER airwallex_wallet_reversals_set_updated_at BEFORE UPDATE ON airwallex_wallet_reversals
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Adopt previously applied all-or-nothing reversals into the new journal.  On
-- the next real provider event the application replaces this synthetic key
-- with the actual Refund/Dispute ID and reconciles an incorrectly full legacy
-- reversal to the provider's exact amount.
INSERT INTO airwallex_wallet_reversals(
  workspace_id,wallet_type,api_topup_id,provider_reversal_kind,provider_reversal_id,
  provider_payment_intent_id,provider_invoice_id,provider_status,currency,
  provider_amount,wallet_amount,fee_amount,is_active,applied_wallet_amount,
  applied_fee_amount,last_event_id,metadata
)
SELECT workspace_id,'API',id,
       CASE WHEN status='CHARGEBACK' THEN 'DISPUTE' ELSE 'REFUND' END,
       'legacy:api:' || id::text,provider_payment_intent_id,provider_invoice_id,status,currency,
       amount,amount,0,TRUE,CASE WHEN credited_at IS NULL THEN 0 ELSE amount END,0,
       'legacy:api:' || id::text,'{"source":"migration_0093"}'::jsonb
FROM workspace_api_topups
WHERE status IN ('REFUNDED','CHARGEBACK')
ON CONFLICT DO NOTHING;

INSERT INTO airwallex_wallet_reversals(
  workspace_id,wallet_type,ad_spend_topup_id,provider_reversal_kind,provider_reversal_id,
  provider_payment_intent_id,provider_invoice_id,provider_status,currency,
  provider_amount,wallet_amount,fee_amount,is_active,applied_wallet_amount,
  applied_fee_amount,last_event_id,metadata
)
SELECT workspace_id,'AD_SPEND',id,
       CASE WHEN status='CHARGEBACK' THEN 'DISPUTE' ELSE 'REFUND' END,
       'legacy:ad:' || id::text,provider_payment_intent_id,provider_invoice_id,status,currency,
       total_amount,net_amount,fee_amount,TRUE,
       CASE WHEN credited_at IS NULL THEN 0 ELSE net_amount END,
       CASE WHEN credited_at IS NULL THEN 0 ELSE fee_amount END,
       'legacy:ad:' || id::text,'{"source":"migration_0093"}'::jsonb
FROM workspace_ad_spend_topups
WHERE status IN ('REFUNDED','CHARGEBACK')
ON CONFLICT DO NOTHING;
