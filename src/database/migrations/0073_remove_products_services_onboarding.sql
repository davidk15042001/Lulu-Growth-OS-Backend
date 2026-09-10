-- Products and services are managed after activation. Onboarding now consists
-- only of company information followed by billing.
UPDATE workspaces
SET onboarding_step = 'billing'
WHERE onboarding_completed_at IS NULL
  AND onboarding_step IN ('business_description', 'products_services', 'existing_platforms');

-- Any previously activated customer has already completed the final step,
-- regardless of whether an offering was created during the former flow.
UPDATE workspaces w
SET onboarding_step = 'setup_complete',
    onboarding_completed_at = COALESCE(w.onboarding_completed_at, NOW()),
    onboarding_file_reupload_required = FALSE
WHERE w.onboarding_completed_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM workspace_subscriptions s
    WHERE s.workspace_id = w.id
      AND s.status = 'active'
      AND s.provider IN ('internal', 'airwallex')
      AND s.plan_key IN ('viewer', 'starter', 'ai', 'test')
  );
