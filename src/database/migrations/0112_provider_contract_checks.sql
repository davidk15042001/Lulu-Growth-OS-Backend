-- Durable, tenant-scoped evidence for provider readiness checks.
-- A contract check is read-only: it may probe a registered adapter, but it
-- never creates or mutates an external provider resource.
CREATE TABLE IF NOT EXISTS provider_contract_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  provider_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PASSED', 'PARTIAL', 'FAILED')),
  phase_results JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(phase_results) = 'object'),
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capabilities) = 'array'),
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provider_contract_checks_workspace
  ON provider_contract_checks (workspace_id, provider_connection_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_provider_contract_checks_status
  ON provider_contract_checks (workspace_id, status, created_at DESC);
