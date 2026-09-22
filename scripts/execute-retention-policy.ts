import 'dotenv/config';
import { Client } from 'pg';

type Policy = {
  id: string;
  workspace_id: string | null;
  data_class: string;
  table_name: string;
  timestamp_column: string;
  retention_days: number;
  disposition: 'ARCHIVE' | 'DELETE' | 'ANONYMIZE' | 'REVIEW';
  legal_hold_required: boolean;
  enabled: boolean;
};

const databaseUrl = process.env.RETENTION_DATABASE_URL ?? process.env.DATABASE_URL;
const policyId = process.env.RETENTION_POLICY_ID?.trim();
const workspaceId = process.env.RETENTION_WORKSPACE_ID?.trim() || null;
const apply = process.env.RETENTION_APPLY === '1';
const dryRun = process.env.RETENTION_DRY_RUN !== '0';
const batchSize = Math.min(5000, Math.max(1, Number.parseInt(process.env.RETENTION_BATCH_SIZE ?? '1000', 10) || 1000));
const allowedTables = new Set(['onboarding_documents', 'domain_events', 'agent_run_events', 'ai_voice_sessions']);

function identifier(value: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return `"${value}"`;
}

if (!databaseUrl) throw new Error('RETENTION_DATABASE_URL or DATABASE_URL must be set');
if (!policyId) throw new Error('RETENTION_POLICY_ID must identify one reviewed policy');
if (!apply) throw new Error('Refusing retention execution. Set RETENTION_APPLY=1 explicitly.');

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '15min'");
    const policyResult = await client.query<Policy>(
      `SELECT id, workspace_id, data_class, table_name, timestamp_column,
              retention_days, disposition, legal_hold_required, enabled
       FROM data_retention_policies WHERE id = $1 FOR UPDATE`,
      [policyId],
    );
    const policy = policyResult.rows[0];
    if (!policy) throw new Error('Retention policy was not found');
    if (!policy.enabled) throw new Error('Retention policy is disabled; enable it only after review');
    if (policy.disposition !== 'DELETE') throw new Error(`Retention disposition ${policy.disposition} is not executable by the delete worker`);
    if (!allowedTables.has(policy.table_name)) throw new Error(`No delete executor is allowed for ${policy.table_name}`);
    const table = identifier(policy.table_name);
    const timestampColumn = identifier(policy.timestamp_column);
    const effectiveWorkspace = policy.workspace_id ?? workspaceId;
    if (!effectiveWorkspace) throw new Error('RETENTION_WORKSPACE_ID is required; retention execution is always tenant-scoped');
    const cutoff = new Date(Date.now() - policy.retention_days * 24 * 60 * 60 * 1000);
    const idempotencyKey = process.env.RETENTION_RUN_KEY?.trim() || `${policy.data_class}:${cutoff.toISOString().slice(0, 10)}`;
    const runResult = await client.query<{ id: string }>(
      `INSERT INTO data_retention_runs (
         workspace_id, policy_id, data_class, cutoff_at, dry_run, status, idempotency_key, started_at
       ) VALUES ($1, $2, $3, $4, $5, 'RUNNING', $6, NOW())
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [effectiveWorkspace, policy.id, policy.data_class, cutoff, dryRun, idempotencyKey],
    );
    const runId = runResult.rows[0]?.id;
    if (!runId) throw new Error('A retention run with this idempotency key already exists');

    const workspaceClause = effectiveWorkspace ? 'workspace_id = $2 AND ' : '';
    const candidateWhere = `${workspaceClause}${timestampColumn} < $1
      AND NOT EXISTS (
        SELECT 1 FROM data_retention_holds hold
        WHERE hold.data_class = $${effectiveWorkspace ? 3 : 2}
          AND hold.subject_type = $${effectiveWorkspace ? 4 : 3}
          AND hold.subject_id = ${table}.id::text
          AND hold.released_at IS NULL
          ${effectiveWorkspace ? 'AND hold.workspace_id = $2' : ''}
      )`;
    const holdParameters = effectiveWorkspace
      ? [cutoff, effectiveWorkspace, policy.data_class, policy.table_name]
      : [cutoff, policy.data_class, policy.table_name];
    const countResult = await client.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM ${table} WHERE ${candidateWhere}`,
      holdParameters,
    );
    const eligible = Number(countResult.rows[0]?.total ?? 0);
    let dispositioned = 0;
    if (!dryRun) {
      const deleteParameters = effectiveWorkspace
        ? [cutoff, effectiveWorkspace, policy.data_class, policy.table_name, batchSize]
        : [cutoff, policy.data_class, policy.table_name, batchSize];
      const deleteWhere = effectiveWorkspace
        ? `workspace_id = $2 AND ${timestampColumn} < $1`
        : `${timestampColumn} < $1`;
      const holdDataClassParam = effectiveWorkspace ? '$3' : '$2';
      const holdSubjectTypeParam = effectiveWorkspace ? '$4' : '$3';
      const holdWorkspaceClause = effectiveWorkspace ? 'AND hold.workspace_id = $2' : '';
      const deleted = await client.query(
        `WITH candidates AS (
           SELECT ${identifier('id')} FROM ${table}
           WHERE ${deleteWhere}
             AND NOT EXISTS (
               SELECT 1 FROM data_retention_holds hold
               WHERE hold.data_class = ${holdDataClassParam}
                 AND hold.subject_type = ${holdSubjectTypeParam}
                 AND hold.subject_id = ${table}.id::text
                 AND hold.released_at IS NULL ${holdWorkspaceClause}
             )
           ORDER BY ${timestampColumn}
           LIMIT $${effectiveWorkspace ? 5 : 4}
         )
         DELETE FROM ${table} target USING candidates
         WHERE target.id = candidates.id`,
        deleteParameters,
      );
      dispositioned = deleted.rowCount ?? 0;
    }
    await client.query(
      `UPDATE data_retention_runs
       SET status = 'COMPLETED', rows_scanned = $2, rows_eligible = $3,
           rows_dispositioned = $4, finished_at = NOW(), metadata = $5::jsonb
       WHERE id = $1`,
      [runId, eligible, eligible, dispositioned, JSON.stringify({ table: policy.table_name, dryRun, batchSize })],
    );
    await client.query('COMMIT');
    console.log(JSON.stringify({ ok: true, runId, policyId, dryRun, eligible, dispositioned, cutoff: cutoff.toISOString() }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
