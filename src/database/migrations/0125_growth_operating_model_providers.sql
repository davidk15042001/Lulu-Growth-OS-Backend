-- Master operating model provider declarations.
-- These rows document planned integrations only; runtime adapters must still
-- verify credentials, scopes, provider review and capability probes.
INSERT INTO provider_registry(provider_key, display_name, category, implementation_status, default_mode)
VALUES
  ('google_tag_manager','Google Tag Manager','MEASUREMENT','NOT_IMPLEMENTED','LULU_MANAGED'),
  ('google_search_console','Google Search Console','SEO','NOT_IMPLEMENTED','CUSTOMER_OWNED'),
  ('google_pagespeed','Google PageSpeed Insights','SEO','NOT_IMPLEMENTED','LULU_MANAGED'),
  ('google_merchant','Google Merchant Center','COMMERCE','NOT_IMPLEMENTED','CUSTOMER_OWNED'),
  ('google_local_services','Google Local Services Ads','ADVERTISING','NOT_IMPLEMENTED','CUSTOMER_OWNED'),
  ('bigquery','Google BigQuery','DATA','NOT_IMPLEMENTED','LULU_MANAGED'),
  ('perplexity','Perplexity Research','RESEARCH','NOT_IMPLEMENTED','LULU_MANAGED'),
  ('firecrawl','Firecrawl','RESEARCH','NOT_IMPLEMENTED','LULU_MANAGED'),
  ('higgsfield','Higgsfield','MEDIA','NOT_IMPLEMENTED','LULU_MANAGED')
ON CONFLICT (provider_key) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  category=EXCLUDED.category,
  implementation_status=EXCLUDED.implementation_status,
  default_mode=EXCLUDED.default_mode,
  updated_at=NOW();

INSERT INTO provider_capability_definitions(provider_key, capability_key, display_name, required_scopes, default_status)
VALUES
  ('google_tag_manager','google_tag_manager.containers.read','Read tag containers','{}','UNCONFIRMED'),
  ('google_tag_manager','google_tag_manager.containers.publish','Publish reviewed tag container versions','{}','PROVIDER_REVIEW'),
  ('google_search_console','google_search_console.performance.read','Read search performance','{}','UNCONFIRMED'),
  ('google_search_console','google_search_console.sitemaps.manage','Manage sitemaps','{}','PROVIDER_REVIEW'),
  ('google_pagespeed','google_pagespeed.run','Run PageSpeed analysis','{}','UNCONFIRMED'),
  ('google_merchant','google_merchant.products.read','Read Merchant products','{}','UNCONFIRMED'),
  ('google_merchant','google_merchant.products.manage','Manage Merchant products','{}','PROVIDER_REVIEW'),
  ('google_local_services','google_local_services.leads.read','Read Local Services leads','{}','UNCONFIRMED'),
  ('bigquery','bigquery.tenant_reporting.read','Read tenant-partitioned reporting data','{}','UNCONFIRMED'),
  ('perplexity','perplexity.research.run','Run cited web research','{}','UNCONFIRMED'),
  ('firecrawl','firecrawl.website.crawl','Crawl an approved website','{}','UNCONFIRMED'),
  ('higgsfield','higgsfield.media.generate','Generate reviewed creative media','{}','UNCONFIRMED')
ON CONFLICT (provider_key, capability_key) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  required_scopes=EXCLUDED.required_scopes,
  default_status=EXCLUDED.default_status;
