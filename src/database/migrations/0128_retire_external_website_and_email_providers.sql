-- Retire legacy external website/shop platforms.
-- Historical rows remain auditable, but no new connection, sync, publish or
-- generation operation may use these providers. Lulu now owns the website and
-- storefront runtime directly.

UPDATE provider_registry
   SET implementation_status = 'UNAVAILABLE',
       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('retired', true, 'retiredAt', NOW(), 'replacement', 'lulu_managed_website'),
       updated_at = NOW()
 WHERE provider_key IN ('wordpress', 'webflow', 'shopify', 'resend');

UPDATE provider_connections
   SET status = 'UNAVAILABLE',
       authorization_state = 'NOT_AUTHORIZED',
       health_status = 'DISCONNECTED',
       health_reason = 'Provider retired; use Lulu managed Website and Shop.',
       last_error = 'PROVIDER_RETIRED',
       updated_at = NOW()
 WHERE provider_key IN ('wordpress', 'webflow', 'shopify', 'resend');

UPDATE workspace_platforms
   SET connection_status = 'disconnected',
       last_error = 'Provider retired; use Lulu managed Website and Shop.',
       updated_at = NOW()
 WHERE integration_key IN ('wordpress', 'webflow', 'shopify', 'resend')
   AND deleted_at IS NULL;

UPDATE website_generation_jobs
   SET status = 'cancelled',
       error_code = 'PROVIDER_RETIRED',
       error_message = 'The external website provider was retired. Create a Lulu managed website instead.',
       updated_at = NOW()
 WHERE site_id IN (SELECT id FROM workspace_sites WHERE provider IN ('wordpress', 'webflow'))
   AND status IN ('queued', 'planning', 'generated', 'preview', 'publishing');

UPDATE workspace_sites
   SET status = 'disconnected',
       updated_at = NOW()
 WHERE provider IN ('wordpress', 'webflow');
