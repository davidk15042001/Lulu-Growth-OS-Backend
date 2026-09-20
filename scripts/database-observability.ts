import 'dotenv/config';
import { Client } from 'pg';

const databaseUrl = process.env.OBSERVABILITY_DATABASE_URL ?? process.env.DATABASE_URL;
const maxQueryAgeSeconds = Math.max(1, Number.parseInt(process.env.DB_OBSERVABILITY_MAX_QUERY_AGE_SECONDS ?? '60', 10) || 60);
const strict = process.env.DB_OBSERVABILITY_STRICT === '1';

if (!databaseUrl) throw new Error('OBSERVABILITY_DATABASE_URL or DATABASE_URL must be set');

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const [activity, blocked, eventBacklog, agentBacklog, webhookBacklog] = await Promise.all([
      client.query<{ pid: number; state: string; wait_event_type: string | null; wait_event: string | null; age_seconds: string | null }>(
        `SELECT pid, state, wait_event_type, wait_event,
                EXTRACT(EPOCH FROM (NOW() - COALESCE(xact_start, query_start)))::int AS age_seconds
         FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
         ORDER BY age_seconds DESC NULLS LAST
         LIMIT 100`,
      ),
      client.query<{ blocked_pid: number; blocker_count: number }>(
        `SELECT blocked.pid AS blocked_pid, count(blocker.pid)::int AS blocker_count
         FROM pg_stat_activity blocked
         JOIN pg_locks blocked_lock ON blocked_lock.pid = blocked.pid AND NOT blocked_lock.granted
         JOIN pg_locks blocker_lock
           ON blocker_lock.locktype = blocked_lock.locktype
          AND blocker_lock.database IS NOT DISTINCT FROM blocked_lock.database
          AND blocker_lock.relation IS NOT DISTINCT FROM blocked_lock.relation
          AND blocker_lock.page IS NOT DISTINCT FROM blocked_lock.page
          AND blocker_lock.tuple IS NOT DISTINCT FROM blocked_lock.tuple
          AND blocker_lock.virtualxid IS NOT DISTINCT FROM blocked_lock.virtualxid
          AND blocker_lock.transactionid IS NOT DISTINCT FROM blocked_lock.transactionid
          AND blocker_lock.classid IS NOT DISTINCT FROM blocked_lock.classid
          AND blocker_lock.objid IS NOT DISTINCT FROM blocked_lock.objid
          AND blocker_lock.objsubid IS NOT DISTINCT FROM blocked_lock.objsubid
          AND blocker_lock.pid <> blocked_lock.pid
          AND blocker_lock.granted
         JOIN pg_stat_activity blocker ON blocker.pid = blocker_lock.pid
         WHERE blocked.datname = current_database()
         GROUP BY blocked.pid`,
      ),
      client.query<{ total: string }>(`SELECT count(*)::text AS total FROM domain_events WHERE status IN ('pending','processing')`),
      client.query<{ total: string }>(`SELECT count(*)::text AS total FROM agent_runs WHERE status IN ('queued','planning','running')`),
      client.query<{ total: string }>(`SELECT count(*)::text AS total FROM provider_webhook_events WHERE status IN ('RECEIVED','PROCESSING')`),
    ]);
    const longRunning = activity.rows.filter((row) => Number(row.age_seconds ?? 0) > maxQueryAgeSeconds);
    const failures = [
      ...(longRunning.length > 0 ? [`${longRunning.length} database sessions exceed ${maxQueryAgeSeconds}s`] : []),
      ...(blocked.rows.length > 0 ? [`${blocked.rows.length} blocked database sessions`] : []),
    ];
    const payload = {
      ok: failures.length === 0,
      checkedAt: new Date().toISOString(),
      strict,
      thresholds: { maxQueryAgeSeconds },
      sessions: { total: activity.rows.length, longRunning: longRunning.length, blocked: blocked.rows.length },
      queueDepth: {
        domainEvents: Number(eventBacklog.rows[0]?.total ?? 0),
        agentRuns: Number(agentBacklog.rows[0]?.total ?? 0),
        providerWebhooks: Number(webhookBacklog.rows[0]?.total ?? 0),
      },
      failures,
      note: 'Read-only database observability snapshot. It does not cancel queries or change queue state.',
    };
    console.log(JSON.stringify(payload, null, 2));
    if (strict && failures.length > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

