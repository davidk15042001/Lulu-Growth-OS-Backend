-- UnifyPort platform messaging transport.
-- The API key remains in the runtime environment; this catalog entry only
-- describes the provider and its truthful capability states.

INSERT INTO provider_registry(provider_key, display_name, category, implementation_status, default_mode)
VALUES ('unifyport', 'UnifyPort', 'MESSAGING', 'PARTIAL', 'LULU_MANAGED')
ON CONFLICT (provider_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  implementation_status = EXCLUDED.implementation_status,
  default_mode = EXCLUDED.default_mode,
  updated_at = NOW();

INSERT INTO provider_capability_definitions(provider_key, capability_key, display_name, required_scopes, default_status)
VALUES
  ('unifyport', 'unifyport.workspace.read', 'Read UnifyPort workspace', '{}', 'AUTHORIZATION_REQUIRED'),
  ('unifyport', 'unifyport.accounts.read', 'Read channel accounts', '{}', 'AUTHORIZATION_REQUIRED'),
  ('unifyport', 'unifyport.accounts.manage', 'Manage channel accounts', '{}', 'AUTHORIZATION_REQUIRED'),
  ('unifyport', 'unifyport.messages.send', 'Send channel messages', '{}', 'UNCONFIRMED'),
  ('unifyport', 'unifyport.messages.read', 'Receive channel messages', '{}', 'UNCONFIRMED')
ON CONFLICT (provider_key, capability_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  required_scopes = EXCLUDED.required_scopes,
  default_status = EXCLUDED.default_status;
