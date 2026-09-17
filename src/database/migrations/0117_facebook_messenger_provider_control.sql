INSERT INTO provider_registry (provider_key, display_name, category, implementation_status, default_mode)
VALUES ('facebook_messenger', 'Facebook Messenger', 'MESSAGING', 'PARTIAL', 'LULU_MANAGED')
ON CONFLICT (provider_key) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  category=EXCLUDED.category,
  implementation_status=EXCLUDED.implementation_status,
  default_mode=EXCLUDED.default_mode,
  updated_at=NOW();

INSERT INTO provider_capability_definitions (provider_key, capability_key, display_name, required_scopes, default_status)
VALUES
  ('facebook_messenger', 'facebook_messenger.messages.send', 'Send Facebook Messenger messages', '{}', 'UNCONFIRMED'),
  ('facebook_messenger', 'facebook_messenger.messages.receive', 'Receive Facebook Messenger messages', '{}', 'UNCONFIRMED'),
  ('facebook_messenger', 'facebook_messenger.messages.status', 'Receive Messenger delivery status', '{}', 'UNCONFIRMED')
ON CONFLICT (provider_key, capability_key) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  required_scopes=EXCLUDED.required_scopes,
  default_status=EXCLUDED.default_status;

UPDATE omni_channels
   SET status='ACTIVE',
       capabilities='{"messages.read":true,"messages.send":true,"messages.inbound_webhook":true,"messages.delivery_status":true,"provider_beta":true}'::jsonb,
       updated_at=NOW()
 WHERE channel_type='FACEBOOK_MESSENGER' AND provider='twilio';
