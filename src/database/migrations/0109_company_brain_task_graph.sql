-- Durable task-graph controls and verified learning records for Company Brain.
-- These rows describe orchestration only; canonical customer/business records
-- remain owned by their existing domain services.

ALTER TABLE company_brain_tasks
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS confidence NUMERIC(6,5),
  ADD COLUMN IF NOT EXISTS blocked_reason TEXT,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD CONSTRAINT company_brain_tasks_attempt_count_ck CHECK (attempt_count >= 0),
  ADD CONSTRAINT company_brain_tasks_max_attempts_ck CHECK (max_attempts BETWEEN 1 AND 20),
  ADD CONSTRAINT company_brain_tasks_confidence_ck CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));

CREATE UNIQUE INDEX IF NOT EXISTS company_brain_tasks_idempotency_uidx
  ON company_brain_tasks(workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS company_brain_tasks_due_idx
  ON company_brain_tasks(workspace_id, status, due_at)
  WHERE due_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS company_brain_task_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (char_length(trim(event_type)) BETWEEN 1 AND 120),
  actor_type TEXT NOT NULL DEFAULT 'system' CHECK (actor_type IN ('system','agent','human')),
  actor_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, task_id)
    REFERENCES company_brain_tasks(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS company_brain_task_events_timeline_idx
  ON company_brain_task_events(workspace_id, task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS company_brain_learning_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id UUID,
  signal_id UUID,
  source_event_id UUID,
  outcome_type TEXT NOT NULL CHECK (char_length(trim(outcome_type)) BETWEEN 1 AND 120),
  outcome TEXT NOT NULL CHECK (char_length(trim(outcome)) BETWEEN 1 AND 4000),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  confidence NUMERIC(6,5) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  actor_type TEXT NOT NULL DEFAULT 'system' CHECK (actor_type IN ('system','agent','human')),
  actor_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, task_id)
    REFERENCES company_brain_tasks(workspace_id, id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id, signal_id)
    REFERENCES company_brain_signals(workspace_id, id) ON DELETE SET NULL,
  FOREIGN KEY (source_event_id)
    REFERENCES domain_events(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS company_brain_learning_source_uidx
  ON company_brain_learning_records(workspace_id, source_event_id, outcome_type)
  WHERE source_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS company_brain_learning_timeline_idx
  ON company_brain_learning_records(workspace_id, verified, created_at DESC);
