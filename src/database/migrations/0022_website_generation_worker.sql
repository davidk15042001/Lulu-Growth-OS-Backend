ALTER TABLE website_generation_jobs
  ADD COLUMN IF NOT EXISTS requested_language TEXT,
  ADD COLUMN IF NOT EXISTS auto_publish BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS worker_id TEXT,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE website_generation_jobs
    ADD CONSTRAINT website_generation_jobs_attempt_count_check CHECK (attempt_count >= 0);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_website_generation_jobs_worker_queue
  ON website_generation_jobs (status, created_at)
  WHERE status IN ('queued', 'planning', 'generated', 'preview', 'publishing');

CREATE INDEX IF NOT EXISTS idx_website_generation_jobs_worker_lease
  ON website_generation_jobs (heartbeat_at)
  WHERE status IN ('planning', 'publishing');

WITH ranked_active_jobs AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY site_id ORDER BY created_at DESC, id DESC) AS position
  FROM website_generation_jobs
  WHERE status IN ('queued', 'planning', 'generated', 'preview', 'publishing')
)
UPDATE website_generation_jobs AS job
SET status = 'cancelled',
    error_code = 'WEBSITE_GENERATION_SUPERSEDED',
    error_message = 'A newer website generation job replaced this job.',
    worker_id = NULL,
    locked_at = NULL,
    heartbeat_at = NOW()
FROM ranked_active_jobs AS ranked
WHERE job.id = ranked.id AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_website_generation_jobs_one_active_per_site
  ON website_generation_jobs (site_id)
  WHERE status IN ('queued', 'planning', 'generated', 'preview', 'publishing');
