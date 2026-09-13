-- Canonical Digital Employee and Work Item foundation for Lulu's Office view.
--
-- The Office is a projection over real persisted work. It does not own or
-- duplicate CRM, commerce, communication, finance, or provider data.

CREATE TABLE IF NOT EXISTS office_departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  department_key TEXT NOT NULL CHECK (department_key ~ '^[a-z][a-z0-9_-]*$'),
  display_name TEXT NOT NULL CHECK (char_length(trim(display_name)) BETWEEN 1 AND 100),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, department_key),
  UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS digital_employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  department_id UUID NOT NULL,
  employee_key TEXT NOT NULL CHECK (employee_key ~ '^[a-z][a-z0-9_-]*$'),
  display_name TEXT NOT NULL CHECK (char_length(trim(display_name)) BETWEEN 1 AND 120),
  role_title TEXT NOT NULL CHECK (char_length(trim(role_title)) BETWEEN 1 AND 160),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  availability TEXT NOT NULL DEFAULT 'LIMITED'
    CHECK (availability IN ('AVAILABLE','LIMITED','UNAVAILABLE')),
  source_agent_ids JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(source_agent_ids) = 'array'),
  source_modules TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, employee_key),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, department_id)
    REFERENCES office_departments(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS digital_employee_capabilities (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL,
  capability_key TEXT NOT NULL REFERENCES workspace_capabilities(key) ON DELETE RESTRICT,
  access_mode TEXT NOT NULL DEFAULT 'OBSERVE'
    CHECK (access_mode IN ('OBSERVE','EXECUTE','MANAGE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, employee_id, capability_key),
  FOREIGN KEY (workspace_id, employee_id)
    REFERENCES digital_employees(workspace_id, id) ON DELETE CASCADE
);

-- A composite candidate key is required for strict tenant-safe references from
-- Office work items to an agent run.
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_workspace_id_id_uidx
  ON agent_runs(workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS agent_action_packets_workspace_record_run_uidx
  ON agent_action_packets(workspace_id, record_id, run_id);

CREATE TABLE IF NOT EXISTS office_work_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_work_item_id UUID,
  primary_employee_id UUID,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('agent_run','agent_action_packet','workflow','domain_event','manual','system')),
  source_id TEXT,
  source_agent_run_id UUID,
  source_record_id UUID,
  idempotency_key TEXT NOT NULL CHECK (char_length(trim(idempotency_key)) BETWEEN 1 AND 300),
  title TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 1 AND 300),
  objective TEXT NOT NULL DEFAULT '' CHECK (char_length(objective) <= 4000),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 10000),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued','running','waiting','paused','waiting_for_approval',
    'human_controlled','failed','completed','cancelled'
  )),
  priority SMALLINT NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 100),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  related_object_type TEXT,
  related_object_id TEXT,
  context JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context) = 'object'),
  result JSONB CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
  error_code TEXT,
  error_message TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  human_controller_id UUID REFERENCES users(id) ON DELETE SET NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, parent_work_item_id)
    REFERENCES office_work_items(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, primary_employee_id)
    REFERENCES digital_employees(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, source_agent_run_id)
    REFERENCES agent_runs(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_record_id)
    REFERENCES workspace_records(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_record_id, source_agent_run_id)
    REFERENCES agent_action_packets(workspace_id, record_id, run_id) ON DELETE CASCADE,
  CHECK (parent_work_item_id IS NULL OR parent_work_item_id <> id),
  CHECK (source_type <> 'agent_run' OR source_agent_run_id IS NOT NULL),
  CHECK (source_type <> 'agent_action_packet' OR (
    source_agent_run_id IS NOT NULL AND source_record_id IS NOT NULL AND parent_work_item_id IS NOT NULL
  )),
  CHECK (status NOT IN ('completed','cancelled') OR finished_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS office_work_item_dependencies (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_item_id UUID NOT NULL,
  depends_on_work_item_id UUID NOT NULL,
  dependency_type TEXT NOT NULL DEFAULT 'BLOCKS'
    CHECK (dependency_type IN ('BLOCKS','CONTEXT','VERIFICATION')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, work_item_id, depends_on_work_item_id),
  FOREIGN KEY (workspace_id, work_item_id)
    REFERENCES office_work_items(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, depends_on_work_item_id)
    REFERENCES office_work_items(workspace_id, id) ON DELETE CASCADE,
  CHECK (work_item_id <> depends_on_work_item_id)
);

CREATE TABLE IF NOT EXISTS office_work_item_assignments (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_item_id UUID NOT NULL,
  employee_id UUID NOT NULL,
  assignment_role TEXT NOT NULL DEFAULT 'CONTRIBUTOR'
    CHECK (assignment_role IN ('PRIMARY','CONTRIBUTOR','REVIEWER')),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, work_item_id, employee_id),
  FOREIGN KEY (workspace_id, work_item_id)
    REFERENCES office_work_items(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, employee_id)
    REFERENCES digital_employees(workspace_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS office_work_item_one_primary_assignment_uidx
  ON office_work_item_assignments(workspace_id, work_item_id)
  WHERE assignment_role = 'PRIMARY';

CREATE TABLE IF NOT EXISTS office_work_item_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_item_id UUID NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  worker_id TEXT,
  input JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input) = 'object'),
  output JSONB CHECK (output IS NULL OR jsonb_typeof(output) = 'object'),
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, work_item_id, attempt_number),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, work_item_id)
    REFERENCES office_work_items(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS office_work_item_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence BIGSERIAL NOT NULL UNIQUE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_item_id UUID NOT NULL,
  employee_id UUID,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (char_length(trim(event_type)) BETWEEN 1 AND 160),
  status_from TEXT,
  status_to TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, work_item_id)
    REFERENCES office_work_items(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, employee_id)
    REFERENCES digital_employees(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS office_work_item_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  work_item_id UUID NOT NULL,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  command TEXT NOT NULL CHECK (command IN ('pause','resume','retry','cancel','takeover')),
  idempotency_key TEXT NOT NULL CHECK (char_length(trim(idempotency_key)) BETWEEN 8 AND 200),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 1),
  result JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, work_item_id)
    REFERENCES office_work_items(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS office_employee_state_projection (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL,
  display_state TEXT NOT NULL DEFAULT 'IDLE' CHECK (display_state IN (
    'IDLE','MONITORING','WORKING','COLLABORATING','WAITING',
    'WAITING_FOR_APPROVAL','HUMAN_CONTROLLED','ERROR','OFFLINE'
  )),
  current_work_item_id UUID,
  active_work_count INTEGER NOT NULL DEFAULT 0 CHECK (active_work_count >= 0),
  failed_work_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_work_count >= 0),
  completed_today_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_today_count >= 0),
  last_event_sequence BIGINT,
  last_activity_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, employee_id),
  FOREIGN KEY (workspace_id, employee_id)
    REFERENCES digital_employees(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, current_work_item_id)
    REFERENCES office_work_items(workspace_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS office_departments_order_idx
  ON office_departments(workspace_id, sort_order, display_name);
CREATE INDEX IF NOT EXISTS digital_employees_department_idx
  ON digital_employees(workspace_id, department_id, active, sort_order);
CREATE INDEX IF NOT EXISTS digital_employees_sources_idx
  ON digital_employees USING GIN(source_agent_ids);
CREATE INDEX IF NOT EXISTS office_work_items_employee_queue_idx
  ON office_work_items(workspace_id, primary_employee_id, status, priority DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS office_work_items_source_idx
  ON office_work_items(workspace_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS office_work_items_parent_idx
  ON office_work_items(workspace_id, parent_work_item_id);
CREATE INDEX IF NOT EXISTS office_work_item_dependencies_reverse_idx
  ON office_work_item_dependencies(workspace_id, depends_on_work_item_id);
CREATE INDEX IF NOT EXISTS office_work_item_events_timeline_idx
  ON office_work_item_events(workspace_id, occurred_at DESC, sequence DESC);
CREATE INDEX IF NOT EXISTS office_work_item_events_employee_idx
  ON office_work_item_events(workspace_id, employee_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION ensure_workspace_office_roster(p_workspace_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO office_departments(workspace_id, department_key, display_name, description, sort_order)
  VALUES
    (p_workspace_id,'executive','Executive','Company-wide coordination, policy, and verified outcomes.',10),
    (p_workspace_id,'crm-sales','CRM & Sales','Customer intelligence, pipeline, follow-up, and commercial documents.',20),
    (p_workspace_id,'communications','Communications','Unified customer conversations, email, and scheduling.',30),
    (p_workspace_id,'marketing','Marketing','Brand, content, search visibility, and paid acquisition.',40),
    (p_workspace_id,'online-presence','Online Presence','Website, CMS, reviews, and public digital presence.',50),
    (p_workspace_id,'commerce','Commerce','Products, categories, and premium product media.',60),
    (p_workspace_id,'finance','Finance','Invoices, billing, usage, and financial operations.',70),
    (p_workspace_id,'operations','Operations','Provider connections and operational reliability.',80),
    (p_workspace_id,'analytics','Analytics','Evidence-backed business intelligence and performance.',90)
  ON CONFLICT (workspace_id, department_key) DO NOTHING;

  INSERT INTO digital_employees(
    workspace_id, department_id, employee_key, display_name, role_title,
    description, availability, source_agent_ids, source_modules, sort_order
  )
  SELECT p_workspace_id, d.id, template.employee_key, template.display_name, template.role_title,
         template.description, template.availability, template.source_agent_ids::jsonb,
         template.source_modules, template.sort_order
  FROM (VALUES
    ('executive','executive-orchestrator','Executive Orchestrator','Executive Orchestrator','Coordinates persisted agent runs and company-wide execution.','AVAILABLE','["system:executive-orchestrator"]',ARRAY['general','dashboard','ai'],10),
    ('executive','security-policy-auditor','Security & Policy Auditor','Security & Policy Auditor','Reviews policy, permissions, and execution safety.','AVAILABLE','["system:security-auditor"]',ARRAY['settings'],20),
    ('executive','outcome-quality-auditor','Outcome & Quality Auditor','Outcome & Quality Auditor','Verifies persisted run outcomes and quality evidence.','LIMITED','["system:outcome-auditor"]',ARRAY[]::TEXT[],30),
    ('crm-sales','company-intelligence-specialist','Company Intelligence Specialist','Company Intelligence Specialist','Researches and enriches company records through the real intelligence workflow.','AVAILABLE','[]',ARRAY['crm'],10),
    ('crm-sales','crm-manager','CRM Manager','CRM Manager','Coordinates canonical CRM records and company context.','LIMITED','["system:customer-revenue-lead"]',ARRAY['crm'],20),
    ('crm-sales','follow-up-specialist','Follow-up Specialist','Follow-up Specialist','Coordinates persisted sales and CRM follow-up work.','LIMITED','[]',ARRAY['sales'],30),
    ('crm-sales','quote-specialist','Quote Specialist','Quote Specialist','Works with canonical quotes and their delivery lifecycle.','LIMITED','[]',ARRAY[]::TEXT[],40),
    ('communications','omnichannel-manager','OmniChannel Manager','OmniChannel Manager','Coordinates real channel identities, routing, and conversations.','AVAILABLE','[]',ARRAY[]::TEXT[],10),
    ('communications','customer-communication-specialist','Customer Communication Specialist','Customer Communication Specialist','Handles persisted autonomous customer replies and outreach.','AVAILABLE','[]',ARRAY[]::TEXT[],20),
    ('communications','email-specialist','Email Specialist','Email Specialist','Works with real mailbox sync, drafts, and deliveries.','AVAILABLE','[]',ARRAY['email'],30),
    ('communications','calendar-coordinator','Calendar Coordinator','Calendar Coordinator','Coordinates native calendar records and provider synchronization.','LIMITED','[]',ARRAY['calendar'],40),
    ('marketing','brand-content-strategist','Brand & Content Strategist','Brand & Content Strategist','Coordinates persisted brand and content work.','LIMITED','["system:brand-trust-lead","system:growth-strategy-lead","system:content-distribution-lead"]',ARRAY['marketing'],10),
    ('marketing','paid-acquisition-specialist','Paid Acquisition Specialist','Paid Acquisition Specialist','Analyzes and executes paid acquisition only through enforced budget policy.','LIMITED','["system:paid-acquisition-lead"]',ARRAY['ads'],20),
    ('online-presence','website-manager','Website Manager','Website Manager','Coordinates real website generation and publishing jobs.','LIMITED','["system:online-presence-lead"]',ARRAY['website'],10),
    ('online-presence','pages-cms-manager','Pages & CMS Manager','Pages & CMS Manager','Works with connected CMS pages, posts, and media.','LIMITED','[]',ARRAY[]::TEXT[],20),
    ('online-presence','reviews-reputation-manager','Reviews & Reputation Manager','Reviews & Reputation Manager','Reads and replies to real provider reviews.','AVAILABLE','[]',ARRAY['reputation'],30),
    ('online-presence','search-visibility-manager','Search Visibility Manager','SEO, GEO & AEO Manager','Coordinates search intelligence and visibility work.','LIMITED','["system:market-intelligence-lead","system:localization-lead"]',ARRAY['seo','geo','aeo'],40),
    ('commerce','product-manager','Product Manager','Product Manager','Works with the canonical product master.','AVAILABLE','[]',ARRAY['commerce'],10),
    ('commerce','premium-media-producer','Premium Media Producer','Premium Media Producer','Creates verified premium product images and video through persisted jobs.','AVAILABLE','[]',ARRAY[]::TEXT[],20),
    ('commerce','category-manager','Category Manager','Category Manager','Works with canonical product categories.','AVAILABLE','[]',ARRAY[]::TEXT[],30),
    ('finance','invoice-manager','Invoice Manager','Invoice Manager','Works with canonical invoices and delivery records.','LIMITED','["system:finance-bookkeeping-lead"]',ARRAY['finance'],10),
    ('finance','billing-usage-manager','Billing & Usage Manager','Billing & Usage Manager','Monitors prepaid AI, advertising, and metered storage ledgers.','AVAILABLE','[]',ARRAY[]::TEXT[],20),
    ('operations','integration-manager','Integration Manager','Integration Manager','Coordinates persisted provider connections, syncs, and failures.','LIMITED','[]',ARRAY[]::TEXT[],10),
    ('analytics','business-intelligence-analyst','Business Intelligence Analyst','Business Intelligence Analyst','Interprets persisted metrics and verified intelligence outputs.','LIMITED','["system:market-intelligence-lead"]',ARRAY['intelligence'],10)
  ) AS template(department_key,employee_key,display_name,role_title,description,availability,source_agent_ids,source_modules,sort_order)
  JOIN office_departments d
    ON d.workspace_id=p_workspace_id AND d.department_key=template.department_key
  ON CONFLICT (workspace_id, employee_key) DO NOTHING;

  INSERT INTO digital_employee_capabilities(workspace_id, employee_id, capability_key, access_mode)
  SELECT p_workspace_id, e.id, mapping.capability_key, mapping.access_mode
  FROM (VALUES
    ('executive-orchestrator','agents.read','OBSERVE'),('executive-orchestrator','agents.manage','MANAGE'),
    ('security-policy-auditor','audit.read','OBSERVE'),('security-policy-auditor','settings.read','OBSERVE'),
    ('outcome-quality-auditor','agents.read','OBSERVE'),
    ('company-intelligence-specialist','crm.read','OBSERVE'),('company-intelligence-specialist','crm.manage','EXECUTE'),
    ('crm-manager','crm.read','OBSERVE'),('crm-manager','crm.manage','MANAGE'),
    ('follow-up-specialist','leads.read','OBSERVE'),('follow-up-specialist','leads.manage','EXECUTE'),
    ('quote-specialist','quotes.read','OBSERVE'),('quote-specialist','quotes.create','EXECUTE'),
    ('omnichannel-manager','omnichannel.read','OBSERVE'),('omnichannel-manager','omnichannel.manage','MANAGE'),
    ('customer-communication-specialist','omnichannel.read','OBSERVE'),('customer-communication-specialist','omnichannel.reply','EXECUTE'),
    ('email-specialist','omnichannel.read','OBSERVE'),('email-specialist','omnichannel.reply','EXECUTE'),
    ('calendar-coordinator','workspace.read','OBSERVE'),('calendar-coordinator','workspace.write','EXECUTE'),
    ('brand-content-strategist','website.read','OBSERVE'),('brand-content-strategist','website.manage','EXECUTE'),
    ('paid-acquisition-specialist','advertising.read','OBSERVE'),('paid-acquisition-specialist','advertising.manage','EXECUTE'),
    ('website-manager','website.read','OBSERVE'),('website-manager','website.publish','EXECUTE'),
    ('pages-cms-manager','website.read','OBSERVE'),('pages-cms-manager','website.manage','EXECUTE'),
    ('reviews-reputation-manager','website.read','OBSERVE'),('reviews-reputation-manager','omnichannel.reply','EXECUTE'),
    ('search-visibility-manager','website.read','OBSERVE'),('search-visibility-manager','website.manage','EXECUTE'),
    ('product-manager','products.read','OBSERVE'),('product-manager','products.update','EXECUTE'),
    ('premium-media-producer','products.read','OBSERVE'),('premium-media-producer','products.update','EXECUTE'),
    ('category-manager','products.read','OBSERVE'),('category-manager','products.update','EXECUTE'),
    ('invoice-manager','invoices.read','OBSERVE'),('invoice-manager','invoices.create','EXECUTE'),
    ('billing-usage-manager','finance.read','OBSERVE'),
    ('integration-manager','providers.read','OBSERVE'),('integration-manager','providers.manage','MANAGE'),
    ('business-intelligence-analyst','agents.read','OBSERVE'),('business-intelligence-analyst','workspace.read','OBSERVE')
  ) AS mapping(employee_key,capability_key,access_mode)
  JOIN digital_employees e
    ON e.workspace_id=p_workspace_id AND e.employee_key=mapping.employee_key
  ON CONFLICT (workspace_id, employee_id, capability_key) DO UPDATE
    SET access_mode=EXCLUDED.access_mode;

  INSERT INTO office_employee_state_projection(workspace_id, employee_id, display_state)
  SELECT p_workspace_id, id, CASE WHEN availability='UNAVAILABLE' THEN 'OFFLINE' ELSE 'IDLE' END
  FROM digital_employees WHERE workspace_id=p_workspace_id AND active
  ON CONFLICT (workspace_id, employee_id) DO NOTHING;
END;
$$;

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
    count(*) FILTER (WHERE wi.status IN ('queued','running','waiting','paused','waiting_for_approval','human_controlled'))::INTEGER,
    count(*) FILTER (WHERE wi.status='failed')::INTEGER,
    count(*) FILTER (WHERE wi.status='completed' AND wi.finished_at >= date_trunc('day', NOW()))::INTEGER
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

CREATE OR REPLACE FUNCTION office_prevent_dependency_cycle()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_cycle BOOLEAN;
BEGIN
  WITH RECURSIVE ancestors(id) AS (
    SELECT NEW.depends_on_work_item_id
    UNION
    SELECT d.depends_on_work_item_id
    FROM office_work_item_dependencies d
    JOIN ancestors a ON a.id=d.work_item_id
    WHERE d.workspace_id=NEW.workspace_id
  )
  SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=NEW.work_item_id) INTO v_cycle;
  IF v_cycle THEN
    RAISE EXCEPTION 'Office work item dependency cycle detected' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION office_require_completed_blockers()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='running' AND OLD.status IS DISTINCT FROM 'running' AND EXISTS (
    SELECT 1 FROM office_work_item_dependencies d
    JOIN office_work_items dependency
      ON dependency.workspace_id=d.workspace_id AND dependency.id=d.depends_on_work_item_id
    WHERE d.workspace_id=NEW.workspace_id AND d.work_item_id=NEW.id
      AND d.dependency_type='BLOCKS' AND dependency.status <> 'completed'
  ) THEN
    RAISE EXCEPTION 'Office work item has incomplete blocking dependencies' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION office_validate_work_item_links()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_type='agent_action_packet' AND NOT EXISTS (
    SELECT 1 FROM office_work_items parent
    WHERE parent.workspace_id=NEW.workspace_id AND parent.id=NEW.parent_work_item_id
      AND parent.source_type='agent_run'
      AND parent.source_agent_run_id=NEW.source_agent_run_id
  ) THEN
    RAISE EXCEPTION 'Agent action work must be attached to its canonical agent run work item'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- A reasoning run is not finished from the Office perspective while one of
-- its persisted action packets is still executing. This keeps visual state
-- aligned with the real downstream side effect rather than the LLM response.
CREATE OR REPLACE FUNCTION office_refresh_parent_run_work_item(p_workspace_id UUID, p_parent_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_run_status TEXT;
  v_next_status TEXT;
  v_has_active BOOLEAN;
  v_has_failed BOOLEAN;
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
    bool_or(status='failed')
  INTO v_has_active,v_has_failed
  FROM office_work_items
  WHERE workspace_id=p_workspace_id AND parent_work_item_id=p_parent_id;

  v_next_status := CASE
    WHEN v_run_status='cancelled' THEN 'cancelled'
    WHEN v_run_status='failed' THEN 'failed'
    WHEN COALESCE(v_has_failed,FALSE) THEN 'failed'
    WHEN COALESCE(v_has_active,FALSE) THEN 'waiting'
    ELSE 'completed' END;

  UPDATE office_work_items SET
    status=v_next_status,
    finished_at=CASE WHEN v_next_status IN ('completed','cancelled') THEN COALESCE(finished_at,NOW()) ELSE NULL END,
    error_code=CASE WHEN v_next_status='failed' AND v_run_status='completed'
      THEN 'AGENT_ACTION_PACKET_FAILED' ELSE error_code END,
    error_message=CASE WHEN v_next_status='failed' AND v_run_status='completed'
      THEN 'A downstream action packet failed after the agent reasoning run completed.' ELSE error_message END,
    version=version+1,
    updated_at=NOW()
  WHERE workspace_id=p_workspace_id AND id=p_parent_id AND status IS DISTINCT FROM v_next_status;
END;
$$;

CREATE OR REPLACE FUNCTION office_work_item_changed()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_event_type TEXT;
BEGIN
  IF TG_OP='INSERT' THEN
    v_event_type := 'office.work_item.created';
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
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

CREATE OR REPLACE FUNCTION office_assignment_changed()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    PERFORM office_refresh_employee_state(OLD.workspace_id,OLD.employee_id);
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    PERFORM office_refresh_employee_state(NEW.workspace_id,NEW.employee_id);
  END IF;
  RETURN COALESCE(NEW,OLD);
END;
$$;

CREATE OR REPLACE FUNCTION office_employee_availability_changed()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM office_refresh_employee_state(NEW.workspace_id,NEW.id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION prevent_office_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Cascading deletion of the owning work item/workspace is a deliberate
  -- tenant teardown and runs from an FK trigger at a deeper trigger level.
  IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Office work item events are append-only' USING ERRCODE='55000';
END;
$$;

CREATE OR REPLACE FUNCTION office_materialize_agent_run(p_run agent_runs, p_attempt_started BOOLEAN DEFAULT FALSE)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_agent_id TEXT := p_run.plan #>> '{agentDefinition,id}';
  v_module TEXT := COALESCE(p_run.plan->>'module',p_run.plan #>> '{agentDefinition,module}','general');
  v_page_id TEXT := p_run.plan #>> '{page,pageId}';
  v_employee_id UUID;
  v_employee_key TEXT;
  v_status TEXT;
  v_item office_work_items%ROWTYPE;
  v_existing_status TEXT;
  v_existing_attempts INTEGER := 0;
  v_attempt_number INTEGER;
BEGIN
  PERFORM ensure_workspace_office_roster(p_run.workspace_id);

  SELECT id INTO v_employee_id FROM digital_employees
  WHERE workspace_id=p_run.workspace_id AND active AND source_agent_ids ? COALESCE(v_agent_id,'')
  ORDER BY CASE availability WHEN 'AVAILABLE' THEN 1 WHEN 'LIMITED' THEN 2 ELSE 3 END, sort_order
  LIMIT 1;

  IF v_employee_id IS NULL THEN
    v_employee_key := CASE
      WHEN COALESCE(v_page_id,'') ~* 'quote' THEN 'quote-specialist'
      WHEN COALESCE(v_page_id,'') ~* 'invoice' THEN 'invoice-manager'
      WHEN COALESCE(v_page_id,'') ~* '(product.image|product.video|media)' THEN 'premium-media-producer'
      WHEN COALESCE(v_page_id,'') ~* 'categor' THEN 'category-manager'
      WHEN COALESCE(v_page_id,'') ~* '(omnichannel|whatsapp|messenger|chat)' THEN 'customer-communication-specialist'
      WHEN COALESCE(v_page_id,'') ~* '(integration|connection)' THEN 'integration-manager'
      WHEN COALESCE(v_page_id,'') ~* '(billing|usage)' THEN 'billing-usage-manager'
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
    WHERE workspace_id=p_run.workspace_id AND employee_key=v_employee_key AND active;
  END IF;

  v_status := CASE
    WHEN p_run.status IN ('planning','running') OR (p_run.status='queued' AND p_run.worker_id IS NOT NULL) THEN 'running'
    WHEN p_run.status='waiting_approval' THEN 'waiting_for_approval'
    WHEN p_run.status='completed' THEN 'completed'
    WHEN p_run.status='failed' THEN 'failed'
    WHEN p_run.status='cancelled' THEN 'cancelled'
    ELSE 'queued' END;

  SELECT status,attempt_count INTO v_existing_status,v_existing_attempts
  FROM office_work_items
  WHERE workspace_id=p_run.workspace_id AND idempotency_key='agent-run:'||p_run.id::text;

  IF v_status='cancelled' AND v_existing_status IN ('paused','human_controlled') THEN
    v_status := v_existing_status;
  END IF;

  INSERT INTO office_work_items(
    workspace_id,primary_employee_id,source_type,source_id,source_agent_run_id,idempotency_key,
    title,objective,status,attempt_count,max_attempts,result,error_code,error_message,
    created_by,started_at,finished_at,created_at,updated_at
  ) VALUES(
    p_run.workspace_id,v_employee_id,'agent_run',p_run.id::text,p_run.id,
    'agent-run:'||p_run.id::text,left(p_run.goal,300),p_run.goal,v_status,
    p_run.attempt_count,3,p_run.result,p_run.error_code,p_run.error_message,p_run.created_by,
    p_run.started_at,CASE WHEN v_status IN ('completed','cancelled') THEN COALESCE(p_run.finished_at,NOW()) ELSE p_run.finished_at END,
    p_run.created_at,p_run.updated_at
  ) ON CONFLICT (workspace_id,idempotency_key) DO UPDATE SET
    primary_employee_id=EXCLUDED.primary_employee_id,
    title=EXCLUDED.title,
    objective=EXCLUDED.objective,
    status=EXCLUDED.status,
    attempt_count=CASE WHEN p_attempt_started THEN office_work_items.attempt_count+1
      ELSE GREATEST(office_work_items.attempt_count,EXCLUDED.attempt_count) END,
    result=EXCLUDED.result,
    error_code=EXCLUDED.error_code,
    error_message=EXCLUDED.error_message,
    started_at=COALESCE(office_work_items.started_at,EXCLUDED.started_at),
    finished_at=CASE WHEN EXCLUDED.status IN ('completed','cancelled') THEN COALESCE(EXCLUDED.finished_at,NOW()) ELSE NULL END,
    version=office_work_items.version + CASE WHEN
      office_work_items.primary_employee_id IS DISTINCT FROM EXCLUDED.primary_employee_id OR
      office_work_items.status IS DISTINCT FROM EXCLUDED.status OR
      office_work_items.result IS DISTINCT FROM EXCLUDED.result OR
      office_work_items.error_code IS DISTINCT FROM EXCLUDED.error_code OR
      office_work_items.error_message IS DISTINCT FROM EXCLUDED.error_message OR p_attempt_started
      THEN 1 ELSE 0 END,
    updated_at=CASE WHEN
      office_work_items.primary_employee_id IS DISTINCT FROM EXCLUDED.primary_employee_id OR
      office_work_items.status IS DISTINCT FROM EXCLUDED.status OR
      office_work_items.result IS DISTINCT FROM EXCLUDED.result OR
      office_work_items.error_code IS DISTINCT FROM EXCLUDED.error_code OR
      office_work_items.error_message IS DISTINCT FROM EXCLUDED.error_message OR p_attempt_started
      THEN NOW() ELSE office_work_items.updated_at END
  RETURNING * INTO v_item;

  INSERT INTO office_work_item_assignments(workspace_id,work_item_id,employee_id,assignment_role)
  VALUES(p_run.workspace_id,v_item.id,v_employee_id,'PRIMARY')
  ON CONFLICT (workspace_id,work_item_id,employee_id) DO UPDATE SET
    assignment_role='PRIMARY',completed_at=NULL;
  DELETE FROM office_work_item_assignments
  WHERE workspace_id=p_run.workspace_id AND work_item_id=v_item.id
    AND assignment_role='PRIMARY' AND employee_id<>v_employee_id;

  IF p_attempt_started THEN
    v_attempt_number := v_item.attempt_count;
    INSERT INTO office_work_item_attempts(
      workspace_id,work_item_id,attempt_number,status,worker_id,started_at,heartbeat_at
    ) VALUES(p_run.workspace_id,v_item.id,v_attempt_number,'running',p_run.worker_id,NOW(),p_run.heartbeat_at)
    ON CONFLICT (workspace_id,work_item_id,attempt_number) DO UPDATE SET
      status='running',worker_id=EXCLUDED.worker_id,
      started_at=COALESCE(office_work_item_attempts.started_at,EXCLUDED.started_at),
      heartbeat_at=EXCLUDED.heartbeat_at;
  ELSIF p_run.status IN ('completed','failed','cancelled') THEN
    UPDATE office_work_item_attempts SET
      status=CASE p_run.status WHEN 'completed' THEN 'succeeded' WHEN 'failed' THEN 'failed' ELSE 'cancelled' END,
      output=p_run.result,error_code=p_run.error_code,error_message=p_run.error_message,
      heartbeat_at=p_run.heartbeat_at,finished_at=COALESCE(p_run.finished_at,NOW())
    WHERE workspace_id=p_run.workspace_id AND work_item_id=v_item.id
      AND attempt_number=(SELECT max(attempt_number) FROM office_work_item_attempts
        WHERE workspace_id=p_run.workspace_id AND work_item_id=v_item.id)
      AND status IN ('queued','running');
  ELSIF p_run.worker_id IS NOT NULL THEN
    UPDATE office_work_item_attempts SET heartbeat_at=p_run.heartbeat_at
    WHERE workspace_id=p_run.workspace_id AND work_item_id=v_item.id
      AND attempt_number=(SELECT max(attempt_number) FROM office_work_item_attempts
        WHERE workspace_id=p_run.workspace_id AND work_item_id=v_item.id)
      AND status='running';
  END IF;
  PERFORM office_refresh_parent_run_work_item(p_run.workspace_id,v_item.id);
END;
$$;

CREATE OR REPLACE FUNCTION office_materialize_action_packet(p_workspace_id UUID, p_record_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_record workspace_records%ROWTYPE;
  v_run_id UUID;
  v_parent_id UUID;
  v_employee_id UUID;
  v_status TEXT;
  v_item office_work_items%ROWTYPE;
  v_existing_attempts INTEGER := 0;
  v_source_attempts INTEGER := 0;
  v_attempt_started BOOLEAN := FALSE;
BEGIN
  SELECT r.* INTO v_record
  FROM workspace_records r
  JOIN agent_action_packets p ON p.workspace_id=r.workspace_id AND p.record_id=r.id
  WHERE r.workspace_id=p_workspace_id AND r.id=p_record_id AND r.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT run_id INTO v_run_id FROM agent_action_packets
  WHERE workspace_id=p_workspace_id AND record_id=p_record_id;

  PERFORM ensure_workspace_office_roster(p_workspace_id);
  SELECT id,primary_employee_id INTO v_parent_id,v_employee_id
  FROM office_work_items
  WHERE workspace_id=p_workspace_id AND source_type='agent_run' AND source_agent_run_id=v_run_id;
  IF v_parent_id IS NULL THEN
    PERFORM office_materialize_agent_run(ar,FALSE) FROM agent_runs ar
    WHERE ar.workspace_id=p_workspace_id AND ar.id=v_run_id;
    SELECT id,primary_employee_id INTO v_parent_id,v_employee_id
    FROM office_work_items
    WHERE workspace_id=p_workspace_id AND source_type='agent_run' AND source_agent_run_id=v_run_id;
  END IF;
  IF v_parent_id IS NULL OR v_employee_id IS NULL THEN RETURN; END IF;

  v_source_attempts := CASE WHEN COALESCE(v_record.data->>'executionAttempts','') ~ '^[0-9]+$'
    THEN (v_record.data->>'executionAttempts')::INTEGER ELSE 0 END;
  v_status := CASE
    WHEN v_record.stage='executing' OR v_record.data->>'executionStatus'='executing' THEN 'running'
    WHEN v_record.stage='executed' OR v_record.data->>'executionStatus'='executed' THEN 'completed'
    WHEN v_record.stage='execution_failed' OR v_record.data->>'executionStatus'='failed' OR v_record.status='failed' THEN 'failed'
    WHEN v_record.stage='execution_paused' OR v_record.data->>'executionStatus'='paused' THEN 'paused'
    WHEN v_record.stage='human_controlled' OR v_record.data->>'executionStatus'='human_controlled' THEN 'human_controlled'
    WHEN v_record.stage='execution_cancelled' OR v_record.data->>'executionStatus'='cancelled' THEN 'cancelled'
    WHEN v_record.stage='waiting_approval' THEN 'waiting_for_approval'
    WHEN v_record.stage='waiting_for_provider' OR v_record.data->>'executionStatus'='waiting_for_provider' THEN 'waiting'
    WHEN v_record.data->>'executionStatus'='queued_retry' THEN 'waiting'
    ELSE 'queued' END;

  SELECT attempt_count INTO v_existing_attempts FROM office_work_items
  WHERE workspace_id=p_workspace_id AND idempotency_key='agent-action-packet:'||p_record_id::text;
  v_attempt_started := v_status='running' AND v_source_attempts > COALESCE(v_existing_attempts,0);

  INSERT INTO office_work_items(
    workspace_id,parent_work_item_id,primary_employee_id,source_type,source_id,
    source_agent_run_id,source_record_id,idempotency_key,title,objective,description,
    status,attempt_count,max_attempts,related_object_type,related_object_id,context,result,
    error_code,error_message,created_by,started_at,finished_at,created_at,updated_at
  ) VALUES(
    p_workspace_id,v_parent_id,v_employee_id,'agent_action_packet',p_record_id::text,
    v_run_id,p_record_id,'agent-action-packet:'||p_record_id::text,
    left('Execute '||v_record.name,300),COALESCE(v_record.data->>'goal',v_record.name),
    COALESCE(v_record.description,''),v_status,v_source_attempts,3,
    v_record.resource_type,p_record_id::text,
    jsonb_build_object('pageId',v_record.data->>'pageId','commandTypes',COALESCE(v_record.data->'commandTypes','[]'::jsonb)),
    CASE WHEN v_status='completed' THEN jsonb_build_object(
      'executionSummary',v_record.data->'executionSummary',
      'resultRecords',COALESCE(v_record.data->'resultRecords','[]'::jsonb)) ELSE NULL END,
    CASE WHEN v_status='failed' THEN COALESCE(v_record.data->>'executionErrorClass','AGENT_ACTION_PACKET_FAILED') ELSE NULL END,
    CASE WHEN v_status='failed' THEN v_record.data->>'executionError' ELSE NULL END,
    v_record.created_by,
    CASE WHEN v_status='running' THEN COALESCE(NULLIF(v_record.data->>'executionStartedAt','')::timestamptz,NOW()) ELSE NULL END,
    CASE WHEN v_status IN ('completed','cancelled') THEN COALESCE(NULLIF(v_record.data->>'executionCompletedAt','')::timestamptz,NOW()) ELSE NULL END,
    v_record.created_at,v_record.updated_at
  ) ON CONFLICT (workspace_id,idempotency_key) DO UPDATE SET
    parent_work_item_id=EXCLUDED.parent_work_item_id,
    primary_employee_id=EXCLUDED.primary_employee_id,
    title=EXCLUDED.title,objective=EXCLUDED.objective,description=EXCLUDED.description,
    status=EXCLUDED.status,
    attempt_count=GREATEST(office_work_items.attempt_count,EXCLUDED.attempt_count),
    related_object_type=EXCLUDED.related_object_type,
    related_object_id=EXCLUDED.related_object_id,
    context=EXCLUDED.context,result=EXCLUDED.result,
    error_code=EXCLUDED.error_code,error_message=EXCLUDED.error_message,
    started_at=COALESCE(office_work_items.started_at,EXCLUDED.started_at),
    finished_at=CASE WHEN EXCLUDED.status IN ('completed','cancelled') THEN COALESCE(EXCLUDED.finished_at,NOW()) ELSE NULL END,
    version=office_work_items.version + CASE WHEN
      office_work_items.status IS DISTINCT FROM EXCLUDED.status OR
      office_work_items.attempt_count IS DISTINCT FROM GREATEST(office_work_items.attempt_count,EXCLUDED.attempt_count) OR
      office_work_items.result IS DISTINCT FROM EXCLUDED.result OR
      office_work_items.error_message IS DISTINCT FROM EXCLUDED.error_message
      THEN 1 ELSE 0 END,
    updated_at=CASE WHEN
      office_work_items.status IS DISTINCT FROM EXCLUDED.status OR
      office_work_items.attempt_count IS DISTINCT FROM GREATEST(office_work_items.attempt_count,EXCLUDED.attempt_count) OR
      office_work_items.result IS DISTINCT FROM EXCLUDED.result OR
      office_work_items.error_message IS DISTINCT FROM EXCLUDED.error_message
      THEN NOW() ELSE office_work_items.updated_at END
  RETURNING * INTO v_item;

  INSERT INTO office_work_item_assignments(workspace_id,work_item_id,employee_id,assignment_role)
  VALUES(p_workspace_id,v_item.id,v_employee_id,'PRIMARY')
  ON CONFLICT (workspace_id,work_item_id,employee_id) DO UPDATE SET
    assignment_role='PRIMARY',completed_at=NULL;

  IF v_attempt_started THEN
    INSERT INTO office_work_item_attempts(
      workspace_id,work_item_id,attempt_number,status,started_at,heartbeat_at,input
    ) VALUES(p_workspace_id,v_item.id,v_source_attempts,'running',COALESCE(v_item.started_at,NOW()),NOW(),
      jsonb_build_object('recordId',p_record_id,'resourceType',v_record.resource_type))
    ON CONFLICT (workspace_id,work_item_id,attempt_number) DO UPDATE SET
      status='running',started_at=COALESCE(office_work_item_attempts.started_at,EXCLUDED.started_at),heartbeat_at=NOW();
  ELSIF v_status IN ('completed','failed') AND v_source_attempts > 0 THEN
    INSERT INTO office_work_item_attempts(
      workspace_id,work_item_id,attempt_number,status,output,error_code,error_message,started_at,finished_at
    ) VALUES(p_workspace_id,v_item.id,v_source_attempts,
      CASE WHEN v_status='completed' THEN 'succeeded' ELSE 'failed' END,
      v_item.result,v_item.error_code,v_item.error_message,COALESCE(v_item.started_at,v_item.created_at),NOW())
    ON CONFLICT (workspace_id,work_item_id,attempt_number) DO UPDATE SET
      status=EXCLUDED.status,output=EXCLUDED.output,error_code=EXCLUDED.error_code,
      error_message=EXCLUDED.error_message,finished_at=EXCLUDED.finished_at;
  END IF;
  PERFORM office_refresh_parent_run_work_item(p_workspace_id,v_parent_id);
END;
$$;

CREATE OR REPLACE FUNCTION office_action_packet_projection_trigger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM office_materialize_action_packet(NEW.workspace_id,NEW.record_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION office_action_record_projection_trigger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM agent_action_packets p WHERE p.workspace_id=NEW.workspace_id AND p.record_id=NEW.id) THEN
    PERFORM office_materialize_action_packet(NEW.workspace_id,NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION office_sync_agent_run_step(p_step agent_run_steps, p_force_completed BOOLEAN DEFAULT FALSE)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_work_item_id UUID;
  v_primary_employee_id UUID;
  v_employee_id UUID;
  v_employee_key TEXT;
  v_module TEXT;
  v_page_id TEXT;
BEGIN
  SELECT wi.id,wi.primary_employee_id,COALESCE(performance.module,ar.plan->>'module','general'),
         ar.plan #>> '{page,pageId}'
  INTO v_work_item_id,v_primary_employee_id,v_module,v_page_id
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
      WHEN COALESCE(v_page_id,'') ~* 'quote' THEN 'quote-specialist'
      WHEN COALESCE(v_page_id,'') ~* 'invoice' THEN 'invoice-manager'
      WHEN COALESCE(v_page_id,'') ~* '(product.image|product.video|media)' THEN 'premium-media-producer'
      WHEN COALESCE(v_page_id,'') ~* 'categor' THEN 'category-manager'
      WHEN COALESCE(v_page_id,'') ~* '(omnichannel|whatsapp|messenger|chat)' THEN 'customer-communication-specialist'
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

CREATE OR REPLACE FUNCTION office_agent_run_step_projection_trigger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.agent_id IS DISTINCT FROM NEW.agent_id THEN
    PERFORM office_sync_agent_run_step(OLD,TRUE);
  END IF;
  PERFORM office_sync_agent_run_step(NEW,FALSE);
  RETURN NEW;
END;
$$;

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
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION office_workspace_roster_trigger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ensure_workspace_office_roster(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS office_work_item_dependencies_no_cycles ON office_work_item_dependencies;
CREATE TRIGGER office_work_item_dependencies_no_cycles
  BEFORE INSERT OR UPDATE ON office_work_item_dependencies
  FOR EACH ROW EXECUTE FUNCTION office_prevent_dependency_cycle();

DROP TRIGGER IF EXISTS office_work_items_blocker_guard ON office_work_items;
CREATE TRIGGER office_work_items_blocker_guard
  BEFORE UPDATE OF status ON office_work_items
  FOR EACH ROW EXECUTE FUNCTION office_require_completed_blockers();

DROP TRIGGER IF EXISTS office_work_items_source_guard ON office_work_items;
CREATE TRIGGER office_work_items_source_guard
  BEFORE INSERT OR UPDATE OF workspace_id,parent_work_item_id,source_type,source_agent_run_id,source_record_id
  ON office_work_items FOR EACH ROW EXECUTE FUNCTION office_validate_work_item_links();

DROP TRIGGER IF EXISTS office_work_items_projection ON office_work_items;
CREATE TRIGGER office_work_items_projection
  AFTER INSERT OR UPDATE ON office_work_items
  FOR EACH ROW EXECUTE FUNCTION office_work_item_changed();

DROP TRIGGER IF EXISTS office_assignments_projection ON office_work_item_assignments;
CREATE TRIGGER office_assignments_projection
  AFTER INSERT OR UPDATE OR DELETE ON office_work_item_assignments
  FOR EACH ROW EXECUTE FUNCTION office_assignment_changed();

DROP TRIGGER IF EXISTS office_work_item_events_immutable ON office_work_item_events;
CREATE TRIGGER office_work_item_events_immutable
  BEFORE UPDATE OR DELETE ON office_work_item_events
  FOR EACH ROW EXECUTE FUNCTION prevent_office_event_mutation();

DROP TRIGGER IF EXISTS agent_runs_office_projection ON agent_runs;
CREATE TRIGGER agent_runs_office_projection
  AFTER INSERT OR UPDATE OF status,plan,result,error_code,error_message,worker_id,heartbeat_at,attempt_count,started_at,finished_at
  ON agent_runs FOR EACH ROW EXECUTE FUNCTION office_agent_run_projection_trigger();

DROP TRIGGER IF EXISTS agent_run_steps_office_projection ON agent_run_steps;
CREATE TRIGGER agent_run_steps_office_projection
  AFTER INSERT OR UPDATE OF status,agent_id,agent_role ON agent_run_steps
  FOR EACH ROW EXECUTE FUNCTION office_agent_run_step_projection_trigger();

DROP TRIGGER IF EXISTS agent_action_packets_office_projection ON agent_action_packets;
CREATE TRIGGER agent_action_packets_office_projection
  AFTER INSERT ON agent_action_packets
  FOR EACH ROW EXECUTE FUNCTION office_action_packet_projection_trigger();

DROP TRIGGER IF EXISTS workspace_action_records_office_projection ON workspace_records;
CREATE TRIGGER workspace_action_records_office_projection
  AFTER UPDATE OF stage,status,data ON workspace_records
  FOR EACH ROW EXECUTE FUNCTION office_action_record_projection_trigger();

DROP TRIGGER IF EXISTS workspaces_office_roster ON workspaces;
CREATE TRIGGER workspaces_office_roster
  AFTER INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION office_workspace_roster_trigger();

DROP TRIGGER IF EXISTS office_departments_set_updated_at ON office_departments;
CREATE TRIGGER office_departments_set_updated_at BEFORE UPDATE ON office_departments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS digital_employees_set_updated_at ON digital_employees;
CREATE TRIGGER digital_employees_set_updated_at BEFORE UPDATE ON digital_employees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS digital_employees_state_projection ON digital_employees;
CREATE TRIGGER digital_employees_state_projection
  AFTER UPDATE OF availability,active ON digital_employees
  FOR EACH ROW EXECUTE FUNCTION office_employee_availability_changed();

-- Materialize only roles backed by actual Lulu capabilities. Unsupported future
-- roles are deliberately absent rather than displayed as fake activity.
DO $$ DECLARE workspace_row RECORD; BEGIN
  FOR workspace_row IN SELECT id FROM workspaces WHERE deleted_at IS NULL LOOP
    PERFORM ensure_workspace_office_roster(workspace_row.id);
  END LOOP;
END $$;

-- Project historical runs without rewriting the canonical agent_runs table.
DO $$ DECLARE run_row agent_runs%ROWTYPE; BEGIN
  FOR run_row IN SELECT * FROM agent_runs LOOP
    PERFORM office_materialize_agent_run(run_row,FALSE);
  END LOOP;
END $$;

DO $$ DECLARE packet_row RECORD; BEGIN
  FOR packet_row IN SELECT workspace_id,record_id FROM agent_action_packets LOOP
    PERFORM office_materialize_action_packet(packet_row.workspace_id,packet_row.record_id);
  END LOOP;
END $$;

DO $$ DECLARE step_row agent_run_steps%ROWTYPE; BEGIN
  FOR step_row IN SELECT * FROM agent_run_steps LOOP
    PERFORM office_sync_agent_run_step(step_row,FALSE);
  END LOOP;
END $$;
