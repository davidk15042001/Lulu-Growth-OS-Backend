-- 0028_workspace_ai_business_profiles.sql
-- Persist AI-generated business-profile drafts for the Knowledge Base page.

CREATE TABLE IF NOT EXISTS workspace_ai_business_profiles (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  model TEXT,
  generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(payload) = 'object')
);

DROP TRIGGER IF EXISTS trg_workspace_ai_business_profiles_set_updated_at ON workspace_ai_business_profiles;
CREATE TRIGGER trg_workspace_ai_business_profiles_set_updated_at
  BEFORE UPDATE ON workspace_ai_business_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
