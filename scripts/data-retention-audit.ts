import 'dotenv/config';
import { Client } from 'pg';

type Policy = {
  id: string;
  workspace_id: string | null;
  data_class: string;
  table_name: string;
  timestamp_column: string;
  retention_days: number;
  disposition: string;
  legal_hold_required: boolean;
  enabled: boolean;
};

const databaseUrl = process.env.RETENTION_DATABASE_URL ?? process.env.DATABASE_URL;
const workspaceId = process.env.RETENTION_WORKSPACE_ID?.trim() || null;
const allowedTables = new Set(['onboarding_documents', 'provider_webhook_events', 'domain_events', 'agent_run_events', 'audit_log', 'financial_ledger_entries', 'ai_voice_sessions']);

function identifier(value: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

if (!databaseUrl) throw new Error('RETENTION_DATABASE_URL or DATABASE_URL must be set');

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const policies = (await client.query<Policy>(
      `SELECT id, workspace_id, data_class, table_name, timestamp_column,
              retention_days, disposition, legal_hold_required, enabled
       FROM data_retention_policies
       WHERE ($1::uuid IS NULL OR workspace_id IS NULL OR workspace_id = $1::uuid)
       ORDER BY data_class`,
      [workspaceId],
    )).rows;
    const reports: Array<Record<string, unknown>> = [];
    for (const policy of policies) {
      if (!allowedTables.has(policy.table_name)) {
        reports.push({ ...policy, status: 'UNSUPPORTED_TABLE', message: 'No retention executor is permitted for this table.' });
        continue;
      }
      const table = identifier(policy.table_name);
      const timestampColumn = identifier(policy.timestamp_column);
      const effectiveWorkspace = policy.workspace_id ?? workspaceId;
      const where = effectiveWorkspace
        ? policy.table_name === 'provider_webhook_events'
          ? `provider_connection_id IN (SELECT id FROM provider_connections WHERE workspace_id = $1)
             AND ${timestampColumn} < NOW() - ($2::int * INTERVAL '1 day')`
          : `workspace_id = $1 AND ${timestampColumn} < NOW() - ($2::int * INTERVAL '1 day')`
        : `${timestampColumn} < NOW() - ($1::int * INTERVAL '1 day')`;
      const parameters = effectiveWorkspace ? [effectiveWorkspace, policy.retention_days] : [policy.retention_days];
      const result = await client.query<{ total: string; oldest: string | null; newest: string | null }>(
        `SELECT count(*)::text AS total,
                min(${timestampColumn})::text AS oldest,
                max(${timestampColumn})::text AS newest
         FROM ${table}
         WHERE ${where}`,
        parameters,
      );
      const holdResult = effectiveWorkspace
        ? await client.query<{ total: string }>(
          `SELECT count(*)::text AS total
           FROM data_retention_holds
           WHERE workspace_id = $1 AND data_class = $2 AND released_at IS NULL`,
          [effectiveWorkspace, policy.data_class],
        )
        : { rows: [{ total: '0' }] };
      reports.push({
        ...policy,
        scopeWorkspaceId: effectiveWorkspace,
        candidateRows: Number(result.rows[0]?.total ?? 0),
        oldestCandidateAt: result.rows[0]?.oldest ?? null,
        newestCandidateAt: result.rows[0]?.newest ?? null,
        activeHoldCount: Number(holdResult.rows[0]?.total ?? 0),
        status: policy.enabled ? 'ENABLED_REVIEW_REQUIRED' : 'DISABLED',
      });
    }
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      workspaceId,
      readOnly: true,
      policies: reports,
      note: 'This audit never mutates data. Enable a reviewed policy and use the guarded executor for an explicit disposition.',
    }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
