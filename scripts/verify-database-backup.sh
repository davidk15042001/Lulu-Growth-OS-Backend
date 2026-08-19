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
[[ -f "$BACKUP_FILE" ]] || { echo "Backup file not found: $BACKUP_FILE" >&2; exit 1; }

if [[ -f "${BACKUP_FILE}.sha256" ]]; then
  sha256sum --check "${BACKUP_FILE}.sha256"
fi
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$RESTORE_DATABASE_URL" "$BACKUP_FILE"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT current_database(), NOW();' >/dev/null
printf 'restore_verification=PASS\nbackup=%s\n' "$BACKUP_FILE"
