-- 0031_agent_run_workspace_indexes.sql
-- Add indexes for columns used during workspace cascading deletes (e.g. admin
-- user deletion). Without these, Postgres falls back to sequential scans on
-- large tables, which makes the delete hang or time out.

CREATE INDEX IF NOT EXISTS idx_agent_run_events_workspace_id
  ON agent_run_events (workspace_id);

CREATE INDEX IF NOT EXISTS idx_agent_run_events_step_id
  ON agent_run_events (step_id);

CREATE INDEX IF NOT EXISTS idx_agent_run_steps_workspace_id
  ON agent_run_steps (workspace_id);

-- The existing idx_workspace_records_parent has workspace_id as its leading
-- column, so the self-referential "ON DELETE SET NULL" cascade cannot use it.
CREATE INDEX IF NOT EXISTS idx_workspace_records_parent_id
  ON workspace_records (parent_id);
