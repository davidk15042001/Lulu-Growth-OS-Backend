-- Security and finance hardening after Parts 1-4.
--
-- This migration is additive and keeps the existing workspace boundary. The
-- NOT VALID clauses deliberately preserve old rows while enforcing the
-- invariant for every new or updated row; historical data can be validated in
-- a controlled maintenance window.

-- ---------------------------------------------------------------------------
-- Workspace owner protection
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_workspace_last_owner_loss()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  owner_count INTEGER;
BEGIN
  -- A cascading workspace deletion is an intentional tenant teardown. The
  -- parent row is already gone when PostgreSQL invokes this trigger.
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Serialize owner changes per workspace so two concurrent demotions or
  -- deletes cannot both observe the same last-owner count.
  IF TG_OP = 'DELETE'
     OR (TG_OP = 'UPDATE' AND OLD.role = 'owner' AND NEW.role <> 'owner') THEN
    PERFORM 1 FROM workspaces WHERE id = OLD.workspace_id FOR UPDATE;
    SELECT count(*)::integer
      INTO owner_count
     FROM workspace_members
     WHERE workspace_id = OLD.workspace_id
       AND role = 'owner'
       AND user_id <> OLD.user_id;
    IF owner_count < 1 THEN
      RAISE EXCEPTION 'A workspace must retain at least one active owner'
        USING ERRCODE = '23514', CONSTRAINT = 'workspace_last_owner_guard';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS workspace_last_owner_guard ON workspace_members;
CREATE TRIGGER workspace_last_owner_guard
  BEFORE UPDATE OF role OR DELETE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION prevent_workspace_last_owner_loss();

-- Restrictions are deny/limit controls. They must never grant a feature that
-- the subscription plan does not provide.
ALTER TABLE workspace_entitlement_restrictions
  DROP CONSTRAINT IF EXISTS workspace_entitlement_restriction_cannot_grant;
ALTER TABLE workspace_entitlement_restrictions
  ADD CONSTRAINT workspace_entitlement_restriction_cannot_grant
  CHECK (enabled = FALSE) NOT VALID;

-- ---------------------------------------------------------------------------
-- Tenant integrity for actor and operational references
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION validate_workspace_record_actor()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM workspace_members wm
    JOIN users u ON u.id = wm.user_id AND u.deleted_at IS NULL
    WHERE wm.workspace_id = NEW.workspace_id
      AND wm.user_id = NEW.created_by
  ) THEN
    RAISE EXCEPTION 'Record actor is not an active member of the workspace'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_record_actor_integrity';
  END IF;
  IF NEW.updated_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM workspace_members wm
    JOIN users u ON u.id = wm.user_id AND u.deleted_at IS NULL
    WHERE wm.workspace_id = NEW.workspace_id
      AND wm.user_id = NEW.updated_by
  ) THEN
    RAISE EXCEPTION 'Record updater is not an active member of the workspace'
      USING ERRCODE = '23514', CONSTRAINT = 'workspace_record_updater_integrity';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workspace_record_actor_integrity ON workspace_records;
CREATE TRIGGER trg_workspace_record_actor_integrity
  BEFORE INSERT OR UPDATE OF workspace_id, created_by, updated_by ON workspace_records
  FOR EACH ROW EXECUTE FUNCTION validate_workspace_record_actor();

-- A notification, saved view, conversation, approval or agent run may only
-- name a user who belongs to the same workspace. Nullable actor fields remain
-- valid for system jobs.
DO $$
BEGIN
  ALTER TABLE notifications
    ADD CONSTRAINT notifications_workspace_user_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_members (workspace_id, user_id)
    ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE saved_views
    ADD CONSTRAINT saved_views_workspace_user_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_members (workspace_id, user_id)
    ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE ai_conversations
    ADD CONSTRAINT ai_conversations_workspace_user_fk
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspace_members (workspace_id, user_id)
    ON DELETE CASCADE NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE ai_usage_ledger ALTER COLUMN user_id DROP NOT NULL;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- AI provider retries must not double-charge a response. The response ID is
-- provider supplied and scoped to a workspace, so it is safe as an idempotency
-- key while rows remain append-only.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_usage_ledger_workspace_response
  ON ai_usage_ledger (workspace_id, (metadata->>'responseId'))
  WHERE metadata->>'responseId' IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Provider uniqueness and mapping safety
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_connection_workspace_account
  ON provider_connections (workspace_id, provider_key, external_account_id)
  WHERE workspace_id IS NOT NULL AND external_account_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Immutable, minor-unit finance ledger foundation
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS financial_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entry_group_id UUID NOT NULL,
  account_code TEXT NOT NULL CHECK (account_code ~ '^[A-Z][A-Z0-9_.-]{1,80}$'),
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference_type TEXT,
  reference_id TEXT,
  idempotency_key TEXT NOT NULL CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 250),
  metadata JSONB NOT NULL DEFAULT '{}',
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (workspace_id, idempotency_key, direction)
);

CREATE INDEX IF NOT EXISTS idx_financial_ledger_workspace_created
  ON financial_ledger_entries (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_financial_ledger_workspace_account
  ON financial_ledger_entries (workspace_id, account_code, currency, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_financial_ledger_group
  ON financial_ledger_entries (workspace_id, entry_group_id);

CREATE OR REPLACE FUNCTION prevent_financial_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Financial ledger entries are append-only'
    USING ERRCODE = '55000', CONSTRAINT = 'financial_ledger_append_only';
END;
$$;

DROP TRIGGER IF EXISTS trg_financial_ledger_append_only ON financial_ledger_entries;
CREATE TRIGGER trg_financial_ledger_append_only
  BEFORE UPDATE OR DELETE ON financial_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_financial_ledger_mutation();
