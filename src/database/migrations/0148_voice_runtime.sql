-- Durable voice-session evidence. Audio bytes are never stored here; only
-- provider/session identifiers, transcripts, and bounded technical metadata.

CREATE TABLE IF NOT EXISTS ai_voice_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES ai_conversations(id) ON DELETE SET NULL,
  transport TEXT NOT NULL CHECK (transport IN ('webrtc', 'browser_fallback')),
  provider TEXT NOT NULL DEFAULT 'browser',
  provider_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'starting'
    CHECK (status IN ('starting', 'active', 'completed', 'failed', 'fallback')),
  language TEXT NOT NULL DEFAULT 'en-US',
  voice TEXT NOT NULL DEFAULT 'marin',
  speed NUMERIC(4, 2) NOT NULL DEFAULT 1.00 CHECK (speed >= 0.25 AND speed <= 1.50),
  mode TEXT NOT NULL DEFAULT 'conversation'
    CHECK (mode IN ('conversation', 'dictation')),
  metadata JSONB NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_ai_voice_sessions_workspace
  ON ai_voice_sessions (workspace_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ai_voice_sessions_conversation
  ON ai_voice_sessions (workspace_id, conversation_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS ai_voice_transcripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES ai_voice_sessions(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES ai_conversations(id) ON DELETE SET NULL,
  direction TEXT NOT NULL CHECK (direction IN ('input', 'output')),
  content TEXT NOT NULL CHECK (char_length(trim(content)) BETWEEN 1 AND 100000),
  sequence_number INTEGER NOT NULL CHECK (sequence_number >= 0),
  is_final BOOLEAN NOT NULL DEFAULT TRUE,
  source TEXT NOT NULL CHECK (source IN ('realtime', 'browser_fallback', 'server_tts', 'browser_tts')),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_ai_voice_transcripts_session
  ON ai_voice_transcripts (workspace_id, session_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_ai_voice_transcripts_conversation
  ON ai_voice_transcripts (workspace_id, conversation_id, created_at ASC, id ASC);

DROP TRIGGER IF EXISTS trg_ai_voice_sessions_updated_at ON ai_voice_sessions;
CREATE TRIGGER trg_ai_voice_sessions_updated_at
  BEFORE UPDATE ON ai_voice_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
