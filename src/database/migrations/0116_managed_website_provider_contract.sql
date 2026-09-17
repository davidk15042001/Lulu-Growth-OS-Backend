-- Promote Lulu's own managed website from a catalog-only row to a real
-- provider-control adapter contract. The adapter reads canonical website
-- state; it never fabricates a connected provider or publishes during probes.

UPDATE provider_registry
   SET implementation_status='IMPLEMENTED',
       default_mode='LULU_MANAGED',
       updated_at=NOW()
 WHERE provider_key='lulu_managed_website';

INSERT INTO provider_capability_definitions(provider_key, capability_key, display_name, required_scopes, default_status)
VALUES
  ('lulu_managed_website','website.site.read','Read managed website','{}','AVAILABLE'),
  ('lulu_managed_website','website.site.preview','Read managed website preview','{}','AVAILABLE'),
  ('lulu_managed_website','website.site.publish','Publish verified managed website plan','{}','AVAILABLE'),
  ('lulu_managed_website','website.domain.verify','Verify managed website domain ownership','{}','AVAILABLE')
ON CONFLICT (provider_key, capability_key) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  required_scopes=EXCLUDED.required_scopes,
  default_status=EXCLUDED.default_status;
