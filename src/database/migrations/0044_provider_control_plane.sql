-- Part 3: canonical Provider Control Plane.
--
-- This migration deliberately keeps the existing workspace_platforms,
-- email_accounts, calendar_accounts and lulu_managed_oauth_connections tables
-- intact. The new tables are the normalized control layer and retain a
-- source_type/source_id pointer so legacy providers can be backfilled and
-- read by compatibility adapters without copying credentials.

-- Provider metadata is intentionally non-secret. This recursive helper keeps
-- legacy settings useful for diagnostics while redacting token-like keys,
-- including values nested inside arrays and objects.
CREATE OR REPLACE FUNCTION redact_provider_metadata(value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  result JSONB;
BEGIN
  IF value IS NULL THEN
    RETURN NULL;
  ELSIF jsonb_typeof(value) = 'object' THEN
    SELECT COALESCE(jsonb_object_agg(key,
      CASE
        WHEN key ~* '(token|secret|password|credential|private.?key|api.?key)' THEN to_jsonb('[REDACTED]'::TEXT)
        ELSE redact_provider_metadata(entry)
      END
    ), '{}'::JSONB)
      INTO result
      FROM jsonb_each(value) AS fields(key, entry);
    RETURN result;
  ELSIF jsonb_typeof(value) = 'array' THEN
    SELECT COALESCE(jsonb_agg(redact_provider_metadata(entry)), '[]'::JSONB)
      INTO result
      FROM jsonb_array_elements(value) AS elements(entry);
    RETURN result;
  END IF;
  RETURN value;
END;
$$;

CREATE TABLE IF NOT EXISTS provider_registry (
  provider_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL,
  implementation_status TEXT NOT NULL DEFAULT 'UNCONFIRMED'
    CHECK (implementation_status IN ('IMPLEMENTED','PARTIAL','AUTHORIZATION_REQUIRED','PROVIDER_REVIEW','UNCONFIRMED','NOT_IMPLEMENTED','UNAVAILABLE')),
  default_mode TEXT NOT NULL DEFAULT 'CUSTOMER_OWNED'
    CHECK (default_mode IN ('LULU_MANAGED','CUSTOMER_OWNED','PARTNER_MANAGED','HYBRID')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS provider_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('WORKSPACE','ORGANIZATION','LULU_PLATFORM','PARTNER')),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  provider_key TEXT NOT NULL REFERENCES provider_registry(provider_key),
  mode TEXT NOT NULL DEFAULT 'CUSTOMER_OWNED'
    CHECK (mode IN ('LULU_MANAGED','CUSTOMER_OWNED','PARTNER_MANAGED','HYBRID')),
  status TEXT NOT NULL DEFAULT 'DISCONNECTED'
    CHECK (status IN ('DISCONNECTED','CONNECTING','CONNECTED','AUTHORIZATION_REQUIRED','EXPIRED','ERROR','SUSPENDED','PROVIDER_REVIEW','UNAVAILABLE')),
  authorization_state TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (authorization_state IN ('AUTHORIZED','REAUTH_REQUIRED','NOT_AUTHORIZED','UNKNOWN')),
  credential_ref TEXT,
  credential_key_version TEXT,
  source_type TEXT,
  source_id UUID,
  external_account_id TEXT,
  granted_scopes TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  health_status TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (health_status IN ('HEALTHY','DEGRADED','AUTHORIZATION_REQUIRED','RATE_LIMITED','ERROR','DISCONNECTED','PROVIDER_REVIEW','UNKNOWN')),
  health_reason TEXT,
  last_verified_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_webhook_at TIMESTAMPTZ,
  rate_limit_reset_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_error TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK ((scope_type = 'WORKSPACE' AND workspace_id IS NOT NULL)
      OR (scope_type <> 'WORKSPACE' AND workspace_id IS NULL)),
  CHECK (scope_type <> 'ORGANIZATION' OR organization_id IS NOT NULL),
  UNIQUE (source_type, source_id)
);

CREATE TABLE IF NOT EXISTS provider_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  provider_key TEXT NOT NULL REFERENCES provider_registry(provider_key),
  external_account_id TEXT NOT NULL,
  name TEXT,
  account_type TEXT,
  status TEXT NOT NULL DEFAULT 'CONNECTED'
    CHECK (status IN ('CONNECTED','DISCONNECTED','ERROR','UNAVAILABLE','UNKNOWN')),
  currency CHAR(3),
  timezone TEXT,
  country TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (provider_connection_id, external_account_id)
);

CREATE TABLE IF NOT EXISTS provider_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_account_id UUID NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  provider_key TEXT NOT NULL REFERENCES provider_registry(provider_key),
  asset_type TEXT NOT NULL,
  external_asset_id TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'CONNECTED'
    CHECK (status IN ('CONNECTED','DISCONNECTED','ERROR','UNAVAILABLE','UNKNOWN')),
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(capabilities) = 'object'),
  CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (provider_account_id, asset_type, external_asset_id)
);

CREATE TABLE IF NOT EXISTS provider_capability_definitions (
  provider_key TEXT NOT NULL REFERENCES provider_registry(provider_key) ON DELETE CASCADE,
  capability_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  required_scopes TEXT[] NOT NULL DEFAULT '{}',
  default_status TEXT NOT NULL DEFAULT 'UNCONFIRMED'
    CHECK (default_status IN ('AVAILABLE','UNAVAILABLE','AUTHORIZATION_REQUIRED','PROVIDER_REVIEW','PLAN_REQUIRED','BLOCKED','UNCONFIRMED','ERROR')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (provider_key, capability_key),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS provider_capability_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('CONNECTION','ACCOUNT','ASSET')),
  subject_id UUID NOT NULL,
  capability_key TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('AVAILABLE','UNAVAILABLE','AUTHORIZATION_REQUIRED','PROVIDER_REVIEW','PLAN_REQUIRED','BLOCKED','UNCONFIRMED','ERROR')),
  source TEXT NOT NULL DEFAULT 'ADAPTER'
    CHECK (source IN ('ADAPTER','OAUTH_SCOPE','PROVIDER_API','LULU_POLICY','ENTITLEMENT','MANUAL')),
  granted_scopes TEXT[] NOT NULL DEFAULT '{}',
  provider_permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_checked_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(provider_permissions) = 'object'),
  CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (provider_connection_id, subject_type, subject_id, capability_key)
);

CREATE TABLE IF NOT EXISTS provider_object_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  provider_account_id UUID NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  provider_asset_id UUID REFERENCES provider_assets(id) ON DELETE SET NULL,
  lulu_object_type TEXT NOT NULL,
  lulu_object_id UUID NOT NULL,
  external_object_type TEXT NOT NULL,
  external_object_id TEXT NOT NULL,
  source_of_truth TEXT NOT NULL DEFAULT 'LULU_MASTER'
    CHECK (source_of_truth IN ('LULU_MASTER','PROVIDER_MASTER','BIDIRECTIONAL','READ_ONLY','LULU_TO_PROVIDER')),
  sync_status TEXT NOT NULL DEFAULT 'IDLE'
    CHECK (sync_status IN ('IDLE','RUNNING','SUCCESS','PARTIAL','FAILED','PAUSED')),
  last_synced_at TIMESTAMPTZ,
  external_version TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (provider_account_id, lulu_object_type, lulu_object_id),
  UNIQUE (provider_account_id, external_object_type, external_object_id)
);

CREATE TABLE IF NOT EXISTS provider_sync_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('CONNECTION','ACCOUNT','ASSET')),
  subject_id UUID NOT NULL,
  sync_type TEXT NOT NULL,
  cursor TEXT,
  status TEXT NOT NULL DEFAULT 'IDLE'
    CHECK (status IN ('IDLE','RUNNING','SUCCESS','PARTIAL','FAILED','PAUSED')),
  last_success_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (provider_connection_id, subject_type, subject_id, sync_type)
);

CREATE TABLE IF NOT EXISTS provider_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  external_request_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','SUCCEEDED','FAILED','CANCELLED')),
  result_reference TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider_connection_id, operation_key)
);

CREATE TABLE IF NOT EXISTS provider_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key TEXT NOT NULL REFERENCES provider_registry(provider_key),
  provider_connection_id UUID REFERENCES provider_connections(id) ON DELETE SET NULL,
  provider_account_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
  external_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED','PROCESSING','PROCESSED','FAILED','DEAD_LETTER','IGNORED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  correlation_id TEXT,
  normalized_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (jsonb_typeof(normalized_metadata) = 'object'),
  UNIQUE (provider_key, external_event_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_connections_workspace
  ON provider_connections (workspace_id, provider_key, status)
  WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_provider_connections_scope
  ON provider_connections (scope_type, provider_key, status);
CREATE INDEX IF NOT EXISTS idx_provider_accounts_connection
  ON provider_accounts (provider_connection_id, status);
CREATE INDEX IF NOT EXISTS idx_provider_assets_account
  ON provider_assets (provider_account_id, asset_type, status);
CREATE INDEX IF NOT EXISTS idx_provider_capability_states_subject
  ON provider_capability_states (subject_type, subject_id, status);
CREATE INDEX IF NOT EXISTS idx_provider_mappings_workspace
  ON provider_object_mappings (workspace_id, lulu_object_type, lulu_object_id)
  WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_provider_sync_states_status
  ON provider_sync_states (status, last_attempt_at);
CREATE INDEX IF NOT EXISTS idx_provider_webhook_events_processing
  ON provider_webhook_events (status, next_attempt_at, received_at);

DROP TRIGGER IF EXISTS trg_provider_registry_set_updated_at ON provider_registry;
CREATE TRIGGER trg_provider_registry_set_updated_at BEFORE UPDATE ON provider_registry FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_provider_connections_set_updated_at ON provider_connections;
CREATE TRIGGER trg_provider_connections_set_updated_at BEFORE UPDATE ON provider_connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_provider_accounts_set_updated_at ON provider_accounts;
CREATE TRIGGER trg_provider_accounts_set_updated_at BEFORE UPDATE ON provider_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_provider_assets_set_updated_at ON provider_assets;
CREATE TRIGGER trg_provider_assets_set_updated_at BEFORE UPDATE ON provider_assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_provider_capability_states_set_updated_at ON provider_capability_states;
CREATE TRIGGER trg_provider_capability_states_set_updated_at BEFORE UPDATE ON provider_capability_states FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_provider_object_mappings_set_updated_at ON provider_object_mappings;
CREATE TRIGGER trg_provider_object_mappings_set_updated_at BEFORE UPDATE ON provider_object_mappings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_provider_sync_states_set_updated_at ON provider_sync_states;
CREATE TRIGGER trg_provider_sync_states_set_updated_at BEFORE UPDATE ON provider_sync_states FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_provider_operations_set_updated_at ON provider_operations;
CREATE TRIGGER trg_provider_operations_set_updated_at BEFORE UPDATE ON provider_operations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO provider_registry(provider_key, display_name, category, implementation_status, default_mode)
VALUES
  ('google_ads','Google Ads','ADVERTISING','PARTIAL','LULU_MANAGED'),
  ('google_analytics','Google Analytics','ANALYTICS','PARTIAL','LULU_MANAGED'),
  ('google_business','Google Business Profile','LOCAL','IMPLEMENTED','CUSTOMER_OWNED'),
  ('google_calendar','Google Calendar','CALENDAR','IMPLEMENTED','CUSTOMER_OWNED'),
  ('meta','Meta','ADVERTISING','PARTIAL','LULU_MANAGED'),
  ('facebook_messenger','Facebook Messenger','MESSAGING','NOT_IMPLEMENTED','CUSTOMER_OWNED'),
  ('instagram','Instagram','MESSAGING','NOT_IMPLEMENTED','CUSTOMER_OWNED'),
  ('whatsapp','WhatsApp','MESSAGING','NOT_IMPLEMENTED','LULU_MANAGED'),
  ('lulu_managed_website','Lulu Managed Website','WEBSITE','PARTIAL','LULU_MANAGED'),
  ('wordpress','WordPress','WEBSITE','PARTIAL','HYBRID'),
  ('webflow','Webflow','WEBSITE','PARTIAL','CUSTOMER_OWNED'),
  ('shopify','Shopify','COMMERCE','PARTIAL','CUSTOMER_OWNED'),
  ('airwallex','Airwallex','PAYMENTS','IMPLEMENTED','LULU_MANAGED'),
  ('gmail','Gmail','EMAIL','IMPLEMENTED','CUSTOMER_OWNED'),
  ('microsoft_email','Microsoft Email','EMAIL','IMPLEMENTED','CUSTOMER_OWNED'),
  ('imap_smtp','IMAP/SMTP','EMAIL','IMPLEMENTED','CUSTOMER_OWNED'),
  ('microsoft_calendar','Microsoft Calendar','CALENDAR','IMPLEMENTED','CUSTOMER_OWNED'),
  ('calendly','Calendly','CALENDAR','PARTIAL','CUSTOMER_OWNED'),
  ('cal_com','Cal.com','CALENDAR','PARTIAL','CUSTOMER_OWNED'),
  ('salesforce','Salesforce','CRM','PARTIAL','CUSTOMER_OWNED'),
  ('hubspot','HubSpot','CRM','PARTIAL','CUSTOMER_OWNED'),
  ('pipedrive','Pipedrive','CRM','PARTIAL','CUSTOMER_OWNED'),
  ('linkedin','LinkedIn','ADVERTISING','PARTIAL','LULU_MANAGED'),
  ('tiktok_ads','TikTok Ads','ADVERTISING','PARTIAL','LULU_MANAGED'),
  ('custom','Custom Provider','OTHER','NOT_IMPLEMENTED','CUSTOMER_OWNED')
ON CONFLICT (provider_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  category = EXCLUDED.category,
  implementation_status = EXCLUDED.implementation_status,
  default_mode = EXCLUDED.default_mode,
  updated_at = NOW();

INSERT INTO provider_capability_definitions(provider_key, capability_key, display_name, required_scopes, default_status)
VALUES
  ('google_ads','google_ads.campaign.read','Read campaigns','{}','UNCONFIRMED'),
  ('google_ads','google_ads.campaign.create','Create campaigns','{}','PROVIDER_REVIEW'),
  ('google_ads','google_ads.campaign.update','Update campaigns','{}','PROVIDER_REVIEW'),
  ('google_ads','google_ads.campaign.pause','Pause campaigns','{}','PROVIDER_REVIEW'),
  ('google_ads','google_ads.spend.read','Read spend','{}','UNCONFIRMED'),
  ('google_analytics','google_analytics.reporting.read','Read analytics reporting','{}','UNCONFIRMED'),
  ('google_business','google_business.locations.read','Read Business Profile locations','{}','AVAILABLE'),
  ('google_business','google_business.reviews.read','Read Business Profile reviews','{}','AVAILABLE'),
  ('google_business','google_business.reviews.reply','Reply to reviews','{}','AVAILABLE'),
  ('lulu_managed_website','website.site.read','Read managed website','{}','AVAILABLE'),
  ('wordpress','wordpress.site.read','Read website','{}','AVAILABLE'),
  ('wordpress','wordpress.site.publish','Publish website content','{}','UNCONFIRMED'),
  ('wordpress','wordpress.media.upload','Upload media','{}','UNCONFIRMED'),
  ('webflow','webflow.site.read','Read Webflow sites','{}','AVAILABLE'),
  ('webflow','webflow.cms.write','Write CMS content','{}','UNCONFIRMED'),
  ('shopify','shopify.products.read','Read products','{}','AVAILABLE'),
  ('shopify','shopify.products.write','Write products','{}','UNCONFIRMED'),
  ('shopify','shopify.orders.read','Read orders','{}','UNCONFIRMED'),
  ('gmail','email.read','Read email','{}','AVAILABLE'),
  ('gmail','email.send','Send email','{}','AVAILABLE'),
  ('microsoft_email','email.read','Read email','{}','AVAILABLE'),
  ('microsoft_email','email.send','Send email','{}','AVAILABLE'),
  ('imap_smtp','email.read','Read email','{}','AVAILABLE'),
  ('imap_smtp','email.send','Send email','{}','AVAILABLE'),
  ('airwallex','airwallex.subscription.billing','Manage Lulu subscription billing','{}','AVAILABLE'),
  ('airwallex','airwallex.payment.checkout','Create buyer payment checkout','{}','UNCONFIRMED'),
  ('airwallex','airwallex.connected_accounts','Manage connected accounts','{}','UNCONFIRMED'),
  ('airwallex','airwallex.funds_split','Split funds','{}','UNCONFIRMED'),
  ('airwallex','airwallex.payouts','Create payouts','{}','UNCONFIRMED')
ON CONFLICT (provider_key, capability_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  required_scopes = EXCLUDED.required_scopes,
  default_status = EXCLUDED.default_status;

-- Backfill workspace-owned legacy platform integrations without copying tokens.
INSERT INTO provider_connections (
  scope_type, workspace_id, provider_key, mode, status, authorization_state,
  credential_ref, source_type, source_id, external_account_id, granted_scopes,
  metadata, health_status, last_verified_at, last_error, created_at, updated_at
)
SELECT
  'WORKSPACE', p.workspace_id,
  CASE p.integration_key
    WHEN 'google-ads' THEN 'google_ads'
    WHEN 'google-analytics' THEN 'google_analytics'
    WHEN 'google-business' THEN 'google_business'
    WHEN 'tiktok-ads' THEN 'tiktok_ads'
    ELSE 'custom'
  END,
  'CUSTOMER_OWNED',
  CASE p.connection_status
    WHEN 'connected' THEN 'CONNECTED'
    WHEN 'pending' THEN 'CONNECTING'
    WHEN 'error' THEN 'ERROR'
    WHEN 'disconnected' THEN 'DISCONNECTED'
    ELSE 'AUTHORIZATION_REQUIRED'
  END,
  CASE WHEN p.connection_status = 'connected' THEN 'AUTHORIZED' ELSE 'UNKNOWN' END,
  CASE WHEN c.platform_id IS NOT NULL THEN 'workspace_platform_oauth_credentials:' || p.id::text ELSE NULL END,
  'workspace_platform', p.id, p.external_account_id, p.granted_scopes,
  jsonb_build_object('legacyPlatformId', p.id, 'integrationKey', p.integration_key, 'category', p.category),
  CASE
    WHEN p.connection_status = 'connected' AND p.last_error IS NULL THEN 'UNKNOWN'
    WHEN p.connection_status = 'error' THEN 'ERROR'
    WHEN p.connection_status IN ('disconnected','not_connected') THEN 'DISCONNECTED'
    ELSE 'UNKNOWN'
  END,
  p.last_synced_at, p.last_error, p.created_at, p.updated_at
FROM workspace_platforms p
LEFT JOIN workspace_platform_oauth_credentials c ON c.platform_id = p.id
JOIN provider_registry r ON r.provider_key = CASE p.integration_key
  WHEN 'google-ads' THEN 'google_ads'
  WHEN 'google-analytics' THEN 'google_analytics'
  WHEN 'google-business' THEN 'google_business'
  WHEN 'tiktok-ads' THEN 'tiktok_ads'
  ELSE 'custom'
END
WHERE p.deleted_at IS NULL
ON CONFLICT (source_type, source_id) DO NOTHING;

INSERT INTO provider_accounts(provider_connection_id, provider_key, external_account_id, name, account_type, status, metadata, last_synced_at)
SELECT c.id, c.provider_key, c.external_account_id, c.metadata->>'accountName', 'legacy_connection',
       CASE WHEN c.status = 'CONNECTED' THEN 'CONNECTED' ELSE 'UNKNOWN' END,
       c.metadata, c.last_verified_at
FROM provider_connections c
WHERE c.source_type = 'workspace_platform' AND c.external_account_id IS NOT NULL
ON CONFLICT (provider_connection_id, external_account_id) DO NOTHING;

INSERT INTO provider_assets(provider_account_id, provider_key, asset_type, external_asset_id, display_name, status, metadata, last_synced_at)
SELECT a.id, a.provider_key, 'legacy_workspace_platform', 'legacy:' || c.source_id::text,
       c.metadata->>'integrationKey', CASE WHEN c.status = 'CONNECTED' THEN 'CONNECTED' ELSE 'UNKNOWN' END,
       c.metadata, c.last_verified_at
FROM provider_accounts a
JOIN provider_connections c ON c.id = a.provider_connection_id
WHERE c.source_type = 'workspace_platform'
ON CONFLICT (provider_account_id, asset_type, external_asset_id) DO NOTHING;

-- Central Lulu-managed OAuth credentials become platform-scoped connections.
INSERT INTO provider_connections (
  scope_type, provider_key, mode, status, authorization_state, credential_ref,
  source_type, source_id, external_account_id, granted_scopes, metadata,
  health_status, last_verified_at, last_error, created_by, created_at, updated_at
)
SELECT
  'LULU_PLATFORM', replace(a.provider, '-', '_'),
  'LULU_MANAGED',
  CASE a.status
    WHEN 'connected' THEN 'CONNECTED'
    WHEN 'error' THEN 'ERROR'
    WHEN 'reauthorization_required' THEN 'AUTHORIZATION_REQUIRED'
    ELSE 'DISCONNECTED'
  END,
  CASE WHEN a.status = 'connected' THEN 'AUTHORIZED' ELSE 'REAUTH_REQUIRED' END,
  'lulu_managed_oauth_connections:' || a.id::text,
  'lulu_managed_oauth', a.id, a.external_account_id, a.granted_scopes,
  jsonb_build_object('displayName', a.display_name, 'settings', redact_provider_metadata(a.settings)),
  CASE WHEN a.status = 'connected' THEN 'UNKNOWN' WHEN a.status = 'error' THEN 'ERROR' ELSE 'DISCONNECTED' END,
  a.updated_at, a.last_error, a.connected_by, a.created_at, a.updated_at
FROM lulu_managed_oauth_connections a
JOIN provider_registry r ON r.provider_key = replace(a.provider, '-', '_')
ON CONFLICT (source_type, source_id) DO NOTHING;

-- Email and calendar credentials are represented as account/asset resources;
-- their existing encrypted credential stores remain the source of secrets.
INSERT INTO provider_connections (
  scope_type, workspace_id, provider_key, mode, status, authorization_state,
  credential_ref, source_type, source_id, external_account_id, metadata,
  health_status, last_verified_at, last_error, created_by, created_at, updated_at
)
SELECT 'WORKSPACE', a.workspace_id,
       CASE a.provider WHEN 'google' THEN 'gmail' WHEN 'microsoft' THEN 'microsoft_email' ELSE 'imap_smtp' END,
       'CUSTOMER_OWNED',
       CASE WHEN a.status IN ('connected','active') THEN 'CONNECTED' WHEN a.status = 'error' THEN 'ERROR' ELSE 'AUTHORIZATION_REQUIRED' END,
       CASE WHEN a.status IN ('connected','active') THEN 'AUTHORIZED' ELSE 'UNKNOWN' END,
       'email_accounts:' || a.id::text, 'email_account', a.id, a.email_address,
       jsonb_build_object('displayName', a.display_name, 'provider', a.provider),
       CASE WHEN a.status = 'error' THEN 'ERROR' WHEN a.status IN ('connected','active') THEN 'UNKNOWN' ELSE 'DISCONNECTED' END,
       a.last_sync_at, NULLIF(CONCAT_WS(': ', a.last_error_code, a.last_error_message), ''), a.connected_by, a.created_at, a.updated_at
FROM email_accounts a
JOIN provider_registry r ON r.provider_key = CASE a.provider WHEN 'google' THEN 'gmail' WHEN 'microsoft' THEN 'microsoft_email' ELSE 'imap_smtp' END
ON CONFLICT (source_type, source_id) DO NOTHING;

INSERT INTO provider_accounts(provider_connection_id, provider_key, external_account_id, name, account_type, status, metadata, last_synced_at)
SELECT c.id, c.provider_key, c.external_account_id, c.metadata->>'displayName', 'mailbox',
       CASE WHEN c.status = 'CONNECTED' THEN 'CONNECTED' ELSE 'UNKNOWN' END, c.metadata, c.last_verified_at
FROM provider_connections c
WHERE c.source_type = 'email_account'
ON CONFLICT (provider_connection_id, external_account_id) DO NOTHING;

INSERT INTO provider_assets(provider_account_id, provider_key, asset_type, external_asset_id, display_name, status, metadata, last_synced_at)
SELECT a.id, a.provider_key, 'mailbox', a.external_account_id, a.name,
       CASE WHEN c.status = 'CONNECTED' THEN 'CONNECTED' ELSE 'UNKNOWN' END, a.metadata, c.last_verified_at
FROM provider_accounts a JOIN provider_connections c ON c.id = a.provider_connection_id
WHERE c.source_type = 'email_account'
ON CONFLICT (provider_account_id, asset_type, external_asset_id) DO NOTHING;

INSERT INTO provider_connections (
  scope_type, workspace_id, provider_key, mode, status, authorization_state,
  credential_ref, source_type, source_id, external_account_id, metadata,
  health_status, last_verified_at, last_error, created_by, created_at, updated_at
)
SELECT 'WORKSPACE', a.workspace_id,
       CASE a.provider WHEN 'google' THEN 'google_calendar' WHEN 'microsoft' THEN 'microsoft_calendar' WHEN 'calendly' THEN 'calendly' ELSE 'cal_com' END,
       'CUSTOMER_OWNED',
       CASE WHEN a.status IN ('connected','active') THEN 'CONNECTED' WHEN a.status = 'error' THEN 'ERROR' ELSE 'AUTHORIZATION_REQUIRED' END,
       CASE WHEN a.status IN ('connected','active') THEN 'AUTHORIZED' ELSE 'UNKNOWN' END,
       'calendar_accounts:' || a.id::text, 'calendar_account', a.id, COALESCE(a.email_address, a.external_account_id),
       jsonb_build_object('displayName', a.display_name, 'provider', a.provider),
       CASE WHEN a.status = 'error' THEN 'ERROR' WHEN a.status IN ('connected','active') THEN 'UNKNOWN' ELSE 'DISCONNECTED' END,
       a.last_sync_at, NULLIF(CONCAT_WS(': ', a.last_error_code, a.last_error_message), ''), a.connected_by, a.created_at, a.updated_at
FROM calendar_accounts a
JOIN provider_registry r ON r.provider_key = CASE a.provider WHEN 'google' THEN 'google_calendar' WHEN 'microsoft' THEN 'microsoft_calendar' WHEN 'calendly' THEN 'calendly' ELSE 'cal_com' END
ON CONFLICT (source_type, source_id) DO NOTHING;

-- Website records already contain the operational site identity. Preserve
-- that record while exposing a canonical provider account/asset for the
-- control plane. Connected WordPress/Webflow sites remain customer-owned;
-- internally managed sites use an explicit Lulu-managed provider key.
INSERT INTO provider_connections (
  scope_type, workspace_id, provider_key, mode, status, authorization_state,
  source_type, source_id, external_account_id, metadata, health_status,
  last_verified_at, last_error, created_at, updated_at
)
SELECT 'WORKSPACE', s.workspace_id,
       CASE WHEN s.provider = 'managed' THEN 'lulu_managed_website' ELSE s.provider END,
       CASE WHEN s.ownership_mode = 'managed' OR s.provider = 'managed' THEN 'LULU_MANAGED' ELSE 'CUSTOMER_OWNED' END,
       CASE
         WHEN s.provider = 'managed' OR EXISTS (
           SELECT 1 FROM provider_connections existing
            WHERE existing.workspace_id = s.workspace_id
              AND existing.provider_key = CASE WHEN s.provider = 'managed' THEN 'lulu_managed_website' ELSE s.provider END
              AND existing.status = 'CONNECTED'
         ) THEN 'CONNECTED'
         ELSE 'AUTHORIZATION_REQUIRED'
       END,
       CASE WHEN s.provider = 'managed' THEN 'AUTHORIZED' ELSE 'UNKNOWN' END,
       'workspace_site', s.id, COALESCE(s.external_site_id, 'workspace-site:' || s.id::text),
       jsonb_build_object('legacySiteId', s.id, 'provider', s.provider, 'ownershipMode', s.ownership_mode, 'name', s.name),
       CASE WHEN s.provider = 'managed' THEN 'UNKNOWN' ELSE 'AUTHORIZATION_REQUIRED' END,
       s.updated_at, NULL, s.created_at, s.updated_at
FROM workspace_sites s
JOIN provider_registry r ON r.provider_key = CASE WHEN s.provider = 'managed' THEN 'lulu_managed_website' ELSE s.provider END
ON CONFLICT (source_type, source_id) DO NOTHING;

INSERT INTO provider_accounts(provider_connection_id, provider_key, external_account_id, name, account_type, status, metadata, last_synced_at)
SELECT c.id, c.provider_key, c.external_account_id, c.metadata->>'name', 'website',
       CASE WHEN c.status = 'CONNECTED' THEN 'CONNECTED' ELSE 'UNKNOWN' END, c.metadata, c.last_verified_at
FROM provider_connections c
WHERE c.source_type = 'workspace_site'
ON CONFLICT (provider_connection_id, external_account_id) DO NOTHING;

INSERT INTO provider_assets(provider_account_id, provider_key, asset_type, external_asset_id, display_name, status, metadata, last_synced_at)
SELECT a.id, a.provider_key, 'website', a.external_account_id, a.name,
       CASE WHEN c.status = 'CONNECTED' THEN 'CONNECTED' ELSE 'UNKNOWN' END, a.metadata, c.last_verified_at
FROM provider_accounts a JOIN provider_connections c ON c.id = a.provider_connection_id
WHERE c.source_type = 'workspace_site'
ON CONFLICT (provider_account_id, asset_type, external_asset_id) DO NOTHING;
