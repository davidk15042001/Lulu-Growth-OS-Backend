-- New accounts choose and activate billing before entering the shortened setup.
-- The business-description and existing-platforms screens are no longer part
-- of the active onboarding sequence.

ALTER TABLE workspaces
  ALTER COLUMN onboarding_step SET DEFAULT 'billing';

UPDATE workspaces w
SET onboarding_step = CASE
      WHEN EXISTS (
        SELECT 1 FROM workspace_subscriptions s
        WHERE s.workspace_id=w.id
          AND s.status='active'
          AND s.provider IN ('internal', 'airwallex')
      ) THEN 'products_services'
      ELSE 'billing'
    END,
    onboarding_file_reupload_required = FALSE
WHERE w.onboarding_completed_at IS NULL
  AND w.onboarding_step IN ('business_description', 'existing_platforms');

UPDATE workspaces w
SET onboarding_step='billing'
WHERE w.onboarding_completed_at IS NULL
  AND w.onboarding_step='company_information'
  AND NOT EXISTS (
    SELECT 1 FROM workspace_subscriptions s
    WHERE s.workspace_id=w.id
      AND s.status='active'
      AND s.provider IN ('internal', 'airwallex')
  );
