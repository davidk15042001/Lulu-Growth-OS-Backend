-- Collaboration content is evidence. Once written, only the technical
-- acknowledgement that the advisory Zep mirror accepted it may change.

CREATE OR REPLACE FUNCTION prevent_agent_collaboration_message_rewrite()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.thread_id IS DISTINCT FROM OLD.thread_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.step_id IS DISTINCT FROM OLD.step_id
    OR NEW.sender_type IS DISTINCT FROM OLD.sender_type
    OR NEW.sender_agent_id IS DISTINCT FROM OLD.sender_agent_id
    OR NEW.recipient_agent_id IS DISTINCT FROM OLD.recipient_agent_id
    OR NEW.message_type IS DISTINCT FROM OLD.message_type
    OR NEW.content IS DISTINCT FROM OLD.content
    OR NEW.structured_content IS DISTINCT FROM OLD.structured_content
    OR NEW.evidence_refs IS DISTINCT FROM OLD.evidence_refs
    OR NEW.confidence IS DISTINCT FROM OLD.confidence
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Agent collaboration messages are append-only'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.zep_synced_at IS NOT NULL
    AND NEW.zep_synced_at IS DISTINCT FROM OLD.zep_synced_at THEN
    RAISE EXCEPTION 'Agent collaboration Zep acknowledgement is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_collaboration_messages_immutable
BEFORE UPDATE ON agent_collaboration_messages
FOR EACH ROW EXECUTE FUNCTION prevent_agent_collaboration_message_rewrite();
