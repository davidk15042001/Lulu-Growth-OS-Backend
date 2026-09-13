-- Bind every billable Kie request to a tenant-scoped prepaid hold and retain
-- ambiguous provider submissions for reconciliation instead of releasing or
-- silently treating missing credit evidence as free.
ALTER TABLE premium_media_candidates
  ADD COLUMN IF NOT EXISTS reservation_id UUID,
  ADD COLUMN IF NOT EXISTS funding_mode VARCHAR(24) NOT NULL DEFAULT 'UNRESOLVED'
    CHECK (funding_mode IN ('UNRESOLVED','CUSTOMER_PREPAID','PLATFORM_FUNDED')),
  ADD COLUMN IF NOT EXISTS provider_submission_state VARCHAR(24) NOT NULL DEFAULT 'UNRESERVED'
    CHECK (provider_submission_state IN ('UNRESERVED','RESERVED','SUBMITTING','SUBMITTED','AMBIGUOUS','REJECTED','SETTLED')),
  ADD COLUMN IF NOT EXISTS billing_resolution VARCHAR(24),
  ADD COLUMN IF NOT EXISTS billing_duration_seconds INTEGER CHECK (billing_duration_seconds IS NULL OR billing_duration_seconds > 0),
  ADD COLUMN IF NOT EXISTS billing_max_credits NUMERIC(18,6) CHECK (billing_max_credits IS NULL OR billing_max_credits > 0),
  ADD COLUMN IF NOT EXISTS quality_reservation_id UUID,
  ADD COLUMN IF NOT EXISTS quality_funding_mode VARCHAR(24) NOT NULL DEFAULT 'UNRESOLVED'
    CHECK (quality_funding_mode IN ('UNRESOLVED','CUSTOMER_PREPAID','PLATFORM_FUNDED')),
  ADD COLUMN IF NOT EXISTS quality_submission_state VARCHAR(24) NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (quality_submission_state IN ('NOT_STARTED','RESERVED','SUBMITTING','SUBMITTED','AMBIGUOUS','REJECTED','SETTLED')),
  ADD COLUMN IF NOT EXISTS quality_provider_response_id VARCHAR(240),
  ADD COLUMN IF NOT EXISTS quality_credits_consumed NUMERIC(18,6)
    CHECK (quality_credits_consumed IS NULL OR quality_credits_consumed > 0),
  ADD COLUMN IF NOT EXISTS quality_billing_resolution VARCHAR(24),
  ADD COLUMN IF NOT EXISTS quality_billing_duration_seconds INTEGER
    CHECK (quality_billing_duration_seconds IS NULL OR quality_billing_duration_seconds > 0),
  ADD COLUMN IF NOT EXISTS quality_billing_max_credits NUMERIC(18,6)
    CHECK (quality_billing_max_credits IS NULL OR quality_billing_max_credits > 0),
  ADD COLUMN IF NOT EXISTS quality_usage_recorded BOOLEAN NOT NULL DEFAULT FALSE;

-- Zero was historically the default for "provider did not report a value".
-- Preserve that uncertainty explicitly; only strictly positive exact evidence
-- may be settled as provider usage.
ALTER TABLE premium_media_candidates
  ALTER COLUMN credits_consumed DROP DEFAULT,
  ALTER COLUMN credits_consumed DROP NOT NULL;
UPDATE premium_media_candidates SET credits_consumed=NULL WHERE credits_consumed=0;
ALTER TABLE premium_media_candidates
  DROP CONSTRAINT IF EXISTS premium_media_candidates_credits_consumed_check;
ALTER TABLE premium_media_candidates
  ADD CONSTRAINT premium_media_candidates_credits_consumed_check
  CHECK (credits_consumed IS NULL OR credits_consumed > 0);

DO $$
BEGIN
  ALTER TABLE premium_media_candidates
    ADD CONSTRAINT premium_media_candidate_reservation_fk
    FOREIGN KEY (workspace_id, reservation_id)
    REFERENCES ai_spend_reservations(workspace_id, id)
    ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE premium_media_candidates
    ADD CONSTRAINT premium_media_candidate_quality_reservation_fk
    FOREIGN KEY (workspace_id, quality_reservation_id)
    REFERENCES ai_spend_reservations(workspace_id, id)
    ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE premium_media_candidates
    ADD CONSTRAINT premium_media_candidate_distinct_reservations
    CHECK (reservation_id IS NULL OR quality_reservation_id IS NULL OR reservation_id <> quality_reservation_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_premium_media_candidate_reservation
  ON premium_media_candidates(workspace_id, reservation_id)
  WHERE reservation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_premium_media_candidate_quality_reservation
  ON premium_media_candidates(workspace_id, quality_reservation_id)
  WHERE quality_reservation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_premium_media_candidate_billing_unresolved
  ON premium_media_candidates(provider_submission_state, quality_submission_state, updated_at)
  WHERE provider_submission_state IN ('SUBMITTING','SUBMITTED','AMBIGUOUS')
     OR quality_submission_state IN ('SUBMITTING','SUBMITTED','AMBIGUOUS');

-- Existing in-flight requests predate durable holds and cannot safely be
-- retried or declared free. Completed, already-metered candidates can continue
-- normal workflow; all other legacy provider submissions remain visible for
-- operator reconciliation.
UPDATE premium_media_candidates
   SET provider_submission_state=CASE
     WHEN usage_recorded THEN 'SETTLED'
     WHEN provider_task_id IS NULL AND status='FAILED' THEN 'REJECTED'
     WHEN provider_task_id IS NOT NULL OR status IN ('SUBMITTED','PROVIDER_SUCCEEDED','PROCESSING','ACCEPTED','REJECTED') THEN 'AMBIGUOUS'
     ELSE provider_submission_state
   END
 WHERE provider_submission_state='UNRESERVED';
