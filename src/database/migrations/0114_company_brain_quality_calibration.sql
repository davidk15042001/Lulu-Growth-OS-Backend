-- Quality outcomes are durable learning signals for the digital employee that
-- produced the artifact. The unique source-event key makes replay safe.

CREATE TABLE IF NOT EXISTS company_brain_learning_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL CHECK (char_length(trim(agent_id)) BETWEEN 1 AND 160),
  source_event_id UUID NOT NULL REFERENCES domain_events(id) ON DELETE CASCADE,
  outcome_type TEXT NOT NULL CHECK (char_length(trim(outcome_type)) BETWEEN 1 AND 120),
  delta NUMERIC(6,2) NOT NULL CHECK (delta BETWEEN -100 AND 100),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, agent_id, source_event_id, outcome_type)
);

CREATE INDEX IF NOT EXISTS company_brain_learning_adjustments_agent_idx
  ON company_brain_learning_adjustments(workspace_id, agent_id, created_at DESC);

