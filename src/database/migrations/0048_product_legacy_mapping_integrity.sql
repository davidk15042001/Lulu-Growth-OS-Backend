-- Part 4 hardening: a legacy mapping must point to a product in the same workspace.
ALTER TABLE product_legacy_mappings
  DROP CONSTRAINT IF EXISTS product_legacy_mappings_canonical_product_id_fkey;
ALTER TABLE product_legacy_mappings
  DROP CONSTRAINT IF EXISTS fk_product_legacy_mapping_product_workspace;
ALTER TABLE product_legacy_mappings
  ADD CONSTRAINT fk_product_legacy_mapping_product_workspace
  FOREIGN KEY (workspace_id, canonical_product_id)
  REFERENCES products (workspace_id, id)
  ON DELETE CASCADE;
