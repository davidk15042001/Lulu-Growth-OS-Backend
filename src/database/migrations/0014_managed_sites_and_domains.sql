CREATE TABLE IF NOT EXISTS workspace_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('wordpress', 'webflow', 'managed')),
  ownership_mode TEXT NOT NULL CHECK (ownership_mode IN ('connected', 'managed')),
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 200),
  external_site_id TEXT,
  external_site_url TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'connected', 'generating', 'preview', 'publishing', 'published', 'error', 'disconnected')),
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(settings) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_workspace_sites_workspace ON workspace_sites (workspace_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_sites_external ON workspace_sites (workspace_id, provider, external_site_id) WHERE external_site_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_site_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES workspace_sites(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL CHECK (hostname = lower(hostname)),
  verification_token TEXT NOT NULL,
  verification_method TEXT NOT NULL DEFAULT 'dns_txt' CHECK (verification_method IN ('dns_txt', 'dns_cname')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed', 'removed')),
  verified_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_site_domains_hostname ON workspace_site_domains (hostname) WHERE status <> 'removed';
CREATE INDEX IF NOT EXISTS idx_workspace_site_domains_site ON workspace_site_domains (site_id, status);

CREATE TABLE IF NOT EXISTS website_generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES workspace_sites(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL CHECK (char_length(trim(prompt)) BETWEEN 10 AND 20000),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'planning', 'generated', 'preview', 'publishing', 'published', 'failed', 'cancelled')),
  plan JSONB NOT NULL DEFAULT '{}',
  preview JSONB NOT NULL DEFAULT '{}',
  provider_result JSONB NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(plan) = 'object'),
  CHECK (jsonb_typeof(preview) = 'object'),
  CHECK (jsonb_typeof(provider_result) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_website_generation_jobs_site ON website_generation_jobs (site_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_workspace_sites_set_updated_at ON workspace_sites;
CREATE TRIGGER trg_workspace_sites_set_updated_at BEFORE UPDATE ON workspace_sites FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_workspace_site_domains_set_updated_at ON workspace_site_domains;
CREATE TRIGGER trg_workspace_site_domains_set_updated_at BEFORE UPDATE ON workspace_site_domains FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_website_generation_jobs_set_updated_at ON website_generation_jobs;
CREATE TRIGGER trg_website_generation_jobs_set_updated_at BEFORE UPDATE ON website_generation_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
