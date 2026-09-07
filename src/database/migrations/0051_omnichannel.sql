-- Part 5: canonical OmniChannel foundation.  Legacy email and provider tables
-- remain intact; these tables provide one tenant-safe conversation model.

CREATE TABLE IF NOT EXISTS omni_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_type TEXT NOT NULL CHECK (channel_type IN ('EMAIL','WEBSITE_CHAT','WHATSAPP','FACEBOOK_MESSENGER','INSTAGRAM','WECHAT','SMS','OTHER')),
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNAVAILABLE' CHECK (status IN ('ACTIVE','INACTIVE','ERROR','UNAVAILABLE')),
  display_name TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel_type, provider),
  CHECK (jsonb_typeof(capabilities) = 'object')
);

CREATE TABLE IF NOT EXISTS omni_channel_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES omni_channels(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_connection_id UUID REFERENCES provider_connections(id) ON DELETE SET NULL,
  provider_account_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
  website_id UUID REFERENCES workspace_sites(id) ON DELETE CASCADE,
  identity_type TEXT NOT NULL,
  external_identity_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'CUSTOMER_OWNED' CHECK (mode IN ('LULU_MANAGED','CUSTOMER_OWNED','PARTNER_MANAGED','HYBRID')),
  status TEXT NOT NULL DEFAULT 'AUTHORIZATION_REQUIRED' CHECK (status IN ('ACTIVE','CONNECTING','AUTHORIZATION_REQUIRED','ERROR','DISCONNECTED','SUSPENDED')),
  region TEXT,
  default_language TEXT,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel_id, external_identity_id),
  CHECK (jsonb_typeof(capabilities) = 'object'),
  CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_omni_identity_workspace ON omni_channel_identities(workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_omni_identity_website ON omni_channel_identities(website_id);

CREATE TABLE IF NOT EXISTS omni_website_chat_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  website_id UUID NOT NULL REFERENCES workspace_sites(id) ON DELETE CASCADE,
  channel_identity_id UUID NOT NULL UNIQUE REFERENCES omni_channel_identities(id) ON DELETE CASCADE,
  public_widget_id TEXT NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', ''),
  welcome_message TEXT NOT NULL DEFAULT 'Hello! How can we help you today?',
  supported_languages TEXT[] NOT NULL DEFAULT '{en}',
  default_language TEXT NOT NULL DEFAULT 'en',
  ai_handling_mode TEXT NOT NULL DEFAULT 'AI_AUTO' CHECK (ai_handling_mode IN ('AI_AUTO','AI_ASSISTED','HUMAN','ESCALATED')),
  allowed_origins TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','ERROR')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, website_id)
);
CREATE INDEX IF NOT EXISTS idx_omni_widget_public_id ON omni_website_chat_identities(public_widget_id);

CREATE TABLE IF NOT EXISTS omni_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES omni_channels(id),
  channel_identity_id UUID NOT NULL REFERENCES omni_channel_identities(id),
  party_id UUID,
  lead_id UUID,
  opportunity_id UUID,
  quote_id UUID,
  order_id UUID,
  primary_product_id UUID,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACTIVE','WAITING_CUSTOMER','WAITING_LULU','ESCALATED','RESOLVED','CLOSED','SPAM')),
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  handling_mode TEXT NOT NULL DEFAULT 'AI_AUTO' CHECK (handling_mode IN ('AI_AUTO','AI_ASSISTED','HUMAN','ESCALATED')),
  language TEXT,
  subject TEXT,
  assigned_user_id UUID,
  assigned_agent_id UUID,
  last_message_at TIMESTAMPTZ,
  first_message_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, primary_product_id) REFERENCES products(workspace_id, id) ON DELETE SET NULL,
  CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_omni_conversations_workspace ON omni_conversations(workspace_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_omni_conversations_filters ON omni_conversations(workspace_id, status, handling_mode, assigned_user_id);

CREATE OR REPLACE FUNCTION validate_omni_conversation_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity_workspace UUID; identity_channel UUID;
BEGIN
  SELECT workspace_id, channel_id INTO identity_workspace, identity_channel FROM omni_channel_identities WHERE id=NEW.channel_identity_id;
  IF identity_channel IS NULL OR identity_channel <> NEW.channel_id THEN RAISE EXCEPTION 'Conversation channel identity mismatch' USING ERRCODE='23514'; END IF;
  -- Shared platform identities are routed explicitly; workspace-owned identities are strict.
  IF identity_workspace IS NOT NULL AND identity_workspace <> NEW.workspace_id THEN RAISE EXCEPTION 'Conversation identity belongs to another workspace' USING ERRCODE='23514'; END IF;
  IF NEW.assigned_user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=NEW.assigned_user_id) THEN RAISE EXCEPTION 'Conversation assignee is not a workspace member' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_validate_omni_conversation_scope ON omni_conversations;
CREATE TRIGGER trg_validate_omni_conversation_scope BEFORE INSERT OR UPDATE ON omni_conversations FOR EACH ROW EXECUTE FUNCTION validate_omni_conversation_scope();

CREATE TABLE IF NOT EXISTS omni_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  channel_id UUID NOT NULL REFERENCES omni_channels(id),
  channel_identity_id UUID NOT NULL REFERENCES omni_channel_identities(id),
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND','INTERNAL')),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('BUYER','USER','AI_AGENT','SYSTEM','PROVIDER')),
  sender_party_id UUID,
  sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  sender_agent_id UUID,
  provider_message_id TEXT,
  client_message_id TEXT,
  message_type TEXT NOT NULL DEFAULT 'TEXT' CHECK (message_type IN ('TEXT','IMAGE','FILE','AUDIO','VIDEO','LOCATION','CONTACT','TEMPLATE','SYSTEM','INTERNAL_NOTE')),
  text_content TEXT,
  status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('QUEUED','SENDING','SENT','DELIVERED','READ','FAILED','RECEIVED')),
  reply_to_message_id UUID,
  sent_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES omni_conversations(workspace_id, id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK ((message_type = 'INTERNAL_NOTE' AND direction = 'INTERNAL') OR message_type <> 'INTERNAL_NOTE'),
  CHECK ((direction = 'INTERNAL' AND message_type = 'INTERNAL_NOTE') OR direction <> 'INTERNAL'
         OR sender_type IN ('SYSTEM','USER','AI_AGENT'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_omni_message_provider_id ON omni_messages(channel_identity_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_omni_message_client_id ON omni_messages(conversation_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_omni_messages_conversation ON omni_messages(workspace_id, conversation_id, created_at);

CREATE TABLE IF NOT EXISTS omni_message_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  message_id UUID NOT NULL,
  media_type TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  storage_reference TEXT NOT NULL,
  provider_media_id TEXT,
  status TEXT NOT NULL DEFAULT 'READY' CHECK (status IN ('PENDING','READY','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, message_id) REFERENCES omni_messages(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS omni_conversation_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  participant_type TEXT NOT NULL CHECK (participant_type IN ('PARTY','CONTACT','USER','AI_AGENT','SYSTEM')),
  participant_key TEXT NOT NULL,
  display_name TEXT,
  role TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES omni_conversations(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (conversation_id, participant_type, participant_key)
);

CREATE TABLE IF NOT EXISTS omni_routing_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_identity_id UUID NOT NULL REFERENCES omni_channel_identities(id) ON DELETE CASCADE,
  provider_message_id TEXT,
  conversation_id UUID,
  resolved_workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW','UNRESOLVED')),
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision_source TEXT NOT NULL CHECK (decision_source IN ('DETERMINISTIC','HISTORY','USER_SELECTION','ADMIN','AI_SUGGESTION')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RESOLVED','REJECTED')),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel_identity_id, provider_message_id)
);

CREATE TABLE IF NOT EXISTS omni_routing_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_identity_id UUID NOT NULL REFERENCES omni_channel_identities(id) ON DELETE CASCADE,
  provider_event_id TEXT,
  provider_message_id TEXT,
  external_sender_key TEXT,
  message_preview TEXT,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence TEXT NOT NULL DEFAULT 'UNRESOLVED' CHECK (confidence IN ('HIGH','MEDIUM','LOW','UNRESOLVED')),
  reason TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'UNRESOLVED' CHECK (status IN ('UNRESOLVED','ASSIGNED','SPAM','FAILED')),
  resolved_workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (channel_identity_id, provider_message_id)
);

CREATE TABLE IF NOT EXISTS omni_website_chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  website_chat_identity_id UUID NOT NULL REFERENCES omni_website_chat_identities(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  conversation_id UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  visitor_id TEXT,
  email TEXT,
  phone TEXT,
  company TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES omni_conversations(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_omni_sessions_expiry ON omni_website_chat_sessions(expires_at);

CREATE TABLE IF NOT EXISTS omni_follow_up_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  channel_type TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  business_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','PAUSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO omni_channels (channel_type, provider, display_name, status, capabilities) VALUES
 ('WEBSITE_CHAT','lulu','Website Chat','ACTIVE','{"messages.read":true,"messages.send":true,"messages.inbound_webhook":true}'::jsonb),
 ('EMAIL','email','Email','UNAVAILABLE','{"messages.read":false,"messages.send":false}'::jsonb),
 ('WHATSAPP','meta','WhatsApp','UNAVAILABLE','{}'::jsonb),
 ('FACEBOOK_MESSENGER','meta','Facebook Messenger','UNAVAILABLE','{}'::jsonb),
 ('INSTAGRAM','meta','Instagram Messaging','UNAVAILABLE','{}'::jsonb),
 ('WECHAT','wechat','WeChat','UNAVAILABLE','{}'::jsonb),
 ('SMS','sms','SMS','UNAVAILABLE','{}'::jsonb)
ON CONFLICT (channel_type, provider) DO NOTHING;

DROP TRIGGER IF EXISTS trg_omni_channels_updated_at ON omni_channels;
CREATE TRIGGER trg_omni_channels_updated_at BEFORE UPDATE ON omni_channels FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_omni_identity_updated_at ON omni_channel_identities;
CREATE TRIGGER trg_omni_identity_updated_at BEFORE UPDATE ON omni_channel_identities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_omni_widget_updated_at ON omni_website_chat_identities;
CREATE TRIGGER trg_omni_widget_updated_at BEFORE UPDATE ON omni_website_chat_identities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_omni_conversations_updated_at ON omni_conversations;
CREATE TRIGGER trg_omni_conversations_updated_at BEFORE UPDATE ON omni_conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_omni_follow_up_updated_at ON omni_follow_up_policies;
CREATE TRIGGER trg_omni_follow_up_updated_at BEFORE UPDATE ON omni_follow_up_policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- New/changed rows cannot mix a website or identity from another workspace.
CREATE OR REPLACE FUNCTION validate_omni_website_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE site_workspace UUID; identity_workspace UUID; channel_type TEXT;
BEGIN
  SELECT workspace_id INTO site_workspace FROM workspace_sites WHERE id = NEW.website_id;
  IF site_workspace IS NULL OR site_workspace <> NEW.workspace_id THEN RAISE EXCEPTION 'Website does not belong to workspace' USING ERRCODE='23514'; END IF;
  SELECT ci.workspace_id, c.channel_type INTO identity_workspace, channel_type
    FROM omni_channel_identities ci JOIN omni_channels c ON c.id=ci.channel_id WHERE ci.id=NEW.channel_identity_id;
  IF channel_type <> 'WEBSITE_CHAT' OR (identity_workspace IS NOT NULL AND identity_workspace <> NEW.workspace_id) THEN RAISE EXCEPTION 'Invalid website chat identity' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_validate_omni_website_identity ON omni_website_chat_identities;
CREATE TRIGGER trg_validate_omni_website_identity BEFORE INSERT OR UPDATE ON omni_website_chat_identities FOR EACH ROW EXECUTE FUNCTION validate_omni_website_identity();

CREATE OR REPLACE FUNCTION validate_omni_message_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c_workspace UUID; c_channel UUID; c_identity UUID; member_exists BOOLEAN;
BEGIN
  SELECT workspace_id, channel_id, channel_identity_id INTO c_workspace,c_channel,c_identity FROM omni_conversations WHERE id=NEW.conversation_id;
  IF c_workspace IS NULL OR c_workspace <> NEW.workspace_id OR c_channel <> NEW.channel_id OR c_identity <> NEW.channel_identity_id THEN RAISE EXCEPTION 'Message scope does not match conversation' USING ERRCODE='23514'; END IF;
  IF NEW.sender_user_id IS NOT NULL THEN SELECT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=NEW.workspace_id AND user_id=NEW.sender_user_id AND role IS NOT NULL) INTO member_exists; IF NOT member_exists THEN RAISE EXCEPTION 'Message sender is not a workspace member' USING ERRCODE='23514'; END IF; END IF;
  IF NEW.direction = 'INTERNAL' AND NEW.message_type <> 'INTERNAL_NOTE' THEN RAISE EXCEPTION 'Internal messages must be notes' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_validate_omni_message_scope ON omni_messages;
CREATE TRIGGER trg_validate_omni_message_scope BEFORE INSERT OR UPDATE ON omni_messages FOR EACH ROW EXECUTE FUNCTION validate_omni_message_scope();

-- Provision the dedicated website identity for existing and newly-created Lulu sites.
INSERT INTO omni_channel_identities(channel_id,workspace_id,website_id,identity_type,external_identity_id,display_name,mode,status,default_language,capabilities)
SELECT c.id,s.workspace_id,s.id,'WEBSITE','website:'||s.id,'Website Chat',CASE WHEN s.ownership_mode='managed' THEN 'LULU_MANAGED' ELSE 'CUSTOMER_OWNED' END,'ACTIVE','en','{"messages.read":true,"messages.send":true,"messages.inbound_webhook":true}'::jsonb
FROM workspace_sites s JOIN omni_channels c ON c.channel_type='WEBSITE_CHAT' AND c.provider='lulu'
ON CONFLICT(channel_id,external_identity_id) DO NOTHING;
INSERT INTO omni_website_chat_identities(workspace_id,website_id,channel_identity_id)
SELECT s.workspace_id,s.id,ci.id FROM workspace_sites s JOIN omni_channel_identities ci ON ci.website_id=s.id
JOIN omni_channels c ON c.id=ci.channel_id AND c.channel_type='WEBSITE_CHAT'
ON CONFLICT(workspace_id,website_id) DO NOTHING;

CREATE OR REPLACE FUNCTION provision_omni_website_chat() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE channel UUID; identity UUID;
BEGIN
  SELECT id INTO channel FROM omni_channels WHERE channel_type='WEBSITE_CHAT' AND provider='lulu';
  IF channel IS NULL THEN RETURN NEW; END IF;
  INSERT INTO omni_channel_identities(channel_id,workspace_id,website_id,identity_type,external_identity_id,display_name,mode,status,default_language,capabilities)
    VALUES(channel,NEW.workspace_id,NEW.id,'WEBSITE','website:'||NEW.id,'Website Chat',CASE WHEN NEW.ownership_mode='managed' THEN 'LULU_MANAGED' ELSE 'CUSTOMER_OWNED' END,'ACTIVE','en','{"messages.read":true,"messages.send":true,"messages.inbound_webhook":true}'::jsonb)
    ON CONFLICT(channel_id,external_identity_id) DO UPDATE SET updated_at=NOW() RETURNING id INTO identity;
  INSERT INTO omni_website_chat_identities(workspace_id,website_id,channel_identity_id) VALUES(NEW.workspace_id,NEW.id,identity) ON CONFLICT(workspace_id,website_id) DO NOTHING;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_provision_omni_website_chat ON workspace_sites;
CREATE TRIGGER trg_provision_omni_website_chat AFTER INSERT ON workspace_sites FOR EACH ROW EXECUTE FUNCTION provision_omni_website_chat();
