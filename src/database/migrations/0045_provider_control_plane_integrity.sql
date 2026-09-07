-- Part 3 follow-up: relational integrity for canonical provider resources.
--
-- The constraints are NOT VALID so a deployment cannot be blocked by an old
-- record that was written before the control plane existed. PostgreSQL still
-- enforces them for every new or updated row; existing rows can be audited and
-- validated in a later maintenance window.

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_connections_id_workspace
  ON provider_connections (id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_connections_id_provider
  ON provider_connections (id, provider_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_accounts_connection_id
  ON provider_accounts (provider_connection_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_accounts_id_provider
  ON provider_accounts (id, provider_key);

INSERT INTO provider_capability_definitions
  (provider_key, capability_key, display_name, required_scopes, default_status)
VALUES
  ('google_calendar', 'calendar.read', 'Read calendar', '{}', 'AVAILABLE'),
  ('google_calendar', 'calendar.write', 'Write calendar', '{}', 'UNCONFIRMED'),
  ('microsoft_calendar', 'calendar.read', 'Read calendar', '{}', 'AVAILABLE')
ON CONFLICT (provider_key, capability_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  required_scopes = EXCLUDED.required_scopes,
  default_status = EXCLUDED.default_status;

-- Explicit routing for shared Lulu/partner resources. A shared connection is
-- never visible to a workspace merely because it exists; it must have an
-- ACTIVE access grant in this table.
CREATE TABLE IF NOT EXISTS provider_connection_workspace_access (
  provider_connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  access_status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (access_status IN ('ACTIVE','REVOKED')),
  granted_capabilities TEXT[] NOT NULL DEFAULT '{}',
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider_connection_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS idx_provider_connection_access_workspace
  ON provider_connection_workspace_access(workspace_id, access_status);
DROP TRIGGER IF EXISTS trg_provider_connection_access_set_updated_at ON provider_connection_workspace_access;
CREATE TRIGGER trg_provider_connection_access_set_updated_at
  BEFORE UPDATE ON provider_connection_workspace_access
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
BEGIN
  ALTER TABLE provider_accounts
    ADD CONSTRAINT fk_provider_account_provider
    FOREIGN KEY (provider_connection_id, provider_key)
    REFERENCES provider_connections (id, provider_key)
    ON DELETE CASCADE
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE provider_assets
    ADD CONSTRAINT fk_provider_asset_provider
    FOREIGN KEY (provider_account_id, provider_key)
    REFERENCES provider_accounts (id, provider_key)
    ON DELETE CASCADE
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE provider_operations
    ADD CONSTRAINT fk_provider_operation_workspace_connection
    FOREIGN KEY (provider_connection_id, workspace_id)
    REFERENCES provider_connections (id, workspace_id)
    ON DELETE CASCADE
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE provider_webhook_events
    ADD CONSTRAINT fk_provider_webhook_provider_connection
    FOREIGN KEY (provider_connection_id, provider_key)
    REFERENCES provider_connections (id, provider_key)
    ON DELETE SET NULL
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE provider_object_mappings
    ADD CONSTRAINT provider_mapping_workspace_required
    CHECK (workspace_id IS NOT NULL)
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE provider_operations
    ADD CONSTRAINT provider_operation_workspace_required
    CHECK (workspace_id IS NOT NULL)
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE provider_object_mappings
    ADD CONSTRAINT fk_provider_mapping_workspace_connection
    FOREIGN KEY (provider_connection_id, workspace_id)
    REFERENCES provider_connections (id, workspace_id)
    ON DELETE CASCADE
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE provider_object_mappings
    ADD CONSTRAINT fk_provider_mapping_connection_account
    FOREIGN KEY (provider_connection_id, provider_account_id)
    REFERENCES provider_accounts (provider_connection_id, id)
    ON DELETE CASCADE
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE provider_webhook_events
    ADD CONSTRAINT fk_provider_webhook_connection_account
    FOREIGN KEY (provider_connection_id, provider_account_id)
    REFERENCES provider_accounts (provider_connection_id, id)
    ON DELETE SET NULL
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
