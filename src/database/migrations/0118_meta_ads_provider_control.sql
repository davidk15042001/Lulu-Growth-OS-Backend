INSERT INTO provider_registry (provider_key, display_name, category, implementation_status, default_mode)
VALUES ('meta', 'Meta', 'ADVERTISING', 'PARTIAL', 'LULU_MANAGED')
ON CONFLICT (provider_key) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  category=EXCLUDED.category,
  implementation_status=EXCLUDED.implementation_status,
  default_mode=EXCLUDED.default_mode,
  updated_at=NOW();

INSERT INTO provider_capability_definitions (provider_key, capability_key, display_name, required_scopes, default_status)
VALUES
  ('meta', 'meta.ads.read_spend', 'Read Meta Ads campaigns and spend', ARRAY['ads_read'], 'UNCONFIRMED'),
  ('meta', 'meta.ads.manage', 'Manage Meta Ads campaigns', ARRAY['ads_management','business_management'], 'PROVIDER_REVIEW')
ON CONFLICT (provider_key, capability_key) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  required_scopes=EXCLUDED.required_scopes,
  default_status=EXCLUDED.default_status;
