-- Make the collaboration ledger's run and step references impossible to mix
-- across runs, and retain a durable acknowledgement for advisory Zep mirroring.

ALTER TABLE agent_collaboration_threads
  ADD CONSTRAINT agent_collaboration_threads_workspace_id_id_run_id_key
  UNIQUE (workspace_id, id, run_id);

ALTER TABLE agent_collaboration_messages
  ADD COLUMN zep_synced_at TIMESTAMPTZ;

ALTER TABLE agent_collaboration_messages
  ADD CONSTRAINT agent_collaboration_messages_thread_run_scope_fkey
  FOREIGN KEY (workspace_id, thread_id, run_id)
  REFERENCES agent_collaboration_threads(workspace_id, id, run_id)
  ON DELETE CASCADE;

CREATE INDEX agent_collaboration_messages_unsynced_idx
  ON agent_collaboration_messages(workspace_id, run_id, created_at ASC, id ASC)
  WHERE zep_synced_at IS NULL;

CREATE OR REPLACE FUNCTION validate_agent_collaboration_step_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.step_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM agent_run_steps
    WHERE id = NEW.step_id
      AND workspace_id = NEW.workspace_id
      AND run_id = NEW.run_id
  ) THEN
    RAISE EXCEPTION 'Agent collaboration step must belong to the same workspace and run'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_collaboration_messages_step_scope_guard
BEFORE INSERT OR UPDATE OF workspace_id, run_id, step_id
ON agent_collaboration_messages
FOR EACH ROW EXECUTE FUNCTION validate_agent_collaboration_step_scope();
