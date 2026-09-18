#!/usr/bin/env bash
set -Eeuo pipefail

: "${BACKUP_FILE:?BACKUP_FILE must point to a custom-format pg_dump file}"
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL must point to an isolated restore database}"

if [[ "${ALLOW_RESTORE_TEST:-}" != "1" ]]; then
  echo 'Refusing restore test: set ALLOW_RESTORE_TEST=1 explicitly.' >&2
  exit 2
fi
if [[ "${RESTORE_DATABASE_URL}" == "${DATABASE_URL:-}" ]]; then
  echo 'Refusing restore test: restore target must differ from DATABASE_URL.' >&2
  exit 2
fi
command -v pg_restore >/dev/null 2>&1 || { echo 'pg_restore is required' >&2; exit 127; }
command -v psql >/dev/null 2>&1 || { echo 'psql is required' >&2; exit 127; }
[[ -f "$BACKUP_FILE" ]] || { echo "Backup file not found: $BACKUP_FILE" >&2; exit 1; }

if [[ -f "${BACKUP_FILE}.sha256" ]]; then
  sha256sum --check "${BACKUP_FILE}.sha256"
fi
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$RESTORE_DATABASE_URL" "$BACKUP_FILE"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -v expected_migration_id="${RESTORE_EXPECTED_SCHEMA_MIGRATION_ID:-}" <<'SQL' >/dev/null
DO $$
DECLARE
  required_table TEXT;
  missing_tables TEXT[] := ARRAY[]::TEXT[];
  required_tables TEXT[] := ARRAY['schema_migrations','users','workspaces','workspace_members','provider_webhook_events'];
  migration_count BIGINT;
  latest_migration BIGINT;
  expected_migration TEXT := NULLIF(:'expected_migration_id', '');
BEGIN
  FOREACH required_table IN ARRAY required_tables LOOP
    IF to_regclass(format('public.%I', required_table)) IS NULL THEN
      missing_tables := array_append(missing_tables, required_table);
    END IF;
  END LOOP;
  IF cardinality(missing_tables) > 0 THEN
    RAISE EXCEPTION 'Restore verification failed; missing required tables: %', array_to_string(missing_tables, ', ');
  END IF;

  SELECT count(*), max(id) INTO migration_count, latest_migration FROM schema_migrations;
  IF migration_count = 0 OR latest_migration IS NULL THEN
    RAISE EXCEPTION 'Restore verification failed; schema_migrations is empty';
  END IF;
  IF expected_migration IS NOT NULL AND latest_migration::TEXT <> expected_migration THEN
    RAISE EXCEPTION 'Restore verification failed; expected latest migration %, found %', expected_migration, latest_migration;
  END IF;
END $$;
SELECT current_database(), NOW();
SQL
printf 'restore_verification=PASS\nbackup=%s\n' "$BACKUP_FILE"
