-- Bind durable Company Brain tasks to real agent runs.
-- A task is dispatched once, then follows the canonical agent-run lifecycle.
-- The dispatcher never retries an unknown external side effect automatically.

ALTER TABLE company_brain_tasks
  ADD COLUMN IF NOT EXISTS agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dispatch_key TEXT,
  ADD COLUMN IF NOT EXISTS claimed_by TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS company_brain_tasks_agent_run_uidx
  ON company_brain_tasks(agent_run_id)
  WHERE agent_run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS company_brain_tasks_dispatch_key_uidx
  ON company_brain_tasks(workspace_id, dispatch_key)
  WHERE dispatch_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS company_brain_tasks_dispatch_queue_idx
  ON company_brain_tasks(workspace_id, status, priority DESC, due_at, created_at)
  WHERE status IN ('PROPOSED','READY') AND agent_run_id IS NULL;
CREATE INDEX IF NOT EXISTS company_brain_tasks_claim_idx
  ON company_brain_tasks(workspace_id, claimed_by, claimed_at)
  WHERE status='RUNNING';
