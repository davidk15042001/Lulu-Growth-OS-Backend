import pg from 'pg';

const REQUIRED_CONFIRMATION = 'DELETE_NON_CORE_DATA_NO_BACKUP';
const confirmation = process.env.PURGE_CONFIRM;
const dryRun = process.env.PURGE_DRY_RUN !== '0';

if (confirmation !== REQUIRED_CONFIRMATION) {
  throw new Error(
    `Refusing to run. Set PURGE_CONFIRM=${REQUIRED_CONFIRMATION} and use PURGE_DRY_RUN=0 only after reviewing this script.`,
  );
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

// These are the only application tables intentionally protected. Everything
// else in public is a purge candidate, except schema_migrations.
const protectedTables = new Set([
  // Identity and workspace access.
  'users', 'refresh_tokens', 'auth_sessions', 'otp_codes', 'rate_limits',
  'workspaces', 'workspace_members', 'workspace_invitations', 'workspace_settings',
  'admin_user_roles',

  // Company and onboarding foundations.
  'organizations', 'legal_entities', 'factories', 'locations', 'brands',
  'workspace_offerings', 'workspace_ai_preferences', 'workspace_ai_business_profiles',
  'onboarding_documents',

  // Billing, payments, wallets, ledgers, and plan reference data.
  'workspace_subscriptions', 'workspace_billing_checkouts', 'airwallex_webhook_events',
  'workspace_payg_profiles', 'workspace_payg_periods', 'workspace_server_usage_ledger',
  'workspace_credit_balances', 'workspace_credit_grants', 'workspace_payg_payment_setups',
  'workspace_payg_qr_payments', 'workspace_usage_adjustments',
  'workspace_ad_spend_wallets', 'workspace_ad_spend_topups', 'workspace_ad_spend_ledger',
  'workspace_api_wallets', 'workspace_api_topups', 'workspace_api_wallet_ledger',
  'workspace_r2_usage_ledger', 'financial_ledger_entries', 'financial_journals',
  'invoices', 'invoice_lines', 'invoice_payments',
  'workspace_document_sequences', 'commercial_policies', 'commercial_document_idempotency',

  // Authorized provider/OAuth connections.
  'workspace_platforms', 'provider_accounts', 'provider_connections',
  'provider_connection_workspace_access', 'workspace_platform_oauth_credentials',
  'lulu_managed_oauth_connections', 'workspace_oauth_self_service_permissions',

  // Static application/reference tables.
  'resource_types', 'workspace_capabilities', 'workspace_role_capabilities',
  'provider_registry', 'provider_capability_definitions', 'plan_catalog',
  'entitlement_definitions', 'plan_entitlements', 'schema_migrations',
]);

const quoteIdent = (value) => `"${String(value).replaceAll('"', '""')}"`;
const tableName = (name) => `${quoteIdent('public')}.${quoteIdent(name)}`;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '30s'");
  await client.query("SET LOCAL statement_timeout = '8h'");

  const tableResult = await client.query(`
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND n.nspname = 'public'
  `);
  const allTables = new Set(tableResult.rows.map(({ table_name }) => table_name));
  const missingProtected = [...protectedTables].filter((name) => !allTables.has(name));
  if (missingProtected.length) {
    throw new Error(`PROTECTED_TABLES_NOT_FOUND: ${missingProtected.sort().join(', ')}`);
  }

  const candidates = [...allTables].filter((name) => !protectedTables.has(name));
  const counts = await client.query(`
    SELECT relname AS table_name, n_live_tup::bigint AS estimated_rows
      FROM pg_stat_user_tables
     WHERE schemaname = 'public' AND relname = ANY($1::text[])
     ORDER BY n_live_tup DESC, relname
  `, [candidates]);

  console.log(JSON.stringify({
    mode: dryRun ? 'dry-run' : 'destructive',
    protectedTables: [...protectedTables].sort(),
    candidateTables: candidates.sort(),
    estimatedCandidateRows: counts.rows,
  }, null, 2));

  if (dryRun) {
    await client.query('ROLLBACK');
    console.log('Dry run complete. No rows were changed. Set PURGE_DRY_RUN=0 to execute.');
    process.exit(0);
  }

  // Delete children before parents. A failed delete caused by a remaining
  // candidate child is retried; a protected-table reference aborts safely.
  const pending = new Set(candidates);
  while (pending.size) {
    let progress = 0;
    for (const name of [...pending]) {
      try {
        const result = await client.query(`DELETE FROM ${tableName(name)}`);
        pending.delete(name);
        progress += 1;
        if (result.rowCount) console.log(`Deleted ${result.rowCount} rows from ${name}`);
      } catch (error) {
        if (error?.code !== '23503') throw error;
      }
    }
    if (!pending.size) break;
    if (!progress) {
      throw new Error(
        `PURGE_BLOCKED_BY_FOREIGN_KEY: ${[...pending].sort().join(', ')}. No protected rows were modified.`,
      );
    }
  }

  await client.query('COMMIT');
  console.log('Purge committed. Protected tables were not modified.');
} catch (error) {
  await client.query('ROLLBACK');
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.end();
}
