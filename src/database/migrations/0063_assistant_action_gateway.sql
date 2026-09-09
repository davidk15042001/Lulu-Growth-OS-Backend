-- Persist every Assistant write before execution. The browser may reference a
-- server-created request id, but it can no longer submit an arbitrary action
-- payload directly to a side-effecting service.
ALTER TABLE ai_conversations
  ADD CONSTRAINT ai_conversations_tenant_actor_identity
  UNIQUE (id, workspace_id, user_id);

CREATE TABLE assistant_action_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 3 AND 500),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('pending_approval','ready','executing','succeeded','failed','rejected','cancelled','expired')),
  approval_id UUID UNIQUE REFERENCES approval_requests(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  result JSONB CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  error_code TEXT,
  error_message TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT assistant_action_conversation_actor_fk
    FOREIGN KEY (conversation_id, workspace_id, requested_by)
    REFERENCES ai_conversations(id, workspace_id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT assistant_action_idempotency_unique UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX assistant_action_requests_queue_idx
  ON assistant_action_requests(status, created_at)
  WHERE status IN ('ready','executing');
CREATE INDEX assistant_action_requests_conversation_idx
  ON assistant_action_requests(workspace_id, requested_by, conversation_id, created_at DESC);
CREATE UNIQUE INDEX approval_requests_assistant_action_unique
  ON approval_requests(workspace_id, action_type, entity_id)
  WHERE action_type = 'agent_assistant_action' AND entity_id IS NOT NULL;

CREATE FUNCTION protect_assistant_action_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.action_type IS DISTINCT FROM OLD.action_type
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR (OLD.approval_id IS NOT NULL AND NEW.approval_id IS DISTINCT FROM OLD.approval_id) THEN
    RAISE EXCEPTION 'Assistant action identity and authorization data are immutable';
  END IF;
  NEW.updated_at = NOW();
  RETURN NEW;
END; $$;

CREATE TRIGGER assistant_action_requests_identity_immutable
  BEFORE UPDATE ON assistant_action_requests
  FOR EACH ROW EXECUTE FUNCTION protect_assistant_action_identity();
