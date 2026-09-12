-- Multi-tenant Twilio WhatsApp routing.
-- Lulu owns one platform sender that is available as the default transport.
-- Workspaces may additionally receive an isolated Twilio subaccount and sender
-- after an administrator explicitly enables WhatsApp self-service.

CREATE TABLE IF NOT EXISTS twilio_platform_configuration (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  admin_whatsapp_identity_id UUID UNIQUE REFERENCES omni_channel_identities(id) ON DELETE SET NULL,
  configured_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS twilio_workspace_accounts (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  twilio_account_sid TEXT NOT NULL UNIQUE CHECK (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  encrypted_auth_token TEXT NOT NULL,
  waba_id TEXT NOT NULL CHECK (char_length(trim(waba_id)) BETWEEN 1 AND 100),
  phone_number_id TEXT NOT NULL CHECK (char_length(trim(phone_number_id)) BETWEEN 1 AND 100),
  sender_sid TEXT CHECK (sender_sid IS NULL OR sender_sid ~ '^XE[0-9a-fA-F]{32}$'),
  sender_address TEXT NOT NULL UNIQUE CHECK (sender_address ~ '^whatsapp:\+[1-9][0-9]{6,14}$'),
  display_name TEXT NOT NULL CHECK (char_length(trim(display_name)) BETWEEN 1 AND 160),
  sender_status TEXT NOT NULL DEFAULT 'CREATING',
  content_sid TEXT CHECK (content_sid IS NULL OR content_sid ~ '^HX[0-9a-fA-F]{32}$'),
  content_approval_status TEXT,
  status TEXT NOT NULL DEFAULT 'PROVISIONING'
    CHECK (status IN ('PROVISIONING','CONNECTED','ERROR','DISABLED','DISCONNECTED')),
  last_error TEXT,
  connected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_twilio_workspace_account_status
  ON twilio_workspace_accounts(status, updated_at DESC);

-- A shared Lulu sender can legitimately converse with the same external phone
-- number on behalf of different tenants. Tenant scope must therefore be part
-- of the provider-thread identity.
DROP INDEX IF EXISTS idx_omni_conversation_provider_thread;
CREATE UNIQUE INDEX idx_omni_conversation_provider_thread
  ON omni_conversations(workspace_id, channel_identity_id, provider_thread_key)
  WHERE provider_thread_key IS NOT NULL;

DROP TRIGGER IF EXISTS trg_twilio_platform_configuration_set_updated_at ON twilio_platform_configuration;
CREATE TRIGGER trg_twilio_platform_configuration_set_updated_at
  BEFORE UPDATE ON twilio_platform_configuration
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_twilio_workspace_accounts_set_updated_at ON twilio_workspace_accounts;
CREATE TRIGGER trg_twilio_workspace_accounts_set_updated_at
  BEFORE UPDATE ON twilio_workspace_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The product is autonomous by definition. Preserve legacy columns for API
-- compatibility, but normalize all existing workspaces to the actual runtime
-- policy: no per-action human approvals; paid media is controlled by wallets.
ALTER TABLE workspace_ai_preferences ALTER COLUMN action_level SET DEFAULT 'automated';
ALTER TABLE workspace_ai_preferences ALTER COLUMN task_creation_mode SET DEFAULT 'auto';
ALTER TABLE workspace_ai_preferences ALTER COLUMN approval_preferences
  SET DEFAULT '{"marketing":"auto","advertising":"auto","content":"auto","website":"auto","product":"auto","customer_comms":"auto","automation":"auto","financial":"auto"}'::jsonb;

UPDATE workspace_ai_preferences
SET action_level='automated',
    task_creation_mode='auto',
    approval_preferences='{"marketing":"auto","advertising":"auto","content":"auto","website":"auto","product":"auto","customer_comms":"auto","automation":"auto","financial":"auto"}'::jsonb,
    approval_threshold=NULL,
    updated_at=NOW()
WHERE action_level <> 'automated'
   OR task_creation_mode <> 'auto'
   OR approval_preferences <> '{"marketing":"auto","advertising":"auto","content":"auto","website":"auto","product":"auto","customer_comms":"auto","automation":"auto","financial":"auto"}'::jsonb
   OR approval_threshold IS NOT NULL;
