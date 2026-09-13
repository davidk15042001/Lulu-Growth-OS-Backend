-- Social publishing authorization and asynchronous execution provenance.
--
-- A queued provider write is not a completed AI action. The active actor fields
-- identify the user/workflow/agent action that most recently queued delivery so
-- the durable event consumer can reconcile the originating action packet only
-- after Meta returns a terminal outcome.

ALTER TABLE social_publication_jobs
  ADD COLUMN IF NOT EXISTS execution_actor_type TEXT,
  ADD COLUMN IF NOT EXISTS execution_actor_ref TEXT;

UPDATE social_publication_jobs
SET execution_actor_type = created_by_actor_type,
    execution_actor_ref = created_by_actor_ref
WHERE execution_actor_type IS NULL;

ALTER TABLE social_publication_jobs
  ALTER COLUMN execution_actor_type SET NOT NULL,
  ALTER COLUMN execution_actor_type SET DEFAULT 'USER';

ALTER TABLE social_publication_jobs
  DROP CONSTRAINT IF EXISTS social_publication_jobs_execution_actor_type_check;
ALTER TABLE social_publication_jobs
  ADD CONSTRAINT social_publication_jobs_execution_actor_type_check
  CHECK (execution_actor_type IN ('USER','AI_AGENT','WORKFLOW','SYSTEM','ADMIN'));

INSERT INTO workspace_capabilities(key, description) VALUES
  ('social.read', 'Read social accounts, content and publication evidence'),
  ('social.manage', 'Manage social identities and canonical social content'),
  ('social.publish', 'Queue, retry and cancel external social publications')
ON CONFLICT (key) DO UPDATE SET description=EXCLUDED.description;

INSERT INTO workspace_role_capabilities(role, capability_key)
SELECT role, capability_key
FROM (VALUES
  ('owner','social.read'),('owner','social.manage'),('owner','social.publish'),
  ('admin','social.read'),('admin','social.manage'),('admin','social.publish'),
  ('marketing_manager','social.read'),('marketing_manager','social.manage'),('marketing_manager','social.publish'),
  ('marketing_user','social.read'),
  ('member','social.read'),
  ('viewer','social.read')
) AS grants(role, capability_key)
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_social_publication_execution_actor
  ON social_publication_jobs(workspace_id, execution_actor_type, execution_actor_ref)
  WHERE execution_actor_ref IS NOT NULL;
