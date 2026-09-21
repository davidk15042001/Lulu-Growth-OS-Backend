-- Keep catalog evidence traceable to its onboarding source without making
-- document cleanup delete the evidence required for review and audit.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'catalog_import_evidence_source_document_fk'
  ) THEN
    ALTER TABLE catalog_import_evidence
      ADD CONSTRAINT catalog_import_evidence_source_document_fk
      FOREIGN KEY (source_document_id)
      REFERENCES onboarding_documents(id)
      ON DELETE SET NULL
      NOT VALID;
  END IF;
END $$;

COMMENT ON CONSTRAINT catalog_import_evidence_source_document_fk
  ON catalog_import_evidence IS
  'Evidence keeps a traceable onboarding source when present; source cleanup preserves the evidence row.';
