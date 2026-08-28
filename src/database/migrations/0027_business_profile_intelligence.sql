-- 0027_business_profile_intelligence.sql
-- Deeper business profile, customer-segment and competitor intelligence structures.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS legal_form TEXT,
  ADD COLUMN IF NOT EXISTS founding_year INTEGER,
  ADD COLUMN IF NOT EXISTS employee_count INTEGER,
  ADD COLUMN IF NOT EXISTS annual_revenue_range TEXT,
  ADD COLUMN IF NOT EXISTS business_model_type TEXT,
  ADD COLUMN IF NOT EXISTS company_stage TEXT,
  ADD COLUMN IF NOT EXISTS sales_model TEXT,
  ADD COLUMN IF NOT EXISTS sales_cycle_days INTEGER,
  ADD COLUMN IF NOT EXISTS primary_icp TEXT,
  ADD COLUMN IF NOT EXISTS usp TEXT,
  ADD COLUMN IF NOT EXISTS mission TEXT,
  ADD COLUMN IF NOT EXISTS vision TEXT,
  ADD COLUMN IF NOT EXISTS primary_challenges TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS languages TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS regulated_industries TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_founding_year_check;
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_founding_year_check
  CHECK (founding_year IS NULL OR founding_year BETWEEN 1800 AND 2100);

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_employee_count_check;
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_employee_count_check
  CHECK (employee_count IS NULL OR employee_count >= 0);

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_sales_cycle_days_check;
ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_sales_cycle_days_check
  CHECK (sales_cycle_days IS NULL OR sales_cycle_days >= 0);

ALTER TABLE workspace_offerings
  ADD COLUMN IF NOT EXISTS sku TEXT,
  ADD COLUMN IF NOT EXISTS portfolio_group TEXT,
  ADD COLUMN IF NOT EXISTS lifecycle_stage TEXT,
  ADD COLUMN IF NOT EXISTS launch_date DATE,
  ADD COLUMN IF NOT EXISTS delivery_model TEXT,
  ADD COLUMN IF NOT EXISTS service_scope TEXT,
  ADD COLUMN IF NOT EXISTS setup_fee NUMERIC(20, 4),
  ADD COLUMN IF NOT EXISTS recurring_fee NUMERIC(20, 4),
  ADD COLUMN IF NOT EXISTS usage_fee NUMERIC(20, 4),
  ADD COLUMN IF NOT EXISTS billing_interval TEXT,
  ADD COLUMN IF NOT EXISTS minimum_contract_months INTEGER,
  ADD COLUMN IF NOT EXISTS cancellation_period_days INTEGER,
  ADD COLUMN IF NOT EXISTS onboarding_effort TEXT,
  ADD COLUMN IF NOT EXISTS fulfilment_effort TEXT,
  ADD COLUMN IF NOT EXISTS differentiators TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS proof_points TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS use_cases TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS objections TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS add_ons TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE workspace_offerings
  DROP CONSTRAINT IF EXISTS workspace_offerings_minimum_contract_months_check;
ALTER TABLE workspace_offerings
  ADD CONSTRAINT workspace_offerings_minimum_contract_months_check
  CHECK (minimum_contract_months IS NULL OR minimum_contract_months >= 0);

ALTER TABLE workspace_offerings
  DROP CONSTRAINT IF EXISTS workspace_offerings_cancellation_period_days_check;
ALTER TABLE workspace_offerings
  ADD CONSTRAINT workspace_offerings_cancellation_period_days_check
  CHECK (cancellation_period_days IS NULL OR cancellation_period_days >= 0);

CREATE TABLE IF NOT EXISTS workspace_customer_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 200),
  industry TEXT,
  company_size TEXT,
  region TEXT,
  maturity_level TEXT,
  pain_points TEXT[] NOT NULL DEFAULT '{}',
  jobs_to_be_done TEXT[] NOT NULL DEFAULT '{}',
  decision_criteria TEXT[] NOT NULL DEFAULT '{}',
  use_cases TEXT[] NOT NULL DEFAULT '{}',
  buying_roles TEXT[] NOT NULL DEFAULT '{}',
  price_sensitivity TEXT,
  primary_segment BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_customer_segments_workspace
  ON workspace_customer_segments (workspace_id, primary_segment DESC, sort_order, created_at)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS workspace_competitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 200),
  website_url TEXT,
  competitor_type TEXT NOT NULL DEFAULT 'direct',
  market TEXT,
  positioning TEXT,
  pricing_summary TEXT,
  strengths TEXT[] NOT NULL DEFAULT '{}',
  weaknesses TEXT[] NOT NULL DEFAULT '{}',
  differentiators TEXT[] NOT NULL DEFAULT '{}',
  feature_overlap TEXT[] NOT NULL DEFAULT '{}',
  threat_level TEXT,
  strategic_priority TEXT,
  source_quality TEXT,
  monitoring_frequency TEXT,
  notes TEXT,
  last_reviewed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_competitors_workspace
  ON workspace_competitors (workspace_id, competitor_type, strategic_priority, created_at)
  WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_workspace_customer_segments_set_updated_at ON workspace_customer_segments;
CREATE TRIGGER trg_workspace_customer_segments_set_updated_at
  BEFORE UPDATE ON workspace_customer_segments
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_workspace_competitors_set_updated_at ON workspace_competitors;
CREATE TRIGGER trg_workspace_competitors_set_updated_at
  BEFORE UPDATE ON workspace_competitors
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
