-- Google Analytics capability is only meaningful with the read-only scope that
-- permits GA4 Admin/Data API property discovery and reporting.
INSERT INTO provider_registry (provider_key, display_name, category, implementation_status, default_mode)
VALUES ('google_analytics', 'Google Analytics', 'ANALYTICS', 'PARTIAL', 'LULU_MANAGED')
ON CONFLICT (provider_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  implementation_status = EXCLUDED.implementation_status,
  default_mode = EXCLUDED.default_mode,
  updated_at = NOW();

INSERT INTO provider_capability_definitions (provider_key, capability_key, display_name, required_scopes, default_status)
VALUES ('google_analytics', 'google_analytics.reporting.read', 'Discover GA4 properties and read reporting data', ARRAY['https://www.googleapis.com/auth/analytics.readonly'], 'UNCONFIRMED')
ON CONFLICT (provider_key, capability_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  required_scopes = EXCLUDED.required_scopes,
  default_status = EXCLUDED.default_status;
