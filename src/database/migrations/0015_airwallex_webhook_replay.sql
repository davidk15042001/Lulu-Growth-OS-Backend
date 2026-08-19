ALTER TABLE airwallex_webhook_events
  ADD COLUMN IF NOT EXISTS processing_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error_code TEXT;

CREATE INDEX IF NOT EXISTS idx_airwallex_webhook_events_processing
  ON airwallex_webhook_events (processing_at)
  WHERE processed_at IS NULL;
