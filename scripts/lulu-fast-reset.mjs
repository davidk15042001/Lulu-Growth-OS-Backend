import pg from 'pg';

const keep = new Set([
  'users', 'device_push_tokens', 'refresh_tokens', 'otp_codes', 'auth_sessions', 'rate_limits',
  'workspaces', 'workspace_members', 'workspace_invitations', 'workspace_offerings', 'workspace_platforms',
  'workspace_ai_preferences', 'workspace_settings', 'workspace_ai_business_profiles', 'onboarding_documents',
  'organizations', 'legal_entities', 'factories', 'brands', 'locations',
  'workspace_knowledge_activations', 'workspace_knowledge_sections', 'workspace_knowledge_snapshots',
  'workspace_competitors', 'workspace_customer_segments', 'workspace_content_assets', 'workspace_site_domains',
  'workspace_sites', 'workspace_storage_objects', 'workspace_entitlement_overrides', 'workspace_entitlement_restrictions',
  'workspace_subscriptions', 'workspace_usage_counters', 'workspace_billing_checkouts', 'airwallex_webhook_events',
  'workspace_payg_profiles', 'workspace_payg_periods', 'workspace_server_usage_ledger',
  'workspace_credit_balances', 'workspace_credit_grants', 'workspace_payg_payment_setups', 'workspace_payg_qr_payments',
  'workspace_usage_adjustments', 'workspace_ad_spend_wallets', 'workspace_ad_spend_topups',
  'workspace_ad_spend_ledger', 'workspace_ad_spend_reservations', 'workspace_api_wallets', 'workspace_api_topups',
  'workspace_api_wallet_ledger', 'workspace_r2_usage_ledger', 'financial_ledger_entries', 'invoices', 'invoice_lines',
  'commercial_policies', 'workspace_document_sequences', 'commercial_document_idempotency',
  'commercial_document_links', 'commercial_document_operations', 'quotes', 'quote_lines', 'quote_versions', 'invoice_payments',
  'admin_user_roles', 'resource_types', 'workspace_capabilities', 'workspace_role_capabilities',
  'plan_catalog', 'entitlement_definitions', 'plan_entitlements', 'schema_migrations',
  'provider_registry', 'provider_capability_definitions', 'provider_capability_states', 'provider_accounts',
  'provider_connections', 'provider_connection_workspace_access', 'provider_object_mappings', 'provider_sync_states',
  'provider_webhook_events', 'omni_channels', 'omni_channel_identities', 'email_accounts', 'calendar_accounts',
  'social_accounts', 'lulu_managed_oauth_connections', 'workspace_oauth_self_service_permissions',
  'workspace_platform_oauth_credentials', 'webhook_endpoints', 'workspace_records', 'record_attachments',
  'record_comments', 'record_relationships', 'products', 'product_applications', 'product_capacity',
  'product_categories', 'product_certificates', 'product_legacy_mappings', 'product_market_data', 'product_media',
  'product_packaging', 'product_prices', 'product_relationships', 'product_seo_metadata', 'product_specifications',
  'product_translations', 'product_variants', 'commerce_orders', 'commerce_order_lines', 'commerce_order_legacy_mappings',
  'commerce_sequences', 'email_automation_rules', 'email_drafts', 'email_folders', 'email_messages', 'email_threads',
  'calendar_events', 'calendar_native_events', 'social_content', 'support_messages', 'support_tickets', 'audit_log',
  'security_events', 'financial_journals', 'metric_definitions',
  'twilio_platform_configuration', 'twilio_workspace_accounts', 'unifyport_platform_configuration',
]);

const ident = (value) => `"${String(value).replaceAll('"', '""')}"`;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '30s'");
  await client.query("SET LOCAL statement_timeout = '8h'");
  // These reservations are explicitly part of the authorized test-data reset.
  // Capture their ids before the generic FK cleanup so their preserved wallet
  // ledger entries can be removed instead of being left as orphaned test data.
  await client.query(`
    CREATE TEMP TABLE reset_ai_reservations ON COMMIT DROP AS
    SELECT workspace_id, id FROM ai_spend_reservations
  `);
  await client.query(`
    DELETE FROM workspace_api_wallet_ledger ledger
     USING reset_ai_reservations reset
     WHERE ledger.workspace_id = reset.workspace_id
       AND ledger.reservation_id = reset.id
  `);

  const tableRows = await client.query(`
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname = 'public'
  `);
  const allTables = new Set(tableRows.rows.map((row) => row.table_name));

  // Keep parents needed by protected rows unless every FK column is nullable.
  // Nullable references (for example test AI reservations in the preserved
  // wallet ledger) are cleared below so those operational parents can reset.
  for (;;) {
    const parents = await client.query(`
      SELECT parent.relname AS table_name
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
      JOIN LATERAL unnest(con.conkey) AS key_parts(attnum) ON TRUE
      JOIN pg_attribute attribute
        ON attribute.attrelid = child.oid
       AND attribute.attnum = key_parts.attnum
      WHERE con.contype = 'f'
        AND child_ns.nspname = 'public'
        AND parent_ns.nspname = 'public'
        AND child.relname = ANY($1::text[])
      GROUP BY con.oid, parent.relname
      HAVING BOOL_AND(attribute.attnotnull)
    `, [[...keep]]);
    let added = 0;
    for (const row of parents.rows) {
      if (!keep.has(row.table_name)) {
        keep.add(row.table_name);
        added += 1;
      }
    }
    if (!added) break;
  }

  const candidates = [...allTables].filter((table) => !keep.has(table));

  // Tables referenced by protected rows cannot be TRUNCATEd because PostgreSQL
  // checks FK definitions even when the referencing rows are empty. They are
  // therefore deleted after their candidate children are truncated.
  const protectedParentRows = await client.query(`
    SELECT parent.relname AS table_name
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    JOIN LATERAL unnest(con.conkey) AS key_parts(attnum) ON TRUE
    JOIN pg_attribute attribute
      ON attribute.attrelid = child.oid
     AND attribute.attnum = key_parts.attnum
    WHERE con.contype = 'f'
      AND child_ns.nspname = 'public'
      AND parent_ns.nspname = 'public'
      AND child.relname = ANY($1::text[])
      AND parent.relname = ANY($2::text[])
    GROUP BY con.oid, parent.relname
    HAVING BOOL_AND(attribute.attnotnull)
  `, [[...keep], candidates]);
  const protectedParents = new Set(protectedParentRows.rows.map((row) => row.table_name));
  // Any candidate parent of a protected-parent candidate also cannot be
  // truncated alone: PostgreSQL checks the FK definition, not row contents.
  // Expand this set until all candidate ancestors are included.
  for (;;) {
    const ancestors = await client.query(`
      SELECT parent.relname AS table_name
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
      JOIN LATERAL unnest(con.conkey) AS key_parts(attnum) ON TRUE
      JOIN pg_attribute attribute
        ON attribute.attrelid = child.oid
       AND attribute.attnum = key_parts.attnum
      WHERE con.contype = 'f'
        AND child_ns.nspname = 'public'
        AND parent_ns.nspname = 'public'
        AND child.relname = ANY($1::text[])
        AND parent.relname = ANY($2::text[])
      GROUP BY con.oid, parent.relname
      HAVING BOOL_AND(attribute.attnotnull)
    `, [[...protectedParents], candidates]);
    let added = 0;
    for (const row of ancestors.rows) {
      if (!protectedParents.has(row.table_name)) {
        protectedParents.add(row.table_name);
        added += 1;
      }
    }
    if (!added) break;
  }
  const safeToTruncate = candidates.filter((table) => !protectedParents.has(table));
  const parentsToDelete = candidates.filter((table) => protectedParents.has(table));

  // Null only nullable references from protected rows into candidate tables.
  // This preserves invoices/ledgers while allowing their old operational
  // records to be deleted safely.
  const refs = await client.query(`
    SELECT child.relname AS child_table,
           parent.relname AS parent_table,
           ARRAY_AGG(attribute.attname ORDER BY key_parts.ordinality)
             FILTER (WHERE NOT attribute.attnotnull) AS nullable_columns,
           BOOL_AND(attribute.attnotnull) AS all_not_null
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY
      AS key_parts(attnum, ordinality) ON TRUE
    JOIN pg_attribute attribute
      ON attribute.attrelid = child.oid
     AND attribute.attnum = key_parts.attnum
    WHERE con.contype = 'f'
      AND child_ns.nspname = 'public'
      AND parent_ns.nspname = 'public'
      AND child.relname = ANY($1::text[])
      AND parent.relname = ANY($2::text[])
    GROUP BY con.oid, child.relname, parent.relname
  `, [[...keep], candidates]);

  for (const row of refs.rows) {
    const columns = Array.isArray(row.nullable_columns) ? row.nullable_columns : [];
    if (row.all_not_null) {
      throw new Error(`PROTECTED_REFERENCE_CANNOT_BE_CLEARED: ${row.child_table} -> ${row.parent_table}`);
    }
    if (!columns.length) continue;
    const assignments = columns.map((column) => `${ident(column)} = NULL`).join(', ');
    await client.query(`UPDATE ${ident('public')}.${ident(row.child_table)} SET ${assignments}`);
  }

  if (safeToTruncate.length) {
    // Keep each TRUNCATE statement small. A single statement containing the
    // entire catalogue can exceed PostgreSQL's parser/statement limits and
    // produces an opaque syntax error. CASCADE is safe here because every
    // table that has a protected descendant was excluded from this set above.
    for (const table of safeToTruncate) {
      await client.query(`TRUNCATE TABLE ${ident('public')}.${ident(table)} RESTART IDENTITY CASCADE`);
    }
  }

  // The remaining candidate parents are referenced by protected tables, so
  // DELETE them after all candidate children are gone.
  const pendingParents = new Set(parentsToDelete);
  const clearPendingNullableFks = async () => {
    const rows = await client.query(`
      SELECT child.relname AS child_table,
             ARRAY_AGG(attribute.attname ORDER BY key_parts.ordinality)
               FILTER (WHERE NOT attribute.attnotnull) AS nullable_columns
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
      JOIN LATERAL unnest(con.conkey) WITH ORDINALITY
        AS key_parts(attnum, ordinality) ON TRUE
      JOIN pg_attribute attribute
        ON attribute.attrelid = child.oid
       AND attribute.attnum = key_parts.attnum
      WHERE con.contype = 'f'
        AND child_ns.nspname = 'public'
        AND parent_ns.nspname = 'public'
        AND child.relname = ANY($1::text[])
        AND parent.relname = ANY($1::text[])
      GROUP BY con.oid, child.relname
    `, [[...pendingParents]]);
    let changed = 0;
    for (const row of rows.rows) {
      const columns = Array.isArray(row.nullable_columns) ? row.nullable_columns : [];
      if (!columns.length) continue;
      const assignments = columns.map((column) => `${ident(column)} = NULL`).join(', ');
      const result = await client.query(`UPDATE ${ident('public')}.${ident(row.child_table)} SET ${assignments}`);
      changed += result.rowCount;
    }
    return changed;
  };
  while (pendingParents.size) {
    let progress = 0;
    for (const table of [...pendingParents]) {
      try {
        await client.query(`DELETE FROM ${ident('public')}.${ident(table)}`);
        pendingParents.delete(table);
        progress++;
      } catch (error) {
        if (error?.code !== '23503') throw error;
      }
    }
    if (!progress) {
      const changed = await clearPendingNullableFks();
      if (!changed) {
        throw new Error(`RESET_BLOCKED_BY_PARENT_FKS: ${[...pendingParents].sort().join(', ')}`);
      }
    }
  }

  // A reset removes all test reservations. Recompute the durable hold column
  // from the now-empty reservation table so available/reserved balances remain
  // mathematically consistent without touching prepaid credit balances.
  await client.query(`
    UPDATE workspace_api_wallets wallet
       SET reserved_amount = COALESCE((
         SELECT SUM(reserved_amount)
           FROM ai_spend_reservations reservation
          WHERE reservation.workspace_id = wallet.workspace_id
            AND reservation.status IN ('RESERVED','SUBMITTING','SUBMITTED','AMBIGUOUS')
       ), 0), updated_at = NOW()
  `);

  await client.query('COMMIT');
  console.log(JSON.stringify({
    protectedTables: [...keep].sort(),
    truncatedTables: safeToTruncate.sort(),
    deletedParentTables: parentsToDelete.sort(),
  }, null, 2));
} catch (error) {
  await client.query('ROLLBACK');
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.end();
}
