-- Automatic agents are explicit, scoped workflow principals. A workspace
-- owner's UUID may still be retained as a legacy audit/FK subject, but their
-- owner role is never the authorization source for an automatic command.
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS execution_actor_type TEXT NOT NULL DEFAULT 'USER',
  ADD COLUMN IF NOT EXISTS execution_actor_ref TEXT,
  ADD COLUMN IF NOT EXISTS execution_capability_scope JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_execution_actor_type_check,
  DROP CONSTRAINT IF EXISTS agent_runs_execution_capability_scope_check;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_execution_actor_type_check
    CHECK (execution_actor_type IN ('USER','WORKFLOW')),
  ADD CONSTRAINT agent_runs_execution_capability_scope_check
    CHECK (jsonb_typeof(execution_capability_scope) = 'array');

UPDATE agent_runs
SET execution_actor_type = CASE WHEN created_by IS NULL OR plan ? 'team' THEN 'WORKFLOW' ELSE 'USER' END,
    execution_actor_ref = CASE
      WHEN created_by IS NULL OR plan ? 'team' THEN 'lulu:legacy-automatic:' || id::text
      ELSE created_by::text
    END,
    execution_capability_scope = CASE
      WHEN created_by IS NOT NULL AND NOT (plan ? 'team') THEN '[]'::jsonb
      WHEN plan->>'module' = 'finance' THEN '["agents.execute","finance.manage","invoices.create","workspace.write"]'::jsonb
      WHEN plan->>'module' = 'sales' THEN '["agents.execute","crm.manage","leads.manage","omnichannel.reply","opportunities.manage","quotes.create","workspace.write"]'::jsonb
      WHEN plan->>'module' = 'crm' THEN '["agents.execute","crm.manage","leads.manage","omnichannel.reply","opportunities.manage","workspace.write"]'::jsonb
      WHEN plan->>'module' = 'email' THEN '["agents.execute","omnichannel.reply","workspace.write"]'::jsonb
      WHEN plan->>'module' = 'marketing' THEN '["agents.execute","social.publish","workspace.write"]'::jsonb
      WHEN plan->>'module' = 'ads' THEN '["advertising.manage","agents.execute","workspace.write"]'::jsonb
      WHEN plan->>'module' IN ('website','seo','geo','aeo') THEN '["agents.execute","website.manage","website.publish","workspace.write"]'::jsonb
      WHEN plan->>'module' = 'commerce' THEN '["agents.execute","orders.manage","products.update","workspace.write"]'::jsonb
      WHEN plan->>'module' = 'reputation' THEN '["agents.execute","omnichannel.reply","workspace.write"]'::jsonb
      WHEN plan->>'module' = 'settings' THEN '["agents.execute","providers.manage","workspace.write"]'::jsonb
      ELSE '["agents.execute","workspace.write"]'::jsonb
    END
WHERE execution_actor_ref IS NULL;

ALTER TABLE agent_action_packets
  ADD COLUMN IF NOT EXISTS actor_type TEXT NOT NULL DEFAULT 'USER',
  ADD COLUMN IF NOT EXISTS actor_ref TEXT,
  ADD COLUMN IF NOT EXISTS required_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE agent_action_packets
  DROP CONSTRAINT IF EXISTS agent_action_packets_actor_type_check,
  DROP CONSTRAINT IF EXISTS agent_action_packets_required_capabilities_check;

ALTER TABLE agent_action_packets
  ADD CONSTRAINT agent_action_packets_actor_type_check
    CHECK (actor_type IN ('USER','WORKFLOW')),
  ADD CONSTRAINT agent_action_packets_required_capabilities_check
    CHECK (jsonb_typeof(required_capabilities) = 'array');

UPDATE agent_action_packets packet
SET actor_type = run.execution_actor_type,
    actor_ref = run.execution_actor_ref,
    required_capabilities = COALESCE((
      SELECT jsonb_agg(required_capability ORDER BY required_capability)
      FROM (
        SELECT DISTINCT CASE command->>'type'
          WHEN 'record.create_artifact' THEN 'workspace.write'
          WHEN 'crm.create_followup_task' THEN 'crm.manage'
          WHEN 'sales.create_followup_task' THEN 'leads.manage'
          WHEN 'advertising.create_optimization' THEN 'advertising.manage'
          WHEN 'finance.create_automation' THEN 'finance.manage'
          WHEN 'finance.invoice.create_from_order' THEN 'invoices.create'
          WHEN 'google_reviews.reply' THEN 'omnichannel.reply'
          WHEN 'email.create_draft' THEN 'omnichannel.reply'
          WHEN 'email.create_ai_draft' THEN 'omnichannel.reply'
          WHEN 'omnichannel.send_message' THEN 'omnichannel.reply'
          WHEN 'website.publish_job' THEN 'website.publish'
          WHEN 'ecommerce.generate_product_images' THEN 'products.update'
          WHEN 'commerce.order.create' THEN 'orders.manage'
          WHEN 'commerce.order.update' THEN 'orders.manage'
          WHEN 'commerce.order.transition' THEN 'orders.manage'
          WHEN 'commerce.inventory.adjust' THEN 'orders.manage'
          WHEN 'commerce.fulfillment.create' THEN 'orders.manage'
          WHEN 'commerce.fulfillment.transition' THEN 'orders.manage'
          WHEN 'social.content.publish' THEN 'social.publish'
          WHEN 'social.publication.retry' THEN 'social.publish'
          WHEN 'social.publication.cancel' THEN 'social.publish'
          ELSE NULL
        END AS required_capability
        FROM workspace_records record,
             jsonb_array_elements(
               CASE WHEN jsonb_typeof(record.data->'commands')='array'
                 THEN record.data->'commands' ELSE '[]'::jsonb END
             ) command
        WHERE record.id = packet.record_id
          AND record.workspace_id = packet.workspace_id
      ) mapped
      WHERE required_capability IS NOT NULL
    ), '[]'::jsonb)
FROM agent_runs run
WHERE run.id = packet.run_id
  AND run.workspace_id = packet.workspace_id;

-- A processed business event can wait for prepaid AI funds without creating a
-- doomed run. Funding events claim and replay these rows idempotently.
CREATE TABLE IF NOT EXISTS agent_reactive_deferrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_event_id UUID NOT NULL REFERENCES domain_events(id) ON DELETE CASCADE,
  source_event_type TEXT NOT NULL,
  required_funding TEXT NOT NULL DEFAULT 'AI_WALLET' CHECK (required_funding IN ('AI_WALLET')),
  status TEXT NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','RESUMING','RESUMED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_at TIMESTAMPTZ,
  resumed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, source_event_id)
);

CREATE INDEX IF NOT EXISTS agent_reactive_deferrals_waiting_idx
  ON agent_reactive_deferrals(workspace_id, created_at)
  WHERE status IN ('WAITING','RESUMING');

DROP TRIGGER IF EXISTS agent_reactive_deferrals_set_updated_at ON agent_reactive_deferrals;
CREATE TRIGGER agent_reactive_deferrals_set_updated_at
BEFORE UPDATE ON agent_reactive_deferrals
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
