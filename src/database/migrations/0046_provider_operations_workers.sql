-- Provider Control Plane hardening: durable worker leases and subject integrity.
--
-- Existing rows are left untouched. The trigger protects all new and updated
-- capability/sync state rows while legacy data can be audited and repaired in
-- a controlled maintenance window.

ALTER TABLE background_jobs
  ADD COLUMN IF NOT EXISTS worker_id TEXT,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;

ALTER TABLE provider_webhook_events
  ADD COLUMN IF NOT EXISTS worker_id TEXT,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_provider_sync_background_jobs
  ON background_jobs (
    job_type,
    status,
    (payload->>'providerConnectionId'),
    (payload->>'syncType'),
    scheduled_at
  )
  WHERE job_type = 'provider.sync';

CREATE INDEX IF NOT EXISTS idx_provider_webhook_claim_queue
  ON provider_webhook_events (status, next_attempt_at, received_at)
  WHERE status IN ('RECEIVED','PROCESSING','FAILED');

-- Workspace-scoped operations and mappings may legitimately point at a
-- shared Lulu/partner connection. The earlier composite FKs only allowed
-- workspace-owned connections, so replace them with access-aware triggers.
ALTER TABLE provider_operations
  DROP CONSTRAINT IF EXISTS fk_provider_operation_workspace_connection;
ALTER TABLE provider_object_mappings
  DROP CONSTRAINT IF EXISTS fk_provider_mapping_workspace_connection;

CREATE OR REPLACE FUNCTION validate_provider_workspace_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  connection_allowed BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM provider_connections c
     WHERE c.id = NEW.provider_connection_id
       AND (
         c.workspace_id = NEW.workspace_id
         OR EXISTS (
           SELECT 1
             FROM provider_connection_workspace_access access
            WHERE access.provider_connection_id = c.id
              AND access.workspace_id = NEW.workspace_id
              AND access.access_status = 'ACTIVE'
         )
       )
  ) INTO connection_allowed;

  IF NOT connection_allowed THEN
    RAISE EXCEPTION 'Provider connection is not owned by or shared with the workspace'
      USING ERRCODE = '23514', CONSTRAINT = 'provider_workspace_reference_integrity';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_provider_operation_workspace_integrity ON provider_operations;
CREATE TRIGGER trg_provider_operation_workspace_integrity
  BEFORE INSERT OR UPDATE ON provider_operations
  FOR EACH ROW EXECUTE FUNCTION validate_provider_workspace_reference();

DROP TRIGGER IF EXISTS trg_provider_mapping_workspace_integrity ON provider_object_mappings;
CREATE TRIGGER trg_provider_mapping_workspace_integrity
  BEFORE INSERT OR UPDATE ON provider_object_mappings
  FOR EACH ROW EXECUTE FUNCTION validate_provider_workspace_reference();

CREATE OR REPLACE FUNCTION validate_provider_control_subject()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  subject_exists BOOLEAN;
  capability_exists BOOLEAN;
BEGIN
  IF NEW.subject_type = 'CONNECTION' THEN
    SELECT EXISTS (
      SELECT 1 FROM provider_connections
       WHERE id = NEW.subject_id
         AND id = NEW.provider_connection_id
    ) INTO subject_exists;
  ELSIF NEW.subject_type = 'ACCOUNT' THEN
    SELECT EXISTS (
      SELECT 1 FROM provider_accounts
       WHERE id = NEW.subject_id
         AND provider_connection_id = NEW.provider_connection_id
    ) INTO subject_exists;
  ELSIF NEW.subject_type = 'ASSET' THEN
    SELECT EXISTS (
      SELECT 1
        FROM provider_assets a
        JOIN provider_accounts pa ON pa.id = a.provider_account_id
       WHERE a.id = NEW.subject_id
         AND pa.provider_connection_id = NEW.provider_connection_id
    ) INTO subject_exists;
  ELSE
    subject_exists := FALSE;
  END IF;

  IF NOT subject_exists THEN
    RAISE EXCEPTION 'Provider control subject does not belong to the connection'
      USING ERRCODE = '23514', CONSTRAINT = 'provider_control_subject_integrity';
  END IF;

  IF TG_TABLE_NAME = 'provider_capability_states' THEN
    SELECT EXISTS (
      SELECT 1
        FROM provider_connections c
        JOIN provider_capability_definitions d
          ON d.provider_key = c.provider_key
         AND d.capability_key = NEW.capability_key
       WHERE c.id = NEW.provider_connection_id
    ) INTO capability_exists;
    IF NOT capability_exists THEN
      RAISE EXCEPTION 'Provider capability is not registered for the connection'
        USING ERRCODE = '23514', CONSTRAINT = 'provider_capability_definition_integrity';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_provider_capability_subject_integrity ON provider_capability_states;
CREATE TRIGGER trg_provider_capability_subject_integrity
  BEFORE INSERT OR UPDATE ON provider_capability_states
  FOR EACH ROW EXECUTE FUNCTION validate_provider_control_subject();

DROP TRIGGER IF EXISTS trg_provider_sync_subject_integrity ON provider_sync_states;
CREATE TRIGGER trg_provider_sync_subject_integrity
  BEFORE INSERT OR UPDATE ON provider_sync_states
  FOR EACH ROW EXECUTE FUNCTION validate_provider_control_subject();
