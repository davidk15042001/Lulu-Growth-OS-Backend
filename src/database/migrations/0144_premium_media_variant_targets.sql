-- Keep premium-media work attached to the exact sellable variant when a
-- product family has more than one purchasable configuration.
ALTER TABLE premium_media_jobs
  ADD COLUMN IF NOT EXISTS variant_id UUID;

ALTER TABLE premium_media_jobs
  DROP CONSTRAINT IF EXISTS premium_media_jobs_variant_product_fk;
ALTER TABLE premium_media_jobs
  ADD CONSTRAINT premium_media_jobs_variant_product_fk
  FOREIGN KEY (workspace_id, variant_id, product_id)
  REFERENCES product_variants(workspace_id, id, product_id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_premium_media_jobs_variant
  ON premium_media_jobs(workspace_id, product_id, variant_id, created_at DESC);

ALTER TABLE premium_media_candidates
  ADD COLUMN IF NOT EXISTS variant_id UUID;

ALTER TABLE premium_media_candidates
  DROP CONSTRAINT IF EXISTS premium_media_candidates_variant_product_fk;
ALTER TABLE premium_media_candidates
  ADD CONSTRAINT premium_media_candidates_variant_product_fk
  FOREIGN KEY (workspace_id, variant_id, product_id)
  REFERENCES product_variants(workspace_id, id, product_id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_premium_media_candidates_variant
  ON premium_media_candidates(workspace_id, product_id, variant_id, created_at DESC);
