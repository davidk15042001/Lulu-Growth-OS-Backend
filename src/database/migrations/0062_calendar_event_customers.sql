ALTER TABLE calendar_native_events
  ADD COLUMN IF NOT EXISTS customer_record_id UUID;

CREATE INDEX IF NOT EXISTS idx_calendar_native_events_customer
  ON calendar_native_events(workspace_id, customer_record_id)
  WHERE customer_record_id IS NOT NULL;
