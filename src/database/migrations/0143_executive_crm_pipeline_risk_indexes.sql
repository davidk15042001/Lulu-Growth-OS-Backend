-- 0143_executive_crm_pipeline_risk_indexes.sql
-- Keeps executive CRM risk scans tenant-local and bounded to the canonical
-- follow-up and opportunity resource types. No customer data is copied.

CREATE INDEX IF NOT EXISTS idx_workspace_records_executive_crm_due_risk
  ON workspace_records (workspace_id, resource_type, due_at ASC, updated_at ASC)
  WHERE deleted_at IS NULL
    AND resource_type IN ('crm_tasks','sales_tasks');

CREATE INDEX IF NOT EXISTS idx_workspace_records_executive_opportunity_stall_risk
  ON workspace_records (workspace_id, resource_type, updated_at ASC)
  WHERE deleted_at IS NULL
    AND resource_type IN ('crm_deals','opportunities','sales_deals','sales_opportunities','growth_opportunities');
