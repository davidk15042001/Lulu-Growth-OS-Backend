-- 0131_feature_flags.sql
-- Deterministic, auditable rollout controls. Flags are data, not ad-hoc env
-- branches, so a canary can be reproduced for one workspace.

CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.-]*$'),
  description TEXT NOT NULL,
  default_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  default_rollout_percent INTEGER NOT NULL DEFAULT 0 CHECK (default_rollout_percent BETWEEN 0 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_feature_flags (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  flag_key TEXT NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  enabled BOOLEAN,
  rollout_percent INTEGER CHECK (rollout_percent IS NULL OR rollout_percent BETWEEN 0 AND 100),
  reason TEXT,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, flag_key),
  CHECK (enabled IS NOT NULL OR rollout_percent IS NOT NULL OR reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS workspace_feature_flags_workspace_idx
  ON workspace_feature_flags (workspace_id, flag_key);

CREATE TABLE IF NOT EXISTS feature_flag_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  flag_key TEXT NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  previous_state JSONB NOT NULL DEFAULT '{}',
  next_state JSONB NOT NULL DEFAULT '{}',
  changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(previous_state) = 'object'),
  CHECK (jsonb_typeof(next_state) = 'object')
);
CREATE INDEX IF NOT EXISTS feature_flag_changes_lookup_idx
  ON feature_flag_changes (workspace_id, flag_key, created_at DESC);

DROP TRIGGER IF EXISTS trg_feature_flags_updated_at ON feature_flags;
CREATE TRIGGER trg_feature_flags_updated_at
  BEFORE UPDATE ON feature_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_workspace_feature_flags_updated_at ON workspace_feature_flags;
CREATE TRIGGER trg_workspace_feature_flags_updated_at
  BEFORE UPDATE ON workspace_feature_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO feature_flags (key, description, default_enabled, default_rollout_percent)
VALUES
  ('autonomous.execution', 'Enable autonomous execution for a workspace after all gates pass.', FALSE, 0),
  ('managed.website', 'Enable Lulu-managed website generation and publishing.', FALSE, 0),
  ('premium.media', 'Enable prepaid premium media generation.', FALSE, 0),
  ('deep.research', 'Enable Perplexity-backed deep research.', FALSE, 0)
ON CONFLICT (key) DO NOTHING;

