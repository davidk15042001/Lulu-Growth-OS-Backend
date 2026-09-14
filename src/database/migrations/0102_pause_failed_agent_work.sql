-- Failed autonomous work must stop immediately. Automatic replay can charge
-- the AI provider again and can repeat an external side effect. A workspace
-- user can still explicitly resume the paused Office item after fixing it.

CREATE OR REPLACE FUNCTION office_agent_run_projection_trigger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_attempt_started BOOLEAN := FALSE;
BEGIN
  IF TG_OP='UPDATE' THEN
    v_attempt_started := NEW.worker_id IS NOT NULL AND (
      OLD.worker_id IS DISTINCT FROM NEW.worker_id OR NEW.attempt_count > OLD.attempt_count
    );
  END IF;
  PERFORM office_materialize_agent_run(NEW,v_attempt_started);

  -- The canonical agent_runs table keeps the failure outcome for auditability.
  -- The customer-facing Office state is paused, so it cannot look runnable and
  -- the only next execution is an explicit Resume/Retry command.
  IF NEW.status='failed' THEN
    UPDATE office_work_items
    SET status='paused',
        finished_at=NULL,
        error_code=COALESCE(error_code,NEW.error_code,'AGENT_RUN_AUTO_PAUSED'),
        error_message=COALESCE(error_message,NEW.error_message,'Agent work paused after a failure. Resume it manually after fixing the issue.'),
        version=version+1,
        updated_at=NOW()
    WHERE workspace_id=NEW.workspace_id
      AND source_type='agent_run'
      AND source_agent_run_id=NEW.id
      AND status='failed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION office_refresh_parent_run_work_item(p_workspace_id UUID, p_parent_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_run_status TEXT;
  v_next_status TEXT;
  v_has_active BOOLEAN;
  v_has_failed BOOLEAN;
  v_has_cancelled BOOLEAN;
BEGIN
  IF p_parent_id IS NULL THEN RETURN; END IF;
  SELECT ar.status INTO v_run_status
  FROM office_work_items parent
  JOIN agent_runs ar
    ON ar.workspace_id=parent.workspace_id AND ar.id=parent.source_agent_run_id
  WHERE parent.workspace_id=p_workspace_id AND parent.id=p_parent_id
    AND parent.source_type='agent_run';
  IF NOT FOUND OR v_run_status NOT IN ('completed','failed','cancelled') THEN RETURN; END IF;

  SELECT
    bool_or(status IN ('queued','running','waiting','paused','waiting_for_approval','human_controlled')),
    bool_or(status='failed'),
    bool_or(status='cancelled')
  INTO v_has_active,v_has_failed,v_has_cancelled
  FROM office_work_items
  WHERE workspace_id=p_workspace_id AND parent_work_item_id=p_parent_id;

  v_next_status := CASE
    WHEN v_run_status='cancelled' THEN 'cancelled'
    WHEN v_run_status='failed' THEN 'paused'
    WHEN COALESCE(v_has_active,FALSE) THEN 'waiting'
    WHEN COALESCE(v_has_failed,FALSE) THEN 'failed'
    WHEN COALESCE(v_has_cancelled,FALSE) THEN 'cancelled'
    ELSE 'completed' END;

  UPDATE office_work_items SET
    status=v_next_status,
    finished_at=CASE WHEN v_next_status IN ('completed','cancelled') THEN COALESCE(finished_at,NOW()) ELSE NULL END,
    error_code=CASE
      WHEN v_next_status='failed' AND v_run_status='completed' THEN 'AGENT_ACTION_PACKET_FAILED'
      WHEN v_run_status='completed' THEN NULL
      ELSE error_code END,
    error_message=CASE
      WHEN v_next_status='failed' AND v_run_status='completed'
        THEN 'A downstream action packet failed after the agent reasoning run completed.'
      WHEN v_run_status='completed' THEN NULL
      ELSE error_message END,
    version=version+1,
    updated_at=NOW()
  WHERE workspace_id=p_workspace_id AND id=p_parent_id AND status IS DISTINCT FROM v_next_status;
END;
$$;

-- Repair already-visible failed Office items without changing canonical audit
-- records. These updates are idempotent and intentionally tenant-scoped.
UPDATE office_work_items wi
SET status='paused',
    finished_at=NULL,
    error_code=COALESCE(wi.error_code,'AGENT_RUN_AUTO_PAUSED'),
    error_message=COALESCE(wi.error_message,'Agent work paused after a failure. Resume it manually after fixing the issue.'),
    version=wi.version+1,
    updated_at=NOW()
FROM agent_runs ar
WHERE wi.workspace_id=ar.workspace_id
  AND wi.source_type='agent_run'
  AND wi.source_agent_run_id=ar.id
  AND wi.status='failed'
  AND ar.status='failed';

UPDATE office_work_items wi
SET status='paused',
    finished_at=NULL,
    error_code=COALESCE(wi.error_code,'AGENT_ACTION_AUTO_PAUSED'),
    error_message=COALESCE(wi.error_message,'Agent action paused after a failure. Resume it manually after fixing the issue.'),
    version=wi.version+1,
    updated_at=NOW()
FROM workspace_records record
WHERE wi.workspace_id=record.workspace_id
  AND wi.source_type='agent_action_packet'
  AND wi.source_record_id=record.id
  AND wi.status='failed'
  AND record.stage='execution_failed';
