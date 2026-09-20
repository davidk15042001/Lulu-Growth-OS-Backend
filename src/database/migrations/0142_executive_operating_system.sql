-- Executive operating system.
--
-- These tables are an evidence-first coordination layer over the canonical
-- Company Brain, metrics, finance, CRM and provider domains. They never own
-- customer records or execute provider mutations themselves. Every row is
-- workspace-scoped, bounded and auditable so Lulu can distinguish measured
-- facts, forecasts, scenarios and human-approved work.

CREATE TABLE IF NOT EXISTS executive_operating_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cycle_type TEXT NOT NULL CHECK (cycle_type IN ('daily','weekly')),
  timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (char_length(trim(timezone)) BETWEEN 1 AND 100),
  hour_of_day SMALLINT NOT NULL DEFAULT 8 CHECK (hour_of_day BETWEEN 0 AND 23),
  weekday SMALLINT NOT NULL DEFAULT 0 CHECK (weekday BETWEEN 0 AND 6),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_at TIMESTAMPTZ,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, cycle_type),
  CHECK ((cycle_type = 'daily' AND weekday = 0) OR cycle_type = 'weekly')
);

CREATE INDEX IF NOT EXISTS executive_operating_schedules_due_idx
  ON executive_operating_schedules(active, next_run_at)
  WHERE active;

CREATE TABLE IF NOT EXISTS executive_operating_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cycle_type TEXT NOT NULL CHECK (cycle_type IN ('daily','weekly')),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('scheduled','manual','event')),
  timezone TEXT NOT NULL CHECK (char_length(trim(timezone)) BETWEEN 1 AND 100),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  data_cutoff_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','completed','failed','superseded')),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  data_gaps JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(data_gaps) = 'array'),
  failure_code TEXT,
  failure_message TEXT,
  started_by UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, cycle_type, period_start),
  CHECK (period_end > period_start),
  CHECK (char_length(COALESCE(failure_message, '')) <= 4000)
);

CREATE INDEX IF NOT EXISTS executive_operating_cycles_timeline_idx
  ON executive_operating_cycles(workspace_id, cycle_type, period_start DESC);
CREATE INDEX IF NOT EXISTS executive_operating_cycles_active_idx
  ON executive_operating_cycles(status, started_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS executive_operating_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cycle_id UUID NOT NULL,
  source_key TEXT NOT NULL CHECK (char_length(trim(source_key)) BETWEEN 1 AND 300),
  finding_type TEXT NOT NULL CHECK (char_length(trim(finding_type)) BETWEEN 1 AND 120),
  subject_type TEXT NOT NULL CHECK (char_length(trim(subject_type)) BETWEEN 1 AND 120),
  subject_id TEXT,
  severity SMALLINT NOT NULL CHECK (severity BETWEEN 0 AND 5),
  materiality NUMERIC(6,5) NOT NULL DEFAULT 0 CHECK (materiality BETWEEN 0 AND 1),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved','dismissed')),
  title TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 300),
  description TEXT NOT NULL CHECK (char_length(trim(description)) BETWEEN 1 AND 4000),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, cycle_id, source_key),
  FOREIGN KEY (workspace_id, cycle_id)
    REFERENCES executive_operating_cycles(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS executive_operating_findings_queue_idx
  ON executive_operating_findings(workspace_id, status, severity DESC, materiality DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS executive_operating_findings_cycle_idx
  ON executive_operating_findings(workspace_id, cycle_id, severity DESC, created_at DESC);

-- Metric IDs are globally generated UUIDs, but executive foreign keys also
-- carry the workspace scope so a metric can never be attached across tenants.
ALTER TABLE metric_definitions
  ADD CONSTRAINT metric_definitions_workspace_id_id_unique UNIQUE (workspace_id, id);

CREATE TABLE IF NOT EXISTS executive_metric_forecasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cycle_id UUID NOT NULL,
  metric_id UUID NOT NULL,
  source_metric_point_id BIGINT REFERENCES metric_points(id) ON DELETE SET NULL,
  method TEXT NOT NULL DEFAULT 'two_point_trend'
    CHECK (method IN ('two_point_trend')),
  model_version TEXT NOT NULL DEFAULT 'v1' CHECK (char_length(trim(model_version)) BETWEEN 1 AND 80),
  baseline_value NUMERIC(30,8) NOT NULL,
  projected_low NUMERIC(30,8) NOT NULL,
  projected_base NUMERIC(30,8) NOT NULL,
  projected_high NUMERIC(30,8) NOT NULL,
  baseline_recorded_at TIMESTAMPTZ NOT NULL,
  forecasted_for TIMESTAMPTZ NOT NULL,
  horizon_seconds INTEGER NOT NULL CHECK (horizon_seconds BETWEEN 1 AND 31536000),
  confidence NUMERIC(6,5) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  assumptions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(assumptions) = 'array'),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','calibrated','superseded','insufficient_data')),
  actual_value NUMERIC(30,8),
  actual_recorded_at TIMESTAMPTZ,
  absolute_error NUMERIC(30,8),
  relative_error NUMERIC(30,8),
  calibrated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, cycle_id, metric_id, forecasted_for, model_version),
  FOREIGN KEY (workspace_id, cycle_id)
    REFERENCES executive_operating_cycles(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, metric_id)
    REFERENCES metric_definitions(workspace_id, id) ON DELETE RESTRICT,
  CHECK (projected_low <= projected_base AND projected_base <= projected_high),
  CHECK ((status = 'calibrated') = (calibrated_at IS NOT NULL)),
  CHECK ((actual_value IS NULL) = (actual_recorded_at IS NULL)),
  CHECK ((actual_value IS NULL) = (absolute_error IS NULL))
);

CREATE INDEX IF NOT EXISTS executive_metric_forecasts_metric_idx
  ON executive_metric_forecasts(workspace_id, metric_id, forecasted_for DESC);
CREATE INDEX IF NOT EXISTS executive_metric_forecasts_calibration_idx
  ON executive_metric_forecasts(status, forecasted_for)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS executive_scenarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cycle_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','archived')),
  assumptions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(assumptions) = 'array'),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, cycle_id)
    REFERENCES executive_operating_cycles(workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS executive_scenarios_workspace_timeline_idx
  ON executive_scenarios(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS executive_scenario_projections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scenario_id UUID NOT NULL,
  forecast_id UUID NOT NULL,
  adjustment_percent NUMERIC(12,4) NOT NULL CHECK (adjustment_percent BETWEEN -100 AND 10000),
  projected_value NUMERIC(30,8) NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, scenario_id, forecast_id),
  FOREIGN KEY (workspace_id, scenario_id)
    REFERENCES executive_scenarios(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, forecast_id)
    REFERENCES executive_metric_forecasts(workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS executive_scenario_projections_scenario_idx
  ON executive_scenario_projections(workspace_id, scenario_id, created_at ASC);

CREATE TABLE IF NOT EXISTS executive_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cycle_id UUID,
  finding_id UUID,
  proposal_type TEXT NOT NULL CHECK (char_length(trim(proposal_type)) BETWEEN 1 AND 120),
  title TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 300),
  objective TEXT NOT NULL CHECK (char_length(trim(objective)) BETWEEN 1 AND 4000),
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('draft','proposed','approved','rejected','dispatched','completed','cancelled')),
  priority SMALLINT NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  confidence NUMERIC(6,5) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  requires_human_approval BOOLEAN NOT NULL DEFAULT TRUE,
  execution_mode TEXT NOT NULL DEFAULT 'plan_only' CHECK (execution_mode IN ('plan_only')),
  expected_impact JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(expected_impact) = 'object'),
  risk_notes JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(risk_notes) = 'array'),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  company_brain_signal_id UUID,
  company_brain_mission_id UUID,
  company_brain_task_id UUID,
  idempotency_key TEXT NOT NULL CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 300),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, cycle_id)
    REFERENCES executive_operating_cycles(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, finding_id)
    REFERENCES executive_operating_findings(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, company_brain_signal_id)
    REFERENCES company_brain_signals(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, company_brain_mission_id)
    REFERENCES company_brain_missions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, company_brain_task_id)
    REFERENCES company_brain_tasks(workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS executive_proposals_queue_idx
  ON executive_proposals(workspace_id, status, priority DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS executive_proposals_cycle_idx
  ON executive_proposals(workspace_id, cycle_id, created_at DESC);

CREATE TABLE IF NOT EXISTS executive_proposal_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  proposal_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (char_length(trim(event_type)) BETWEEN 1 AND 120),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system','agent','human')),
  actor_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, proposal_id)
    REFERENCES executive_proposals(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS executive_proposal_events_timeline_idx
  ON executive_proposal_events(workspace_id, proposal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS executive_learning_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cycle_id UUID,
  forecast_id UUID,
  proposal_id UUID,
  source_key TEXT NOT NULL CHECK (char_length(trim(source_key)) BETWEEN 1 AND 300),
  learning_type TEXT NOT NULL CHECK (char_length(trim(learning_type)) BETWEEN 1 AND 120),
  outcome TEXT NOT NULL CHECK (char_length(trim(outcome)) BETWEEN 1 AND 4000),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  confidence NUMERIC(6,5) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, source_key),
  FOREIGN KEY (workspace_id, cycle_id)
    REFERENCES executive_operating_cycles(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, forecast_id)
    REFERENCES executive_metric_forecasts(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, proposal_id)
    REFERENCES executive_proposals(workspace_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS executive_learning_records_timeline_idx
  ON executive_learning_records(workspace_id, verified, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_executive_operating_history_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Executive operating history is append-only'
    USING ERRCODE = '55000', CONSTRAINT = 'executive_operating_history_append_only';
END;
$$;

DROP TRIGGER IF EXISTS executive_proposal_events_immutable ON executive_proposal_events;
CREATE TRIGGER executive_proposal_events_immutable
  BEFORE UPDATE OR DELETE ON executive_proposal_events
  FOR EACH ROW EXECUTE FUNCTION prevent_executive_operating_history_mutation();

DROP TRIGGER IF EXISTS executive_learning_records_immutable ON executive_learning_records;
CREATE TRIGGER executive_learning_records_immutable
  BEFORE UPDATE OR DELETE ON executive_learning_records
  FOR EACH ROW EXECUTE FUNCTION prevent_executive_operating_history_mutation();

DROP TRIGGER IF EXISTS executive_operating_schedules_set_updated_at ON executive_operating_schedules;
CREATE TRIGGER executive_operating_schedules_set_updated_at
  BEFORE UPDATE ON executive_operating_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS executive_operating_cycles_set_updated_at ON executive_operating_cycles;
CREATE TRIGGER executive_operating_cycles_set_updated_at
  BEFORE UPDATE ON executive_operating_cycles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS executive_metric_forecasts_set_updated_at ON executive_metric_forecasts;
CREATE TRIGGER executive_metric_forecasts_set_updated_at
  BEFORE UPDATE ON executive_metric_forecasts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS executive_scenarios_set_updated_at ON executive_scenarios;
CREATE TRIGGER executive_scenarios_set_updated_at
  BEFORE UPDATE ON executive_scenarios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS executive_proposals_set_updated_at ON executive_proposals;
CREATE TRIGGER executive_proposals_set_updated_at
  BEFORE UPDATE ON executive_proposals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
