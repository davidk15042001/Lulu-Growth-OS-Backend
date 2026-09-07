-- Part 4: Canonical Product Master.
--
-- Lulu Product is the business source of truth. Legacy onboarding offerings
-- and generic ecommerce records remain intact and are linked through the
-- product_legacy_mappings compatibility table.

CREATE TABLE IF NOT EXISTS product_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id UUID,
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 200),
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','ARCHIVED')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, slug)
);

ALTER TABLE product_categories
  DROP CONSTRAINT IF EXISTS fk_product_category_parent;
ALTER TABLE product_categories
  ADD CONSTRAINT fk_product_category_parent
  FOREIGN KEY (workspace_id, parent_id)
  REFERENCES product_categories (workspace_id, id)
  ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  factory_id UUID REFERENCES factories(id) ON DELETE SET NULL,
  brand_id UUID REFERENCES brands(id) ON DELETE SET NULL,
  category_id UUID,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','INACTIVE','ARCHIVED')),
  product_type TEXT NOT NULL DEFAULT 'PHYSICAL_PRODUCT' CHECK (product_type IN ('PHYSICAL_PRODUCT','CUSTOM_MANUFACTURING','OEM','ODM','SERVICE','COMPONENT','MATERIAL','MACHINE','OTHER')),
  sku TEXT,
  internal_code TEXT,
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 300),
  short_description TEXT,
  long_description TEXT,
  default_currency CHAR(3),
  default_price NUMERIC(20,4) CHECK (default_price IS NULL OR default_price >= 0),
  pricing_type TEXT NOT NULL DEFAULT 'QUOTE_REQUIRED' CHECK (pricing_type IN ('FIXED','STARTING_FROM','RANGE','QUOTE_REQUIRED','TIERED')),
  moq_quantity NUMERIC(20,4) CHECK (moq_quantity IS NULL OR moq_quantity > 0),
  moq_unit TEXT,
  lead_time_min_days INTEGER CHECK (lead_time_min_days IS NULL OR lead_time_min_days >= 0),
  lead_time_max_days INTEGER CHECK (lead_time_max_days IS NULL OR lead_time_max_days >= 0),
  production_capacity_value NUMERIC(20,4) CHECK (production_capacity_value IS NULL OR production_capacity_value >= 0),
  production_capacity_unit TEXT,
  production_capacity_period TEXT,
  country_of_origin TEXT,
  hs_code TEXT,
  visibility TEXT NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PRIVATE','WORKSPACE','PUBLIC')),
  source_language TEXT NOT NULL DEFAULT 'en' CHECK (source_language ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  legacy_source_type TEXT,
  legacy_source_id UUID,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  CHECK (lead_time_max_days IS NULL OR lead_time_min_days IS NULL OR lead_time_max_days >= lead_time_min_days),
  CHECK ((legacy_source_type IS NULL AND legacy_source_id IS NULL) OR (legacy_source_type IS NOT NULL AND legacy_source_id IS NOT NULL))
);

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS fk_product_category,
  DROP CONSTRAINT IF EXISTS fk_product_factory_workspace,
  DROP CONSTRAINT IF EXISTS fk_product_brand_workspace;
ALTER TABLE products
  ADD CONSTRAINT fk_product_category
  FOREIGN KEY (workspace_id, category_id)
  REFERENCES product_categories (workspace_id, id)
  ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION validate_product_business_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  valid_factory BOOLEAN;
  valid_brand BOOLEAN;
BEGIN
  IF NEW.factory_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM factories f
       WHERE f.id = NEW.factory_id
         AND f.source_workspace_id = NEW.workspace_id
    ) INTO valid_factory;
    IF NOT valid_factory THEN
      RAISE EXCEPTION 'Product factory does not belong to the workspace'
        USING ERRCODE = '23514', CONSTRAINT = 'product_factory_workspace_integrity';
    END IF;
  END IF;

  IF NEW.brand_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
        FROM brands b
        JOIN workspaces w ON w.id = NEW.workspace_id
       WHERE b.id = NEW.brand_id
         AND (b.workspace_id = NEW.workspace_id OR (b.workspace_id IS NULL AND b.organization_id = w.organization_id))
    ) INTO valid_brand;
    IF NOT valid_brand THEN
      RAISE EXCEPTION 'Product brand does not belong to the workspace organization'
        USING ERRCODE = '23514', CONSTRAINT = 'product_brand_workspace_integrity';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_product_business_identity ON products;
CREATE TRIGGER trg_product_business_identity
  BEFORE INSERT OR UPDATE OF workspace_id, factory_id, brand_id ON products
  FOR EACH ROW EXECUTE FUNCTION validate_product_business_identity();

CREATE UNIQUE INDEX IF NOT EXISTS uq_products_workspace_sku
  ON products (workspace_id, lower(sku))
  WHERE sku IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_workspace_internal_code
  ON products (workspace_id, lower(internal_code))
  WHERE internal_code IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_workspace_status
  ON products (workspace_id, status, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_workspace_category
  ON products (workspace_id, category_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_products_search
  ON products USING GIN (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(sku, '') || ' ' || coalesce(internal_code, '') || ' ' || coalesce(short_description, '') || ' ' || coalesce(long_description, '')));

CREATE TABLE IF NOT EXISTS product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  sku TEXT,
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT','ACTIVE','INACTIVE','ARCHIVED')),
  barcode TEXT,
  weight NUMERIC(20,4) CHECK (weight IS NULL OR weight >= 0),
  weight_unit TEXT,
  dimension_length NUMERIC(20,4) CHECK (dimension_length IS NULL OR dimension_length >= 0),
  dimension_width NUMERIC(20,4) CHECK (dimension_width IS NULL OR dimension_width >= 0),
  dimension_height NUMERIC(20,4) CHECK (dimension_height IS NULL OR dimension_height >= 0),
  dimension_unit TEXT,
  default_price NUMERIC(20,4) CHECK (default_price IS NULL OR default_price >= 0),
  default_currency CHAR(3),
  moq_quantity NUMERIC(20,4) CHECK (moq_quantity IS NULL OR moq_quantity > 0),
  moq_unit TEXT,
  lead_time_min_days INTEGER CHECK (lead_time_min_days IS NULL OR lead_time_min_days >= 0),
  lead_time_max_days INTEGER CHECK (lead_time_max_days IS NULL OR lead_time_max_days >= lead_time_min_days),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, product_id),
  CHECK (jsonb_typeof(metadata) = 'object')
);
ALTER TABLE product_variants
  DROP CONSTRAINT IF EXISTS fk_product_variant_product;
ALTER TABLE product_variants
  ADD CONSTRAINT fk_product_variant_product
  FOREIGN KEY (workspace_id, product_id) REFERENCES products(workspace_id, id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_variants_workspace_sku
  ON product_variants (workspace_id, lower(sku))
  WHERE sku IS NOT NULL AND status <> 'ARCHIVED';
CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants (workspace_id, product_id, status);

CREATE TABLE IF NOT EXISTS product_specifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  variant_id UUID,
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 200),
  value TEXT NOT NULL CHECK (char_length(trim(value)) BETWEEN 1 AND 2000),
  unit TEXT,
  group_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  market_visibility TEXT NOT NULL DEFAULT 'ALL' CHECK (market_visibility IN ('ALL','PUBLIC','PRIVATE')),
  key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, product_id)
);
ALTER TABLE product_specifications
  DROP CONSTRAINT IF EXISTS fk_product_specification_product,
  DROP CONSTRAINT IF EXISTS fk_product_specification_variant;
ALTER TABLE product_specifications
  ADD CONSTRAINT fk_product_specification_product
  FOREIGN KEY (workspace_id, product_id) REFERENCES products(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE product_specifications
  ADD CONSTRAINT fk_product_specification_variant
  FOREIGN KEY (workspace_id, variant_id, product_id) REFERENCES product_variants(workspace_id, id, product_id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_product_specifications_product ON product_specifications (workspace_id, product_id, variant_id, sort_order);

CREATE TABLE IF NOT EXISTS product_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  variant_id UUID,
  media_type TEXT NOT NULL CHECK (media_type IN ('IMAGE','VIDEO','DOCUMENT','CAD_FILE','DATASHEET','BROCHURE','OTHER')),
  storage_reference TEXT NOT NULL,
  external_url TEXT,
  title TEXT,
  alt_text TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  language TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, id, product_id)
);
ALTER TABLE product_media
  DROP CONSTRAINT IF EXISTS fk_product_media_product,
  DROP CONSTRAINT IF EXISTS fk_product_media_variant;
ALTER TABLE product_media
  ADD CONSTRAINT fk_product_media_product
  FOREIGN KEY (workspace_id, product_id) REFERENCES products(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE product_media
  ADD CONSTRAINT fk_product_media_variant
  FOREIGN KEY (workspace_id, variant_id, product_id) REFERENCES product_variants(workspace_id, id, product_id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_product_media_product ON product_media (workspace_id, product_id, variant_id, sort_order);

CREATE TABLE IF NOT EXISTS product_certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  certificate_type TEXT NOT NULL CHECK (char_length(trim(certificate_type)) BETWEEN 1 AND 120),
  certificate_number TEXT,
  issuing_body TEXT,
  issued_at DATE,
  expires_at DATE,
  document_media_id UUID,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_status IN ('UNVERIFIED','PENDING','VERIFIED','REJECTED','EXPIRED')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  CHECK (expires_at IS NULL OR issued_at IS NULL OR expires_at >= issued_at)
);
ALTER TABLE product_certificates
  DROP CONSTRAINT IF EXISTS fk_product_certificate_product,
  DROP CONSTRAINT IF EXISTS fk_product_certificate_media;
ALTER TABLE product_certificates
  ADD CONSTRAINT fk_product_certificate_product
  FOREIGN KEY (workspace_id, product_id) REFERENCES products(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE product_certificates
  ADD CONSTRAINT fk_product_certificate_media
  FOREIGN KEY (workspace_id, document_media_id, product_id) REFERENCES product_media(workspace_id, id, product_id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_product_certificates_product ON product_certificates (workspace_id, product_id, verification_status);

CREATE TABLE IF NOT EXISTS product_packaging (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  variant_id UUID,
  packaging_type TEXT NOT NULL CHECK (char_length(trim(packaging_type)) BETWEEN 1 AND 120),
  units_per_package NUMERIC(20,4) CHECK (units_per_package IS NULL OR units_per_package > 0),
  package_length NUMERIC(20,4) CHECK (package_length IS NULL OR package_length >= 0),
  package_width NUMERIC(20,4) CHECK (package_width IS NULL OR package_width >= 0),
  package_height NUMERIC(20,4) CHECK (package_height IS NULL OR package_height >= 0),
  package_weight NUMERIC(20,4) CHECK (package_weight IS NULL OR package_weight >= 0),
  dimension_unit TEXT,
  weight_unit TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id)
);
ALTER TABLE product_packaging
  DROP CONSTRAINT IF EXISTS fk_product_packaging_product,
  DROP CONSTRAINT IF EXISTS fk_product_packaging_variant;
ALTER TABLE product_packaging
  ADD CONSTRAINT fk_product_packaging_product
  FOREIGN KEY (workspace_id, product_id) REFERENCES products(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE product_packaging
  ADD CONSTRAINT fk_product_packaging_variant
  FOREIGN KEY (workspace_id, variant_id, product_id) REFERENCES product_variants(workspace_id, id, product_id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS product_capacity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  variant_id UUID,
  value NUMERIC(20,4) NOT NULL CHECK (value >= 0),
  unit TEXT NOT NULL CHECK (char_length(trim(unit)) BETWEEN 1 AND 80),
  period TEXT NOT NULL CHECK (char_length(trim(period)) BETWEEN 1 AND 80),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, product_id, variant_id, unit, period)
);
ALTER TABLE product_capacity
  DROP CONSTRAINT IF EXISTS fk_product_capacity_product,
  DROP CONSTRAINT IF EXISTS fk_product_capacity_variant;
ALTER TABLE product_capacity
  ADD CONSTRAINT fk_product_capacity_product
  FOREIGN KEY (workspace_id, product_id) REFERENCES products(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE product_capacity
  ADD CONSTRAINT fk_product_capacity_variant
  FOREIGN KEY (workspace_id, variant_id, product_id) REFERENCES product_variants(workspace_id, id, product_id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS product_prices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  variant_id UUID,
  market_code TEXT,
  currency CHAR(3) NOT NULL,
  amount NUMERIC(20,4) CHECK (amount IS NULL OR amount >= 0),
  min_quantity NUMERIC(20,4) CHECK (min_quantity IS NULL OR min_quantity > 0),
  max_quantity NUMERIC(20,4) CHECK (max_quantity IS NULL OR max_quantity >= min_quantity),
  pricing_type TEXT NOT NULL DEFAULT 'QUOTE_REQUIRED' CHECK (pricing_type IN ('FIXED','STARTING_FROM','RANGE','QUOTE_REQUIRED','TIERED')),
  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT','ACTIVE','INACTIVE','EXPIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  CHECK (pricing_type = 'QUOTE_REQUIRED' OR amount IS NOT NULL)
);
ALTER TABLE product_prices
  DROP CONSTRAINT IF EXISTS fk_product_price_product,
  DROP CONSTRAINT IF EXISTS fk_product_price_variant;
ALTER TABLE product_prices
  ADD CONSTRAINT fk_product_price_product
  FOREIGN KEY (workspace_id, product_id) REFERENCES products(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE product_prices
  ADD CONSTRAINT fk_product_price_variant
  FOREIGN KEY (workspace_id, variant_id, product_id) REFERENCES product_variants(workspace_id, id, product_id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_product_prices_lookup ON product_prices (workspace_id, product_id, market_code, currency, status, valid_from);

CREATE TABLE IF NOT EXISTS product_market_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  market_code TEXT NOT NULL CHECK (market_code ~ '^[A-Z]{2,3}(-[A-Z]{2})?$'),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT','ACTIVE','INACTIVE','ARCHIVED')),
  localized_name TEXT,
  localized_description TEXT,
  market_price NUMERIC(20,4) CHECK (market_price IS NULL OR market_price >= 0),
  currency CHAR(3),
  moq_quantity NUMERIC(20,4) CHECK (moq_quantity IS NULL OR moq_quantity > 0),
  moq_unit TEXT,
  lead_time_min_days INTEGER CHECK (lead_time_min_days IS NULL OR lead_time_min_days >= 0),
  lead_time_max_days INTEGER CHECK (lead_time_max_days IS NULL OR lead_time_max_days >= lead_time_min_days),
  compliance_notes TEXT,
  availability TEXT,
  sales_priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, product_id, market_code),
  UNIQUE (workspace_id, id)
);
ALTER TABLE product_market_data
  DROP CONSTRAINT IF EXISTS fk_product_market_product;
ALTER TABLE product_market_data
  ADD CONSTRAINT fk_product_market_product
  FOREIGN KEY (workspace_id, product_id) REFERENCES products(workspace_id, id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS product_translations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  language TEXT NOT NULL CHECK (language ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 300),
  short_description TEXT,
  long_description TEXT,
  seo_title TEXT,
  seo_description TEXT,
  technical_metadata JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','GENERATED','VERIFIED','ACTIVE','OUTDATED')),
  source TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','AI_GENERATED','IMPORTED')),
  quality_state TEXT NOT NULL DEFAULT 'UNREVIEWED' CHECK (quality_state IN ('UNREVIEWED','REVIEW_REQUIRED','VERIFIED','REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, product_id, language),
  UNIQUE (workspace_id, id),
  CHECK (jsonb_typeof(technical_metadata) = 'object')
);
ALTER TABLE product_translations
  DROP CONSTRAINT IF EXISTS fk_product_translation_product;
ALTER TABLE product_translations
  ADD CONSTRAINT fk_product_translation_product
  FOREIGN KEY (workspace_id, product_id) REFERENCES products(workspace_id, id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_product_translations_product ON product_translations (workspace_id, product_id, language, status);

CREATE TABLE IF NOT EXISTS product_seo_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  seo_title TEXT,
  meta_description TEXT,
  canonical_name TEXT,
  keywords TEXT[] NOT NULL DEFAULT '{}',
  faq_candidates JSONB NOT NULL DEFAULT '[]',
  buyer_questions TEXT[] NOT NULL DEFAULT '{}',
  applications TEXT[] NOT NULL DEFAULT '{}',
  search_intent TEXT,
  source TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','AI_GENERATED','IMPORTED')),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','OUTDATED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, product_id, language),
  UNIQUE (workspace_id, id),
  CHECK (jsonb_typeof(faq_candidates) = 'array')
);
ALTER TABLE product_seo_metadata
  DROP CONSTRAINT IF EXISTS fk_product_seo_product;
ALTER TABLE product_seo_metadata
  ADD CONSTRAINT fk_product_seo_product
  FOREIGN KEY (workspace_id, product_id) REFERENCES products(workspace_id, id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS product_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 200),
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, product_id, name),
  UNIQUE (workspace_id, id)
);
ALTER TABLE product_applications
  DROP CONSTRAINT IF EXISTS fk_product_application_product;
ALTER TABLE product_applications
  ADD CONSTRAINT fk_product_application_product
  FOREIGN KEY (workspace_id, product_id) REFERENCES products(workspace_id, id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS product_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_product_id UUID NOT NULL,
  target_product_id UUID NOT NULL,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN ('ACCESSORY','REPLACEMENT','COMPATIBLE_WITH','UPSELL','CROSS_SELL','COMPONENT_OF','ALTERNATIVE')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, source_product_id, target_product_id, relationship_type),
  CHECK (source_product_id <> target_product_id)
);
ALTER TABLE product_relationships
  DROP CONSTRAINT IF EXISTS fk_product_relationship_source,
  DROP CONSTRAINT IF EXISTS fk_product_relationship_target;
ALTER TABLE product_relationships
  ADD CONSTRAINT fk_product_relationship_source
  FOREIGN KEY (workspace_id, source_product_id) REFERENCES products(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE product_relationships
  ADD CONSTRAINT fk_product_relationship_target
  FOREIGN KEY (workspace_id, target_product_id) REFERENCES products(workspace_id, id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS product_legacy_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('workspace_offering','workspace_record','website_product','other')),
  source_id UUID NOT NULL,
  canonical_product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  migration_status TEXT NOT NULL DEFAULT 'TRANSFORMATION_REQUIRED' CHECK (migration_status IN ('AUTO_MIGRATABLE','TRANSFORMATION_REQUIRED','AMBIGUOUS','LEGACY_ONLY','FAILED')),
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, source_type, source_id),
  CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_product_legacy_mappings_product ON product_legacy_mappings (workspace_id, canonical_product_id);

-- All child tables use the same updated_at contract as the rest of Lulu.
DROP TRIGGER IF EXISTS trg_product_categories_set_updated_at ON product_categories;
CREATE TRIGGER trg_product_categories_set_updated_at BEFORE UPDATE ON product_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_products_set_updated_at ON products;
CREATE TRIGGER trg_products_set_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_product_variants_set_updated_at ON product_variants;
CREATE TRIGGER trg_product_variants_set_updated_at BEFORE UPDATE ON product_variants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_product_specifications_set_updated_at ON product_specifications;
CREATE TRIGGER trg_product_specifications_set_updated_at BEFORE UPDATE ON product_specifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_product_media_set_updated_at ON product_media;
CREATE TRIGGER trg_product_media_set_updated_at BEFORE UPDATE ON product_media FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_product_certificates_set_updated_at ON product_certificates;
CREATE TRIGGER trg_product_certificates_set_updated_at BEFORE UPDATE ON product_certificates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_product_packaging_set_updated_at ON product_packaging;
CREATE TRIGGER trg_product_packaging_set_updated_at BEFORE UPDATE ON product_packaging FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_product_capacity_set_updated_at ON product_capacity;
CREATE TRIGGER trg_product_capacity_set_updated_at BEFORE UPDATE ON product_capacity FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_product_prices_set_updated_at ON product_prices;
CREATE TRIGGER trg_product_prices_set_updated_at BEFORE UPDATE ON product_prices FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_product_market_data_set_updated_at ON product_market_data;
CREATE TRIGGER trg_product_market_data_set_updated_at BEFORE UPDATE ON product_market_data FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_product_translations_set_updated_at ON product_translations;
CREATE TRIGGER trg_product_translations_set_updated_at BEFORE UPDATE ON product_translations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_product_seo_metadata_set_updated_at ON product_seo_metadata;
CREATE TRIGGER trg_product_seo_metadata_set_updated_at BEFORE UPDATE ON product_seo_metadata FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_product_applications_set_updated_at ON product_applications;
CREATE TRIGGER trg_product_applications_set_updated_at BEFORE UPDATE ON product_applications FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_product_relationships_set_updated_at ON product_relationships;
CREATE TRIGGER trg_product_relationships_set_updated_at BEFORE UPDATE ON product_relationships FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_product_legacy_mappings_set_updated_at ON product_legacy_mappings;
CREATE TRIGGER trg_product_legacy_mappings_set_updated_at BEFORE UPDATE ON product_legacy_mappings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Legacy offerings are structured enough to migrate automatically. Their
-- source rows remain untouched and are linked for compatibility.
WITH inserted AS (
  INSERT INTO products (
    workspace_id, status, product_type, sku, name, short_description,
    long_description, default_currency, default_price, pricing_type,
    visibility, source_language, legacy_source_type, legacy_source_id,
    created_at, updated_at
  )
  SELECT wo.workspace_id,
         CASE upper(wo.status) WHEN 'ACTIVE' THEN 'ACTIVE' WHEN 'INACTIVE' THEN 'INACTIVE' WHEN 'ARCHIVED' THEN 'ARCHIVED' ELSE 'DRAFT' END,
         CASE wo.offering_type WHEN 'service' THEN 'SERVICE' ELSE 'PHYSICAL_PRODUCT' END,
         CASE WHEN wo.sku IS NOT NULL AND (SELECT count(*) FROM workspace_offerings wo2 WHERE wo2.workspace_id = wo.workspace_id AND wo2.deleted_at IS NULL AND lower(wo2.sku) = lower(wo.sku)) = 1 THEN wo.sku ELSE NULL END,
         wo.name,
         wo.description,
         wo.value_proposition,
         NULLIF(upper(left(coalesce(wo.price_currency, ''), 3)), ''),
         wo.price_amount,
         CASE WHEN wo.price_amount IS NOT NULL THEN 'FIXED' ELSE 'QUOTE_REQUIRED' END,
         'WORKSPACE',
         'en',
         'workspace_offering',
         wo.id,
         wo.created_at,
         wo.updated_at
    FROM workspace_offerings wo
   WHERE wo.deleted_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM product_legacy_mappings lm
        WHERE lm.workspace_id = wo.workspace_id
          AND lm.source_type = 'workspace_offering'
          AND lm.source_id = wo.id
     )
  RETURNING id, workspace_id, legacy_source_id
)
INSERT INTO product_legacy_mappings (workspace_id, source_type, source_id, canonical_product_id, migration_status, details)
SELECT workspace_id, 'workspace_offering', legacy_source_id, id, 'AUTO_MIGRATABLE', '{"source":"workspace_offerings"}'::jsonb
  FROM inserted
ON CONFLICT (workspace_id, source_type, source_id) DO NOTHING;

-- Generic ecommerce product records are transformed conservatively. No source
-- record is deleted; records without enough structure are explicitly marked
-- TRANSFORMATION_REQUIRED rather than treated as verified product facts.
WITH inserted AS (
  INSERT INTO products (
    workspace_id, status, product_type, sku, name, short_description,
    default_currency, default_price, pricing_type, visibility,
    source_language, legacy_source_type, legacy_source_id, created_by,
    created_at, updated_at
  )
  SELECT wr.workspace_id,
         CASE upper(wr.status) WHEN 'ACTIVE' THEN 'ACTIVE' WHEN 'INACTIVE' THEN 'INACTIVE' WHEN 'ARCHIVED' THEN 'ARCHIVED' ELSE 'DRAFT' END,
         'PHYSICAL_PRODUCT',
         CASE WHEN NULLIF(wr.data->>'sku', '') IS NOT NULL AND (SELECT count(*) FROM workspace_records wr2 WHERE wr2.workspace_id = wr.workspace_id AND wr2.resource_type = 'ecommerce_products' AND wr2.deleted_at IS NULL AND lower(wr2.data->>'sku') = lower(wr.data->>'sku')) = 1 THEN NULLIF(wr.data->>'sku', '') ELSE NULL END,
         wr.name,
         wr.description,
         NULLIF(upper(left(coalesce(wr.currency, ''), 3)), ''),
         wr.value_amount,
         CASE WHEN wr.value_amount IS NOT NULL THEN 'FIXED' ELSE 'QUOTE_REQUIRED' END,
         'WORKSPACE',
         'en',
         'workspace_record',
         wr.id,
         wr.created_by,
         wr.created_at,
         wr.updated_at
    FROM workspace_records wr
   WHERE wr.resource_type = 'ecommerce_products'
     AND wr.deleted_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM product_legacy_mappings lm
        WHERE lm.workspace_id = wr.workspace_id
          AND lm.source_type = 'workspace_record'
          AND lm.source_id = wr.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM products p
        WHERE p.workspace_id = wr.workspace_id
          AND p.legacy_source_type = 'workspace_record'
          AND p.legacy_source_id = wr.id
     )
  RETURNING id, workspace_id, legacy_source_id
)
INSERT INTO product_legacy_mappings (workspace_id, source_type, source_id, canonical_product_id, migration_status, details)
SELECT workspace_id, 'workspace_record', legacy_source_id, id, 'TRANSFORMATION_REQUIRED', '{"source":"workspace_records","resourceType":"ecommerce_products"}'::jsonb
  FROM inserted
ON CONFLICT (workspace_id, source_type, source_id) DO NOTHING;
