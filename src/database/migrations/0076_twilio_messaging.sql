-- Replace the experimental UnifyPort transport with Twilio Programmable
-- Messaging. Existing UnifyPort audit data is retained but no longer active.

INSERT INTO provider_registry (provider_key, display_name, category, implementation_status, default_mode)
VALUES ('twilio', 'Twilio', 'MESSAGING', 'IMPLEMENTED', 'LULU_MANAGED')
ON CONFLICT (provider_key) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  category=EXCLUDED.category,
  implementation_status=EXCLUDED.implementation_status,
  default_mode=EXCLUDED.default_mode,
  updated_at=NOW();

UPDATE provider_registry SET implementation_status='UNAVAILABLE', updated_at=NOW() WHERE provider_key='unifyport';

INSERT INTO provider_capability_definitions (provider_key, capability_key, display_name, required_scopes, default_status)
VALUES
  ('twilio', 'twilio.messages.send', 'Send messages', '{}', 'AVAILABLE'),
  ('twilio', 'twilio.messages.receive', 'Receive messages', '{}', 'AVAILABLE'),
  ('twilio', 'twilio.messages.status', 'Receive delivery status', '{}', 'AVAILABLE')
ON CONFLICT (provider_key, capability_key) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  required_scopes=EXCLUDED.required_scopes,
  default_status=EXCLUDED.default_status;

INSERT INTO omni_channels (channel_type, provider, display_name, status, capabilities)
VALUES
  ('WHATSAPP','twilio','WhatsApp','ACTIVE','{"messages.read":true,"messages.send":true,"messages.inbound_webhook":true,"messages.delivery_status":true}'::jsonb),
  ('FACEBOOK_MESSENGER','twilio','Facebook Messenger','ACTIVE','{"messages.read":true,"messages.send":true,"messages.inbound_webhook":true,"messages.delivery_status":true,"provider_beta":true}'::jsonb)
ON CONFLICT (channel_type, provider) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  status=EXCLUDED.status,
  capabilities=EXCLUDED.capabilities,
  updated_at=NOW();

UPDATE omni_channels SET status='UNAVAILABLE', updated_at=NOW()
WHERE provider IN ('unifyport','meta') AND channel_type IN ('WHATSAPP','FACEBOOK_MESSENGER');

ALTER TABLE omni_conversations ADD COLUMN IF NOT EXISTS provider_thread_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_omni_conversation_provider_thread
  ON omni_conversations(channel_identity_id, provider_thread_key)
  WHERE provider_thread_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS omni_ai_reply_jobs (
  message_id UUID PRIMARY KEY REFERENCES omni_messages(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','WAITING_FUNDS','SUCCEEDED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY(workspace_id,conversation_id) REFERENCES omni_conversations(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_omni_ai_reply_jobs_ready ON omni_ai_reply_jobs(workspace_id,status,updated_at);

INSERT INTO omni_ai_reply_jobs(message_id,workspace_id,conversation_id,status)
SELECT m.id,m.workspace_id,m.conversation_id,'PENDING'
FROM omni_messages m JOIN omni_conversations c ON c.id=m.conversation_id AND c.workspace_id=m.workspace_id
WHERE m.direction='INBOUND' AND c.handling_mode='AI_AUTO'
  AND NOT EXISTS(SELECT 1 FROM omni_messages reply WHERE reply.conversation_id=m.conversation_id AND reply.client_message_id='auto-reply:'||m.id::text)
ON CONFLICT(message_id) DO NOTHING;
