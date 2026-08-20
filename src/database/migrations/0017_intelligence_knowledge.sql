-- 0017_intelligence_knowledge.sql
-- Persisted, evidence-aware business intelligence generated after confirmed billing.
-- Missing source data is represented explicitly; no demo values are inserted.

CREATE TABLE IF NOT EXISTS workspace_knowledge_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  snapshot_type TEXT NOT NULL DEFAULT 'initial_business_analysis',
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('queued','running','completed','failed','superseded')),
  confidence TEXT CHECK (confidence IN ('high','medium','low')),
  executive_summary TEXT,
  data_gaps JSONB NOT NULL DEFAULT '[]'::jsonb,
  verified_facts JSONB NOT NULL DEFAULT '[]'::jsonb,
  priorities JSONB NOT NULL DEFAULT '[]'::jsonb,
  knowledge_base JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, snapshot_type, source_run_id),
  CHECK (jsonb_typeof(data_gaps) = 'array'),
  CHECK (jsonb_typeof(verified_facts) = 'array'),
  CHECK (jsonb_typeof(priorities) = 'array'),
  CHECK (jsonb_typeof(knowledge_base) = 'object'),
  CHECK (jsonb_typeof(source_manifest) = 'object')
);
CREATE INDEX IF NOT EXISTS workspace_knowledge_latest_idx
  ON workspace_knowledge_snapshots(workspace_id, snapshot_type, generated_at DESC NULLS LAST, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_knowledge_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES workspace_knowledge_snapshots(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  section_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','partial','unavailable','failed')),
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(snapshot_id, section_key),
  CHECK (jsonb_typeof(content) = 'object')
);
CREATE INDEX IF NOT EXISTS workspace_knowledge_sections_idx
  ON workspace_knowledge_sections(workspace_id, section_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_intelligence_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id UUID REFERENCES workspace_knowledge_snapshots(id) ON DELETE SET NULL,
  metric_key TEXT NOT NULL,
  value JSONB,
  unit TEXT,
  period TEXT,
  source TEXT,
  source_status TEXT NOT NULL CHECK (source_status IN ('verified','derived','forecast','unavailable','not_applicable')),
  confidence TEXT CHECK (confidence IN ('high','medium','low')),
  limitations JSONB NOT NULL DEFAULT '[]'::jsonb,
  measured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, snapshot_id, metric_key),
  CHECK (jsonb_typeof(limitations) = 'array')
);
CREATE INDEX IF NOT EXISTS workspace_intelligence_metrics_idx
  ON workspace_intelligence_metrics(workspace_id, metric_key, updated_at DESC);

DROP TRIGGER IF EXISTS trg_workspace_knowledge_snapshots_set_updated_at ON workspace_knowledge_snapshots;
CREATE TRIGGER trg_workspace_knowledge_snapshots_set_updated_at
  BEFORE UPDATE ON workspace_knowledge_snapshots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_workspace_knowledge_sections_set_updated_at ON workspace_knowledge_sections;
CREATE TRIGGER trg_workspace_knowledge_sections_set_updated_at
  BEFORE UPDATE ON workspace_knowledge_sections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_workspace_intelligence_metrics_set_updated_at ON workspace_intelligence_metrics;
CREATE TRIGGER trg_workspace_intelligence_metrics_set_updated_at
  BEFORE UPDATE ON workspace_intelligence_metrics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
