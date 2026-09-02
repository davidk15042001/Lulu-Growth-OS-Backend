-- 0032_workspace_credit_balances.sql
-- Prepaid AI credits that an administrator can grant per workspace/user.

CREATE TABLE IF NOT EXISTS workspace_credit_balances (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  balance NUMERIC(18,6) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS workspace_credit_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  amount NUMERIC(18,6) NOT NULL,
  balance_after NUMERIC(18,6) NOT NULL,
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_credit_grants_workspace
  ON workspace_credit_grants (workspace_id, created_at DESC);
