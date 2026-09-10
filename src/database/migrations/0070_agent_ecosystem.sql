-- Lulu's agent ecosystem selects a small, relevant team from the complete
-- registry and learns from verified run outcomes. The permanent mission is
-- defined in application code and cannot be replaced per workspace.

CREATE TABLE IF NOT EXISTS workspace_agent_performance (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  module TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('executive','domain_lead','specialist','auditor')),
  run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  selection_count INTEGER NOT NULL DEFAULT 0 CHECK (selection_count >= 0),
  performance_score NUMERIC(5,2) NOT NULL DEFAULT 50 CHECK (performance_score BETWEEN 0 AND 100),
  last_status TEXT,
  last_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  last_run_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, agent_id)
);

CREATE INDEX IF NOT EXISTS workspace_agent_performance_routing_idx
  ON workspace_agent_performance(workspace_id, performance_score DESC, last_run_at ASC NULLS FIRST);

CREATE TABLE IF NOT EXISTS workspace_agent_team_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('scheduled','reactive','manual','recovery')),
  north_star TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','running','completed','failed')),
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
  selected_agent_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(selected_agent_ids) = 'array'),
  selection_reasons JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(selection_reasons) = 'array'),
  context JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspace_agent_team_cycles_latest_idx
  ON workspace_agent_team_cycles(workspace_id, created_at DESC);

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS team_cycle_id UUID REFERENCES workspace_agent_team_cycles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS agent_runs_team_cycle_idx
  ON agent_runs(team_cycle_id) WHERE team_cycle_id IS NOT NULL;

ALTER TABLE agent_run_steps
  ADD COLUMN IF NOT EXISTS agent_id TEXT,
  ADD COLUMN IF NOT EXISTS task_type TEXT,
  ADD COLUMN IF NOT EXISTS success_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE agent_run_steps
  DROP CONSTRAINT IF EXISTS agent_run_steps_success_criteria_check,
  DROP CONSTRAINT IF EXISTS agent_run_steps_verification_status_check;

ALTER TABLE agent_run_steps
  ADD CONSTRAINT agent_run_steps_success_criteria_check CHECK (jsonb_typeof(success_criteria) = 'array'),
  ADD CONSTRAINT agent_run_steps_verification_status_check
    CHECK (verification_status IN ('pending','verified','failed','skipped'));

UPDATE agent_run_steps
SET idempotency_key = 'legacy:' || id::text
WHERE idempotency_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS agent_run_steps_idempotency_uidx
  ON agent_run_steps(run_id, idempotency_key);

DROP TRIGGER IF EXISTS workspace_agent_performance_set_updated_at ON workspace_agent_performance;
CREATE TRIGGER workspace_agent_performance_set_updated_at
BEFORE UPDATE ON workspace_agent_performance
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS workspace_agent_team_cycles_set_updated_at ON workspace_agent_team_cycles;
CREATE TRIGGER workspace_agent_team_cycles_set_updated_at
BEFORE UPDATE ON workspace_agent_team_cycles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
