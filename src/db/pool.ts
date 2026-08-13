import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { env, hasDb } from '../config/env.js';
import { logger } from '../config/logger.js';

export const pool = hasDb
  ? new Pool({
      connectionString: env.DATABASE_URL,
      max: env.DATABASE_POOL_MAX,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    })
  : (null as unknown as Pool);

if (hasDb) {
  pool.on('error', (err: unknown) => {
    logger.error({ err }, 'Unexpected PG pool error');
  });
} else {
  logger.warn('DATABASE_URL not set; running without database connection');
}

export function getPool(): Pool {
  if (!hasDb) {
    throw new Error('Database is not configured. Set DATABASE_URL to enable DB queries.');
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
  client?: PoolClient
): Promise<{ rows: T[]; rowCount: number }> {
  const executor = client ?? getPool();
  const result = await executor.query<T>(text, [...params]);
  return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function checkDatabase() {
  if (!hasDb) {
    return { configured: false, connected: false, latencyMs: null };
  }

  const startedAt = performance.now();
  try {
    await getPool().query('SELECT 1');
    return {
      configured: true,
      connected: true,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    logger.error({ error }, 'Database readiness check failed');
    return {
      configured: true,
      connected: false,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }
}
