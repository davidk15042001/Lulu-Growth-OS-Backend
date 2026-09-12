-- UnifyPort becomes Lulu's WhatsApp transport. Twilio remains active for
-- Facebook Messenger, while its WhatsApp channel stays stored for rollback.

INSERT INTO provider_registry(provider_key,display_name,category,implementation_status,default_mode)
VALUES('unifyport','UnifyPort (WhatsApp beta)','MESSAGING','PARTIAL','LULU_MANAGED')
ON CONFLICT(provider_key) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  category=EXCLUDED.category,
  implementation_status=EXCLUDED.implementation_status,
  default_mode=EXCLUDED.default_mode,
  updated_at=NOW();

INSERT INTO provider_capability_definitions(provider_key,capability_key,display_name,required_scopes,default_status)
VALUES
  ('unifyport','unifyport.workspace.read','Read UnifyPort workspace','{}','AVAILABLE'),
  ('unifyport','unifyport.accounts.read','Read WhatsApp accounts','{}','AVAILABLE'),
  ('unifyport','unifyport.accounts.manage','Manage WhatsApp accounts','{}','AVAILABLE'),
  ('unifyport','unifyport.messages.send','Send WhatsApp messages','{}','AVAILABLE'),
  ('unifyport','unifyport.messages.read','Receive WhatsApp messages','{}','AVAILABLE')
ON CONFLICT(provider_key,capability_key) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  required_scopes=EXCLUDED.required_scopes,
  default_status=EXCLUDED.default_status;

INSERT INTO omni_channels(channel_type,provider,display_name,status,capabilities)
VALUES('WHATSAPP','unifyport','WhatsApp','ACTIVE',
  '{"messages.read":true,"messages.send":true,"messages.inbound_webhook":true,"provider_beta":true,"provider_official_bsp":false}'::jsonb)
ON CONFLICT(channel_type,provider) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  status=EXCLUDED.status,
  capabilities=EXCLUDED.capabilities,
  updated_at=NOW();

CREATE TABLE IF NOT EXISTS unifyport_platform_configuration(
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  admin_whatsapp_identity_id UUID UNIQUE REFERENCES omni_channel_identities(id) ON DELETE SET NULL,
  configured_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_unifyport_platform_configuration_set_updated_at ON unifyport_platform_configuration;
CREATE TRIGGER trg_unifyport_platform_configuration_set_updated_at
  BEFORE UPDATE ON unifyport_platform_configuration
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
