-- Expand the persisted Digital Employee organization without creating a second
-- execution system. These are role-level projections over the same canonical
-- Workspace services and command policy.

ALTER FUNCTION ensure_workspace_office_roster(UUID)
  RENAME TO ensure_workspace_employee_execution_roster_v2_base;

CREATE OR REPLACE FUNCTION ensure_workspace_office_roster(p_workspace_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ensure_workspace_employee_execution_roster_v2_base(p_workspace_id);

  INSERT INTO digital_employees(
    workspace_id, department_id, employee_key, display_name, role_title,
    description, availability, source_agent_ids, source_modules, sort_order
  )
  SELECT p_workspace_id, d.id, template.employee_key, template.display_name,
         template.role_title, template.description, template.availability,
         template.source_agent_ids::jsonb, template.source_modules, template.sort_order
  FROM (VALUES
    ('crm-sales','customer-manager','Customer Manager','Customer Manager','Maintains complete customer and company context across the canonical CRM.','LIMITED','[]',ARRAY['crm'],50),
    ('crm-sales','lead-generation-specialist','Lead Generation Specialist','Lead Generation Specialist','Finds and records qualified opportunities from verified business signals.','LIMITED','[]',ARRAY['sales'],60),
    ('crm-sales','lead-qualification-specialist','Lead Qualification Specialist','Lead Qualification Specialist','Qualifies leads using persisted evidence and the customer context.','LIMITED','[]',ARRAY['sales','crm'],70),
    ('crm-sales','opportunity-manager','Opportunity Manager','Opportunity Manager','Maintains opportunity stages, next actions, and commercial handoffs.','LIMITED','[]',ARRAY['sales'],80),
    ('crm-sales','sales-representative','Sales Representative','Sales Representative','Coordinates evidence-backed sales follow-up and quote handoff.','LIMITED','[]',ARRAY['sales'],90),
    ('communications','customer-support-specialist','Customer Support Specialist','Customer Support Specialist','Handles customer support conversations through enabled channel identities.','LIMITED','[]',ARRAY['support','omnichannel'],50),
    ('marketing','marketing-manager','Marketing Manager','Marketing Manager','Coordinates brand, content, distribution, and measured growth work.','LIMITED','[]',ARRAY['marketing'],30),
    ('marketing','content-specialist','Content Specialist','Content Specialist','Creates and distributes evidence-backed content through approved destinations.','LIMITED','[]',ARRAY['marketing','content'],40),
    ('online-presence','media-assets-manager','Media & Assets Manager','Media & Assets Manager','Maintains the canonical media library used by websites and commerce.','LIMITED','[]',ARRAY['website','commerce'],50),
    ('online-presence','domain-manager','Domain Manager','Domain Manager','Verifies domains and coordinates safe publication boundaries.','LIMITED','[]',ARRAY['website'],60),
    ('commerce','store-manager','Store Manager','Store Manager','Coordinates the managed storefront, catalog, and commerce operations.','LIMITED','[]',ARRAY['commerce'],40),
    ('commerce','order-manager','Order Manager','Order Manager','Processes canonical orders and keeps their lifecycle consistent.','LIMITED','[]',ARRAY['commerce'],50),
    ('commerce','inventory-manager','Inventory Manager','Inventory Manager','Maintains stock levels, reservations, and inventory evidence.','LIMITED','[]',ARRAY['commerce'],60),
    ('commerce','fulfillment-manager','Fulfillment Manager','Fulfillment Manager','Coordinates fulfillment records and verified order handoffs.','LIMITED','[]',ARRAY['commerce'],70),
    ('finance','bookkeeping-manager','Bookkeeping Specialist','Bookkeeping Specialist','Posts balanced operational journals and reconciles canonical payments.','LIMITED','[]',ARRAY['finance'],30),
    ('finance','finance-operations-manager','Finance Operations Manager','Finance Operations Manager','Coordinates billing, usage, receivables, and finance controls.','LIMITED','[]',ARRAY['finance'],40),
    ('operations','automation-manager','Automation Manager','Automation Manager','Monitors autonomous schedules, event delivery, and safe recovery.','LIMITED','[]',ARRAY['operations','ai'],20),
    ('operations','operations-manager','Operations Manager','Operations Manager','Coordinates operational reliability and cross-system execution.','LIMITED','[]',ARRAY['operations'],30),
    ('analytics','analytics-manager','Analytics Manager','Analytics Manager','Coordinates verified metrics, reporting, and business intelligence.','LIMITED','[]',ARRAY['analytics'],20),
    ('analytics','commerce-analytics-manager','Commerce Analytics Manager','Commerce Analytics Manager','Measures catalog, order, inventory, and fulfillment performance.','LIMITED','[]',ARRAY['analytics','commerce'],30)
  ) AS template(department_key,employee_key,display_name,role_title,description,availability,source_agent_ids,source_modules,sort_order)
  JOIN office_departments d
    ON d.workspace_id=p_workspace_id AND d.department_key=template.department_key
  ON CONFLICT (workspace_id, employee_key) DO NOTHING;

  INSERT INTO digital_employee_capabilities(workspace_id,employee_id,capability_key,access_mode)
  SELECT p_workspace_id, employee.id, mapping.capability_key, mapping.access_mode
  FROM (VALUES
    ('customer-manager','crm.read','OBSERVE'),('customer-manager','crm.manage','EXECUTE'),
    ('lead-generation-specialist','leads.read','OBSERVE'),('lead-generation-specialist','leads.manage','EXECUTE'),
    ('lead-qualification-specialist','leads.read','OBSERVE'),('lead-qualification-specialist','leads.manage','EXECUTE'),
    ('opportunity-manager','opportunities.read','OBSERVE'),('opportunity-manager','opportunities.manage','EXECUTE'),
    ('sales-representative','leads.read','OBSERVE'),('sales-representative','opportunities.read','OBSERVE'),('sales-representative','quotes.read','OBSERVE'),
    ('customer-support-specialist','omnichannel.read','OBSERVE'),('customer-support-specialist','omnichannel.reply','EXECUTE'),
    ('marketing-manager','workspace.read','OBSERVE'),('marketing-manager','social.read','OBSERVE'),('marketing-manager','social.manage','EXECUTE'),('marketing-manager','website.read','OBSERVE'),
    ('content-specialist','website.read','OBSERVE'),('content-specialist','website.manage','EXECUTE'),('content-specialist','social.read','OBSERVE'),('content-specialist','social.manage','EXECUTE'),
    ('media-assets-manager','website.read','OBSERVE'),('media-assets-manager','website.manage','EXECUTE'),
    ('domain-manager','website.read','OBSERVE'),('domain-manager','website.publish','EXECUTE'),
    ('store-manager','products.read','OBSERVE'),('store-manager','orders.read','OBSERVE'),('store-manager','orders.manage','EXECUTE'),
    ('order-manager','orders.read','OBSERVE'),('order-manager','orders.manage','EXECUTE'),
    ('inventory-manager','products.read','OBSERVE'),('inventory-manager','orders.read','OBSERVE'),('inventory-manager','orders.manage','EXECUTE'),
    ('fulfillment-manager','orders.read','OBSERVE'),('fulfillment-manager','orders.manage','EXECUTE'),
    ('bookkeeping-manager','finance.read','OBSERVE'),('bookkeeping-manager','finance.manage','EXECUTE'),('bookkeeping-manager','invoices.read','OBSERVE'),
    ('finance-operations-manager','finance.read','OBSERVE'),('finance-operations-manager','finance.manage','MANAGE'),('finance-operations-manager','invoices.read','OBSERVE'),
    ('automation-manager','agents.read','OBSERVE'),('automation-manager','agents.manage','EXECUTE'),('automation-manager','providers.read','OBSERVE'),
    ('operations-manager','workspace.read','OBSERVE'),('operations-manager','workspace.manage','EXECUTE'),('operations-manager','providers.read','OBSERVE'),
    ('analytics-manager','workspace.read','OBSERVE'),('analytics-manager','agents.read','OBSERVE'),
    ('commerce-analytics-manager','workspace.read','OBSERVE'),('commerce-analytics-manager','orders.read','OBSERVE'),('commerce-analytics-manager','products.read','OBSERVE')
  ) AS mapping(employee_key,capability_key,access_mode)
  JOIN digital_employees employee
    ON employee.workspace_id=p_workspace_id
   AND employee.employee_key=mapping.employee_key
   AND employee.active
  ON CONFLICT (workspace_id,employee_id,capability_key) DO UPDATE
    SET access_mode=EXCLUDED.access_mode;

  INSERT INTO office_employee_state_projection(workspace_id, employee_id, display_state)
  SELECT p_workspace_id, id, CASE WHEN availability='UNAVAILABLE' THEN 'OFFLINE' ELSE 'IDLE' END
  FROM digital_employees
  WHERE workspace_id=p_workspace_id AND active
  ON CONFLICT (workspace_id, employee_id) DO NOTHING;
END;
$$;

SELECT ensure_workspace_office_roster(id)
FROM workspaces
WHERE deleted_at IS NULL;
