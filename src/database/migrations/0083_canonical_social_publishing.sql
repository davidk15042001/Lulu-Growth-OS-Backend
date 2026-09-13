-- Canonical, tenant-scoped social publishing execution layer.
--
-- Credentials remain in the Provider Control Plane credential stores. These
-- tables contain only provider identities, content, durable jobs and redacted
-- execution evidence. A publication is never marked successful without a
-- provider publication id returned by Meta.

UPDATE provider_registry SET category='SOCIAL', implementation_status='PARTIAL', updated_at=NOW()
 WHERE provider_key IN ('facebook','instagram');

INSERT INTO provider_capability_definitions
  (provider_key, capability_key, display_name, description, required_scopes, default_status)
VALUES
  ('facebook', 'facebook.pages.publish', 'Publish Facebook Page posts',
   'Publish text, link and single-image posts to a verified Facebook Page.',
   ARRAY['pages_manage_posts','pages_read_engagement'], 'AUTHORIZATION_REQUIRED'),
  ('instagram', 'instagram.content.publish', 'Publish Instagram content',
   'Publish single-image posts to a verified Instagram Business account.',
   ARRAY['instagram_basic','instagram_content_publish','pages_show_list','pages_read_engagement'],
   'AUTHORIZATION_REQUIRED')
ON CONFLICT (provider_key, capability_key) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  description=EXCLUDED.description,
  required_scopes=EXCLUDED.required_scopes;

CREATE TABLE IF NOT EXISTS social_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('FACEBOOK','INSTAGRAM')),
  display_name TEXT NOT NULL CHECK (char_length(trim(display_name)) BETWEEN 1 AND 200),
  facebook_page_id TEXT NOT NULL CHECK (facebook_page_id ~ '^[0-9]{2,40}$'),
  instagram_business_account_id TEXT,
  provider_username TEXT,
  status TEXT NOT NULL DEFAULT 'BLOCKED'
    CHECK (status IN ('AVAILABLE','BLOCKED','UNAVAILABLE')),
  status_reason TEXT NOT NULL DEFAULT 'Provider verification is required.'
    CHECK (char_length(status_reason) <= 2000),
  verified_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  idempotency_key TEXT NOT NULL CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 240),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, provider, facebook_page_id, instagram_business_account_id),
  CHECK ((provider='FACEBOOK' AND instagram_business_account_id IS NULL)
      OR (provider='INSTAGRAM' AND instagram_business_account_id ~ '^[0-9]{2,40}$'))
);
CREATE INDEX IF NOT EXISTS idx_social_accounts_workspace_provider
  ON social_accounts(workspace_id, provider, status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_accounts_facebook_page
  ON social_accounts(workspace_id, facebook_page_id)
  WHERE provider='FACEBOOK';
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_accounts_instagram_business
  ON social_accounts(workspace_id, instagram_business_account_id)
  WHERE provider='INSTAGRAM';
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_accounts_instagram_page
  ON social_accounts(workspace_id, facebook_page_id)
  WHERE provider='INSTAGRAM';

CREATE OR REPLACE FUNCTION validate_social_account_connection_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  connection_provider TEXT;
  connection_workspace UUID;
  connection_scope TEXT;
BEGIN
  SELECT provider_key, workspace_id, scope_type
    INTO connection_provider, connection_workspace, connection_scope
    FROM provider_connections
   WHERE id=NEW.provider_connection_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Social provider connection does not exist'
      USING ERRCODE='23503', CONSTRAINT='social_account_provider_connection_fk';
  END IF;
  IF lower(NEW.provider) <> connection_provider THEN
    RAISE EXCEPTION 'Social account provider does not match its provider connection'
      USING ERRCODE='23514', CONSTRAINT='social_account_provider_match';
  END IF;
  IF connection_scope='WORKSPACE' AND connection_workspace <> NEW.workspace_id THEN
    RAISE EXCEPTION 'Social account provider connection belongs to another workspace'
      USING ERRCODE='23514', CONSTRAINT='social_account_workspace_scope';
  ELSIF connection_scope <> 'WORKSPACE' AND NOT EXISTS (
    SELECT 1 FROM provider_connection_workspace_access access
     WHERE access.provider_connection_id=NEW.provider_connection_id
       AND access.workspace_id=NEW.workspace_id
       AND access.access_status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Shared social provider connection is not granted to this workspace'
      USING ERRCODE='23514', CONSTRAINT='social_account_shared_access';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_social_account_connection_scope ON social_accounts;
CREATE TRIGGER trg_social_account_connection_scope
  BEFORE INSERT OR UPDATE OF workspace_id, provider_connection_id, provider
  ON social_accounts FOR EACH ROW EXECUTE FUNCTION validate_social_account_connection_scope();

CREATE TABLE IF NOT EXISTS social_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('TEXT','LINK','IMAGE')),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','READY','ARCHIVED')),
  message TEXT NOT NULL DEFAULT '' CHECK (char_length(message) <= 63206),
  link_url TEXT,
  media_url TEXT,
  alt_text TEXT CHECK (alt_text IS NULL OR char_length(alt_text) <= 1000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  idempotency_key TEXT NOT NULL CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 240),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_actor_type TEXT NOT NULL DEFAULT 'USER'
    CHECK (created_by_actor_type IN ('USER','AI_AGENT','WORKFLOW','SYSTEM','ADMIN')),
  created_by_actor_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  CHECK ((content_type='TEXT' AND char_length(trim(message)) > 0 AND link_url IS NULL AND media_url IS NULL)
      OR (content_type='LINK' AND char_length(trim(message)) > 0 AND link_url IS NOT NULL AND media_url IS NULL)
      OR (content_type='IMAGE' AND media_url IS NOT NULL AND link_url IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_social_content_workspace_status
  ON social_content(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS social_publication_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  social_account_id UUID NOT NULL,
  content_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT','SCHEDULED','QUEUED','PUBLISHING','PUBLISHED','FAILED','CANCELLED','BLOCKED'
  )),
  scheduled_at TIMESTAMPTZ,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provider_publication_id TEXT,
  provider_permalink TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  published_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  block_code TEXT,
  block_message TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  idempotency_key TEXT NOT NULL CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 240),
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_actor_type TEXT NOT NULL DEFAULT 'USER'
    CHECK (created_by_actor_type IN ('USER','AI_AGENT','WORKFLOW','SYSTEM','ADMIN')),
  created_by_actor_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, social_account_id)
    REFERENCES social_accounts(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, content_id)
    REFERENCES social_content(workspace_id, id) ON DELETE RESTRICT,
  CHECK (status <> 'SCHEDULED' OR scheduled_at IS NOT NULL),
  CHECK (status <> 'PUBLISHED' OR (provider_publication_id IS NOT NULL AND published_at IS NOT NULL)),
  CHECK (status NOT IN ('PUBLISHED','FAILED','CANCELLED','BLOCKED') OR finished_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_social_publication_jobs_worker
  ON social_publication_jobs(status, available_at, scheduled_at, created_at)
  WHERE status IN ('QUEUED','SCHEDULED','PUBLISHING');
CREATE INDEX IF NOT EXISTS idx_social_publication_jobs_workspace
  ON social_publication_jobs(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS social_publication_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  publication_job_id UUID NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL DEFAULT 'RUNNING'
    CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','BLOCKED','DEAD_LETTER')),
  worker_id TEXT NOT NULL,
  request_summary JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(request_summary)='object'),
  response_summary JSONB CHECK (response_summary IS NULL OR jsonb_typeof(response_summary)='object'),
  provider_request_id TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, publication_job_id, attempt_number),
  FOREIGN KEY (workspace_id, publication_job_id)
    REFERENCES social_publication_jobs(workspace_id, id) ON DELETE CASCADE,
  CHECK (status='RUNNING' OR finished_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_social_publication_attempts_job
  ON social_publication_attempts(workspace_id, publication_job_id, attempt_number DESC);

DROP TRIGGER IF EXISTS trg_social_accounts_set_updated_at ON social_accounts;
CREATE TRIGGER trg_social_accounts_set_updated_at BEFORE UPDATE ON social_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_social_content_set_updated_at ON social_content;
CREATE TRIGGER trg_social_content_set_updated_at BEFORE UPDATE ON social_content
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_social_publication_jobs_set_updated_at ON social_publication_jobs;
CREATE TRIGGER trg_social_publication_jobs_set_updated_at BEFORE UPDATE ON social_publication_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
