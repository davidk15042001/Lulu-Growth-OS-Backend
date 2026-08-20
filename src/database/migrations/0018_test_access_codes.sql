CREATE TABLE IF NOT EXISTS workspace_test_access_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspace_test_access_codes_lookup_idx
  ON workspace_test_access_codes (workspace_id, email, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_test_access_codes_active_unique_idx
  ON workspace_test_access_codes (workspace_id, email)
  WHERE consumed_at IS NULL;
