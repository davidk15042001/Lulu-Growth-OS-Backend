import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { PoolClient } from 'pg';
import { getPool, query } from '../db/pool.js';
import { hasDb } from '../config/env.js';
import { logger } from '../config/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const migrationLockName = 'lulu_growth_os_schema_migrations';

async function ensureSchemaTable(client: PoolClient) {
  await query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    [],
    client
  );
}

async function appliedMigrations(client: PoolClient): Promise<Set<string>> {
  const { rows } = await query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY id',
    [],
    client
  );
  return new Set(rows.map((row) => row.name));
}

export async function ensureMigrations() {
  if (!hasDb) {
    logger.warn('Skipping migrations because DATABASE_URL is not configured');
    return;
  }

  const client = await getPool().connect();
  let hasMigrationLock = false;

  try {
    // Never wait indefinitely for a stale or independently running migration.
    // Deployments can retry safely, while the HTTP service remains available.
    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
      [migrationLockName],
    );
    hasMigrationLock = lock.rows[0]?.acquired === true;
    if (!hasMigrationLock) {
      logger.warn({ migrationLockName }, 'Migration lock is already held; skipping this migration attempt');
      throw new Error('Database migration lock is already held by another process');
    }
    await ensureSchemaTable(client);

    const dir = path.join(__dirname, 'migrations');
    await fs.mkdir(dir, { recursive: true });

    const files = (await fs.readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
    const done = await appliedMigrations(client);

    for (const file of files) {
      if (done.has(file)) continue;

      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      logger.info({ migration: file }, 'Applying migration');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info({ migration: file }, 'Applied migration');
      } catch (error) {
        await client.query('ROLLBACK');
        logger.error({ error, migration: file }, 'Failed migration');
        throw error;
      }
    }
  } finally {
    if (hasMigrationLock) {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [migrationLockName]).catch(() => undefined);
    }
    client.release();
  }
}
