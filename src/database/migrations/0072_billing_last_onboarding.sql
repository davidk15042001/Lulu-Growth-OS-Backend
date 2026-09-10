-- Billing is the final step of the shortened three-step onboarding:
-- company information -> products and services -> billing.
ALTER TABLE workspaces
  ALTER COLUMN onboarding_step SET DEFAULT 'company_information';

-- Move unfinished billing-first workspaces back into the new sequence. Paid
-- workspaces are not affected when onboarding is already complete.
UPDATE workspaces
SET onboarding_step = CASE
  WHEN onboarding_step IN ('billing', 'company_information') THEN 'company_information'
  WHEN onboarding_step IN ('business_description', 'existing_platforms') THEN 'products_services'
  ELSE onboarding_step
END
WHERE onboarding_completed_at IS NULL;

-- A saved offering makes step two complete. These workspaces can proceed
-- directly to the final billing step after the deployment.
UPDATE workspaces w
SET onboarding_step = 'billing'
WHERE w.onboarding_completed_at IS NULL
  AND w.onboarding_step = 'products_services'
  AND EXISTS (
    SELECT 1
    FROM workspace_offerings o
    WHERE o.workspace_id = w.id
      AND o.deleted_at IS NULL
  );

-- Existing customers who already paid and supplied an offering are complete
-- under the new sequence and should not be sent through billing again.
UPDATE workspaces w
SET onboarding_step = 'setup_complete',
    onboarding_completed_at = COALESCE(w.onboarding_completed_at, NOW())
WHERE w.onboarding_completed_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM workspace_offerings o
    WHERE o.workspace_id = w.id
      AND o.deleted_at IS NULL
  )
  AND EXISTS (
    SELECT 1
    FROM workspace_subscriptions s
    WHERE s.workspace_id = w.id
      AND s.status = 'active'
      AND s.provider IN ('internal', 'airwallex')
      AND s.plan_key IN ('viewer', 'starter', 'ai', 'test')
  );
