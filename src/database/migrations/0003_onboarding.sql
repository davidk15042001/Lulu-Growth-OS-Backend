-- 0003_onboarding.sql
-- Structured data collected by the company onboarding flow.

CREATE TABLE IF NOT EXISTS workspace_offerings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 200),
  offering_type TEXT NOT NULL CHECK (offering_type IN ('product', 'service')),
  category TEXT,
  description TEXT,
  target_customer TEXT,
  pricing_model TEXT,
  price_amount NUMERIC(20, 4),
  price_currency CHAR(3),
  price_label TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'inactive', 'archived')),
  customer_problem TEXT,
  value_proposition TEXT,
  url TEXT,
  image_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_offerings_workspace
  ON workspace_offerings (workspace_id, sort_order, created_at)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS workspace_platforms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_key TEXT,
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 200),
  category TEXT NOT NULL DEFAULT 'custom',
  connection_status TEXT NOT NULL DEFAULT 'not_connected'
    CHECK (connection_status IN (
      'not_connected',
      'pending',
      'connected',
      'syncing',
      'error',
      'disconnected'
    )),
  external_account_id TEXT,
  granted_scopes TEXT[] NOT NULL DEFAULT '{}',
  secret_reference TEXT,
  settings JSONB NOT NULL DEFAULT '{}',
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(settings) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_platforms_integration
  ON workspace_platforms (workspace_id, integration_key)
  WHERE integration_key IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_platforms_workspace
  ON workspace_platforms (workspace_id, connection_status, category)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS workspace_ai_preferences (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  business_priorities TEXT[] NOT NULL DEFAULT '{}',
  priority_order TEXT[] NOT NULL DEFAULT '{}',
  recommendation_style TEXT NOT NULL DEFAULT 'balanced'
    CHECK (recommendation_style IN ('conservative', 'balanced', 'aggressive')),
  risk_tolerance TEXT NOT NULL DEFAULT 'moderate'
    CHECK (risk_tolerance IN ('low', 'moderate', 'high')),
  action_level TEXT NOT NULL DEFAULT 'advisory'
    CHECK (action_level IN ('advisory', 'assisted', 'automated')),
  communication_style TEXT NOT NULL DEFAULT 'balanced'
    CHECK (communication_style IN ('concise', 'balanced', 'detailed')),
  insight_detail TEXT NOT NULL DEFAULT 'standard'
    CHECK (insight_detail IN ('executive', 'standard', 'detailed')),
  recommendation_frequency TEXT NOT NULL DEFAULT 'only_important'
    CHECK (recommendation_frequency IN ('only_important', 'daily', 'weekly', 'as_insights_occur')),
  task_creation_mode TEXT NOT NULL DEFAULT 'recommend'
    CHECK (task_creation_mode IN ('off', 'recommend', 'auto')),
  detection_settings JSONB NOT NULL DEFAULT '{"opportunity":true,"risk":true,"anomaly":true,"content":true}',
  search_priorities JSONB NOT NULL DEFAULT '{"SEO":"medium","GEO":"medium","AEO":"medium"}',
  approval_preferences JSONB NOT NULL DEFAULT '{}',
  approval_threshold NUMERIC(20, 4),
  notification_preferences JSONB NOT NULL DEFAULT '{}',
  notification_channels JSONB NOT NULL DEFAULT '{"in_app":true,"email":true,"push":false}',
  business_hours JSONB NOT NULL DEFAULT '{"enabled":false}',
  response_language TEXT NOT NULL DEFAULT 'en',
  transparency_settings JSONB NOT NULL DEFAULT '{"insights":true,"recommendations":true,"content":true,"labels":true,"data":true}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(detection_settings) = 'object'),
  CHECK (jsonb_typeof(search_priorities) = 'object'),
  CHECK (jsonb_typeof(approval_preferences) = 'object'),
  CHECK (jsonb_typeof(notification_preferences) = 'object'),
  CHECK (jsonb_typeof(notification_channels) = 'object'),
  CHECK (jsonb_typeof(business_hours) = 'object'),
  CHECK (jsonb_typeof(transparency_settings) = 'object')
);

DROP TRIGGER IF EXISTS trg_workspace_offerings_set_updated_at ON workspace_offerings;
CREATE TRIGGER trg_workspace_offerings_set_updated_at
  BEFORE UPDATE ON workspace_offerings
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_workspace_platforms_set_updated_at ON workspace_platforms;
CREATE TRIGGER trg_workspace_platforms_set_updated_at
  BEFORE UPDATE ON workspace_platforms
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_workspace_ai_preferences_set_updated_at ON workspace_ai_preferences;
CREATE TRIGGER trg_workspace_ai_preferences_set_updated_at
  BEFORE UPDATE ON workspace_ai_preferences
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
