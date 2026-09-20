import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';

type ExplainRow = { 'QUERY PLAN'?: unknown };
type BenchmarkQuery = { name: string; text: string };

const databaseUrl = process.env.PERFORMANCE_DATABASE_URL?.trim();
const workspaceId = process.env.PERFORMANCE_WORKSPACE_ID?.trim();
const iterations = Math.min(20, Math.max(1, Number.parseInt(process.env.PERFORMANCE_ITERATIONS ?? '3', 10) || 3));
const outputFile = process.env.PERFORMANCE_OUTPUT?.trim();

if (!databaseUrl) throw new Error('PERFORMANCE_DATABASE_URL must point to an isolated, production-like database');
if (!workspaceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)) {
  throw new Error('PERFORMANCE_WORKSPACE_ID must be a valid UUID from the isolated benchmark dataset');
}

const parsedUrl = new URL(databaseUrl);
const deniedHosts = new Set([
  'lulu-ai.cn',
  'www.lulu-ai.cn',
  ...(process.env.PRODUCTION_DB_HOSTS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
]);
const sameAsRuntimeDatabase = databaseUrl === process.env.DATABASE_URL;
if ((deniedHosts.has(parsedUrl.hostname) || sameAsRuntimeDatabase) && process.env.ALLOW_PERFORMANCE_DATABASE !== '1') {
  throw new Error('Refusing to benchmark a production/runtime database. Use an isolated database or set ALLOW_PERFORMANCE_DATABASE=1 explicitly.');
}

const queries: BenchmarkQuery[] = [
  {
    name: 'workspace_records_list',
    text: `SELECT id, resource_type, name, status, created_at
           FROM workspace_records
           WHERE workspace_id = $1 AND deleted_at IS NULL
           ORDER BY created_at DESC
           LIMIT 100`,
  },
  {
    name: 'agent_runs_list',
    text: `SELECT id, status, goal, updated_at
           FROM agent_runs
           WHERE workspace_id = $1
           ORDER BY updated_at DESC
           LIMIT 100`,
  },
  {
    name: 'domain_event_stream',
    text: `SELECT sequence, event_type, event_version, status, occurred_at
           FROM domain_events
           WHERE workspace_id = $1
           ORDER BY sequence DESC
           LIMIT 100`,
  },
  {
    name: 'invoices_list',
    text: `SELECT id, invoice_number, status, grand_total, currency, updated_at
           FROM invoices
           WHERE workspace_id = $1
           ORDER BY updated_at DESC
           LIMIT 100`,
  },
  {
    name: 'financial_ledger_list',
    text: `SELECT id, account_code, direction, amount_minor, currency, created_at
           FROM financial_ledger_entries
           WHERE workspace_id = $1
           ORDER BY created_at DESC
           LIMIT 100`,
  },
];

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const results: Array<Record<string, unknown>> = [];
  try {
    for (const benchmark of queries) {
      const latencies: number[] = [];
      let rowCount = 0;
      let plan: unknown = null;
      for (let index = 0; index < iterations; index += 1) {
        const startedAt = performance.now();
        const result = await client.query(benchmark.text, [workspaceId]);
        latencies.push(Math.round((performance.now() - startedAt) * 100) / 100);
        rowCount = result.rowCount ?? 0;
      }
      const explain = await client.query<ExplainRow>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${benchmark.text}`,
        [workspaceId],
      );
      plan = explain.rows[0]?.['QUERY PLAN'] ?? null;
      const sorted = [...latencies].sort((a, b) => a - b);
      results.push({
        name: benchmark.name,
        iterations,
        rowCount,
        p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? null,
        p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? null,
        maxMs: sorted.at(-1) ?? null,
        plan,
      });
    }
    const payload = {
      generatedAt: new Date().toISOString(),
      databaseHost: parsedUrl.hostname,
      workspaceId,
      iterations,
      queries: results,
      note: 'Read-only benchmark. Plans include ANALYZE/BUFFERS and must be compared with the same dataset tier.',
    };
    const serialized = JSON.stringify(payload, null, 2);
    if (outputFile) await writeFile(outputFile, `${serialized}\n`, 'utf8');
    console.log(serialized);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
