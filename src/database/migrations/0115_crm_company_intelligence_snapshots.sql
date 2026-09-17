-- Immutable evidence trail for autonomous CRM company research.
-- workspace_records remains the current projection; this table preserves each
-- research attempt so operators can inspect provenance, confidence and gaps.

CREATE TABLE IF NOT EXISTS crm_company_intelligence_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_record_id UUID NOT NULL,
  input_fingerprint TEXT,
  status TEXT NOT NULL CHECK (status IN ('researching','complete','partial','blocked_funds','failed')),
  completeness INTEGER CHECK (completeness IS NULL OR completeness BETWEEN 0 AND 100),
  confidence TEXT CHECK (confidence IS NULL OR confidence IN ('low','medium','high')),
  missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(missing_fields) = 'array'),
  source_evidence JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_evidence) = 'array'),
  output_data JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(output_data) = 'object'),
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crm_company_intelligence_snapshots_record_workspace_fk
    FOREIGN KEY (workspace_id, company_record_id)
    REFERENCES workspace_records (workspace_id, id)
    ON DELETE CASCADE
    NOT VALID
);

CREATE INDEX IF NOT EXISTS crm_company_intelligence_snapshots_record_idx
  ON crm_company_intelligence_snapshots(workspace_id, company_record_id, created_at DESC);

CREATE INDEX IF NOT EXISTS crm_company_intelligence_snapshots_status_idx
  ON crm_company_intelligence_snapshots(workspace_id, status, created_at DESC);

