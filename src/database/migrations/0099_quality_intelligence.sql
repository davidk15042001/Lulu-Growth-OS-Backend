-- Quality Intelligence foundation.
-- Quality records are projections attached to canonical workspace objects; they
-- never replace or duplicate the underlying business records.

CREATE TABLE IF NOT EXISTS quality_source_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (char_length(trim(source_type)) BETWEEN 1 AND 120),
  source_ref TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fresh_until TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'verified' CHECK (status IN ('verified','derived','forecast','unavailable','not_applicable')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quality_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL CHECK (char_length(trim(artifact_type)) BETWEEN 1 AND 120),
  canonical_entity_type TEXT NOT NULL CHECK (char_length(trim(canonical_entity_type)) BETWEEN 1 AND 120),
  canonical_entity_id TEXT NOT NULL CHECK (char_length(trim(canonical_entity_id)) BETWEEN 1 AND 200),
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','REVIEW_PENDING','REVIEWING','REPAIR_REQUIRED','REPAIRING','FINAL_REVIEW','APPROVED','REJECTED','WITHHELD','ESCALATED','RELEASE_QUEUED','RELEASED','OUTCOME_PENDING','MEASURED')),
  risk_class TEXT NOT NULL DEFAULT 'standard' CHECK (risk_class IN ('low','standard','high','regulated')),
  language TEXT NOT NULL DEFAULT 'en' CHECK (char_length(language) BETWEEN 2 AND 20),
  target_market TEXT,
  target_channel TEXT,
  release_mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK (release_mode IN ('SHADOW','ASSISTED','CANARY','ENFORCED')),
  provider_status TEXT NOT NULL DEFAULT 'not_started' CHECK (provider_status IN ('not_started','queued','submitted','running','completed','failed','ambiguous')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS quality_artifact_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  artifact_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  content JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(content) = 'object'),
  rendered_ref TEXT,
  producer_agent_id TEXT NOT NULL CHECK (char_length(trim(producer_agent_id)) BETWEEN 1 AND 160),
  producer_version TEXT NOT NULL DEFAULT 'unknown',
  model_provider TEXT,
  model_name TEXT,
  model_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(model_metadata) = 'object'),
  source_snapshot_id UUID REFERENCES quality_source_snapshots(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, artifact_id, version),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES quality_artifacts(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quality_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_snapshot_id UUID REFERENCES quality_source_snapshots(id) ON DELETE SET NULL,
  reference TEXT NOT NULL CHECK (char_length(trim(reference)) BETWEEN 1 AND 500),
  excerpt TEXT,
  status TEXT NOT NULL DEFAULT 'verified' CHECK (status IN ('verified','derived','forecast','unavailable','not_applicable','contradictory')),
  observed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS quality_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  artifact_version_id UUID NOT NULL,
  claim_text TEXT NOT NULL CHECK (char_length(trim(claim_text)) BETWEEN 1 AND 4_000),
  position JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(position) = 'object'),
  claim_type TEXT NOT NULL DEFAULT 'factual' CHECK (claim_type IN ('factual','numeric','comparative','testimonial','forecast','opinion','instruction','other')),
  source_status TEXT NOT NULL DEFAULT 'unavailable' CHECK (source_status IN ('verified','derived','forecast','unavailable','not_applicable')),
  freshness TEXT CHECK (freshness IS NULL OR freshness IN ('current','stale','unknown')),
  confidence TEXT NOT NULL DEFAULT 'low' CHECK (confidence IN ('high','medium','low')),
  verdict TEXT NOT NULL DEFAULT 'unchecked' CHECK (verdict IN ('unchecked','verified','failed','unavailable','contradictory')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, artifact_version_id) REFERENCES quality_artifact_versions(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quality_claim_evidence (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  claim_id UUID NOT NULL,
  evidence_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, claim_id, evidence_id),
  FOREIGN KEY (workspace_id, claim_id) REFERENCES quality_claims(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, evidence_id) REFERENCES quality_evidence(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quality_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  artifact_version_id UUID NOT NULL,
  reviewer_agent_id TEXT NOT NULL CHECK (char_length(trim(reviewer_agent_id)) BETWEEN 1 AND 160),
  reviewer_version TEXT NOT NULL DEFAULT 'unknown',
  reviewer_kind TEXT NOT NULL CHECK (reviewer_kind IN ('final_gate','evidence_claim','brand_voice','customer_reality','evaluation_calibration','visual_ux','statistics','native_market','claims_compliance','repair_orchestrator','human')),
  verdict TEXT NOT NULL CHECK (verdict IN ('passed','failed','needs_repair','unavailable')),
  overall_score NUMERIC(5,2) CHECK (overall_score IS NULL OR (overall_score >= 0 AND overall_score <= 100)),
  dimensions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(dimensions) = 'array'),
  findings JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  checked_claims JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checked_claims) = 'array'),
  confidence TEXT NOT NULL DEFAULT 'low' CHECK (confidence IN ('high','medium','low')),
  limitations JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(limitations) = 'array'),
  next_action TEXT NOT NULL CHECK (next_action IN ('approve','repair','withhold','escalate')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, artifact_version_id) REFERENCES quality_artifact_versions(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quality_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  review_id UUID NOT NULL,
  artifact_version_id UUID NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('hard_block','major','minor','suggestion')),
  category TEXT NOT NULL CHECK (char_length(trim(category)) BETWEEN 1 AND 120),
  location TEXT,
  message TEXT NOT NULL CHECK (char_length(trim(message)) BETWEEN 1 AND 4_000),
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
  suggested_fix TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, review_id) REFERENCES quality_reviews(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, artifact_version_id) REFERENCES quality_artifact_versions(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quality_repair_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  artifact_id UUID NOT NULL,
  input_version_id UUID NOT NULL,
  output_version_id UUID,
  round_number INTEGER NOT NULL CHECK (round_number >= 1),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','withheld')),
  finding_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(finding_ids) = 'array'),
  error_message TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES quality_artifacts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, input_version_id) REFERENCES quality_artifact_versions(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, output_version_id) REFERENCES quality_artifact_versions(workspace_id, id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS quality_release_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  artifact_id UUID NOT NULL,
  artifact_version_id UUID NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','withheld','escalated','queued','released')),
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) BETWEEN 1 AND 4_000),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM','AI_AGENT','USER','ADMIN')),
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  override_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES quality_artifacts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, artifact_version_id) REFERENCES quality_artifact_versions(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quality_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  artifact_id UUID NOT NULL,
  artifact_version_id UUID NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted_without_edit','accepted_with_edit','rejected','overridden','complaint','problem_reported')),
  edit_distance NUMERIC(12,4),
  notes TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES quality_artifacts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, artifact_version_id) REFERENCES quality_artifact_versions(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quality_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  artifact_id UUID NOT NULL,
  artifact_version_id UUID NOT NULL,
  metric_key TEXT NOT NULL CHECK (char_length(trim(metric_key)) BETWEEN 1 AND 160),
  value NUMERIC,
  value_text TEXT,
  source TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES quality_artifacts(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, artifact_version_id) REFERENCES quality_artifact_versions(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quality_rubrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  dimensions JSONB NOT NULL CHECK (jsonb_typeof(dimensions) = 'array'),
  hard_failure_rules JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(hard_failure_rules) = 'array'),
  minimum_dimension_score NUMERIC(5,2) NOT NULL DEFAULT 85 CHECK (minimum_dimension_score BETWEEN 0 AND 100),
  minimum_overall_score NUMERIC(5,2) NOT NULL DEFAULT 90 CHECK (minimum_overall_score BETWEEN 0 AND 100),
  required_reviewers JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(required_reviewers) = 'array'),
  risk_class TEXT NOT NULL DEFAULT 'standard',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, artifact_type, version)
);

CREATE TABLE IF NOT EXISTS quality_workspace_config (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  default_mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK (default_mode IN ('SHADOW','ASSISTED','CANARY','ENFORCED')),
  max_repair_rounds INTEGER NOT NULL DEFAULT 3 CHECK (max_repair_rounds BETWEEN 0 AND 20),
  independent_review_required BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS quality_artifacts_workspace_status_idx ON quality_artifacts(workspace_id,status,updated_at DESC);
CREATE INDEX IF NOT EXISTS quality_versions_artifact_idx ON quality_artifact_versions(workspace_id,artifact_id,version DESC);
CREATE INDEX IF NOT EXISTS quality_reviews_version_idx ON quality_reviews(workspace_id,artifact_version_id,created_at DESC);
CREATE INDEX IF NOT EXISTS quality_findings_version_idx ON quality_findings(workspace_id,artifact_version_id,severity,resolved_at);
CREATE INDEX IF NOT EXISTS quality_outcomes_artifact_idx ON quality_outcomes(workspace_id,artifact_id,observed_at DESC);

INSERT INTO workspace_capabilities(key, description) VALUES
  ('quality.read','Read quality artifacts, reviews, findings and evidence'),
  ('quality.review','Create and manage independent quality reviews'),
  ('quality.repair','Request and record versioned repair attempts'),
  ('quality.release','Make quality release decisions for approved artifacts'),
  ('quality.override','Perform an audited human quality override'),
  ('quality.admin','Manage quality modes, rubrics and reviewer policy')
ON CONFLICT (key) DO UPDATE SET description=EXCLUDED.description;

INSERT INTO workspace_role_capabilities(role,capability_key)
SELECT role,key FROM (VALUES ('owner'),('admin')) roles(role)
CROSS JOIN workspace_capabilities c
WHERE c.key LIKE 'quality.%'
ON CONFLICT DO NOTHING;

INSERT INTO workspace_role_capabilities(role,capability_key)
SELECT role,key FROM (VALUES ('member'),('sales_manager'),('sales_user'),('marketing_manager'),('marketing_user'),('finance_manager'),('operations_manager'),('viewer')) roles(role)
CROSS JOIN workspace_capabilities c
WHERE c.key='quality.read'
   OR (role IN ('sales_manager','marketing_manager','finance_manager','operations_manager') AND c.key='quality.review')
ON CONFLICT DO NOTHING;

INSERT INTO quality_rubrics(workspace_id,artifact_type,version,dimensions,hard_failure_rules,required_reviewers,risk_class)
SELECT NULL::uuid,'default',1,'["factual_accuracy","evidence_coverage","policy_safety","clarity"]'::jsonb,'["open_hard_block","missing_required_evidence","invalid_provider_status"]'::jsonb,'["final_gate"]'::jsonb,'standard'
WHERE NOT EXISTS (SELECT 1 FROM quality_rubrics WHERE workspace_id IS NULL AND artifact_type='default' AND version=1)
UNION ALL
SELECT NULL::uuid,'public_marketing',1,'["factual_accuracy","evidence_coverage","brand_voice","customer_reality","policy_safety"]'::jsonb,'["open_hard_block","unsupported_public_claim","missing_required_evidence"]'::jsonb,'["evidence_claim","brand_voice","customer_reality","claims_compliance","final_gate"]'::jsonb,'high'
WHERE NOT EXISTS (SELECT 1 FROM quality_rubrics WHERE workspace_id IS NULL AND artifact_type='public_marketing' AND version=1);
