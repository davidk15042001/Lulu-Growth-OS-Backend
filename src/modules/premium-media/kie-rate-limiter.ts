import { hasDb } from '../../config/env.js';
import { getPool } from '../../db/pool.js';

const providerKey = 'kie.ai:generation';
const defaultIntervalMs = 550;
let localNextSlotAt = 0;
let databaseStateUnavailable = false;

function intervalMs() {
  return defaultIntervalMs;
}

function sleep(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
}

/**
 * Reserve one global Kie dispatch slot.
 *
 * Kie documents a quota of 20 new generations per 10 seconds per account.
 * A 550ms spacing gives a small safety margin while still allowing 18+ calls
 * per ten seconds.  The PostgreSQL clock makes this queue shared across all
 * workspaces and all API processes; the local fallback only applies while the
 * database is unavailable or before the migration has been applied.
 */
async function reserveDatabaseSlot(): Promise<number> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [providerKey]);
    await client.query(
      `INSERT INTO provider_rate_limit_state(provider_key,next_slot_at)
       VALUES ($1,NOW()) ON CONFLICT(provider_key) DO NOTHING`,
      [providerKey],
    );
    const result = await client.query<{ next_slot_at: Date }>(
      `SELECT next_slot_at FROM provider_rate_limit_state WHERE provider_key=$1 FOR UPDATE`,
      [providerKey],
    );
    const storedAt = result.rows[0]?.next_slot_at instanceof Date
      ? result.rows[0].next_slot_at.getTime()
      : Date.parse(String(result.rows[0]?.next_slot_at ?? ''));
    const scheduledAt = Math.max(Date.now(), Number.isFinite(storedAt) ? storedAt : Date.now());
    await client.query(
      `UPDATE provider_rate_limit_state
          SET next_slot_at=to_timestamp($2::double precision / 1000), updated_at=NOW()
        WHERE provider_key=$1`,
      [providerKey, scheduledAt + intervalMs()],
    );
    await client.query('COMMIT');
    return scheduledAt;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    // This allows a rolling deployment to keep serving while the migration is
    // being applied.  Once the table exists, every subsequent slot is durable.
    if ((error as { code?: string }).code === '42P01') {
      databaseStateUnavailable = true;
      return reserveLocalSlot();
    }
    throw error;
  } finally {
    client.release();
  }
}

function reserveLocalSlot() {
  const scheduledAt = Math.max(Date.now(), localNextSlotAt);
  localNextSlotAt = scheduledAt + intervalMs();
  return scheduledAt;
}

/** Wait until the next globally available Kie generation slot. */
export async function waitForKieGenerationSlot(): Promise<number> {
  const startedAt = Date.now();
  const scheduledAt = hasDb && !databaseStateUnavailable
    ? await reserveDatabaseSlot()
    : reserveLocalSlot();
  await sleep(scheduledAt - Date.now());
  return Date.now() - startedAt;
}
