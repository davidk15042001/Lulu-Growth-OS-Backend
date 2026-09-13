-- Preserve the durable AI execution correlation when a human controls a
-- social publication, while recording the human transition separately.
ALTER TABLE social_publication_jobs
  ADD COLUMN IF NOT EXISTS last_transition_actor_type TEXT,
  ADD COLUMN IF NOT EXISTS last_transition_actor_ref TEXT,
  ADD COLUMN IF NOT EXISTS last_transition_actor_id UUID REFERENCES users(id) ON DELETE SET NULL;

UPDATE social_publication_jobs
SET execution_actor_type=created_by_actor_type,
    execution_actor_ref=created_by_actor_ref
WHERE created_by_actor_type='AI_AGENT'
  AND execution_actor_type IN ('USER','ADMIN');

UPDATE social_publication_jobs
SET last_transition_actor_type=execution_actor_type,
    last_transition_actor_ref=execution_actor_ref,
    last_transition_actor_id=updated_by
WHERE last_transition_actor_type IS NULL;

ALTER TABLE social_publication_jobs
  ALTER COLUMN last_transition_actor_type SET DEFAULT 'USER',
  ALTER COLUMN last_transition_actor_type SET NOT NULL;

ALTER TABLE social_publication_jobs
  DROP CONSTRAINT IF EXISTS social_publication_jobs_last_transition_actor_type_check;
ALTER TABLE social_publication_jobs
  ADD CONSTRAINT social_publication_jobs_last_transition_actor_type_check
  CHECK (last_transition_actor_type IN ('USER','AI_AGENT','WORKFLOW','SYSTEM','ADMIN'));

-- 0087 originally appended the canonical invoice page on every roster ensure.
-- Wrap the deployed function so old installations and clean installs both end
-- every ensure with the same one-element JSON value.
ALTER FUNCTION ensure_workspace_office_roster(UUID)
  RENAME TO ensure_workspace_domain_office_roster;

CREATE OR REPLACE FUNCTION ensure_workspace_office_roster(p_workspace_id UUID)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ensure_workspace_domain_office_roster(p_workspace_id);
  UPDATE digital_employees
  SET source_agent_ids='["page:breezy-soil-2475"]'::jsonb,
      updated_at=NOW()
  WHERE workspace_id=p_workspace_id AND employee_key='invoice-manager'
    AND source_agent_ids IS DISTINCT FROM '["page:breezy-soil-2475"]'::jsonb;
END;
$$;

UPDATE digital_employees
SET source_agent_ids='["page:breezy-soil-2475"]'::jsonb,
    updated_at=NOW()
WHERE employee_key='invoice-manager'
  AND source_agent_ids IS DISTINCT FROM '["page:breezy-soil-2475"]'::jsonb;
