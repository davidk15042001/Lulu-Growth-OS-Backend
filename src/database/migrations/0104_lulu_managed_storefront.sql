-- Lulu-owned website and storefront foundation.
--
-- The storefront is a projection over the canonical product and commerce
-- tables. It deliberately does not duplicate products, prices, inventory or
-- orders from an external provider.

CREATE TABLE IF NOT EXISTS storefront_carts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES workspace_sites(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  currency CHAR(3) NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CHECKOUT','CONVERTED','ABANDONED')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS idx_storefront_carts_site_status
  ON storefront_carts(site_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS storefront_cart_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id UUID NOT NULL REFERENCES storefront_carts(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  variant_id UUID,
  quantity NUMERIC(20,4) NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(20,4) NOT NULL CHECK (unit_price >= 0),
  currency CHAR(3) NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(metadata) = 'object'),
  FOREIGN KEY (workspace_id, product_id)
    REFERENCES products(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, variant_id, product_id)
    REFERENCES product_variants(workspace_id, id, product_id) ON DELETE CASCADE,
  UNIQUE (cart_id, product_id, variant_id)
);

CREATE INDEX IF NOT EXISTS idx_storefront_cart_items_cart
  ON storefront_cart_items(cart_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS storefront_checkout_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES workspace_sites(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  cart_id UUID NOT NULL REFERENCES storefront_carts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING_CONFIRMATION' CHECK (status IN ('PENDING_CONFIRMATION','PENDING_PAYMENT','PAID','FAILED','EXPIRED','CANCELLED')),
  customer_email TEXT,
  currency CHAR(3) NOT NULL,
  amount NUMERIC(20,4) NOT NULL CHECK (amount >= 0),
  payment_provider TEXT,
  provider_session_id TEXT,
  order_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_storefront_checkout_sessions_workspace
  ON storefront_checkout_sessions(workspace_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_storefront_carts_set_updated_at ON storefront_carts;
CREATE TRIGGER trg_storefront_carts_set_updated_at
  BEFORE UPDATE ON storefront_carts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_storefront_cart_items_set_updated_at ON storefront_cart_items;
CREATE TRIGGER trg_storefront_cart_items_set_updated_at
  BEFORE UPDATE ON storefront_cart_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_storefront_checkout_sessions_set_updated_at ON storefront_checkout_sessions;
CREATE TRIGGER trg_storefront_checkout_sessions_set_updated_at
  BEFORE UPDATE ON storefront_checkout_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
