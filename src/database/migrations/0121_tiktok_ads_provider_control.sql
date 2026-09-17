-- TikTok Ads has a conservative read-only control-plane adapter. Campaign
-- mutations remain disabled until a provider review and the Lulu prepaid
-- advertising policy are both satisfied.
INSERT INTO provider_registry (provider_key, display_name, category, implementation_status, default_mode)
VALUES ('tiktok_ads', 'TikTok Ads', 'ADVERTISING', 'PARTIAL', 'LULU_MANAGED')
ON CONFLICT (provider_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  implementation_status = EXCLUDED.implementation_status,
  default_mode = EXCLUDED.default_mode,
  updated_at = NOW();

INSERT INTO provider_capability_definitions (provider_key, capability_key, display_name, required_scopes, default_status)
VALUES
  ('tiktok_ads', 'tiktok_ads.accounts.read', 'Read TikTok advertiser accounts', ARRAY['advertiser.read'], 'UNCONFIRMED'),
  ('tiktok_ads', 'tiktok_ads.spend.read', 'Read TikTok ad spend', ARRAY['ad.read'], 'UNCONFIRMED')
ON CONFLICT (provider_key, capability_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  required_scopes = EXCLUDED.required_scopes,
  default_status = EXCLUDED.default_status;
