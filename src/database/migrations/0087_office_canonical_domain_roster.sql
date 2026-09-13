-- Extend the human-readable Office roster for the canonical domain engines.
-- The renamed function remains the original 0079 seed; the public wrapper
-- keeps every existing caller and future workspace on one complete roster.

ALTER FUNCTION ensure_workspace_office_roster(UUID)
  RENAME TO ensure_workspace_base_office_roster;

CREATE OR REPLACE FUNCTION ensure_workspace_office_roster(p_workspace_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ensure_workspace_base_office_roster(p_workspace_id);

  -- The bookkeeping lead owns the accounting engine; the invoice employee
  -- remains attached to the canonical invoice page.
  UPDATE digital_employees
  SET source_agent_ids='["page:breezy-soil-2475"]'::jsonb,
      updated_at=NOW()
  WHERE workspace_id=p_workspace_id AND employee_key='invoice-manager'
    AND source_agent_ids IS DISTINCT FROM '["page:breezy-soil-2475"]'::jsonb;

  INSERT INTO digital_employees(
    workspace_id,department_id,employee_key,display_name,role_title,
    description,availability,source_agent_ids,source_modules,sort_order
  )
  SELECT p_workspace_id,department.id,template.employee_key,template.display_name,
         template.role_title,template.description,template.availability,
         template.source_agent_ids::jsonb,template.source_modules,template.sort_order
  FROM (VALUES
    ('commerce','order-manager','Order Manager','Order Manager',
      'Operates the canonical order lifecycle, reservations, and customer order state.',
      'AVAILABLE','["page:mightily-shore-7108"]',ARRAY['commerce'],40),
    ('commerce','inventory-manager','Inventory Manager','Inventory Manager',
      'Maintains canonical locations, stock levels, reservations, and availability evidence.',
      'AVAILABLE','["page:smart-village-1099"]',ARRAY['commerce'],50),
    ('commerce','fulfillment-manager','Fulfillment Manager','Fulfillment Manager',
      'Coordinates canonical fulfillment, shipment, and delivery transitions.',
      'AVAILABLE','["page:purely-dusk-2409"]',ARRAY['commerce'],60),
    ('marketing','social-publishing-specialist','Social Publishing Specialist','Social Publishing Specialist',
      'Runs verified Facebook and Instagram publication jobs and records real provider outcomes.',
      'LIMITED','["page:wondrous-cloud-1355"]',ARRAY['marketing'],30),
    ('finance','bookkeeping-manager','Bookkeeping Manager','Bookkeeping Manager',
      'Maintains the balanced, canonical accounting journal and verified financial evidence.',
      'AVAILABLE','["system:finance-bookkeeping-lead","page:quietly-stone-4158"]',ARRAY['finance'],30)
  ) AS template(
    department_key,employee_key,display_name,role_title,description,
    availability,source_agent_ids,source_modules,sort_order
  )
  JOIN office_departments department
    ON department.workspace_id=p_workspace_id
   AND department.department_key=template.department_key
  ON CONFLICT (workspace_id,employee_key) DO UPDATE SET
    department_id=EXCLUDED.department_id,
    display_name=EXCLUDED.display_name,
    role_title=EXCLUDED.role_title,
    description=EXCLUDED.description,
    availability=EXCLUDED.availability,
    source_agent_ids=EXCLUDED.source_agent_ids,
    source_modules=EXCLUDED.source_modules,
    sort_order=EXCLUDED.sort_order,
    active=TRUE,
    updated_at=NOW();

  INSERT INTO digital_employee_capabilities(workspace_id,employee_id,capability_key,access_mode)
  SELECT p_workspace_id,employee.id,mapping.capability_key,mapping.access_mode
  FROM (VALUES
    ('order-manager','orders.read','OBSERVE'),('order-manager','orders.manage','EXECUTE'),
    ('inventory-manager','orders.read','OBSERVE'),('inventory-manager','orders.manage','EXECUTE'),
    ('fulfillment-manager','orders.read','OBSERVE'),('fulfillment-manager','orders.manage','EXECUTE'),
    ('social-publishing-specialist','social.read','OBSERVE'),
    ('social-publishing-specialist','social.manage','EXECUTE'),
    ('social-publishing-specialist','social.publish','EXECUTE'),
    ('bookkeeping-manager','finance.read','OBSERVE'),('bookkeeping-manager','finance.manage','EXECUTE')
  ) AS mapping(employee_key,capability_key,access_mode)
  JOIN digital_employees employee
    ON employee.workspace_id=p_workspace_id AND employee.employee_key=mapping.employee_key
  ON CONFLICT (workspace_id,employee_id,capability_key) DO UPDATE
    SET access_mode=EXCLUDED.access_mode;

  INSERT INTO office_employee_state_projection(workspace_id,employee_id,display_state)
  SELECT p_workspace_id,id,CASE WHEN availability='UNAVAILABLE' THEN 'OFFLINE' ELSE 'IDLE' END
  FROM digital_employees
  WHERE workspace_id=p_workspace_id AND active
  ON CONFLICT (workspace_id,employee_id) DO NOTHING;
END;
$$;

SELECT ensure_workspace_office_roster(id)
FROM workspaces
WHERE deleted_at IS NULL;
