CREATE TABLE IF NOT EXISTS email_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft', 'imap')),
  email_address TEXT NOT NULL,
  display_name TEXT,
  encrypted_access_token TEXT,
  encrypted_refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  encrypted_password TEXT,
  imap_host TEXT,
  imap_port INTEGER CHECK (imap_port IS NULL OR imap_port BETWEEN 1 AND 65535),
  imap_secure BOOLEAN NOT NULL DEFAULT TRUE,
  smtp_host TEXT,
  smtp_port INTEGER CHECK (smtp_port IS NULL OR smtp_port BETWEEN 1 AND 65535),
  smtp_secure BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'syncing', 'reauth_required', 'error', 'disconnected')),
  sync_cursor TEXT,
  last_sync_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, provider, email_address)
);

CREATE INDEX IF NOT EXISTS idx_email_accounts_workspace ON email_accounts(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS email_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  provider_folder_id TEXT NOT NULL,
  parent_provider_folder_id TEXT,
  name TEXT NOT NULL,
  system_name TEXT,
  unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  total_count INTEGER NOT NULL DEFAULT 0 CHECK (total_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, provider_folder_id)
);

CREATE INDEX IF NOT EXISTS idx_email_folders_account ON email_folders(account_id, name);

CREATE TABLE IF NOT EXISTS email_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  provider_thread_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '(No subject)',
  preview TEXT NOT NULL DEFAULT '',
  participant_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
  folder_provider_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  latest_at TIMESTAMPTZ NOT NULL,
  unread BOOLEAN NOT NULL DEFAULT FALSE,
  starred BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, provider_thread_id),
  CHECK (jsonb_typeof(participant_emails) = 'array'),
  CHECK (jsonb_typeof(folder_provider_ids) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_email_threads_account_latest ON email_threads(account_id, latest_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_threads_unread ON email_threads(account_id, unread, latest_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_threads_folders ON email_threads USING GIN(folder_provider_ids);

CREATE TABLE IF NOT EXISTS email_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
  provider_message_id TEXT NOT NULL,
  internet_message_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender JSONB NOT NULL DEFAULT '{}'::jsonb,
  recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc_recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject TEXT NOT NULL DEFAULT '(No subject)',
  text_body TEXT NOT NULL DEFAULT '',
  html_body TEXT,
  provider_folder_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  received_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  starred BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, provider_message_id),
  CHECK (jsonb_typeof(sender) = 'object'),
  CHECK (jsonb_typeof(recipients) = 'array'),
  CHECK (jsonb_typeof(cc_recipients) = 'array'),
  CHECK (jsonb_typeof(provider_folder_ids) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_email_messages_thread ON email_messages(thread_id, COALESCE(received_at, sent_at, created_at));

CREATE TABLE IF NOT EXISTS email_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  thread_id UUID REFERENCES email_threads(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'ai', 'automation')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent', 'failed')),
  to_recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc_recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  reply_to_provider_message_id TEXT,
  provider_message_id TEXT,
  ai_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(to_recipients) = 'array'),
  CHECK (jsonb_typeof(cc_recipients) = 'array'),
  CHECK (jsonb_typeof(ai_metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_email_drafts_workspace ON email_drafts(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS email_automation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id UUID REFERENCES email_accounts(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_run_at TIMESTAMPTZ,
  run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(conditions) = 'object'),
  CHECK (jsonb_typeof(actions) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_email_automation_rules_workspace ON email_automation_rules(workspace_id, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS email_automation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_id UUID NOT NULL REFERENCES email_automation_rules(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(rule_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_email_automation_runs_workspace ON email_automation_runs(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS email_sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  folders_synced INTEGER NOT NULL DEFAULT 0,
  messages_synced INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sync_jobs_one_active
  ON email_sync_jobs(account_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_email_sync_jobs_workspace ON email_sync_jobs(workspace_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_email_accounts_set_updated_at ON email_accounts;
CREATE TRIGGER trg_email_accounts_set_updated_at BEFORE UPDATE ON email_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_email_folders_set_updated_at ON email_folders;
CREATE TRIGGER trg_email_folders_set_updated_at BEFORE UPDATE ON email_folders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_email_threads_set_updated_at ON email_threads;
CREATE TRIGGER trg_email_threads_set_updated_at BEFORE UPDATE ON email_threads FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_email_messages_set_updated_at ON email_messages;
CREATE TRIGGER trg_email_messages_set_updated_at BEFORE UPDATE ON email_messages FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_email_drafts_set_updated_at ON email_drafts;
CREATE TRIGGER trg_email_drafts_set_updated_at BEFORE UPDATE ON email_drafts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_email_automation_rules_set_updated_at ON email_automation_rules;
CREATE TRIGGER trg_email_automation_rules_set_updated_at BEFORE UPDATE ON email_automation_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_email_sync_jobs_set_updated_at ON email_sync_jobs;
CREATE TRIGGER trg_email_sync_jobs_set_updated_at BEFORE UPDATE ON email_sync_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
