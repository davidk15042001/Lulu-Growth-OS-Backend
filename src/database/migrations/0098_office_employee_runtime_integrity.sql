-- Keep Digital Employee projections aligned with the exact work an employee
-- still owns.  Completed contributor handoffs must not make that employee look
-- busy, and a reasoning run remains non-terminal while any real downstream
-- action packet is still active.

CREATE OR REPLACE FUNCTION office_refresh_employee_state(p_workspace_id UUID, p_employee_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_employee digital_employees%ROWTYPE;
  v_item office_work_items%ROWTYPE;
  v_active_count INTEGER;
  v_failed_count INTEGER;
  v_completed_today INTEGER;
  v_assignment_count INTEGER;
  v_state TEXT;
  v_last_sequence BIGINT;
BEGIN
  SELECT * INTO v_employee FROM digital_employees
  WHERE workspace_id=p_workspace_id AND id=p_employee_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT wi.* INTO v_item
  FROM office_work_items wi
  WHERE wi.workspace_id=p_workspace_id
    AND (wi.primary_employee_id=p_employee_id OR EXISTS (
      SELECT 1 FROM office_work_item_assignments a
      WHERE a.workspace_id=wi.workspace_id AND a.work_item_id=wi.id
        AND a.employee_id=p_employee_id AND a.completed_at IS NULL
    ))
    AND wi.status IN ('queued','running','waiting','paused','waiting_for_approval','human_controlled','failed')
  ORDER BY
    CASE wi.status
      WHEN 'human_controlled' THEN 90 WHEN 'waiting_for_approval' THEN 80
      WHEN 'failed' THEN 70 WHEN 'running' THEN 60 WHEN 'paused' THEN 50
      WHEN 'waiting' THEN 40 ELSE 30 END DESC,
    wi.priority DESC, wi.updated_at DESC, wi.id
  LIMIT 1;

  SELECT
    count(*) FILTER (
      WHERE wi.status IN ('queued','running','waiting','paused','waiting_for_approval','human_controlled')
        AND (wi.primary_employee_id=p_employee_id OR EXISTS (
          SELECT 1 FROM office_work_item_assignments active_assignment
          WHERE active_assignment.workspace_id=wi.workspace_id
            AND active_assignment.work_item_id=wi.id
            AND active_assignment.employee_id=p_employee_id
            AND active_assignment.completed_at IS NULL
        ))
    )::INTEGER,
    count(*) FILTER (WHERE wi.status='failed')::INTEGER,
    count(*) FILTER (
      WHERE wi.status='completed' AND wi.finished_at >= date_trunc('day', NOW())
    )::INTEGER
  INTO v_active_count, v_failed_count, v_completed_today
  FROM office_work_items wi
  WHERE wi.workspace_id=p_workspace_id
    AND (wi.primary_employee_id=p_employee_id OR EXISTS (
      SELECT 1 FROM office_work_item_assignments a
      WHERE a.workspace_id=wi.workspace_id AND a.work_item_id=wi.id AND a.employee_id=p_employee_id
    ));

  IF v_employee.availability='UNAVAILABLE' OR NOT v_employee.active THEN
    v_state := 'OFFLINE';
  ELSIF v_item.id IS NULL THEN
    v_state := 'IDLE';
  ELSIF v_item.status='human_controlled' THEN
    v_state := 'HUMAN_CONTROLLED';
  ELSIF v_item.status='waiting_for_approval' THEN
    v_state := 'WAITING_FOR_APPROVAL';
  ELSIF v_item.status='failed' THEN
    v_state := 'ERROR';
  ELSIF v_item.status IN ('queued','waiting','paused') THEN
    v_state := 'WAITING';
  ELSE
    SELECT count(*)::INTEGER INTO v_assignment_count
    FROM office_work_item_assignments
    WHERE workspace_id=p_workspace_id AND work_item_id=v_item.id AND completed_at IS NULL;
    v_state := CASE WHEN v_assignment_count > 1 THEN 'COLLABORATING' ELSE 'WORKING' END;
  END IF;

  SELECT max(sequence) INTO v_last_sequence FROM office_work_item_events
  WHERE workspace_id=p_workspace_id AND employee_id=p_employee_id;

  INSERT INTO office_employee_state_projection(
    workspace_id,employee_id,display_state,current_work_item_id,active_work_count,
    failed_work_count,completed_today_count,last_event_sequence,last_activity_at,updated_at
  ) VALUES(
    p_workspace_id,p_employee_id,v_state,v_item.id,COALESCE(v_active_count,0),
    COALESCE(v_failed_count,0),COALESCE(v_completed_today,0),v_last_sequence,
    COALESCE(v_item.updated_at,v_employee.updated_at),NOW()
  ) ON CONFLICT (workspace_id,employee_id) DO UPDATE SET
    display_state=EXCLUDED.display_state,
    current_work_item_id=EXCLUDED.current_work_item_id,
    active_work_count=EXCLUDED.active_work_count,
    failed_work_count=EXCLUDED.failed_work_count,
    completed_today_count=EXCLUDED.completed_today_count,
    last_event_sequence=EXCLUDED.last_event_sequence,
    last_activity_at=EXCLUDED.last_activity_at,
    updated_at=NOW();
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
    WHEN v_run_status='failed' THEN 'failed'
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

-- Pausing or handing over an agent run is implemented by cooperatively
-- cancelling its current execution lease before the Office state is persisted.
-- That internal bridge is not a user-visible cancellation and must not create
-- a fake cancellation entry in the employee timeline.
CREATE OR REPLACE FUNCTION office_work_item_changed()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_event_type TEXT;
BEGIN
  IF TG_OP='INSERT' THEN
    v_event_type := 'office.work_item.created';
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.source_type='agent_run'
       AND NEW.status='cancelled'
       AND NEW.error_code IN ('OFFICE_PAUSED','OFFICE_HUMAN_TAKEOVER') THEN
      IF NEW.primary_employee_id IS NOT NULL THEN
        PERFORM office_refresh_employee_state(NEW.workspace_id,NEW.primary_employee_id);
      END IF;
      RETURN NEW;
    END IF;
    v_event_type := 'office.work_item.' || NEW.status;
  ELSIF OLD.primary_employee_id IS DISTINCT FROM NEW.primary_employee_id THEN
    v_event_type := 'office.work_item.reassigned';
  ELSE
    PERFORM office_refresh_employee_state(NEW.workspace_id, NEW.primary_employee_id);
    RETURN NEW;
  END IF;

  INSERT INTO office_work_item_events(
    workspace_id,work_item_id,employee_id,event_type,status_from,status_to,payload,occurred_at
  ) VALUES(
    NEW.workspace_id,NEW.id,NEW.primary_employee_id,v_event_type,
    CASE WHEN TG_OP='UPDATE' THEN OLD.status ELSE NULL END,NEW.status,
    jsonb_build_object('sourceType',NEW.source_type,'sourceId',NEW.source_id,
      'relatedObjectType',NEW.related_object_type,'relatedObjectId',NEW.related_object_id),NOW()
  );
  IF TG_OP='UPDATE' AND OLD.primary_employee_id IS DISTINCT FROM NEW.primary_employee_id
     AND OLD.primary_employee_id IS NOT NULL THEN
    PERFORM office_refresh_employee_state(OLD.workspace_id, OLD.primary_employee_id);
  END IF;
  IF NEW.primary_employee_id IS NOT NULL THEN
    PERFORM office_refresh_employee_state(NEW.workspace_id, NEW.primary_employee_id);
  END IF;
  IF NEW.parent_work_item_id IS NOT NULL THEN
    PERFORM office_refresh_parent_run_work_item(NEW.workspace_id,NEW.parent_work_item_id);
  END IF;
  RETURN NEW;
END;
$$;

-- Attribute a collaborating page specialist by its own persisted performance
-- module.  The parent page only identifies the primary specialist and must not
-- overwrite a delegated employee's actual department.
CREATE OR REPLACE FUNCTION office_sync_agent_run_step(p_step agent_run_steps, p_force_completed BOOLEAN DEFAULT FALSE)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_work_item_id UUID;
  v_primary_employee_id UUID;
  v_employee_id UUID;
  v_employee_key TEXT;
  v_module TEXT;
  v_page_id TEXT;
  v_primary_agent_id TEXT;
BEGIN
  SELECT wi.id,wi.primary_employee_id,COALESCE(performance.module,ar.plan->>'module','general'),
         ar.plan #>> '{page,pageId}',ar.plan #>> '{agentDefinition,id}'
  INTO v_work_item_id,v_primary_employee_id,v_module,v_page_id,v_primary_agent_id
  FROM agent_runs ar
  JOIN office_work_items wi
    ON wi.workspace_id=ar.workspace_id AND wi.source_type='agent_run' AND wi.source_agent_run_id=ar.id
  LEFT JOIN workspace_agent_performance performance
    ON performance.workspace_id=ar.workspace_id AND performance.agent_id=p_step.agent_id
  WHERE ar.workspace_id=p_step.workspace_id AND ar.id=p_step.run_id;
  IF v_work_item_id IS NULL OR p_step.agent_id IS NULL THEN RETURN; END IF;

  SELECT id INTO v_employee_id FROM digital_employees
  WHERE workspace_id=p_step.workspace_id AND active AND source_agent_ids ? p_step.agent_id
  ORDER BY CASE availability WHEN 'AVAILABLE' THEN 1 WHEN 'LIMITED' THEN 2 ELSE 3 END,sort_order
  LIMIT 1;
  IF v_employee_id IS NULL THEN
    v_employee_key := CASE
      WHEN p_step.agent_id=v_primary_agent_id AND COALESCE(v_page_id,'') ~* 'quote' THEN 'quote-specialist'
      WHEN p_step.agent_id=v_primary_agent_id AND COALESCE(v_page_id,'') ~* 'invoice' THEN 'invoice-manager'
      WHEN p_step.agent_id=v_primary_agent_id AND COALESCE(v_page_id,'') ~* '(product.image|product.video|media)' THEN 'premium-media-producer'
      WHEN p_step.agent_id=v_primary_agent_id AND COALESCE(v_page_id,'') ~* 'categor' THEN 'category-manager'
      WHEN p_step.agent_id=v_primary_agent_id AND COALESCE(v_page_id,'') ~* '(omnichannel|whatsapp|messenger|chat)' THEN 'customer-communication-specialist'
      WHEN v_module='crm' THEN 'crm-manager'
      WHEN v_module='sales' THEN 'follow-up-specialist'
      WHEN v_module='email' THEN 'email-specialist'
      WHEN v_module='calendar' THEN 'calendar-coordinator'
      WHEN v_module='marketing' THEN 'brand-content-strategist'
      WHEN v_module='ads' THEN 'paid-acquisition-specialist'
      WHEN v_module='website' THEN 'website-manager'
      WHEN v_module IN ('seo','geo','aeo') THEN 'search-visibility-manager'
      WHEN v_module='commerce' THEN 'product-manager'
      WHEN v_module='reputation' THEN 'reviews-reputation-manager'
      WHEN v_module='finance' THEN 'invoice-manager'
      WHEN v_module='intelligence' THEN 'business-intelligence-analyst'
      WHEN v_module='settings' THEN 'security-policy-auditor'
      ELSE 'executive-orchestrator' END;
    SELECT id INTO v_employee_id FROM digital_employees
    WHERE workspace_id=p_step.workspace_id AND employee_key=v_employee_key AND active;
  END IF;
  IF v_employee_id IS NULL THEN RETURN; END IF;

  IF v_employee_id=v_primary_employee_id THEN
    UPDATE office_work_item_assignments SET assignment_role='PRIMARY',completed_at=NULL
    WHERE workspace_id=p_step.workspace_id AND work_item_id=v_work_item_id AND employee_id=v_employee_id;
  ELSE
    INSERT INTO office_work_item_assignments(
      workspace_id,work_item_id,employee_id,assignment_role,completed_at
    ) VALUES(
      p_step.workspace_id,v_work_item_id,v_employee_id,
      CASE WHEN p_step.agent_role='reviewer' THEN 'REVIEWER' ELSE 'CONTRIBUTOR' END,
      CASE WHEN NOT p_force_completed AND p_step.status IN ('running','waiting_approval') THEN NULL ELSE NOW() END
    ) ON CONFLICT (workspace_id,work_item_id,employee_id) DO UPDATE SET
      assignment_role=EXCLUDED.assignment_role,completed_at=EXCLUDED.completed_at;
  END IF;
  PERFORM office_refresh_employee_state(p_step.workspace_id,v_employee_id);
  PERFORM office_refresh_employee_state(p_step.workspace_id,v_primary_employee_id);
END;
$$;

-- Agent reasoning work can contain sensitive domain context even when it has
-- no canonical business object yet.  Persist a module-specific related type so
-- Office visibility uses the same domain RBAC as the eventual action packet.
CREATE OR REPLACE FUNCTION office_agent_run_related_type(p_run agent_runs)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT 'agent_run_' || CASE COALESCE(
    p_run.plan->>'module',p_run.plan #>> '{agentDefinition,module}','general'
  )
    WHEN 'finance' THEN 'finance'
    WHEN 'sales' THEN 'sales'
    WHEN 'crm' THEN 'crm'
    WHEN 'email' THEN 'email'
    WHEN 'calendar' THEN 'calendar'
    WHEN 'marketing' THEN 'marketing'
    WHEN 'ads' THEN 'ads'
    WHEN 'website' THEN 'website'
    WHEN 'commerce' THEN 'commerce'
    WHEN 'reputation' THEN 'reputation'
    WHEN 'settings' THEN 'settings'
    WHEN 'seo' THEN 'seo'
    WHEN 'geo' THEN 'geo'
    WHEN 'aeo' THEN 'aeo'
    WHEN 'dashboard' THEN 'dashboard'
    WHEN 'intelligence' THEN 'intelligence'
    WHEN 'ai' THEN 'ai'
    ELSE 'general' END;
$$;

CREATE OR REPLACE FUNCTION office_tag_agent_run_work_item()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_related_type TEXT;
BEGIN
  v_related_type := office_agent_run_related_type(NEW);
  UPDATE office_work_items
  SET related_object_type=v_related_type,
      related_object_id=NEW.id::text,
      version=version+1,
      updated_at=NOW()
  WHERE workspace_id=NEW.workspace_id
    AND source_type='agent_run'
    AND source_agent_run_id=NEW.id
    AND (related_object_type IS DISTINCT FROM v_related_type
      OR related_object_id IS DISTINCT FROM NEW.id::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_agent_runs_office_visibility_projection ON agent_runs;
CREATE TRIGGER zz_agent_runs_office_visibility_projection
  AFTER INSERT OR UPDATE OF plan ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION office_tag_agent_run_work_item();

UPDATE office_work_items work_item
SET related_object_type=office_agent_run_related_type(run),
    related_object_id=run.id::text,
    version=work_item.version+1,
    updated_at=NOW()
FROM agent_runs run
WHERE work_item.workspace_id=run.workspace_id
  AND work_item.source_type='agent_run'
  AND work_item.source_agent_run_id=run.id
  AND (work_item.related_object_type IS DISTINCT FROM office_agent_run_related_type(run)
    OR work_item.related_object_id IS DISTINCT FROM run.id::text);

-- Cross-domain coordinators and auditors can surface arbitrary business
-- context.  Only actors with audit visibility may inspect their work.  Wrap
-- the canonical roster function so this remains true for future workspaces.
ALTER FUNCTION ensure_workspace_office_roster(UUID)
  RENAME TO ensure_workspace_pre_runtime_integrity_roster;

CREATE OR REPLACE FUNCTION ensure_workspace_office_roster(p_workspace_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ensure_workspace_pre_runtime_integrity_roster(p_workspace_id);
  INSERT INTO digital_employee_capabilities(workspace_id,employee_id,capability_key,access_mode)
  SELECT p_workspace_id,id,'audit.read','OBSERVE'
  FROM digital_employees
  WHERE workspace_id=p_workspace_id
    AND employee_key IN ('executive-orchestrator','outcome-quality-auditor')
  ON CONFLICT (workspace_id,employee_id,capability_key) DO UPDATE
  SET access_mode=EXCLUDED.access_mode;
END;
$$;

SELECT ensure_workspace_office_roster(id)
FROM workspaces
WHERE deleted_at IS NULL;

-- Recompute every projection once after replacing the projection rules.
DO $$
DECLARE employee_row RECORD;
BEGIN
  FOR employee_row IN SELECT workspace_id,id FROM digital_employees LOOP
    PERFORM office_refresh_employee_state(employee_row.workspace_id,employee_row.id);
  END LOOP;
END;
$$;
