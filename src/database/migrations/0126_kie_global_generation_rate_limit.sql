-- Kie.ai applies its generation quota per Lulu account, not per customer
-- workspace.  Keep one durable next-slot clock so every API process and every
-- tenant shares the same provider queue.  The application advances this clock
-- transactionally under a PostgreSQL advisory lock before dispatching a Kie
-- request.
CREATE TABLE IF NOT EXISTS provider_rate_limit_state (
  provider_key TEXT PRIMARY KEY,
  next_slot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE provider_rate_limit_state IS
  'Durable cross-tenant provider dispatch clocks. Kie generation is globally rate limited because the provider quota is account-wide.';
