import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { RESOURCE_CATALOG } from '../src/domain/resource-catalog.js';
import { failExhaustedJobsSql, markGenerationJobFailedSql, updateGenerationJobSql, updateSiteStatusSql } from '../src/modules/websites/website.repo.js';
import { claimExpiredOnboardingWorkspaceSql, finishOnboardingFileCleanupSql } from '../src/modules/onboarding/onboarding-cleanup.repo.js';
import { saveBusinessDescriptionSql } from '../src/modules/onboarding/onboarding.repo.js';
import { claimDomainEventsSql } from '../src/events/domain-event.repo.js';

const migrationsDirectory = path.resolve('src/database/migrations');

async function main() {
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  if (migrationFiles.length === 0) {
    throw new Error('No SQL migrations were found');
  }

  const database = new PGlite();

  try {
    for (const migrationFile of migrationFiles) {
      const sql = await readFile(path.join(migrationsDirectory, migrationFile), 'utf8');
      await database.exec(sql);
      console.log(`Applied ${migrationFile}`);
    }

    const result = await database.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
       ORDER BY table_name`
    );

    const actualTables = result.rows.map((row) => row.table_name);
    const expectedTables = [
      'users',
      'workspaces',
      'workspace_members',
      'workspace_invitations',
      'workspace_subscriptions',
      'workspace_usage_counters',
      'workspace_payg_profiles',
      'workspace_payg_periods',
      'workspace_server_usage_ledger',
      'idempotency_keys',
      'workspace_offerings',
      'workspace_platforms',
      'workspace_ai_preferences',
      'resource_types',
      'workspace_records',
      'metric_definitions',
      'metric_points',
      'notifications',
      'ai_conversations',
      'ai_messages',
      'approval_requests',
      'background_jobs',
      'webhook_endpoints',
      'audit_log',
      'domain_events',
      'domain_event_receipts',
    ];
    for (const table of expectedTables) {
      assert.ok(actualTables.includes(table), `Expected migration table ${table}`);
    }

    const catalogValues: unknown[] = [];
    const catalogRows = RESOURCE_CATALOG.map((resource, index) => {
      const offset = index * 4;
      catalogValues.push(resource.key, resource.domain, resource.label, resource.description);
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
    });
    await database.query(
      `INSERT INTO resource_types (key, domain, label, description)
       VALUES ${catalogRows.join(', ')}`,
      catalogValues
    );

    const user = await database.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, first_name, last_name, verified_at)
       VALUES ('migration-test@example.com', 'test-hash', 'Migration', 'Test', NOW())
       RETURNING id`
    );
    const userId = user.rows[0]?.id;
    assert.ok(userId);

    const workspace = await database.query<{ id: string }>(
      `INSERT INTO workspaces (name, slug, created_by)
       VALUES ('Migration Test GmbH', 'migration-test', $1)
       RETURNING id`,
      [userId]
    );
    const workspaceId = workspace.rows[0]?.id;
    assert.ok(workspaceId);

    await database.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [workspaceId, userId]
    );
    await database.query(
      `INSERT INTO workspace_subscriptions (
         workspace_id, trial_ends_at, current_period_starts_at, current_period_ends_at
       ) VALUES ($1, NOW() + INTERVAL '14 days', NOW(), NOW() + INTERVAL '1 month')`,
      [workspaceId]
    );
    await database.query(
      `INSERT INTO workspace_invitations (
         workspace_id, email, role, token_hash, invited_by, expires_at
       ) VALUES ($1, 'invitee@example.com', 'member', 'migration-test-token-hash', $2, NOW() + INTERVAL '7 days')`,
      [workspaceId, userId]
    );
    await database.query(
      `INSERT INTO workspace_usage_counters (
         workspace_id, metric_key, period_start, period_end, quantity
       ) VALUES ($1, 'ai_input_tokens', CURRENT_DATE, CURRENT_DATE + 30, 42)`,
      [workspaceId]
    );
    await database.query(
      `INSERT INTO idempotency_keys (
         workspace_id, key, request_hash, expires_at
       ) VALUES ($1, 'migration-request', 'sha256-placeholder', NOW() + INTERVAL '1 day')`,
      [workspaceId]
    );
    await database.query(
      `INSERT INTO workspace_offerings (workspace_id, name, offering_type)
       VALUES ($1, 'Lulu Growth OS', 'product')`,
      [workspaceId]
    );
    await database.query(
      `INSERT INTO workspace_ai_preferences (workspace_id)
       VALUES ($1)`,
      [workspaceId]
    );
    await database.query(
      `INSERT INTO workspace_payg_profiles (
         workspace_id, current_period_start, current_period_end
       ) VALUES ($1, NOW() - INTERVAL '14 days', NOW())`,
      [workspaceId],
    );
    const paygProfile = await database.query<{ interval_days: number; ai_access_blocked: boolean }>(
      `SELECT interval_days, ai_access_blocked
       FROM workspace_payg_profiles WHERE workspace_id=$1`,
      [workspaceId],
    );
    assert.equal(paygProfile.rows[0]?.interval_days, 7);
    assert.equal(paygProfile.rows[0]?.ai_access_blocked, false);
    const paygPeriod = await database.query<{ id: string }>(
      `INSERT INTO workspace_payg_periods (
         workspace_id, period_start, period_end, api_cost_usd, server_cost_usd
       ) VALUES ($1, NOW() - INTERVAL '14 days', NOW(), 1.25, 2.75)
       RETURNING id`,
      [workspaceId],
    );
    assert.ok(paygPeriod.rows[0]?.id);
    const paygTotal = await database.query<{ total_cost_usd: string }>(
      `SELECT total_cost_usd FROM workspace_payg_periods WHERE id=$1`,
      [paygPeriod.rows[0]?.id],
    );
    assert.equal(Number(paygTotal.rows[0]?.total_cost_usd), 4);
    await database.query(`UPDATE workspace_payg_periods SET status='payment_failed' WHERE id=$1`, [paygPeriod.rows[0]?.id]);
    await database.query(
      `INSERT INTO workspace_server_usage_ledger (
         workspace_id, usage_date, provider_cost_usd, customer_cost_usd, payg_period_id
       ) VALUES ($1, CURRENT_DATE, 2.75, 2.75, $2)`,
      [workspaceId, paygPeriod.rows[0]?.id],
    );
    const retention = await database.query<{ onboarding_files_expires_at: string }>(
      `SELECT onboarding_files_expires_at FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    assert.ok(retention.rows[0]?.onboarding_files_expires_at);
    const onboardingDocument = await database.query<{ id: string }>(
      `INSERT INTO onboarding_documents (
         workspace_id, uploaded_by, file_name, mime_type, size_bytes, storage_key, content
       ) VALUES ($1, $2, 'company-profile.txt', 'text/plain', 7, $3, $4)
       RETURNING id`,
      [workspaceId, userId, `workspaces/${workspaceId}/onboarding/documents/migration-test`, Buffer.from('profile')],
    );
    const onboardingDocumentId = onboardingDocument.rows[0]?.id;
    assert.ok(onboardingDocumentId);
    await database.query(
      `UPDATE workspaces SET onboarding_files_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
      [workspaceId],
    );
    const cleanupClaim = await database.query<{ workspaceId: string }>(claimExpiredOnboardingWorkspaceSql, [30]);
    assert.equal(cleanupClaim.rows[0]?.workspaceId, workspaceId);
    await database.query(
      `DELETE FROM onboarding_documents WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, onboardingDocumentId],
    );
    await database.query(finishOnboardingFileCleanupSql, [workspaceId, 5]);
    const cleanedWorkspace = await database.query<{
      onboarding_step: string;
      onboarding_file_reupload_required: boolean;
      onboarding_files_purged_at: string | null;
      onboarding_file_cleanup_started_at: string | null;
    }>(
      `SELECT onboarding_step, onboarding_file_reupload_required,
              onboarding_files_purged_at, onboarding_file_cleanup_started_at
       FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    assert.equal(cleanedWorkspace.rows[0]?.onboarding_step, 'business_description');
    assert.equal(cleanedWorkspace.rows[0]?.onboarding_file_reupload_required, true);
    assert.ok(cleanedWorkspace.rows[0]?.onboarding_files_purged_at);
    assert.equal(cleanedWorkspace.rows[0]?.onboarding_file_cleanup_started_at, null);
    const blockedDescriptionSave = await database.query<{ id: string }>(saveBusinessDescriptionSql, [
      workspaceId,
      'Existing text must not bypass the re-upload requirement.',
      null,
      null,
      null,
      [],
    ]);
    assert.equal(blockedDescriptionSave.rows.length, 0);
    await database.query(
      `INSERT INTO onboarding_documents (
         workspace_id, uploaded_by, file_name, mime_type, size_bytes, storage_key, content
       ) VALUES ($1, $2, 'reuploaded-profile.txt', 'text/plain', 7, $3, $4)`,
      [workspaceId, userId, `workspaces/${workspaceId}/onboarding/documents/reuploaded`, Buffer.from('profile')],
    );
    const acceptedDescriptionSave = await database.query<{ id: string }>(saveBusinessDescriptionSql, [
      workspaceId,
      'Freshly uploaded company profile.',
      null,
      null,
      null,
      [],
    ]);
    assert.equal(acceptedDescriptionSave.rows[0]?.id, workspaceId);
    await database.query(
      `UPDATE workspace_subscriptions SET status = 'active' WHERE workspace_id = $1`,
      [workspaceId],
    );
    await database.query(
      `UPDATE workspaces SET onboarding_files_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
      [workspaceId],
    );
    const paidCleanupClaim = await database.query<{ workspaceId: string }>(claimExpiredOnboardingWorkspaceSql, [30]);
    assert.equal(paidCleanupClaim.rows.length, 0);
    const websiteSite = await database.query<{ id: string }>(
      `INSERT INTO workspace_sites (workspace_id, provider, ownership_mode, name, external_site_id)
       VALUES ($1, 'wordpress', 'connected', 'Migration Website', 'migration-site')
       RETURNING id`,
      [workspaceId]
    );
    const updatedWebsiteSite = await database.query<{ id: string }>(updateSiteStatusSql, [workspaceId, websiteSite.rows[0]?.id, 'generating']);
    assert.equal(updatedWebsiteSite.rows[0]?.id, websiteSite.rows[0]?.id);
    const updatedWebsiteSiteStatus = await database.query<{ status: string }>('SELECT status FROM workspace_sites WHERE id = $1', [websiteSite.rows[0]?.id]);
    assert.equal(updatedWebsiteSiteStatus.rows[0]?.status, 'generating');
    const websiteJob = await database.query<{ id: string }>(
      `INSERT INTO website_generation_jobs (site_id, prompt, created_by, auto_publish, status, preview, plan, provider_result)
       VALUES ($1, 'Generate a progressive migration test website.', $2, TRUE, 'publishing', '{"progress":{"phase":"publishing_pages","percent":72,"completedSections":3,"totalSections":8}}'::jsonb, '{"pages":[{"slug":"home","generatedSections":[{"key":"hero","title":"Hero","html":"<section>Hero</section>"}]}]}'::jsonb, '{"pages":[{"slug":"home","id":"42"}]}'::jsonb)
       RETURNING id`,
      [websiteSite.rows[0]?.id, userId]
    );
    const updatedWebsiteJob = await database.query<{ id: string }>(updateGenerationJobSql, [websiteSite.rows[0]?.id, websiteJob.rows[0]?.id, 'planning', null, null, null, null, null]);
    assert.equal(updatedWebsiteJob.rows[0]?.id, websiteJob.rows[0]?.id);
    const cancelledWebsiteJob = await database.query<{ status: string; preview: { progress?: { phase?: string; percent?: number } } }>(
      `UPDATE website_generation_jobs
       SET status = 'cancelled',
           preview = jsonb_set(COALESCE(preview, '{}'::jsonb), '{progress}', COALESCE(preview->'progress', '{}'::jsonb) || '{"phase":"cancelled"}'::jsonb, TRUE)
       WHERE id = $1
       RETURNING status, preview`,
      [websiteJob.rows[0]?.id]
    );
    assert.equal(cancelledWebsiteJob.rows[0]?.status, 'cancelled');
    assert.equal(cancelledWebsiteJob.rows[0]?.preview.progress?.phase, 'cancelled');
    assert.equal(cancelledWebsiteJob.rows[0]?.preview.progress?.percent, 72);
    const resumedWebsiteJob = await database.query<{ status: string; preview: { progress?: { phase?: string; completedSections?: number } }; plan: { pages?: Array<{ generatedSections?: unknown[] }> }; provider_result: { pages?: unknown[] } }>(
      `UPDATE website_generation_jobs
       SET status = 'queued',
           preview = jsonb_set(COALESCE(preview, '{}'::jsonb), '{progress}', COALESCE(preview->'progress', '{}'::jsonb) || '{"phase":"resuming"}'::jsonb, TRUE),
           error_code = NULL,
           error_message = NULL,
           attempt_count = 0,
           worker_id = NULL,
           locked_at = NULL,
           heartbeat_at = NOW()
       WHERE id = $1 AND status = 'cancelled'
       RETURNING status, preview, plan, provider_result`,
      [websiteJob.rows[0]?.id],
    );
    assert.equal(resumedWebsiteJob.rows[0]?.status, 'queued');
    assert.equal(resumedWebsiteJob.rows[0]?.preview.progress?.phase, 'resuming');
    assert.equal(resumedWebsiteJob.rows[0]?.preview.progress?.completedSections, 3);
    assert.equal(resumedWebsiteJob.rows[0]?.plan.pages?.[0]?.generatedSections?.length, 1);
    assert.equal(resumedWebsiteJob.rows[0]?.provider_result.pages?.length, 1);
    await database.query(
      `UPDATE website_generation_jobs
       SET status = 'planning', attempt_count = 3, worker_id = 'expired-worker',
           locked_at = NOW() - INTERVAL '5 minutes', heartbeat_at = NOW() - INTERVAL '5 minutes'
       WHERE id = $1`,
      [websiteJob.rows[0]?.id],
    );
    await database.query(failExhaustedJobsSql, [3, 90, websiteSite.rows[0]?.id]);
    const exhaustedWebsiteJob = await database.query<{
      status: string;
      error_code: string;
      preview: { progress?: { phase?: string; percent?: number }; activity?: Array<{ code?: string; params?: { attempts?: number } }> };
      provider_result: { failureDetails?: { reason?: string; attempts?: number } };
    }>(`SELECT status, error_code, preview, provider_result FROM website_generation_jobs WHERE id = $1`, [websiteJob.rows[0]?.id]);
    assert.equal(exhaustedWebsiteJob.rows[0]?.status, 'failed');
    assert.equal(exhaustedWebsiteJob.rows[0]?.error_code, 'WEBSITE_GENERATION_RETRY_EXHAUSTED');
    assert.equal(exhaustedWebsiteJob.rows[0]?.preview.progress?.phase, 'failed');
    assert.equal(exhaustedWebsiteJob.rows[0]?.preview.progress?.percent, 72);
    assert.equal(exhaustedWebsiteJob.rows[0]?.preview.activity?.at(-1)?.code, 'generation_retry_exhausted');
    assert.equal(exhaustedWebsiteJob.rows[0]?.preview.activity?.at(-1)?.params?.attempts, 3);
    assert.equal(exhaustedWebsiteJob.rows[0]?.provider_result.failureDetails?.reason, 'worker_lease_expired');
    await database.query(markGenerationJobFailedSql, [websiteSite.rows[0]?.id, websiteJob.rows[0]?.id, 'WEBSITE_TEST_FAILURE', 'Typed fallback test']);
    const fallbackWebsiteJob = await database.query<{ status: string; error_code: string; error_message: string; preview: { progress?: { phase?: string; percent?: number } } }>('SELECT status, error_code, error_message, preview FROM website_generation_jobs WHERE id = $1', [websiteJob.rows[0]?.id]);
    assert.equal(fallbackWebsiteJob.rows[0]?.status, 'failed');
    assert.equal(fallbackWebsiteJob.rows[0]?.error_code, 'WEBSITE_TEST_FAILURE');
    assert.equal(fallbackWebsiteJob.rows[0]?.error_message, 'Typed fallback test');
    assert.equal(fallbackWebsiteJob.rows[0]?.preview.progress?.phase, 'failed');
    assert.equal(fallbackWebsiteJob.rows[0]?.preview.progress?.percent, 72);
    const exhaustedWebsiteSite = await database.query<{ status: string }>('SELECT status FROM workspace_sites WHERE id = $1', [websiteSite.rows[0]?.id]);
    assert.equal(exhaustedWebsiteSite.rows[0]?.status, 'error');
    const record = await database.query<{ id: string }>(
      `INSERT INTO workspace_records (
         workspace_id, resource_type, name, created_by
       ) VALUES ($1, 'crm_contacts', 'Ada Lovelace', $2)
       RETURNING id`,
      [workspaceId, userId]
    );
    assert.ok(record.rows[0]?.id);

    const domainEvent = await database.query<{ id: string; sequence: string; status: string }>(
      `INSERT INTO domain_events (
         workspace_id, event_type, aggregate_type, aggregate_id, payload, idempotency_key
       ) VALUES ($1, 'record.created', 'workspace_record', $2, $3::jsonb, $4)
       RETURNING id, sequence::text, status`,
      [workspaceId, record.rows[0]?.id, JSON.stringify({ resourceType: 'crm_contacts' }), `migration-record:${record.rows[0]?.id}:created`],
    );
    assert.ok(domainEvent.rows[0]?.id);
    assert.equal(domainEvent.rows[0]?.status, 'pending');
    assert.ok(Number(domainEvent.rows[0]?.sequence) > 0);
    const duplicateDomainEvent = await database.query<{ id: string }>(
      `INSERT INTO domain_events (
         workspace_id, event_type, aggregate_type, aggregate_id, payload, idempotency_key
       ) VALUES ($1, 'record.created', 'workspace_record', $2, '{}'::jsonb, $3)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [workspaceId, record.rows[0]?.id, `migration-record:${record.rows[0]?.id}:created`],
    );
    assert.equal(duplicateDomainEvent.rows.length, 0);
    const claimedDomainEvent = await database.query<{ id: string; status: string; attempts: number; lockedBy: string }>(
      claimDomainEventsSql,
      ['migration-event-worker', 10, 60],
    );
    assert.equal(claimedDomainEvent.rows[0]?.id, domainEvent.rows[0]?.id);
    assert.equal(claimedDomainEvent.rows[0]?.status, 'processing');
    assert.equal(claimedDomainEvent.rows[0]?.attempts, 1);
    assert.equal(claimedDomainEvent.rows[0]?.lockedBy, 'migration-event-worker');
    await database.query(
      `INSERT INTO domain_event_receipts (event_id, consumer_name, result)
       VALUES ($1, 'migration-test-consumer.v1', '{"verified":true}'::jsonb)`,
      [domainEvent.rows[0]?.id],
    );
    const receipt = await database.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM domain_event_receipts WHERE event_id=$1`,
      [domainEvent.rows[0]?.id],
    );
    assert.equal(receipt.rows[0]?.total, 1);

    const metric = await database.query<{ id: string }>(
      `INSERT INTO metric_definitions (workspace_id, key, name, domain)
       VALUES ($1, 'monthly_revenue', 'Monthly Revenue', 'finance')
       RETURNING id`,
      [workspaceId]
    );
    await database.query(
      `INSERT INTO metric_points (metric_id, recorded_at, value)
       VALUES ($1, NOW(), 125000.50)`,
      [metric.rows[0]?.id]
    );

    const catalogCount = await database.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM resource_types'
    );
    assert.equal(catalogCount.rows[0]?.total, RESOURCE_CATALOG.length);

    console.log(
      `Verified ${migrationFiles.length} migrations, ${result.rows.length} tables, ` +
      `${RESOURCE_CATALOG.length} resource types and core relational inserts`
    );
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
