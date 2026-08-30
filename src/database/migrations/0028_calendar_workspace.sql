CREATE TABLE IF NOT EXISTS calendar_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft', 'calendly', 'calcom')),
  external_account_id TEXT,
  email_address TEXT,
  display_name TEXT,
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  encrypted_api_key TEXT,
  base_url TEXT,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'syncing', 'reauth_required', 'error', 'disconnected')),
  last_sync_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(settings) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_calendar_accounts_workspace
  ON calendar_accounts(workspace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_calendar_accounts_provider
  ON calendar_accounts(workspace_id, provider, status);

CREATE TABLE IF NOT EXISTS calendar_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
  provider_event_id TEXT NOT NULL,
  source_id TEXT,
  source_name TEXT,
  title TEXT NOT NULL,
  description TEXT,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  timezone TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed',
  location TEXT,
  meeting_url TEXT,
  organizer_name TEXT,
  organizer_email TEXT,
  attendee_count INTEGER NOT NULL DEFAULT 0 CHECK (attendee_count >= 0),
  attendees JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, provider_event_id),
  CHECK (jsonb_typeof(attendees) = 'array'),
  CHECK (jsonb_typeof(raw_data) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_account_start
  ON calendar_events(account_id, start_at ASC);

CREATE INDEX IF NOT EXISTS idx_calendar_events_source
  ON calendar_events(account_id, source_name, start_at ASC);

CREATE TABLE IF NOT EXISTS calendar_sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES calendar_accounts(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  events_synced INTEGER NOT NULL DEFAULT 0 CHECK (events_synced >= 0),
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_sync_jobs_one_active
  ON calendar_sync_jobs(account_id) WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_calendar_sync_jobs_workspace
  ON calendar_sync_jobs(workspace_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_calendar_accounts_set_updated_at ON calendar_accounts;
CREATE TRIGGER trg_calendar_accounts_set_updated_at
  BEFORE UPDATE ON calendar_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_calendar_events_set_updated_at ON calendar_events;
CREATE TRIGGER trg_calendar_events_set_updated_at
  BEFORE UPDATE ON calendar_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_calendar_sync_jobs_set_updated_at ON calendar_sync_jobs;
CREATE TRIGGER trg_calendar_sync_jobs_set_updated_at
  BEFORE UPDATE ON calendar_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
