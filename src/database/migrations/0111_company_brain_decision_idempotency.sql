-- Every autonomous terminal outcome should leave one durable, evidence-linked
-- Company Brain decision. The source event is the idempotency boundary: a
-- replayed domain event must never create a second decision row.

CREATE UNIQUE INDEX IF NOT EXISTS company_brain_decisions_source_event_uidx
  ON company_brain_decisions(workspace_id, decision_type, (evidence->>'sourceEventId'))
  WHERE evidence ? 'sourceEventId';
