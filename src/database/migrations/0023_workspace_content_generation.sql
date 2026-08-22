-- 0023_workspace_content_generation.sql
-- Versioned, reusable content generated from workspace intelligence.

CREATE TABLE IF NOT EXISTS workspace_content_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id UUID REFERENCES workspace_knowledge_snapshots(id) ON DELETE SET NULL,
  module TEXT NOT NULL CHECK (module IN ('website','seo','marketing','advertisement','email','analytics')),
  asset_type TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  title TEXT NOT NULL,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','published','superseded','failed')),
  version INTEGER NOT NULL DEFAULT 1,
  source_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(content) = 'object'),
  CHECK (jsonb_typeof(source_manifest) = 'object')
);
CREATE INDEX IF NOT EXISTS workspace_content_assets_lookup_idx
  ON workspace_content_assets(workspace_id, module, language, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_content_refresh_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id UUID REFERENCES workspace_knowledge_snapshots(id) ON DELETE SET NULL,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  current_phase TEXT NOT NULL DEFAULT 'snapshot',
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  modules JSONB NOT NULL DEFAULT '[]'::jsonb,
  module_status JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  locked_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(modules) = 'array'),
  CHECK (jsonb_typeof(module_status) = 'object')
);
CREATE INDEX IF NOT EXISTS workspace_content_refresh_jobs_lookup_idx
  ON workspace_content_refresh_jobs(workspace_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_content_refresh_active_idx
  ON workspace_content_refresh_jobs(workspace_id)
  WHERE status IN ('queued','running');

DROP TRIGGER IF EXISTS trg_workspace_content_assets_set_updated_at ON workspace_content_assets;
CREATE TRIGGER trg_workspace_content_assets_set_updated_at
  BEFORE UPDATE ON workspace_content_assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_workspace_content_refresh_jobs_set_updated_at ON workspace_content_refresh_jobs;
CREATE TRIGGER trg_workspace_content_refresh_jobs_set_updated_at
  BEFORE UPDATE ON workspace_content_refresh_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
