-- External AI provider controls. Kie remains the default Lulu gateway; these
-- providers are available only through explicit, authenticated operations.
INSERT INTO provider_registry(provider_key, display_name, category, implementation_status, default_mode)
VALUES
  ('perplexity', 'Perplexity Research', 'RESEARCH', 'IMPLEMENTED', 'LULU_MANAGED'),
  ('composio', 'Composio', 'AUTOMATION', 'PARTIAL', 'LULU_MANAGED')
ON CONFLICT (provider_key) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  category=EXCLUDED.category,
  implementation_status=EXCLUDED.implementation_status,
  default_mode=EXCLUDED.default_mode,
  updated_at=NOW();

INSERT INTO provider_capability_definitions(provider_key, capability_key, display_name, required_scopes, default_status)
VALUES
  ('perplexity', 'perplexity.research.run', 'Run cited web research', '{}', 'AVAILABLE'),
  ('composio', 'composio.sessions.create', 'Create a tenant-scoped Composio tool session', '{}', 'UNCONFIRMED')
ON CONFLICT (provider_key, capability_key) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  required_scopes=EXCLUDED.required_scopes,
  default_status=EXCLUDED.default_status;
