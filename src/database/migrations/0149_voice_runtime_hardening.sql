-- Harden voice evidence without storing audio bytes.
-- Client IDs make browser retries safe while workspace/user/session predicates
-- keep the existing tenant boundary authoritative.

ALTER TABLE ai_voice_sessions
  ADD COLUMN IF NOT EXISTS client_session_id UUID;

ALTER TABLE ai_voice_transcripts
  ADD COLUMN IF NOT EXISTS client_event_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_voice_sessions_client_session
  ON ai_voice_sessions (workspace_id, user_id, client_session_id)
  WHERE client_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_voice_transcripts_client_event
  ON ai_voice_transcripts (workspace_id, session_id, direction, client_event_id)
  WHERE client_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ai_voice_transcripts_retention
  ON ai_voice_transcripts (workspace_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ai_voice_sessions_retention
  ON ai_voice_sessions (workspace_id, created_at);

INSERT INTO data_retention_policies (
  data_class, table_name, timestamp_column, retention_days,
  disposition, legal_hold_required, enabled
)
VALUES ('voice_sessions', 'ai_voice_sessions', 'created_at', 90, 'DELETE', TRUE, FALSE)
ON CONFLICT DO NOTHING;
