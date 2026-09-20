import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

type Row = Record<string, unknown>;

const migrationsDirectory = path.resolve('src/database/migrations');

async function applyMigrations(database: PGlite) {
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  assert.ok(migrationFiles.length > 0, 'No SQL migrations were found');
  for (const migrationFile of migrationFiles) {
    await database.exec(await readFile(path.join(migrationsDirectory, migrationFile), 'utf8'));
  }
  return migrationFiles;
}

async function main() {
  const database = new PGlite();
  try {
    const migrationFiles = await applyMigrations(database);
    const query = async <T extends Row = Row>(sql: string, params: unknown[] = []) =>
      (await database.query<T>(sql, params)).rows;

    const expectedTables = [
      'workspaces',
      'workspace_members',
      'workspace_records',
      'agent_runs',
      'agent_run_steps',
      'agent_run_events',
      'domain_events',
      'domain_event_receipts',
      'provider_connections',
      'products',
      'quotes',
      'invoices',
      'financial_ledger_entries',
      'idempotency_keys',
    ];
    const tables = await query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name = ANY($1::text[])`,
      [expectedTables],
    );
    const actualTables = new Set(tables.map((row) => row.table_name));
    for (const table of expectedTables) {
      assert.ok(actualTables.has(table), `Schema contract missing table: ${table}`);
    }

    const workspaceScopedTables = [
      'workspace_records',
      'agent_runs',
      'agent_run_steps',
      'agent_run_events',
      'products',
      'quotes',
      'invoices',
      'financial_ledger_entries',
      'idempotency_keys',
    ];
    const workspaceColumns = await query<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name = 'workspace_id'
         AND table_name = ANY($1::text[])`,
      [workspaceScopedTables],
    );
    const workspaceColumnByTable = new Map(workspaceColumns.map((row) => [row.table_name, row.is_nullable]));
    for (const table of workspaceScopedTables) {
      assert.equal(workspaceColumnByTable.get(table), 'NO', `workspace_id must be NOT NULL on ${table}`);
    }

    const foreignKeys = await query<{ child_table: string; parent_table: string }>(
      `SELECT child.relname AS child_table, parent.relname AS parent_table
       FROM pg_constraint constraint_row
       JOIN pg_class child ON child.oid = constraint_row.conrelid
       JOIN pg_namespace child_schema ON child_schema.oid = child.relnamespace
       JOIN pg_class parent ON parent.oid = constraint_row.confrelid
       JOIN pg_namespace parent_schema ON parent_schema.oid = parent.relnamespace
       WHERE constraint_row.contype = 'f'
         AND child_schema.nspname = 'public'
         AND parent_schema.nspname = 'public'`,
    );
    const foreignKeyPairs = new Set(foreignKeys.map((row) => `${row.child_table}->${row.parent_table}`));
    for (const pair of [
      'workspace_records->workspaces',
      'agent_runs->workspaces',
      'agent_run_steps->workspaces',
      'agent_run_events->workspaces',
      'domain_event_receipts->domain_events',
      'provider_connections->workspaces',
      'products->workspaces',
      'quotes->workspaces',
      'invoices->workspaces',
      'financial_ledger_entries->workspaces',
      'idempotency_keys->workspaces',
    ]) {
      assert.ok(foreignKeyPairs.has(pair), `Schema contract missing foreign key: ${pair}`);
    }

    const uniqueConstraints = await query<{ table_name: string; columns: string }>(
      `SELECT tc.table_name,
              string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS columns
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_schema = tc.constraint_schema
        AND kcu.constraint_name = tc.constraint_name
        AND kcu.table_name = tc.table_name
       WHERE tc.constraint_schema = 'public'
         AND tc.constraint_type IN ('UNIQUE', 'PRIMARY KEY')
         AND tc.table_name = ANY($1::text[])
       GROUP BY tc.table_name, tc.constraint_name`,
      [['workspace_members', 'invoices', 'quotes', 'financial_ledger_entries', 'idempotency_keys']],
    );
    const uniquePairs = new Set(uniqueConstraints.map((row) => `${row.table_name}:${row.columns}`));
    for (const pair of [
      'workspace_members:workspace_id,user_id',
      'invoices:workspace_id,invoice_number',
      'quotes:workspace_id,quote_number',
      'financial_ledger_entries:workspace_id,idempotency_key,direction',
      'idempotency_keys:workspace_id,key',
    ]) {
      assert.ok(uniquePairs.has(pair), `Schema contract missing unique key: ${pair}`);
    }

    const indexes = await query<{ tablename: string; indexname: string; indexdef: string }>(
      `SELECT tablename, indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = ANY($1::text[])`,
      [['workspace_records', 'agent_runs', 'invoices', 'financial_ledger_entries', 'domain_events']],
    );
    const indexText = indexes.map((row) => `${row.tablename}:${row.indexname}:${row.indexdef}`.toLowerCase());
    const requireIndex = (label: string, predicate: (value: string) => boolean) =>
      assert.ok(indexText.some(predicate), `Schema contract missing index: ${label}`);
    requireIndex('workspace_records workspace list index', (value) => value.includes('workspace_records') && value.includes('workspace_id') && value.includes('resource_type'));
    requireIndex('agent_runs workspace index', (value) => value.includes('agent_runs') && value.includes('workspace_id'));
    requireIndex('invoices workspace status index', (value) => value.includes('invoices') && value.includes('workspace_id') && value.includes('status'));
    requireIndex('financial ledger workspace index', (value) => value.includes('financial_ledger_entries') && value.includes('workspace_id'));
    requireIndex('domain event delivery index', (value) => value.includes('domain_events') && value.includes('status') && value.includes('available_at'));
    requireIndex('domain event idempotency index', (value) => value.includes('domain_events') && value.includes('idempotency_key'));

    const domainEventColumns = await query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'domain_events'
         AND column_name = ANY($1::text[])`,
      [['event_version', 'idempotency_key', 'status', 'available_at', 'attempts']],
    );
    const domainEventColumnNames = new Set(domainEventColumns.map((row) => row.column_name));
    for (const column of ['event_version', 'idempotency_key', 'status', 'available_at', 'attempts']) {
      assert.ok(domainEventColumnNames.has(column), `Domain event contract missing column: ${column}`);
    }

    const triggers = await query<{ trigger_name: string }>(
      `SELECT trigger_name
       FROM information_schema.triggers
       WHERE trigger_schema = 'public' AND event_object_table = 'financial_ledger_entries'`,
    );
    assert.ok(
      triggers.some((row) => row.trigger_name === 'trg_financial_ledger_append_only'),
      'Financial ledger must remain append-only',
    );

    const forbiddenDuplicateTables = ['canonical_invoices', 'canonical_quotes', 'legacy_invoices', 'legacy_quotes'];
    const duplicateRows = await query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [forbiddenDuplicateTables],
    );
    assert.deepEqual(duplicateRows, [], 'Duplicate canonical business-object tables are not allowed');

    console.log(JSON.stringify({
      ok: true,
      migrationCount: migrationFiles.length,
      contract: {
        tables: expectedTables.length,
        workspaceScopedTables: workspaceScopedTables.length,
        requiredForeignKeys: 11,
        requiredUniqueKeys: 5,
        requiredIndexes: 6,
        appendOnlyLedger: true,
        versionedIdempotentEvents: true,
        duplicateCanonicalTables: false,
      },
    }, null, 2));
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
