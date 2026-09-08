-- Canonical commercial documents. Legacy workspace_records remain available as a
-- compatibility surface; these tables are the authoritative source for new
-- quotes and invoices.

CREATE TABLE IF NOT EXISTS commercial_policies (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  automatic_quote_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  automatic_quote_send_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  max_automatic_quote_value NUMERIC(20,4),
  automatic_discount_limit NUMERIC(8,4) NOT NULL DEFAULT 0 CHECK (automatic_discount_limit >= 0 AND automatic_discount_limit <= 100),
  minimum_margin NUMERIC(8,4),
  allowed_currencies TEXT[] NOT NULL DEFAULT ARRAY['CNY','EUR','USD'],
  allowed_incoterms TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  default_quote_validity_days INTEGER NOT NULL DEFAULT 30 CHECK (default_quote_validity_days BETWEEN 1 AND 365),
  default_payment_terms TEXT,
  invoice_creation_policy JSONB NOT NULL DEFAULT '{"trigger":"manual"}'::jsonb,
  invoice_auto_send_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  invoice_reminder_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  require_approval_for_custom_terms BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(invoice_creation_policy) = 'object'),
  CHECK (jsonb_typeof(invoice_reminder_policy) = 'object')
);

CREATE TABLE IF NOT EXISTS workspace_document_sequences (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('QUOTE','INVOICE')),
  next_value BIGINT NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (workspace_id, document_type)
);

CREATE TABLE IF NOT EXISTS quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  factory_id UUID,
  customer_record_id UUID,
  company_record_id UUID,
  lead_record_id UUID,
  opportunity_record_id UUID,
  quote_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','READY','AWAITING_APPROVAL','SENT','VIEWED','ACCEPTED','DECLINED','EXPIRED','CANCELLED','SUPERSEDED')),
  currency CHAR(3) NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  market_code TEXT,
  current_version_id UUID,
  source TEXT NOT NULL DEFAULT 'workspace' CHECK (source IN ('workspace','conversation','email','website_chat','api','import')),
  creation_mode TEXT NOT NULL DEFAULT 'MANUAL' CHECK (creation_mode IN ('MANUAL','AI_ASSISTED','AUTOMATIC','API','IMPORT')),
  handling_mode TEXT NOT NULL DEFAULT 'USER_AUTHORIZATION_REQUIRED' CHECK (handling_mode IN ('AUTONOMOUS','LIMITED_AUTONOMOUS','USER_AUTHORIZATION_REQUIRED','PROHIBITED')),
  assigned_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_agent_id UUID,
  valid_until DATE,
  accepted_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, quote_number),
  FOREIGN KEY (workspace_id, customer_record_id) REFERENCES workspace_records(workspace_id, id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id, company_record_id) REFERENCES workspace_records(workspace_id, id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id, lead_record_id) REFERENCES workspace_records(workspace_id, id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id, opportunity_record_id) REFERENCES workspace_records(workspace_id, id) ON DELETE SET NULL,
  CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_quotes_workspace_status ON quotes(workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_workspace_customer ON quotes(workspace_id, customer_record_id, created_at DESC);

CREATE TABLE IF NOT EXISTS quote_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  quote_id UUID NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','READY','AWAITING_APPROVAL','SENT','VIEWED','ACCEPTED','DECLINED','EXPIRED','CANCELLED','SUPERSEDED')),
  currency CHAR(3) NOT NULL,
  subtotal NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_total NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  shipping_total NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (shipping_total >= 0),
  tax_total NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  grand_total NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  valid_until DATE,
  terms_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  commercial_policy_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_type TEXT NOT NULL DEFAULT 'USER' CHECK (created_by_actor_type IN ('USER','AI_AGENT','WORKFLOW','SYSTEM','ADMIN')),
  created_by_actor_id UUID,
  document_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (document_status IN ('PENDING','GENERATING','READY','FAILED')),
  document_storage_reference TEXT,
  document_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  UNIQUE (workspace_id, quote_id, version_number),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, quote_id) REFERENCES quotes(workspace_id, id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(terms_snapshot) = 'object'),
  CHECK (jsonb_typeof(commercial_policy_snapshot) = 'object')
);
ALTER TABLE quotes DROP CONSTRAINT IF EXISTS quotes_current_version_fk;
ALTER TABLE quotes ADD CONSTRAINT quotes_current_version_fk FOREIGN KEY (workspace_id, current_version_id) REFERENCES quote_versions(workspace_id, id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS quote_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  quote_version_id UUID NOT NULL,
  product_id UUID,
  variant_id UUID,
  sku_snapshot TEXT,
  product_name_snapshot TEXT NOT NULL,
  description_snapshot TEXT,
  specifications_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  quantity NUMERIC(20,4) NOT NULL CHECK (quantity > 0),
  quantity_unit TEXT,
  unit_price NUMERIC(20,4) NOT NULL CHECK (unit_price >= 0),
  discount NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  tax NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  line_total NUMERIC(20,4) GENERATED ALWAYS AS (ROUND((quantity * unit_price) - discount + tax, 4)) STORED,
  lead_time_snapshot TEXT,
  moq_snapshot TEXT,
  customization_notes TEXT,
  price_source TEXT NOT NULL DEFAULT 'MANUAL' CHECK (price_source IN ('CATALOG','MARKET_PRICE','CUSTOMER_PRICE','NEGOTIATED','MANUAL','AI_PROPOSED','PROMOTION','CONTRACT')),
  source_reference TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, quote_version_id) REFERENCES quote_versions(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, product_id) REFERENCES products(workspace_id, id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id, variant_id) REFERENCES product_variants(workspace_id, id) ON DELETE SET NULL,
  CHECK (jsonb_typeof(specifications_snapshot) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_quote_lines_version ON quote_lines(workspace_id, quote_version_id, sort_order);

CREATE TABLE IF NOT EXISTS invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  factory_id UUID,
  customer_record_id UUID,
  company_record_id UUID,
  order_record_id UUID,
  quote_id UUID,
  invoice_number TEXT NOT NULL,
  invoice_type TEXT NOT NULL DEFAULT 'STANDARD' CHECK (invoice_type IN ('PROFORMA','COMMERCIAL','STANDARD','DEPOSIT','FINAL')),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','READY','AWAITING_APPROVAL','ISSUED','SENT','PARTIALLY_PAID','PAID','OVERDUE','CANCELLED','VOID','REFUNDED')),
  currency CHAR(3) NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  issue_date DATE,
  due_date DATE,
  subtotal NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_total NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  shipping_total NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (shipping_total >= 0),
  tax_total NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  grand_total NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  amount_paid NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  amount_due NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (amount_due >= 0),
  source TEXT NOT NULL DEFAULT 'workspace' CHECK (source IN ('workspace','conversation','email','website_chat','api','import')),
  creation_mode TEXT NOT NULL DEFAULT 'MANUAL' CHECK (creation_mode IN ('MANUAL','AI_ASSISTED','AUTOMATIC','API','IMPORT')),
  issue_stage TEXT,
  payment_reference TEXT,
  issued_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  document_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (document_status IN ('PENDING','GENERATING','READY','FAILED')),
  document_storage_reference TEXT,
  document_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, invoice_number),
  FOREIGN KEY (workspace_id, customer_record_id) REFERENCES workspace_records(workspace_id, id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id, company_record_id) REFERENCES workspace_records(workspace_id, id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id, order_record_id) REFERENCES workspace_records(workspace_id, id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id, quote_id) REFERENCES quotes(workspace_id, id) ON DELETE SET NULL,
  CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_invoices_workspace_status ON invoices(workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_workspace_due ON invoices(workspace_id, due_date, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_from_order_stage ON invoices(workspace_id, order_record_id, invoice_type, COALESCE(issue_stage, '')) WHERE order_record_id IS NOT NULL AND status NOT IN ('CANCELLED','VOID');

CREATE TABLE IF NOT EXISTS invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  invoice_id UUID NOT NULL,
  product_id UUID,
  sku_snapshot TEXT,
  product_name_snapshot TEXT NOT NULL,
  description_snapshot TEXT,
  quantity NUMERIC(20,4) NOT NULL CHECK (quantity > 0),
  quantity_unit TEXT,
  unit_price NUMERIC(20,4) NOT NULL CHECK (unit_price >= 0),
  discount NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  tax NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  line_total NUMERIC(20,4) GENERATED ALWAYS AS (ROUND((quantity * unit_price) - discount + tax, 4)) STORED,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, invoice_id) REFERENCES invoices(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, product_id) REFERENCES products(workspace_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(workspace_id, invoice_id, sort_order);

CREATE TABLE IF NOT EXISTS document_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('QUOTE','INVOICE')),
  document_id UUID NOT NULL,
  document_version_id UUID,
  conversation_id UUID,
  channel TEXT NOT NULL,
  channel_identity_id UUID,
  recipient TEXT,
  message_id UUID,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENDING','SENT','DELIVERED','FAILED')),
  provider_message_id TEXT,
  failure_reason TEXT,
  actor_type TEXT NOT NULL DEFAULT 'USER' CHECK (actor_type IN ('USER','AI_AGENT','WORKFLOW','SYSTEM','ADMIN')),
  actor_id UUID,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, conversation_id) REFERENCES omni_conversations(workspace_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_document_deliveries_document ON document_deliveries(workspace_id, document_type, document_id, created_at DESC);

CREATE TABLE IF NOT EXISTS commercial_document_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('QUOTE','INVOICE')),
  document_id UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_document_links_lookup ON commercial_document_links(token_hash) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS commercial_document_idempotency (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  document_type TEXT NOT NULL CHECK (document_type IN ('QUOTE','INVOICE','DELIVERY','ACCEPTANCE')),
  document_id UUID,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, operation_key),
  CHECK (jsonb_typeof(result) = 'object')
);

DROP TRIGGER IF EXISTS trg_commercial_policies_updated_at ON commercial_policies;
CREATE TRIGGER trg_commercial_policies_updated_at BEFORE UPDATE ON commercial_policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_quotes_updated_at ON quotes;
CREATE TRIGGER trg_quotes_updated_at BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_invoices_updated_at ON invoices;
CREATE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Reuse the existing capability registry; invoice and policy permissions are
-- intentionally separate from generic finance permissions.
INSERT INTO workspace_capabilities (key, description) VALUES
 ('quotes.update','Edit quote drafts'),('invoices.read','Read invoices'),('invoices.create','Create invoices'),
 ('invoices.issue','Issue invoices'),('invoices.send','Send invoices'),('invoices.cancel','Cancel invoices'),
 ('commercial_policy.read','Read commercial automation policy'),('commercial_policy.manage','Manage commercial automation policy')
ON CONFLICT (key) DO NOTHING;
INSERT INTO workspace_role_capabilities (role, capability_key)
SELECT r.role, c.key FROM (VALUES ('owner'),('admin')) AS r(role)
JOIN workspace_capabilities c ON c.key IN ('quotes.update','invoices.read','invoices.create','invoices.issue','invoices.send','invoices.cancel','commercial_policy.read','commercial_policy.manage')
ON CONFLICT DO NOTHING;
INSERT INTO workspace_role_capabilities (role, capability_key)
SELECT r.role, c.key FROM (VALUES ('finance_manager')) AS r(role)
JOIN workspace_capabilities c ON c.key IN ('invoices.read','invoices.create','invoices.issue','invoices.send','invoices.cancel','commercial_policy.read','commercial_policy.manage')
ON CONFLICT DO NOTHING;
INSERT INTO workspace_role_capabilities (role, capability_key)
SELECT r.role, c.key FROM (VALUES ('sales_manager'),('sales_user'),('member')) AS r(role)
JOIN workspace_capabilities c ON c.key IN ('quotes.update','invoices.read','invoices.create','invoices.send')
ON CONFLICT DO NOTHING;
