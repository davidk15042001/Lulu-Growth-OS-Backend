-- Durable, tenant-scoped coordination for the agents that participate in one
-- real run. This is an evidence ledger, not a second execution path: agent
-- commands continue through the canonical action-packet workflow.

CREATE TABLE IF NOT EXISTS agent_collaboration_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  company_brain_task_id UUID,
  topic TEXT NOT NULL CHECK (char_length(trim(topic)) BETWEEN 1 AND 4000),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','failed','cancelled')),
  zep_thread_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, run_id),
  FOREIGN KEY (workspace_id, company_brain_task_id)
    REFERENCES company_brain_tasks(workspace_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS agent_collaboration_threads_workspace_status_idx
  ON agent_collaboration_threads(workspace_id, status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS agent_collaboration_threads_zep_thread_uidx
  ON agent_collaboration_threads(workspace_id, zep_thread_id)
  WHERE zep_thread_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_collaboration_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL,
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_id UUID REFERENCES agent_run_steps(id) ON DELETE SET NULL,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('agent','system','human')),
  sender_agent_id TEXT,
  recipient_agent_id TEXT,
  message_type TEXT NOT NULL
    CHECK (message_type IN ('plan','status','evidence','handoff','proposal','challenge','decision','action','verification','error')),
  content TEXT NOT NULL CHECK (char_length(trim(content)) BETWEEN 1 AND 12000),
  structured_content JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(structured_content) = 'object'),
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_refs) = 'array'),
  confidence NUMERIC(6,5) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  idempotency_key TEXT NOT NULL CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, thread_id, idempotency_key),
  FOREIGN KEY (workspace_id, thread_id)
    REFERENCES agent_collaboration_threads(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS agent_collaboration_messages_thread_timeline_idx
  ON agent_collaboration_messages(workspace_id, thread_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS agent_collaboration_messages_run_timeline_idx
  ON agent_collaboration_messages(workspace_id, run_id, created_at DESC, id DESC);

DROP TRIGGER IF EXISTS agent_collaboration_threads_set_updated_at ON agent_collaboration_threads;
CREATE TRIGGER agent_collaboration_threads_set_updated_at
BEFORE UPDATE ON agent_collaboration_threads
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
