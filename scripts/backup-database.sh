#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/lulu-growth-os}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_FILE="${BACKUP_DIR}/lulu_growth_os_${TIMESTAMP}.dump"

command -v pg_dump >/dev/null 2>&1 || { echo 'pg_dump is required' >&2; exit 127; }
mkdir -p "$BACKUP_DIR"
umask 077

pg_dump --format=custom --no-owner --no-privileges --file="$BACKUP_FILE" "$DATABASE_URL"
pg_restore --list "$BACKUP_FILE" >/dev/null
sha256sum "$BACKUP_FILE" > "${BACKUP_FILE}.sha256"
find "$BACKUP_DIR" -type f -name 'lulu_growth_os_*.dump' -mtime "+${RETENTION_DAYS}" -delete
find "$BACKUP_DIR" -type f -name 'lulu_growth_os_*.dump.sha256' -mtime "+${RETENTION_DAYS}" -delete
printf 'backup=%s\nchecksum=%s\n' "$BACKUP_FILE" "${BACKUP_FILE}.sha256"
