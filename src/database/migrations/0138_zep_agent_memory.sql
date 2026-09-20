-- Zep is an optional agent-memory layer. Lulu/Postgres remains the source of
-- truth; this column stores only the external memory-thread identifier.

ALTER TABLE ai_conversations
  ADD COLUMN IF NOT EXISTS zep_thread_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ai_conversations_zep_thread_unique
  ON ai_conversations(workspace_id, zep_thread_id)
  WHERE zep_thread_id IS NOT NULL;
