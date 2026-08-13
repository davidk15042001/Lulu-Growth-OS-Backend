-- 0004_resources.sql
-- Shared, workspace-scoped storage for CRM, Sales, Marketing, Advertising,
-- Ecommerce, Finance, Intelligence and AI resources.

CREATE TABLE IF NOT EXISTS resource_types (
  key TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  domain TEXT NOT NULL CHECK (domain ~ '^[a-z][a-z0-9_]*$'),
  label TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL REFERENCES resource_types(key) ON DELETE RESTRICT,
  parent_id UUID REFERENCES workspace_records(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 300),
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  stage TEXT,
  value_amount NUMERIC(20, 4),
  currency CHAR(3),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  external_id TEXT,
  source TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  data JSONB NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(data) = 'object'),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at)
);

CREATE INDEX IF NOT EXISTS idx_workspace_records_list
  ON workspace_records (workspace_id, resource_type, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_records_parent
  ON workspace_records (workspace_id, parent_id)
  WHERE parent_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_records_assignee
  ON workspace_records (workspace_id, assignee_id, due_at)
  WHERE assignee_id IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_records_external
  ON workspace_records (workspace_id, resource_type, external_id)
  WHERE external_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_records_tags
  ON workspace_records USING GIN (tags);

CREATE INDEX IF NOT EXISTS idx_workspace_records_data
  ON workspace_records USING GIN (data);

CREATE INDEX IF NOT EXISTS idx_workspace_records_search
  ON workspace_records USING GIN (
    to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, ''))
  );

CREATE TABLE IF NOT EXISTS record_relationships (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_record_id UUID NOT NULL REFERENCES workspace_records(id) ON DELETE CASCADE,
  target_record_id UUID NOT NULL REFERENCES workspace_records(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL CHECK (relationship_type ~ '^[a-z][a-z0-9_]*$'),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_record_id, target_record_id, relationship_type),
  CHECK (source_record_id <> target_record_id),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_record_relationships_target
  ON record_relationships (workspace_id, target_record_id, relationship_type);

CREATE TABLE IF NOT EXISTS record_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  record_id UUID NOT NULL REFERENCES workspace_records(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body TEXT NOT NULL CHECK (char_length(trim(body)) BETWEEN 1 AND 10000),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_record_comments_record
  ON record_comments (workspace_id, record_id, created_at)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS record_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  record_id UUID NOT NULL REFERENCES workspace_records(id) ON DELETE CASCADE,
  uploaded_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  storage_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_record_attachments_storage_key
  ON record_attachments (storage_key);

CREATE TABLE IF NOT EXISTS metric_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'number',
  format TEXT,
  source TEXT,
  configuration JSONB NOT NULL DEFAULT '{}',
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, key),
  CHECK (jsonb_typeof(configuration) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_metric_definitions_workspace
  ON metric_definitions (workspace_id, domain, key)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS metric_points (
  id BIGSERIAL PRIMARY KEY,
  metric_id UUID NOT NULL REFERENCES metric_definitions(id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL,
  value NUMERIC(30, 8) NOT NULL,
  dimensions JSONB NOT NULL DEFAULT '{}',
  source_record_id UUID REFERENCES workspace_records(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(dimensions) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_metric_points_series
  ON metric_points (metric_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_metric_points_dimensions
  ON metric_points USING GIN (dimensions);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  request_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  before_data JSONB,
  after_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (before_data IS NULL OR jsonb_typeof(before_data) = 'object'),
  CHECK (after_data IS NULL OR jsonb_typeof(after_data) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_audit_log_workspace
  ON audit_log (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity
  ON audit_log (workspace_id, entity_type, entity_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_resource_types_set_updated_at ON resource_types;
CREATE TRIGGER trg_resource_types_set_updated_at
  BEFORE UPDATE ON resource_types
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_workspace_records_set_updated_at ON workspace_records;
CREATE TRIGGER trg_workspace_records_set_updated_at
  BEFORE UPDATE ON workspace_records
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_record_comments_set_updated_at ON record_comments;
CREATE TRIGGER trg_record_comments_set_updated_at
  BEFORE UPDATE ON record_comments
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_metric_definitions_set_updated_at ON metric_definitions;
CREATE TRIGGER trg_metric_definitions_set_updated_at
  BEFORE UPDATE ON metric_definitions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
