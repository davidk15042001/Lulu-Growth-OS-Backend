-- Close remaining cross-workspace reference gaps without rewriting historical
-- data. NOT VALID keeps deployment safe; new and changed rows are enforced.

-- Owner reassignment is also a protected owner change. The trigger from 0049
-- previously covered role updates/deletes, but not a direct user/workspace
-- reassignment on an owner row.
CREATE OR REPLACE FUNCTION prevent_workspace_last_owner_loss()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  owner_count INTEGER;
BEGIN
  -- A cascading workspace deletion is an intentional tenant teardown.
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE'
     OR (TG_OP = 'UPDATE'
         AND OLD.role = 'owner'
         AND (NEW.role <> 'owner'
              OR NEW.user_id <> OLD.user_id
              OR NEW.workspace_id <> OLD.workspace_id)) THEN
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
  BEFORE UPDATE OR DELETE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION prevent_workspace_last_owner_loss();

-- Assignees and relationship authors must belong to the same workspace. Parent,
-- source and target record constraints already exist from Part 2 and are
-- intentionally reused instead of adding duplicate foreign keys.
ALTER TABLE workspace_records
  DROP CONSTRAINT IF EXISTS workspace_records_assignee_workspace_fk;
ALTER TABLE workspace_records
  ADD CONSTRAINT workspace_records_assignee_workspace_fk
  FOREIGN KEY (workspace_id, assignee_id)
  REFERENCES workspace_members (workspace_id, user_id)
  ON DELETE SET NULL NOT VALID;
ALTER TABLE record_relationships
  DROP CONSTRAINT IF EXISTS record_relationships_creator_workspace_fk;
ALTER TABLE record_relationships
  ADD CONSTRAINT record_relationships_creator_workspace_fk
  FOREIGN KEY (workspace_id, created_by)
  REFERENCES workspace_members (workspace_id, user_id)
  ON DELETE RESTRICT NOT VALID;
