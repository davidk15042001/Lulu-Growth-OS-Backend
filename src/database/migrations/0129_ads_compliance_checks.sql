-- Every paid-ad publication must have a durable, tenant-scoped compliance decision.
-- The decision is an execution gate, not a UI hint: a blocked/review-required
-- check cannot be bypassed by the Office, Workspace, or an agent worker.
CREATE TABLE IF NOT EXISTS ad_compliance_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL DEFAULT 'system:ads-compliance-auditor',
  provider TEXT NOT NULL CHECK (provider IN ('google-ads','meta-ads','linkedin-ads')),
  action TEXT NOT NULL CHECK (action IN ('launch','publish','pause')),
  account_id TEXT,
  campaign_id TEXT,
  country_codes TEXT[] NOT NULL DEFAULT '{}',
  industry TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('PASSED','BLOCKED','REVIEW_REQUIRED')),
  findings JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  corrections JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(corrections) = 'array'),
  input_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input_snapshot) = 'object'),
  policy_version TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ad_compliance_checks_workspace_created
  ON ad_compliance_checks(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ad_compliance_checks_campaign_latest
  ON ad_compliance_checks(workspace_id, provider, campaign_id, created_at DESC);
