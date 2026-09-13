-- Canonical commerce execution layer.
--
-- Generic ecommerce workspace records remain readable for compatibility, but
-- they are not authoritative order or inventory state. New manual and agentic
-- commerce operations use the same tenant-scoped tables below.

CREATE TABLE IF NOT EXISTS commerce_sequences (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sequence_type TEXT NOT NULL CHECK (sequence_type IN ('ORDER', 'FULFILLMENT')),
  next_value BIGINT NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (workspace_id, sequence_type)
);

CREATE TABLE IF NOT EXISTS inventory_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (char_length(trim(code)) BETWEEN 1 AND 80),
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  address JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_actor_type TEXT NOT NULL DEFAULT 'USER'
    CHECK (created_by_actor_type IN ('USER', 'AI_AGENT', 'WORKFLOW', 'SYSTEM', 'ADMIN')),
  created_by_actor_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  CHECK (jsonb_typeof(address) = 'object'),
  CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_locations_workspace_code
  ON inventory_locations(workspace_id, lower(code))
  WHERE status <> 'ARCHIVED';
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_locations_default
  ON inventory_locations(workspace_id)
  WHERE is_default AND status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_inventory_locations_workspace_status
  ON inventory_locations(workspace_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS inventory_levels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  location_id UUID NOT NULL,
  product_id UUID NOT NULL,
  variant_id UUID,
  on_hand NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  reserved NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  reorder_point NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, location_id)
    REFERENCES inventory_locations(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, product_id)
    REFERENCES products(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, variant_id, product_id)
    REFERENCES product_variants(workspace_id, id, product_id) ON DELETE RESTRICT,
  CHECK (reserved <= on_hand)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_levels_base_product
  ON inventory_levels(workspace_id, location_id, product_id)
  WHERE variant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_levels_variant
  ON inventory_levels(workspace_id, location_id, product_id, variant_id)
  WHERE variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_levels_workspace_product
  ON inventory_levels(workspace_id, product_id, variant_id, location_id);

CREATE TABLE IF NOT EXISTS commerce_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_number TEXT NOT NULL CHECK (char_length(trim(order_number)) BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PLACED', 'CONFIRMED', 'PROCESSING', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED')),
  payment_status TEXT NOT NULL DEFAULT 'UNPAID'
    CHECK (payment_status IN ('UNPAID', 'PARTIALLY_PAID', 'PAID', 'REFUNDED')),
  fulfillment_status TEXT NOT NULL DEFAULT 'UNFULFILLED'
    CHECK (fulfillment_status IN ('UNFULFILLED', 'PARTIALLY_FULFILLED', 'FULFILLED')),
  customer_record_id UUID,
  company_record_id UUID,
  quote_id UUID,
  currency CHAR(3) NOT NULL,
  subtotal NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  discount_total NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  shipping_total NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (shipping_total >= 0),
  tax_total NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  grand_total NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  source TEXT NOT NULL DEFAULT 'workspace'
    CHECK (source IN ('workspace', 'conversation', 'email', 'website_chat', 'api', 'import', 'provider')),
  source_provider TEXT,
  external_reference TEXT,
  notes TEXT,
  shipping_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  billing_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  placed_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_actor_type TEXT NOT NULL DEFAULT 'USER'
    CHECK (created_by_actor_type IN ('USER', 'AI_AGENT', 'WORKFLOW', 'SYSTEM', 'ADMIN')),
  created_by_actor_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, order_number),
  FOREIGN KEY (workspace_id, customer_record_id)
    REFERENCES workspace_records(workspace_id, id) ON DELETE SET NULL (customer_record_id),
  FOREIGN KEY (workspace_id, company_record_id)
    REFERENCES workspace_records(workspace_id, id) ON DELETE SET NULL (company_record_id),
  FOREIGN KEY (workspace_id, quote_id)
    REFERENCES quotes(workspace_id, id) ON DELETE SET NULL (quote_id),
  CHECK (jsonb_typeof(shipping_address) = 'object'),
  CHECK (jsonb_typeof(billing_address) = 'object'),
  CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK ((source_provider IS NULL AND external_reference IS NULL) OR source_provider IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_orders_external_reference
  ON commerce_orders(workspace_id, lower(source_provider), external_reference)
  WHERE source_provider IS NOT NULL AND external_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_orders_workspace_status
  ON commerce_orders(workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_orders_workspace_customer
  ON commerce_orders(workspace_id, customer_record_id, created_at DESC);

CREATE TABLE IF NOT EXISTS commerce_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  order_id UUID NOT NULL,
  product_id UUID NOT NULL,
  variant_id UUID,
  inventory_location_id UUID,
  sku_snapshot TEXT,
  product_name_snapshot TEXT NOT NULL,
  description_snapshot TEXT,
  quantity NUMERIC(20,4) NOT NULL CHECK (quantity > 0),
  quantity_unit TEXT,
  unit_price NUMERIC(20,4) NOT NULL CHECK (unit_price >= 0),
  discount NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  tax NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  line_total NUMERIC(20,4)
    GENERATED ALWAYS AS (ROUND((quantity * unit_price) - discount + tax, 4)) STORED,
  reserved_quantity NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
  fulfilled_quantity NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (fulfilled_quantity >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, order_id),
  FOREIGN KEY (workspace_id, order_id)
    REFERENCES commerce_orders(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, product_id)
    REFERENCES products(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, variant_id, product_id)
    REFERENCES product_variants(workspace_id, id, product_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, inventory_location_id)
    REFERENCES inventory_locations(workspace_id, id) ON DELETE RESTRICT,
  CHECK (line_total >= 0),
  CHECK (reserved_quantity + fulfilled_quantity <= quantity),
  CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_commerce_order_lines_order
  ON commerce_order_lines(workspace_id, order_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_commerce_order_lines_inventory
  ON commerce_order_lines(workspace_id, inventory_location_id, product_id, variant_id)
  WHERE inventory_location_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS commerce_fulfillments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  order_id UUID NOT NULL,
  fulfillment_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED')),
  carrier TEXT,
  tracking_number TEXT,
  tracking_url TEXT,
  notes TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  shipped_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_actor_type TEXT NOT NULL DEFAULT 'USER'
    CHECK (created_by_actor_type IN ('USER', 'AI_AGENT', 'WORKFLOW', 'SYSTEM', 'ADMIN')),
  created_by_actor_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, order_id),
  UNIQUE (workspace_id, fulfillment_number),
  FOREIGN KEY (workspace_id, order_id)
    REFERENCES commerce_orders(workspace_id, id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_commerce_fulfillments_order
  ON commerce_fulfillments(workspace_id, order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS commerce_fulfillment_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  order_id UUID NOT NULL,
  fulfillment_id UUID NOT NULL,
  order_line_id UUID NOT NULL,
  quantity NUMERIC(20,4) NOT NULL CHECK (quantity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, fulfillment_id, order_line_id),
  FOREIGN KEY (workspace_id, fulfillment_id, order_id)
    REFERENCES commerce_fulfillments(workspace_id, id, order_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, order_line_id, order_id)
    REFERENCES commerce_order_lines(workspace_id, id, order_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_commerce_fulfillment_lines_order_line
  ON commerce_fulfillment_lines(workspace_id, order_line_id);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  inventory_level_id UUID NOT NULL,
  movement_type TEXT NOT NULL
    CHECK (movement_type IN ('INITIAL', 'ADJUSTMENT', 'RESERVATION', 'RELEASE', 'FULFILLMENT', 'RETURN')),
  on_hand_delta NUMERIC(20,4) NOT NULL DEFAULT 0,
  reserved_delta NUMERIC(20,4) NOT NULL DEFAULT 0,
  on_hand_before NUMERIC(20,4) NOT NULL CHECK (on_hand_before >= 0),
  on_hand_after NUMERIC(20,4) NOT NULL CHECK (on_hand_after >= 0),
  reserved_before NUMERIC(20,4) NOT NULL CHECK (reserved_before >= 0),
  reserved_after NUMERIC(20,4) NOT NULL CHECK (reserved_after >= 0),
  order_id UUID,
  order_line_id UUID,
  fulfillment_id UUID,
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) BETWEEN 1 AND 2000),
  operation_key TEXT NOT NULL CHECK (char_length(trim(operation_key)) BETWEEN 1 AND 200),
  actor_type TEXT NOT NULL DEFAULT 'USER'
    CHECK (actor_type IN ('USER', 'AI_AGENT', 'WORKFLOW', 'SYSTEM', 'ADMIN')),
  actor_ref TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, operation_key, inventory_level_id),
  FOREIGN KEY (workspace_id, inventory_level_id)
    REFERENCES inventory_levels(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, order_id)
    REFERENCES commerce_orders(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, order_line_id, order_id)
    REFERENCES commerce_order_lines(workspace_id, id, order_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, fulfillment_id, order_id)
    REFERENCES commerce_fulfillments(workspace_id, id, order_id) ON DELETE RESTRICT,
  CHECK (on_hand_after = on_hand_before + on_hand_delta),
  CHECK (reserved_after = reserved_before + reserved_delta),
  CHECK (reserved_after <= on_hand_after),
  CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK ((order_line_id IS NULL AND fulfillment_id IS NULL) OR order_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_level
  ON inventory_movements(workspace_id, inventory_level_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_order
  ON inventory_movements(workspace_id, order_id, created_at DESC)
  WHERE order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS commerce_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL CHECK (char_length(trim(operation_key)) BETWEEN 1 AND 200),
  operation_type TEXT NOT NULL CHECK (char_length(trim(operation_type)) BETWEEN 1 AND 160),
  request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'STARTED' CHECK (status IN ('STARTED', 'COMPLETED')),
  resource_type TEXT,
  resource_id UUID,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_type TEXT NOT NULL DEFAULT 'USER'
    CHECK (actor_type IN ('USER', 'AI_AGENT', 'WORKFLOW', 'SYSTEM', 'ADMIN')),
  actor_ref TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, operation_key),
  CHECK (jsonb_typeof(result) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_commerce_operations_resource
  ON commerce_operations(workspace_id, resource_type, resource_id, created_at DESC);

-- Existing generic orders are intentionally not promoted into authoritative
-- commerce orders without verified line/customer/amount data. They are mapped
-- for an explicit import workflow instead of being silently treated as valid.
CREATE TABLE IF NOT EXISTS commerce_order_legacy_mappings (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type = 'workspace_record'),
  source_id UUID NOT NULL,
  canonical_order_id UUID,
  migration_status TEXT NOT NULL DEFAULT 'TRANSFORMATION_REQUIRED'
    CHECK (migration_status IN ('TRANSFORMATION_REQUIRED', 'IMPORTED', 'IGNORED')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, source_type, source_id),
  FOREIGN KEY (workspace_id, source_id)
    REFERENCES workspace_records(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, canonical_order_id)
    REFERENCES commerce_orders(workspace_id, id) ON DELETE SET NULL (canonical_order_id),
  CHECK (jsonb_typeof(details) = 'object')
);

INSERT INTO commerce_order_legacy_mappings (
  workspace_id, source_type, source_id, migration_status, details
)
SELECT workspace_id, 'workspace_record', id, 'TRANSFORMATION_REQUIRED',
       '{"source":"workspace_records","resourceType":"ecommerce_orders","reason":"canonical line and inventory verification required"}'::jsonb
FROM workspace_records
WHERE resource_type = 'ecommerce_orders' AND deleted_at IS NULL
ON CONFLICT (workspace_id, source_type, source_id) DO NOTHING;

DROP TRIGGER IF EXISTS trg_inventory_locations_updated_at ON inventory_locations;
CREATE TRIGGER trg_inventory_locations_updated_at
  BEFORE UPDATE ON inventory_locations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_inventory_levels_updated_at ON inventory_levels;
CREATE TRIGGER trg_inventory_levels_updated_at
  BEFORE UPDATE ON inventory_levels FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_commerce_orders_updated_at ON commerce_orders;
CREATE TRIGGER trg_commerce_orders_updated_at
  BEFORE UPDATE ON commerce_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_commerce_order_lines_updated_at ON commerce_order_lines;
CREATE TRIGGER trg_commerce_order_lines_updated_at
  BEFORE UPDATE ON commerce_order_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_commerce_fulfillments_updated_at ON commerce_fulfillments;
CREATE TRIGGER trg_commerce_fulfillments_updated_at
  BEFORE UPDATE ON commerce_fulfillments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_commerce_order_legacy_mappings_updated_at ON commerce_order_legacy_mappings;
CREATE TRIGGER trg_commerce_order_legacy_mappings_updated_at
  BEFORE UPDATE ON commerce_order_legacy_mappings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION prevent_inventory_movement_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM workspaces WHERE id = OLD.workspace_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Inventory movements are append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS inventory_movements_append_only ON inventory_movements;
CREATE TRIGGER inventory_movements_append_only
  BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION prevent_inventory_movement_mutation();
