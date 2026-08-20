-- AI usage ledger for transparent token credits and customer cost accounting.
CREATE TABLE IF NOT EXISTS ai_usage_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  total_tokens INTEGER GENERATED ALWAYS AS (input_tokens + output_tokens) STORED,
  credits NUMERIC(18,6) GENERATED ALWAYS AS ((input_tokens + output_tokens)::numeric / 1000) STORED,
  provider_cost_usd NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (provider_cost_usd >= 0),
  customer_cost_usd NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (customer_cost_usd >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_ledger_workspace_created
  ON ai_usage_ledger (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_ledger_workspace_model
  ON ai_usage_ledger (workspace_id, model, created_at DESC);
