-- Mandatory activation gates plus separated prepaid AI and advertising wallets.
-- Existing completed workspaces stay completed; no migration-created credit or
-- entitlement is granted to any customer.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS billing_skipped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS billing_skipped_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS profile_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS knowledge_base_completed_at TIMESTAMPTZ;

ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_onboarding_step_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_onboarding_step_check CHECK (onboarding_step IN (
  'company_information','business_description','products_services','existing_platforms',
  'integrations','ai_preferences','billing','profile_completion','knowledge_base','setup_complete'
));

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_product_type_check;
ALTER TABLE products ADD CONSTRAINT products_product_type_check CHECK (product_type IN (
  'PHYSICAL_PRODUCT','DIGITAL_PRODUCT','CUSTOM_MANUFACTURING','OEM','ODM','SERVICE','COMPONENT','MATERIAL','MACHINE','OTHER'
));

UPDATE workspaces
SET profile_completed_at=COALESCE(profile_completed_at,onboarding_completed_at),
    knowledge_base_completed_at=COALESCE(knowledge_base_completed_at,onboarding_completed_at)
WHERE onboarding_completed_at IS NOT NULL;

-- Storage invoices remain collectible, but they never control prepaid AI
-- execution. Remove legacy PAYG access blocks during the model transition.
UPDATE workspace_payg_profiles
SET ai_access_blocked=FALSE, blocked_at=NULL, block_reason=NULL, blocked_period_id=NULL
WHERE ai_access_blocked=TRUE OR blocked_at IS NOT NULL OR block_reason IS NOT NULL OR blocked_period_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_knowledge_activations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  status VARCHAR(24) NOT NULL DEFAULT 'PROCESSING'
    CHECK (status IN ('PROCESSING','COMPLETED','FAILED')),
  source_text TEXT,
  source_document_ids UUID[] NOT NULL DEFAULT '{}',
  classification JSONB NOT NULL DEFAULT '{}'::jsonb,
  model VARCHAR(200),
  error_code VARCHAR(120),
  error_message TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workspace_knowledge_activations_workspace_idx
  ON workspace_knowledge_activations(workspace_id,created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_api_wallets (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  currency VARCHAR(3) NOT NULL DEFAULT 'CNY' CHECK (currency='CNY'),
  available_amount NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (available_amount >= 0),
  spent_amount NUMERIC(20,6) NOT NULL DEFAULT 0 CHECK (spent_amount >= 0),
  total_funded_amount NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (total_funded_amount >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_api_topups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  amount NUMERIC(20,2) NOT NULL CHECK (amount IN (1000,2500,5000,9000)),
  currency VARCHAR(3) NOT NULL DEFAULT 'CNY' CHECK (currency='CNY'),
  payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('card','alipaycn','wechatpay')),
  provider VARCHAR(30) NOT NULL DEFAULT 'airwallex' CHECK (provider='airwallex'),
  status VARCHAR(40) NOT NULL DEFAULT 'CREATED' CHECK (status IN (
    'CREATED','PENDING_PAYMENT','REQUIRES_CUSTOMER_ACTION','SUCCEEDED','CANCELLED',
    'FAILED','EXPIRED','REFUNDED','CHARGEBACK'
  )),
  merchant_order_id VARCHAR(200) NOT NULL UNIQUE,
  provider_invoice_id VARCHAR(200),
  provider_payment_intent_id VARCHAR(200),
  checkout_url TEXT,
  qr_payload TEXT,
  expires_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  credited_at TIMESTAMPTZ,
  provider_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code VARCHAR(120),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_api_topups_invoice_uidx
  ON workspace_api_topups(provider_invoice_id) WHERE provider_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_api_topups_intent_uidx
  ON workspace_api_topups(provider_payment_intent_id) WHERE provider_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workspace_api_topups_workspace_idx
  ON workspace_api_topups(workspace_id,created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_api_wallet_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  topup_id UUID REFERENCES workspace_api_topups(id) ON DELETE SET NULL,
  ai_usage_ledger_id UUID REFERENCES ai_usage_ledger(id) ON DELETE SET NULL,
  entry_type VARCHAR(24) NOT NULL CHECK (entry_type IN ('TOPUP_CREDIT','USAGE_DEBIT','REFUND','ADJUSTMENT')),
  amount_delta NUMERIC(20,6) NOT NULL CHECK (amount_delta <> 0 OR entry_type IN ('USAGE_DEBIT','REFUND')),
  balance_after NUMERIC(20,6) NOT NULL CHECK (balance_after >= 0),
  currency VARCHAR(3) NOT NULL DEFAULT 'CNY' CHECK (currency='CNY'),
  idempotency_key VARCHAR(240) NOT NULL UNIQUE,
  usd_cost NUMERIC(20,8),
  usd_cny_rate NUMERIC(18,8),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workspace_api_wallet_ledger_workspace_idx
  ON workspace_api_wallet_ledger(workspace_id,created_at DESC);

-- R2 Standard has no free-tier deduction in Lulu's customer calculation.
CREATE TABLE IF NOT EXISTS workspace_storage_objects (
  object_key TEXT PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  content_type VARCHAR(240),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workspace_storage_objects_active_idx
  ON workspace_storage_objects(workspace_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS workspace_r2_usage_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  storage_gb_month NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (storage_gb_month >= 0),
  class_a_operations NUMERIC(24,0) NOT NULL DEFAULT 0 CHECK (class_a_operations >= 0),
  class_b_operations NUMERIC(24,0) NOT NULL DEFAULT 0 CHECK (class_b_operations >= 0),
  provider_cost_usd NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (provider_cost_usd >= 0),
  customer_cost_usd NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (customer_cost_usd >= 0),
  payg_period_id UUID REFERENCES workspace_payg_periods(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id,usage_date)
);
CREATE INDEX IF NOT EXISTS workspace_r2_usage_unbilled_idx
  ON workspace_r2_usage_ledger(workspace_id,created_at) WHERE payg_period_id IS NULL;

DROP TRIGGER IF EXISTS workspace_knowledge_activations_set_updated_at ON workspace_knowledge_activations;
CREATE TRIGGER workspace_knowledge_activations_set_updated_at BEFORE UPDATE ON workspace_knowledge_activations
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS workspace_api_wallets_set_updated_at ON workspace_api_wallets;
CREATE TRIGGER workspace_api_wallets_set_updated_at BEFORE UPDATE ON workspace_api_wallets
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS workspace_api_topups_set_updated_at ON workspace_api_topups;
CREATE TRIGGER workspace_api_topups_set_updated_at BEFORE UPDATE ON workspace_api_topups
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS workspace_storage_objects_set_updated_at ON workspace_storage_objects;
CREATE TRIGGER workspace_storage_objects_set_updated_at BEFORE UPDATE ON workspace_storage_objects
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
