import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import assert from 'node:assert/strict';
import { RESOURCE_CATALOG } from '../src/domain/resource-catalog.js';

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
