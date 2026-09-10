-- Durable, autonomous premium product-media production through Kie.ai.
-- Provider callbacks only update task state; background workers perform
-- quality review, retries, storage and product publication idempotently.

CREATE TABLE IF NOT EXISTS premium_media_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'SUBMITTING_IMAGES' CHECK (status IN (
    'SUBMITTING_IMAGES','GENERATING_IMAGES','SUBMITTING_IMAGE_UPSCALE','UPSCALING_IMAGE',
    'SUBMITTING_VIDEOS','GENERATING_VIDEOS','SUBMITTING_VIDEO_UPSCALE','UPSCALING_VIDEO',
    'COMPLETED','FAILED','CANCELLED'
  )),
  aspect_ratio TEXT NOT NULL DEFAULT '1:1' CHECK (aspect_ratio IN ('1:1','16:9','9:16')),
  creative_direction TEXT,
  reference_assets JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reference_assets)='array'),
  deliver_image BOOLEAN NOT NULL DEFAULT TRUE,
  deliver_video BOOLEAN NOT NULL DEFAULT TRUE,
  image_round INTEGER NOT NULL DEFAULT 1 CHECK (image_round BETWEEN 1 AND 10),
  video_round INTEGER NOT NULL DEFAULT 0 CHECK (video_round BETWEEN 0 AND 10),
  max_rounds INTEGER NOT NULL DEFAULT 3 CHECK (max_rounds BETWEEN 1 AND 10),
  image_quality_threshold INTEGER NOT NULL DEFAULT 92 CHECK (image_quality_threshold BETWEEN 70 AND 100),
  video_quality_threshold INTEGER NOT NULL DEFAULT 90 CHECK (video_quality_threshold BETWEEN 70 AND 100),
  selected_image_candidate_id UUID,
  selected_video_candidate_id UUID,
  final_image_media_id UUID,
  final_video_media_id UUID,
  error_code TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  CONSTRAINT premium_media_job_product_fk FOREIGN KEY (workspace_id, product_id)
    REFERENCES products(workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_premium_media_active_product
  ON premium_media_jobs(workspace_id, product_id)
  WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED');
CREATE INDEX IF NOT EXISTS idx_premium_media_jobs_active
  ON premium_media_jobs(status, updated_at)
  WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED');

CREATE TABLE IF NOT EXISTS premium_media_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  product_id UUID NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('IMAGE_GENERATION','IMAGE_UPSCALE','VIDEO_GENERATION','VIDEO_UPSCALE')),
  media_type TEXT NOT NULL CHECK (media_type IN ('IMAGE','VIDEO')),
  model TEXT NOT NULL,
  provider_api TEXT NOT NULL CHECK (provider_api IN ('MARKET','VEO')),
  provider_task_id TEXT,
  callback_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'SUBMITTING' CHECK (status IN (
    'SUBMITTING','SUBMITTED','PROVIDER_SUCCEEDED','PROCESSING','ACCEPTED','REJECTED','FAILED'
  )),
  generation_round INTEGER NOT NULL DEFAULT 1 CHECK (generation_round BETWEEN 1 AND 10),
  prompt TEXT NOT NULL,
  reference_urls JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reference_urls)='array'),
  result_urls JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(result_urls)='array'),
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  credits_consumed NUMERIC(18,6) NOT NULL DEFAULT 0 CHECK (credits_consumed >= 0),
  usage_recorded BOOLEAN NOT NULL DEFAULT FALSE,
  quality_score INTEGER CHECK (quality_score BETWEEN 0 AND 100),
  quality_report JSONB,
  storage_reference TEXT,
  mime_type TEXT,
  product_media_id UUID,
  processing_attempts INTEGER NOT NULL DEFAULT 0 CHECK (processing_attempts >= 0),
  worker_id TEXT,
  processing_started_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, job_id, id),
  UNIQUE (provider_api, provider_task_id),
  CONSTRAINT premium_media_candidate_job_fk FOREIGN KEY (workspace_id, job_id)
    REFERENCES premium_media_jobs(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT premium_media_candidate_product_fk FOREIGN KEY (workspace_id, product_id)
    REFERENCES products(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT premium_media_candidate_product_media_fk FOREIGN KEY (workspace_id, product_media_id, product_id)
    REFERENCES product_media(workspace_id, id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_premium_media_candidates_job
  ON premium_media_candidates(workspace_id, job_id, purpose, generation_round, created_at);
CREATE INDEX IF NOT EXISTS idx_premium_media_candidates_poll
  ON premium_media_candidates(status, updated_at)
  WHERE status IN ('SUBMITTED','PROVIDER_SUCCEEDED','PROCESSING','SUBMITTING');

-- Selected IDs remain denormalized workflow pointers. The authoritative
-- candidate and product-media rows are already tenant-scoped and cascade with
-- the owning product; avoiding reverse foreign keys keeps product deletion
-- cycle-free.

DROP TRIGGER IF EXISTS trg_premium_media_jobs_set_updated_at ON premium_media_jobs;
CREATE TRIGGER trg_premium_media_jobs_set_updated_at BEFORE UPDATE ON premium_media_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_premium_media_candidates_set_updated_at ON premium_media_candidates;
CREATE TRIGGER trg_premium_media_candidates_set_updated_at BEFORE UPDATE ON premium_media_candidates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
