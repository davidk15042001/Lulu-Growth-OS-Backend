CREATE TABLE IF NOT EXISTS calendar_native_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  location TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled','completed')),
  agora_channel_name TEXT NOT NULL UNIQUE,
  guest_token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_at > start_at)
);

CREATE INDEX IF NOT EXISTS idx_calendar_native_events_workspace_start
  ON calendar_native_events(workspace_id, start_at ASC);

CREATE INDEX IF NOT EXISTS idx_calendar_native_events_workspace_status
  ON calendar_native_events(workspace_id, status, start_at ASC);

DROP TRIGGER IF EXISTS trg_calendar_native_events_set_updated_at ON calendar_native_events;
CREATE TRIGGER trg_calendar_native_events_set_updated_at
  BEFORE UPDATE ON calendar_native_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
