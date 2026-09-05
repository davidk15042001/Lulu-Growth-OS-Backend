-- Part 1: extend existing auth, credentials and website models.
CREATE TABLE auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  device_label TEXT NOT NULL DEFAULT 'Browser',
  impersonated_by_user_id UUID REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id, expires_at) WHERE revoked_at IS NULL;
ALTER TABLE refresh_tokens ADD COLUMN session_id UUID REFERENCES auth_sessions(id) ON DELETE CASCADE;
ALTER TABLE refresh_tokens ADD COLUMN rotated_at TIMESTAMPTZ;
ALTER TABLE refresh_tokens ADD COLUMN revocation_reason TEXT;
INSERT INTO auth_sessions(id,user_id,created_at,last_used_at,expires_at,revoked_at,revocation_reason,impersonated_by_user_id)
SELECT id,user_id,created_at,COALESCE(last_used_at,created_at),LEAST(expires_at,NOW()+INTERVAL '30 days'),
       CASE WHEN revoked THEN NOW() ELSE NULL END, CASE WHEN revoked THEN 'legacy_revoked' ELSE NULL END,
       impersonated_by_user_id FROM refresh_tokens;
UPDATE refresh_tokens SET session_id=id, expires_at=LEAST(expires_at,NOW()+INTERVAL '30 days');
ALTER TABLE refresh_tokens ALTER COLUMN session_id SET NOT NULL;
CREATE INDEX idx_refresh_tokens_session ON refresh_tokens(session_id);
-- Tokens, passwords and raw request bodies must never enter this table. UUIDs are
-- intentionally not foreign keys: security history survives account deletion.
CREATE TABLE security_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID,
  user_id UUID,
  event_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_id TEXT,
  correlation_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(metadata)='object')
);
CREATE INDEX idx_security_events_user ON security_events(user_id,created_at DESC);
CREATE INDEX idx_security_events_workspace ON security_events(workspace_id,created_at DESC);
CREATE FUNCTION prevent_security_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Security events are append-only'; END; $$;
CREATE TRIGGER security_events_immutable BEFORE UPDATE OR DELETE ON security_events
FOR EACH ROW EXECUTE FUNCTION prevent_security_event_mutation();

CREATE TABLE admin_user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('SUPER_ADMIN','SUPPORT_ADMIN','FINANCE_ADMIN','SECURITY_ADMIN','OPERATIONS_ADMIN','READ_ONLY_ADMIN')),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id,role)
);
-- One-time migration of the *previously authorized* administrator only.
-- Runtime authorization never uses an email address and does not promote other users.
INSERT INTO admin_user_roles(user_id,role)
SELECT id,'SUPER_ADMIN' FROM users
WHERE role='admin' AND lower(email)='lulu.ai.cn@gmail.com' AND deleted_at IS NULL;
INSERT INTO security_events(user_id,event_type,metadata)
SELECT user_id,'ADMIN_ACTION','{"action":"legacy_admin_migrated","role":"SUPER_ADMIN"}'::jsonb FROM admin_user_roles;

ALTER TABLE workspace_site_domains DROP CONSTRAINT workspace_site_domains_status_check;
ALTER TABLE workspace_site_domains ADD CONSTRAINT workspace_site_domains_status_check
CHECK(status IN ('pending','verifying','verified','failed','expired','removed'));
ALTER TABLE workspace_site_domains ADD COLUMN expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW()+INTERVAL '7 days');
ALTER TABLE workspace_site_domains ADD COLUMN ownership_verified_at TIMESTAMPTZ;
-- Legacy "verified" flags were not DNS evidence. Keep sites/content, but require proof.
UPDATE workspace_site_domains SET status='pending',verified_at=NULL,last_error='DNS_REVERIFICATION_REQUIRED'
WHERE status='verified';
ALTER TABLE approval_requests ADD COLUMN authorization_consumed_at TIMESTAMPTZ;
-- Provenance is separate from public record JSON, which clients can edit.
CREATE TABLE agent_action_packets (
  record_id UUID PRIMARY KEY REFERENCES workspace_records(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  step_id UUID NOT NULL REFERENCES agent_run_steps(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  commands_digest TEXT NOT NULL,
  approval_id UUID UNIQUE REFERENCES approval_requests(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
