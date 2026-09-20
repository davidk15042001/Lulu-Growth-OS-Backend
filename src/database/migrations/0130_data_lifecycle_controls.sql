-- 0130_data_lifecycle_controls.sql
-- Explicit, auditable retention policy state. Policies are disabled by default;
-- a deployment must opt in after legal/compliance review.

CREATE TABLE IF NOT EXISTS data_retention_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  data_class TEXT NOT NULL CHECK (data_class ~ '^[a-z][a-z0-9_]*$'),
  table_name TEXT NOT NULL CHECK (table_name ~ '^[a-z][a-z0-9_]*$'),
  timestamp_column TEXT NOT NULL CHECK (timestamp_column ~ '^[a-z][a-z0-9_]*$'),
  retention_days INTEGER NOT NULL CHECK (retention_days > 0),
  disposition TEXT NOT NULL DEFAULT 'REVIEW'
    CHECK (disposition IN ('ARCHIVE','DELETE','ANONYMIZE','REVIEW')),
  legal_hold_required BOOLEAN NOT NULL DEFAULT TRUE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS data_retention_policies_global_key
  ON data_retention_policies (data_class)
  WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS data_retention_policies_workspace_key
  ON data_retention_policies (workspace_id, data_class)
  WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS data_retention_policies_enabled_idx
  ON data_retention_policies (enabled, disposition, data_class);

CREATE TABLE IF NOT EXISTS data_retention_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  data_class TEXT NOT NULL CHECK (data_class ~ '^[a-z][a-z0-9_]*$'),
  subject_type TEXT NOT NULL CHECK (subject_type ~ '^[a-z][a-z0-9_]*$'),
  subject_id TEXT NOT NULL CHECK (char_length(trim(subject_id)) BETWEEN 1 AND 250),
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) BETWEEN 1 AND 2000),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ,
  released_by UUID REFERENCES users(id) ON DELETE SET NULL,
  release_reason TEXT,
  UNIQUE (workspace_id, data_class, subject_type, subject_id)
);
CREATE INDEX IF NOT EXISTS data_retention_holds_active_idx
  ON data_retention_holds (workspace_id, data_class, subject_type, subject_id)
  WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS data_retention_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  policy_id UUID NOT NULL REFERENCES data_retention_policies(id) ON DELETE RESTRICT,
  data_class TEXT NOT NULL,
  cutoff_at TIMESTAMPTZ NOT NULL,
  dry_run BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'PLANNED'
    CHECK (status IN ('PLANNED','RUNNING','COMPLETED','FAILED','CANCELLED')),
  rows_scanned BIGINT NOT NULL DEFAULT 0 CHECK (rows_scanned >= 0),
  rows_eligible BIGINT NOT NULL DEFAULT 0 CHECK (rows_eligible >= 0),
  rows_dispositioned BIGINT NOT NULL DEFAULT 0 CHECK (rows_dispositioned >= 0),
  rows_skipped_hold BIGINT NOT NULL DEFAULT 0 CHECK (rows_skipped_hold >= 0),
  idempotency_key TEXT NOT NULL CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 250),
  started_by UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS data_retention_runs_policy_idx
  ON data_retention_runs (policy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS data_retention_runs_status_idx
  ON data_retention_runs (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_data_retention_policies_updated_at ON data_retention_policies;
CREATE TRIGGER trg_data_retention_policies_updated_at
  BEFORE UPDATE ON data_retention_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO data_retention_policies (
  data_class, table_name, timestamp_column, retention_days, disposition, legal_hold_required, enabled
)
VALUES
  ('onboarding_files', 'onboarding_documents', 'created_at', 30, 'DELETE', TRUE, FALSE),
  ('provider_webhooks', 'provider_webhook_events', 'received_at', 180, 'ARCHIVE', TRUE, FALSE),
  ('domain_events', 'domain_events', 'occurred_at', 365, 'ARCHIVE', TRUE, FALSE),
  ('agent_run_events', 'agent_run_events', 'created_at', 180, 'ARCHIVE', TRUE, FALSE),
  ('audit_log', 'audit_log', 'created_at', 2555, 'REVIEW', TRUE, FALSE),
  ('financial_ledger', 'financial_ledger_entries', 'created_at', 2555, 'REVIEW', TRUE, FALSE)
ON CONFLICT DO NOTHING;
