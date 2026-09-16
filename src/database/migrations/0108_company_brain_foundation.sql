-- Company Brain foundation.
--
-- This is an evidence-first projection over existing domain events. It does
-- not create synthetic activity and it does not replace canonical business
-- objects. Observations are deduplicated, signals are materiality-scored and
-- missions/tasks remain explicit persisted work that can be audited later.

CREATE TABLE IF NOT EXISTS company_brain_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('domain_event','metric','provider','user')),
  source_key TEXT NOT NULL CHECK (char_length(trim(source_key)) BETWEEN 1 AND 300),
  source_event_id UUID REFERENCES domain_events(id) ON DELETE SET NULL,
  subject_type TEXT NOT NULL CHECK (char_length(trim(subject_type)) BETWEEN 1 AND 160),
  subject_id TEXT,
  event_type TEXT,
  summary TEXT NOT NULL CHECK (char_length(trim(summary)) BETWEEN 1 AND 2000),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  trust_score NUMERIC(6,5) NOT NULL DEFAULT 1 CHECK (trust_score >= 0 AND trust_score <= 1),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_type, source_key)
);

CREATE TABLE IF NOT EXISTS company_brain_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  observation_id UUID NOT NULL,
  signal_type TEXT NOT NULL CHECK (char_length(trim(signal_type)) BETWEEN 1 AND 160),
  severity SMALLINT NOT NULL DEFAULT 1 CHECK (severity BETWEEN 0 AND 5),
  materiality NUMERIC(6,5) NOT NULL DEFAULT 0 CHECK (materiality >= 0 AND materiality <= 1),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','NO_ACTION','ACTIONED','DISMISSED')),
  explanation TEXT NOT NULL DEFAULT '' CHECK (char_length(explanation) <= 2000),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, observation_id, signal_type),
  FOREIGN KEY (workspace_id, observation_id)
    REFERENCES company_brain_observations(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS company_brain_missions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  signal_id UUID,
  title TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 300),
  objective TEXT NOT NULL CHECK (char_length(trim(objective)) BETWEEN 1 AND 4000),
  status TEXT NOT NULL DEFAULT 'PROPOSED'
    CHECK (status IN ('PROPOSED','PLANNED','RUNNING','BLOCKED','COMPLETED','CANCELLED')),
  priority SMALLINT NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  north_star TEXT NOT NULL DEFAULT 'customer_value_and_trust',
  owner_employee_id UUID,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  context JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
  outcome JSONB CHECK (outcome IS NULL OR jsonb_typeof(outcome) = 'object'),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, signal_id),
  FOREIGN KEY (workspace_id, signal_id)
    REFERENCES company_brain_signals(workspace_id, id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id, owner_employee_id)
    REFERENCES digital_employees(workspace_id, id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS company_brain_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id UUID NOT NULL,
  parent_task_id UUID,
  assigned_employee_id UUID,
  task_type TEXT NOT NULL CHECK (char_length(trim(task_type)) BETWEEN 1 AND 120),
  title TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 300),
  objective TEXT NOT NULL DEFAULT '' CHECK (char_length(objective) <= 4000),
  status TEXT NOT NULL DEFAULT 'PROPOSED'
    CHECK (status IN ('PROPOSED','READY','RUNNING','BLOCKED','COMPLETED','FAILED','CANCELLED')),
  priority SMALLINT NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  dependency_count INTEGER NOT NULL DEFAULT 0 CHECK (dependency_count >= 0),
  context JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
  result JSONB CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, mission_id)
    REFERENCES company_brain_missions(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, parent_task_id)
    REFERENCES company_brain_tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, assigned_employee_id)
    REFERENCES digital_employees(workspace_id, id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS company_brain_task_dependencies (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id UUID NOT NULL,
  depends_on_task_id UUID NOT NULL,
  dependency_type TEXT NOT NULL DEFAULT 'BLOCKS'
    CHECK (dependency_type IN ('BLOCKS','CONTEXT','VERIFICATION')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, task_id, depends_on_task_id),
  FOREIGN KEY (workspace_id, task_id)
    REFERENCES company_brain_tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, depends_on_task_id)
    REFERENCES company_brain_tasks(workspace_id, id) ON DELETE CASCADE,
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS company_brain_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  signal_id UUID,
  mission_id UUID,
  decision_type TEXT NOT NULL CHECK (char_length(trim(decision_type)) BETWEEN 1 AND 120),
  decision TEXT NOT NULL CHECK (char_length(trim(decision)) BETWEEN 1 AND 4000),
  confidence NUMERIC(6,5) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  rationale TEXT NOT NULL DEFAULT '' CHECK (char_length(rationale) <= 4000),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  actor_type TEXT NOT NULL DEFAULT 'system' CHECK (actor_type IN ('system','agent','human')),
  actor_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, signal_id)
    REFERENCES company_brain_signals(workspace_id, id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id, mission_id)
    REFERENCES company_brain_missions(workspace_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS company_brain_observations_timeline_idx
  ON company_brain_observations(workspace_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS company_brain_signals_queue_idx
  ON company_brain_signals(workspace_id, status, materiality DESC, detected_at DESC);
CREATE INDEX IF NOT EXISTS company_brain_missions_queue_idx
  ON company_brain_missions(workspace_id, status, priority DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS company_brain_tasks_queue_idx
  ON company_brain_tasks(workspace_id, status, priority DESC, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS company_brain_tasks_root_investigate_uidx
  ON company_brain_tasks(workspace_id, mission_id)
  WHERE parent_task_id IS NULL AND task_type = 'investigate';
CREATE INDEX IF NOT EXISTS company_brain_decisions_timeline_idx
  ON company_brain_decisions(workspace_id, created_at DESC);

DROP TRIGGER IF EXISTS company_brain_missions_set_updated_at ON company_brain_missions;
CREATE TRIGGER company_brain_missions_set_updated_at
  BEFORE UPDATE ON company_brain_missions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS company_brain_tasks_set_updated_at ON company_brain_tasks;
CREATE TRIGGER company_brain_tasks_set_updated_at
  BEFORE UPDATE ON company_brain_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
