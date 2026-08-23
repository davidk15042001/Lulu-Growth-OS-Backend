import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { RESOURCE_CATALOG } from '../src/domain/resource-catalog.js';
import { failExhaustedJobsSql } from '../src/modules/websites/website.repo.js';

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
    const websiteSite = await database.query<{ id: string }>(
      `INSERT INTO workspace_sites (workspace_id, provider, ownership_mode, name, external_site_id)
       VALUES ($1, 'wordpress', 'connected', 'Migration Website', 'migration-site')
       RETURNING id`,
      [workspaceId]
    );
    const websiteJob = await database.query<{ id: string }>(
      `INSERT INTO website_generation_jobs (site_id, prompt, created_by, auto_publish, status, preview, plan, provider_result)
       VALUES ($1, 'Generate a progressive migration test website.', $2, TRUE, 'publishing', '{"progress":{"phase":"publishing_pages","percent":72,"completedSections":3,"totalSections":8}}'::jsonb, '{"pages":[{"slug":"home","generatedSections":[{"key":"hero","title":"Hero","html":"<section>Hero</section>"}]}]}'::jsonb, '{"pages":[{"slug":"home","id":"42"}]}'::jsonb)
       RETURNING id`,
      [websiteSite.rows[0]?.id, userId]
    );
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
