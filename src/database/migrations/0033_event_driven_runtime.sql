-- 0033_event_driven_runtime.sql
-- Durable, versioned domain events with at-least-once consumer delivery.

CREATE TABLE IF NOT EXISTS domain_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence BIGSERIAL NOT NULL UNIQUE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (char_length(trim(event_type)) BETWEEN 3 AND 160),
  event_version INTEGER NOT NULL DEFAULT 1 CHECK (event_version > 0),
  aggregate_type TEXT NOT NULL CHECK (char_length(trim(aggregate_type)) BETWEEN 1 AND 120),
  aggregate_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'processed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 10 CHECK (max_attempts > 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  processed_at TIMESTAMPTZ,
  dead_lettered_at TIMESTAMPTZ,
  last_error TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS domain_events_idempotency_idx
  ON domain_events (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS domain_events_delivery_idx
  ON domain_events (status, available_at, sequence)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS domain_events_workspace_stream_idx
  ON domain_events (workspace_id, sequence);

CREATE INDEX IF NOT EXISTS domain_events_aggregate_idx
  ON domain_events (aggregate_type, aggregate_id, sequence);

CREATE TABLE IF NOT EXISTS domain_event_receipts (
  event_id UUID NOT NULL REFERENCES domain_events(id) ON DELETE CASCADE,
  consumer_name TEXT NOT NULL CHECK (char_length(trim(consumer_name)) BETWEEN 3 AND 160),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result JSONB,
  PRIMARY KEY (event_id, consumer_name),
  CHECK (result IS NULL OR jsonb_typeof(result) = 'object')
);

CREATE INDEX IF NOT EXISTS domain_event_receipts_consumer_idx
  ON domain_event_receipts (consumer_name, processed_at DESC);

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS worker_id TEXT,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS agent_runs_worker_queue_idx
  ON agent_runs (status, updated_at, created_at)
  WHERE status IN ('queued', 'planning', 'running');

CREATE INDEX IF NOT EXISTS workspace_content_refresh_worker_idx
  ON workspace_content_refresh_jobs (status, updated_at, created_at)
  WHERE status IN ('queued', 'running');
