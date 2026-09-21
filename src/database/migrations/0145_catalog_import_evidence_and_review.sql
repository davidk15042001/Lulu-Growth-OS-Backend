-- A catalog import is intentionally a two-step process: parse and retain
-- source evidence first, then create only confirmed product-master drafts.
ALTER TABLE workspace_knowledge_activations
  DROP CONSTRAINT IF EXISTS workspace_knowledge_activations_status_check;
ALTER TABLE workspace_knowledge_activations
  ADD CONSTRAINT workspace_knowledge_activations_status_check
  CHECK (status IN ('PROCESSING','REVIEW_REQUIRED','COMPLETED','FAILED'));

CREATE TABLE IF NOT EXISTS catalog_import_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  activation_id UUID NOT NULL REFERENCES workspace_knowledge_activations(id) ON DELETE CASCADE,
  source_document_id UUID,
  asset_id TEXT NOT NULL CHECK (char_length(trim(asset_id)) BETWEEN 1 AND 300),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('DOCUMENT_TEXT','PDF_PAGE_TEXT','PDF_IMAGE','UPLOADED_IMAGE')),
  page_number INTEGER CHECK (page_number IS NULL OR page_number > 0),
  mime_type TEXT,
  storage_reference TEXT,
  extracted_text TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (activation_id, asset_id),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_catalog_import_evidence_activation
  ON catalog_import_evidence (workspace_id, activation_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_catalog_import_evidence_document
  ON catalog_import_evidence (workspace_id, source_document_id, page_number)
  WHERE source_document_id IS NOT NULL;
