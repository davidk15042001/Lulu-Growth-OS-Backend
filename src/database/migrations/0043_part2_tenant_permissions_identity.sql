-- Part 2: tenant integrity, capability-based workspace authorization,
-- canonical entitlements and business identity scaffolding.
--
-- RLS is intentionally not enabled in this migration. Lulu currently uses a
-- pooled connection without a transaction-scoped tenant variable, and workers
-- and platform-admin operations need an explicit transition plan before RLS can
-- be safely enabled. Application authorization plus the composite constraints
-- below are the current defense-in-depth controls.

-- ---------------------------------------------------------------------------
-- Workspace roles and capabilities
-- ---------------------------------------------------------------------------

ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_role_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN (
    'owner', 'admin', 'sales_manager', 'sales_user', 'marketing_manager',
    'marketing_user', 'finance_manager', 'operations_manager', 'member', 'viewer'
  ));

ALTER TABLE workspace_invitations DROP CONSTRAINT IF EXISTS workspace_invitations_role_check;
ALTER TABLE workspace_invitations ADD CONSTRAINT workspace_invitations_role_check
  CHECK (role IN (
    'admin', 'sales_manager', 'sales_user', 'marketing_manager',
    'marketing_user', 'finance_manager', 'operations_manager', 'member', 'viewer'
  ));

CREATE TABLE IF NOT EXISTS workspace_capabilities (
  key TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]*$'),
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_role_capabilities (
  role TEXT NOT NULL CHECK (role IN (
    'owner', 'admin', 'sales_manager', 'sales_user', 'marketing_manager',
    'marketing_user', 'finance_manager', 'operations_manager', 'member', 'viewer'
  )),
  capability_key TEXT NOT NULL REFERENCES workspace_capabilities(key) ON DELETE CASCADE,
  PRIMARY KEY (role, capability_key)
);

INSERT INTO workspace_capabilities (key, description) VALUES
  ('workspace.read', 'Read workspace identity and operational data'),
  ('workspace.write', 'Create and update ordinary workspace data'),
  ('workspace.manage', 'Manage workspace identity and access policy'),
  ('members.read', 'View workspace members and invitations'),
  ('members.invite', 'Invite workspace members'),
  ('members.manage', 'Change member roles and membership'),
  ('members.remove', 'Remove workspace members'),
  ('products.read', 'Read product records'),
  ('products.create', 'Create product records'),
  ('products.update', 'Update product records'),
  ('products.delete', 'Delete product records'),
  ('crm.read', 'Read CRM records'),
  ('crm.manage', 'Manage CRM records'),
  ('leads.read', 'Read leads'),
  ('leads.manage', 'Manage leads'),
  ('opportunities.read', 'Read opportunities'),
  ('opportunities.manage', 'Manage opportunities'),
  ('quotes.read', 'Read quotes'),
  ('quotes.create', 'Create quotes'),
  ('quotes.send', 'Send quotes'),
  ('quotes.approve', 'Approve quotes'),
  ('orders.read', 'Read orders'),
  ('orders.manage', 'Manage orders'),
  ('website.read', 'Read website settings and content'),
  ('website.manage', 'Manage website content'),
  ('website.publish', 'Publish a website'),
  ('omnichannel.read', 'Read unified communication data'),
  ('omnichannel.reply', 'Reply to conversations'),
  ('omnichannel.manage', 'Manage communication channels'),
  ('advertising.read', 'Read advertising data'),
  ('advertising.manage', 'Manage advertising configuration'),
  ('advertising.budget_authorize', 'Authorize advertising budgets'),
  ('finance.read', 'Read financial data'),
  ('finance.manage', 'Manage financial configuration'),
  ('payouts.request', 'Request a payout'),
  ('payouts.manage', 'Manage and approve payouts'),
  ('providers.read', 'Read provider connections'),
  ('providers.connect', 'Connect a provider'),
  ('providers.manage', 'Manage provider connections'),
  ('agents.read', 'Read AI agent runs'),
  ('agents.manage', 'Manage AI agents and policies'),
  ('agents.execute', 'Execute an AI agent action'),
  ('settings.read', 'Read workspace settings'),
  ('settings.manage', 'Manage workspace settings'),
  ('audit.read', 'Read workspace audit history')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

-- Owner is deliberately represented by the same registry as every other role.
INSERT INTO workspace_role_capabilities (role, capability_key)
SELECT 'owner', key FROM workspace_capabilities
ON CONFLICT DO NOTHING;

INSERT INTO workspace_role_capabilities (role, capability_key)
SELECT 'admin', key FROM workspace_capabilities
ON CONFLICT DO NOTHING;

INSERT INTO workspace_role_capabilities (role, capability_key)
SELECT 'member', key FROM workspace_capabilities
WHERE key IN (
  'workspace.read', 'workspace.write', 'members.read', 'products.read',
  'products.create', 'products.update', 'crm.read', 'crm.manage', 'leads.read',
  'leads.manage', 'opportunities.read', 'opportunities.manage', 'quotes.read',
  'quotes.create', 'quotes.send', 'orders.read', 'orders.manage', 'website.read',
  'website.manage', 'omnichannel.read', 'omnichannel.reply', 'advertising.read',
  'finance.read', 'agents.read', 'agents.execute', 'settings.read'
)
ON CONFLICT DO NOTHING;

INSERT INTO workspace_role_capabilities (role, capability_key)
SELECT role, key FROM (VALUES
  ('sales_manager'), ('sales_user'), ('marketing_manager'), ('marketing_user'),
  ('finance_manager'), ('operations_manager')
) AS roles(role)
CROSS JOIN workspace_capabilities
WHERE (role IN ('sales_manager', 'sales_user') AND key IN ('workspace.read','workspace.write','members.read','products.read','crm.read','crm.manage','leads.read','leads.manage','opportunities.read','opportunities.manage','quotes.read','quotes.create','quotes.send','orders.read','orders.manage','omnichannel.read','omnichannel.reply','settings.read'))
   OR (role IN ('marketing_manager', 'marketing_user') AND key IN ('workspace.read','workspace.write','members.read','products.read','website.read','website.manage','website.publish','advertising.read','advertising.manage','advertising.budget_authorize','omnichannel.read','agents.read','settings.read'))
   OR (role = 'finance_manager' AND key IN ('workspace.read','members.read','finance.read','finance.manage','payouts.request','payouts.manage','orders.read','settings.read'))
   OR (role = 'operations_manager' AND key IN ('workspace.read','workspace.write','members.read','products.read','products.create','products.update','orders.read','orders.manage','website.read','website.manage','providers.read','settings.read'))
ON CONFLICT DO NOTHING;

INSERT INTO workspace_role_capabilities (role, capability_key)
SELECT 'viewer', key FROM workspace_capabilities
WHERE key IN ('workspace.read','members.read','products.read','crm.read','leads.read','opportunities.read','quotes.read','orders.read','website.read','omnichannel.read','advertising.read','finance.read','providers.read','agents.read','settings.read','audit.read')
ON CONFLICT DO NOTHING;

-- The last owner invariant is enforced in the database as well as in the
-- service layer. Ownership transfer is safe when the new owner is promoted
-- before the old owner is demoted in one transaction.
CREATE OR REPLACE FUNCTION prevent_workspace_last_owner_loss()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Cascading workspace deletion has already removed the parent row. It is a
  -- deliberate tenant teardown and must not be mistaken for owner loss.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  -- Role changes are mediated by the owner-protected service. DELETE remains
  -- database-guarded so a direct teardown cannot strand a workspace.
  IF OLD.role = 'owner' AND TG_OP = 'DELETE' THEN
    IF (SELECT count(*) FROM workspace_members WHERE workspace_id = OLD.workspace_id AND role = 'owner') <= 1 THEN
      RAISE EXCEPTION 'A workspace must retain at least one active owner' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS workspace_last_owner_guard ON workspace_members;
CREATE TRIGGER workspace_last_owner_guard
  BEFORE UPDATE OF role OR DELETE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION prevent_workspace_last_owner_loss();

CREATE INDEX IF NOT EXISTS idx_workspace_role_capabilities_capability
  ON workspace_role_capabilities (capability_key, role);

-- ---------------------------------------------------------------------------
-- Canonical entitlements. Commercial price remains in the existing billing
-- catalog; these tables describe technical access only.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plan_catalog (
  key TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  display_name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO plan_catalog(key, display_name) VALUES
  ('explorer','Explorer'), ('viewer','Viewer'), ('starter','Starter'), ('ai','AI'), ('test','Test')
ON CONFLICT (key) DO UPDATE SET display_name=EXCLUDED.display_name;

CREATE TABLE IF NOT EXISTS entitlement_definitions (
  key TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]*$'),
  value_type TEXT NOT NULL CHECK (value_type IN ('boolean', 'limit')),
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plan_entitlements (
  plan_key TEXT NOT NULL REFERENCES plan_catalog(key) ON DELETE CASCADE,
  entitlement_key TEXT NOT NULL REFERENCES entitlement_definitions(key) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  limit_value NUMERIC(30, 8),
  configuration JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (plan_key, entitlement_key),
  CHECK (jsonb_typeof(configuration) = 'object'),
  CHECK (limit_value IS NULL OR limit_value >= 0)
);

CREATE TABLE IF NOT EXISTS workspace_entitlement_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entitlement_key TEXT NOT NULL REFERENCES entitlement_definitions(key) ON DELETE CASCADE,
  enabled BOOLEAN,
  limit_value NUMERIC(30, 8),
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) BETWEEN 1 AND 500),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (enabled IS NOT NULL OR limit_value IS NOT NULL),
  CHECK (limit_value IS NULL OR limit_value >= 0)
);

CREATE TABLE IF NOT EXISTS workspace_entitlement_restrictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entitlement_key TEXT NOT NULL REFERENCES entitlement_definitions(key) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  limit_value NUMERIC(30, 8),
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) BETWEEN 1 AND 500),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (limit_value IS NULL OR limit_value >= 0)
);

INSERT INTO entitlement_definitions (key, value_type, description) VALUES
  ('website.enabled','boolean','Workspace websites are available'),
  ('workspace.write','boolean','Workspace write actions are available'),
  ('website.managed_mode','boolean','Lulu-managed website publishing is available'),
  ('ai.enabled','boolean','AI assistance is available'),
  ('ai.autonomous_agents','boolean','Autonomous AI agent runs are available'),
  ('email.enabled','boolean','Workspace email features are available'),
  ('calendar.enabled','boolean','Workspace calendar features are available'),
  ('omnichannel.enabled','boolean','Unified communication features are available'),
  ('whatsapp.enabled','boolean','WhatsApp features are available'),
  ('advertising.google','boolean','Google advertising features are available'),
  ('advertising.meta','boolean','Meta advertising features are available'),
  ('advertising.autopilot','boolean','Advertising autopilot is available'),
  ('finance.buyer_payments','boolean','Buyer payments are available'),
  ('finance.payouts','boolean','Factory payouts are available'),
  ('partner_portal.enabled','boolean','Partner portal is available'),
  ('ai.monthly_usage_limit','limit','Maximum monthly AI usage units'),
  ('workspace.max_users','limit','Maximum workspace users'),
  ('website.max_sites','limit','Maximum managed websites'),
  ('storage.max_bytes','limit','Maximum workspace storage bytes')
ON CONFLICT (key) DO UPDATE SET value_type=EXCLUDED.value_type, description=EXCLUDED.description;

-- Preserve the existing plan behavior while making it data-driven. Unknown
-- future plans intentionally receive no entitlements until explicitly seeded.
INSERT INTO plan_entitlements (plan_key, entitlement_key, enabled, limit_value)
SELECT plan_key, entitlement_key, enabled, limit_value
FROM (VALUES
  ('explorer','workspace.max_users',TRUE,1::numeric),
  ('viewer','workspace.max_users',TRUE,1::numeric),
  ('starter','workspace.max_users',TRUE,10::numeric),
  ('ai','workspace.max_users',TRUE,25::numeric),
  ('test','workspace.max_users',TRUE,25::numeric),
  ('explorer','workspace.write',FALSE,NULL::numeric),
  ('viewer','workspace.write',FALSE,NULL::numeric),
  ('starter','workspace.write',TRUE,NULL::numeric),
  ('ai','workspace.write',TRUE,NULL::numeric),
  ('test','workspace.write',TRUE,NULL::numeric),
  ('starter','website.enabled',TRUE,NULL::numeric),
  ('starter','website.managed_mode',TRUE,NULL::numeric),
  ('ai','website.enabled',TRUE,NULL::numeric),
  ('ai','website.managed_mode',TRUE,NULL::numeric),
  ('test','website.enabled',TRUE,NULL::numeric),
  ('test','website.managed_mode',TRUE,NULL::numeric),
  ('starter','ai.enabled',TRUE,NULL::numeric),
  ('ai','ai.enabled',TRUE,NULL::numeric),
  ('test','ai.enabled',TRUE,NULL::numeric),
  ('ai','ai.autonomous_agents',TRUE,NULL::numeric),
  ('test','ai.autonomous_agents',TRUE,NULL::numeric),
  ('starter','email.enabled',TRUE,NULL::numeric),
  ('ai','email.enabled',TRUE,NULL::numeric),
  ('test','email.enabled',TRUE,NULL::numeric),
  ('starter','calendar.enabled',TRUE,NULL::numeric),
  ('ai','calendar.enabled',TRUE,NULL::numeric),
  ('test','calendar.enabled',TRUE,NULL::numeric),
  ('ai','omnichannel.enabled',TRUE,NULL::numeric),
  ('test','omnichannel.enabled',TRUE,NULL::numeric),
  ('ai','whatsapp.enabled',TRUE,NULL::numeric),
  ('test','whatsapp.enabled',TRUE,NULL::numeric),
  ('ai','advertising.google',TRUE,NULL::numeric),
  ('ai','advertising.meta',TRUE,NULL::numeric),
  ('test','advertising.google',TRUE,NULL::numeric),
  ('test','advertising.meta',TRUE,NULL::numeric),
  ('ai','advertising.autopilot',TRUE,NULL::numeric),
  ('test','advertising.autopilot',TRUE,NULL::numeric),
  ('ai','finance.buyer_payments',TRUE,NULL::numeric),
  ('test','finance.buyer_payments',TRUE,NULL::numeric),
  ('ai','finance.payouts',TRUE,NULL::numeric),
  ('test','finance.payouts',TRUE,NULL::numeric),
  ('starter','ai.monthly_usage_limit',TRUE,100000::numeric),
  ('ai','ai.monthly_usage_limit',TRUE,1000000::numeric),
  ('test','ai.monthly_usage_limit',TRUE,1000000::numeric),
  ('starter','website.max_sites',TRUE,1::numeric),
  ('ai','website.max_sites',TRUE,10::numeric),
  ('test','website.max_sites',TRUE,10::numeric)
) AS seeded(plan_key, entitlement_key, enabled, limit_value)
JOIN entitlement_definitions d ON d.key = seeded.entitlement_key
ON CONFLICT (plan_key, entitlement_key) DO UPDATE SET enabled=EXCLUDED.enabled, limit_value=EXCLUDED.limit_value;

CREATE INDEX IF NOT EXISTS idx_workspace_entitlement_overrides_lookup
  ON workspace_entitlement_overrides (workspace_id, entitlement_key, expires_at);
CREATE INDEX IF NOT EXISTS idx_workspace_entitlement_restrictions_lookup
  ON workspace_entitlement_restrictions (workspace_id, entitlement_key, expires_at);

-- ---------------------------------------------------------------------------
-- Business identity: Workspace remains the isolation and billing boundary.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_workspace_id UUID UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 200),
  display_name TEXT,
  country TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS legal_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  legal_name TEXT NOT NULL CHECK (char_length(trim(legal_name)) BETWEEN 1 AND 250),
  registration_country TEXT,
  registration_number TEXT,
  legal_form TEXT,
  tax_identifier TEXT,
  registered_address TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','pending','verified','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS legal_entities_organization_name_key
  ON legal_entities (organization_id, legal_name);

CREATE TABLE IF NOT EXISTS factories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_workspace_id UUID UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  legal_entity_id UUID REFERENCES legal_entities(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 200),
  factory_code TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  timezone TEXT,
  default_currency CHAR(3),
  default_language TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, factory_code)
);

CREATE TABLE IF NOT EXISTS brands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 200),
  domain TEXT,
  logo_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  factory_id UUID REFERENCES factories(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'factory' CHECK (type IN ('factory','office','warehouse','other')),
  country TEXT,
  region TEXT,
  city TEXT,
  timezone TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS factory_id UUID REFERENCES factories(id) ON DELETE SET NULL;

-- Deterministic, restart-safe bootstrap for all existing workspaces.
INSERT INTO organizations (source_workspace_id, name, display_name, country)
SELECT w.id, w.name, w.name, w.country_region
FROM workspaces w
WHERE w.deleted_at IS NULL
ON CONFLICT (source_workspace_id) DO NOTHING;

INSERT INTO legal_entities (organization_id, legal_name, registration_country, legal_form, tax_identifier, registered_address)
SELECT o.id, w.name, w.country_region, w.legal_form, w.tax_id, w.address
FROM workspaces w
JOIN organizations o ON o.source_workspace_id = w.id
WHERE NOT EXISTS (SELECT 1 FROM legal_entities le WHERE le.organization_id = o.id);

INSERT INTO factories (source_workspace_id, organization_id, legal_entity_id, name, factory_code, country, timezone, default_language)
SELECT w.id, o.id, le.id, w.name, 'WS-' || upper(substr(replace(w.id::text, '-', ''), 1, 12)), w.country_region, 'UTC', 'en'
FROM workspaces w
JOIN organizations o ON o.source_workspace_id = w.id
LEFT JOIN legal_entities le ON le.organization_id = o.id
WHERE NOT EXISTS (SELECT 1 FROM factories f WHERE f.source_workspace_id = w.id);

UPDATE workspaces w
SET organization_id = o.id,
    factory_id = f.id
FROM organizations o
JOIN factories f ON f.organization_id = o.id AND f.source_workspace_id = o.source_workspace_id
WHERE o.source_workspace_id = w.id
  AND (w.organization_id IS NULL OR w.factory_id IS NULL);

CREATE INDEX IF NOT EXISTS idx_workspaces_organization ON workspaces (organization_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_factory ON workspaces (factory_id);
CREATE INDEX IF NOT EXISTS idx_factories_organization ON factories (organization_id);
CREATE INDEX IF NOT EXISTS idx_legal_entities_organization ON legal_entities (organization_id);
CREATE INDEX IF NOT EXISTS idx_brands_workspace ON brands (workspace_id);
CREATE INDEX IF NOT EXISTS idx_locations_factory ON locations (factory_id);

DROP TRIGGER IF EXISTS trg_organizations_set_updated_at ON organizations;
CREATE TRIGGER trg_organizations_set_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_legal_entities_set_updated_at ON legal_entities;
CREATE TRIGGER trg_legal_entities_set_updated_at BEFORE UPDATE ON legal_entities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_factories_set_updated_at ON factories;
CREATE TRIGGER trg_factories_set_updated_at BEFORE UPDATE ON factories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_brands_set_updated_at ON brands;
CREATE TRIGGER trg_brands_set_updated_at BEFORE UPDATE ON brands FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_locations_set_updated_at ON locations;
CREATE TRIGGER trg_locations_set_updated_at BEFORE UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- New workspaces created after this migration receive the same identity mapping
-- through the application service; the source_workspace_id uniqueness makes
-- retries and migration reruns idempotent.

-- ---------------------------------------------------------------------------
-- Critical cross-workspace record links. NOT VALID keeps legacy inconsistent
-- rows readable while enforcing the invariant for all new writes. Existing
-- data can be audited and validated in a later controlled rollout.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS workspace_records_workspace_id_id_key
  ON workspace_records (workspace_id, id);

ALTER TABLE workspace_records
  DROP CONSTRAINT IF EXISTS workspace_records_parent_same_workspace_fk;
ALTER TABLE workspace_records
  ADD CONSTRAINT workspace_records_parent_same_workspace_fk
  FOREIGN KEY (workspace_id, parent_id)
  REFERENCES workspace_records (workspace_id, id)
  ON DELETE SET NULL NOT VALID;

ALTER TABLE record_relationships
  DROP CONSTRAINT IF EXISTS record_relationships_source_same_workspace_fk,
  DROP CONSTRAINT IF EXISTS record_relationships_target_same_workspace_fk;
ALTER TABLE record_relationships
  ADD CONSTRAINT record_relationships_source_same_workspace_fk
  FOREIGN KEY (workspace_id, source_record_id)
  REFERENCES workspace_records (workspace_id, id)
  ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT record_relationships_target_same_workspace_fk
  FOREIGN KEY (workspace_id, target_record_id)
  REFERENCES workspace_records (workspace_id, id)
  ON DELETE CASCADE NOT VALID;

ALTER TABLE record_comments
  DROP CONSTRAINT IF EXISTS record_comments_record_same_workspace_fk;
ALTER TABLE record_comments
  ADD CONSTRAINT record_comments_record_same_workspace_fk
  FOREIGN KEY (workspace_id, record_id)
  REFERENCES workspace_records (workspace_id, id)
  ON DELETE CASCADE NOT VALID;

ALTER TABLE record_attachments
  DROP CONSTRAINT IF EXISTS record_attachments_record_same_workspace_fk;
ALTER TABLE record_attachments
  ADD CONSTRAINT record_attachments_record_same_workspace_fk
  FOREIGN KEY (workspace_id, record_id)
  REFERENCES workspace_records (workspace_id, id)
  ON DELETE CASCADE NOT VALID;
