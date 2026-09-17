-- Give every visible Digital Employee the complete capability set required by
-- its documented responsibility. These are employee identities in the Office
-- projection; external side effects still pass through the same server-side
-- command policy and canonical domain services as manual workspace actions.

ALTER FUNCTION ensure_workspace_office_roster(UUID)
  RENAME TO ensure_workspace_employee_execution_roster;

CREATE OR REPLACE FUNCTION ensure_workspace_office_roster(p_workspace_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ensure_workspace_employee_execution_roster(p_workspace_id);

  INSERT INTO digital_employee_capabilities(workspace_id,employee_id,capability_key,access_mode)
  SELECT p_workspace_id,employee.id,mapping.capability_key,mapping.access_mode
  FROM (VALUES
    ('crm-manager','leads.read','OBSERVE'),
    ('crm-manager','leads.manage','MANAGE'),
    ('crm-manager','opportunities.read','OBSERVE'),
    ('crm-manager','opportunities.manage','MANAGE'),
    ('quote-specialist','quotes.update','EXECUTE'),
    ('quote-specialist','quotes.send','EXECUTE'),
    ('omnichannel-manager','omnichannel.reply','EXECUTE'),
    ('website-manager','website.manage','EXECUTE'),
    ('pages-cms-manager','website.publish','EXECUTE'),
    ('search-visibility-manager','website.publish','EXECUTE'),
    ('product-manager','products.create','EXECUTE'),
    ('invoice-manager','invoices.issue','EXECUTE'),
    ('invoice-manager','invoices.send','EXECUTE'),
    ('billing-usage-manager','finance.manage','EXECUTE'),
    ('bookkeeping-manager','finance.manage','EXECUTE'),
    ('integration-manager','providers.connect','EXECUTE'),
    ('outcome-quality-auditor','quality.read','OBSERVE'),
    ('outcome-quality-auditor','quality.review','EXECUTE')
  ) AS mapping(employee_key,capability_key,access_mode)
  JOIN digital_employees employee
    ON employee.workspace_id=p_workspace_id
   AND employee.employee_key=mapping.employee_key
   AND employee.active
  ON CONFLICT (workspace_id,employee_id,capability_key) DO UPDATE
    SET access_mode=EXCLUDED.access_mode;
END;
$$;

SELECT ensure_workspace_office_roster(id)
FROM workspaces
WHERE deleted_at IS NULL;
