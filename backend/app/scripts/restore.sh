#!/usr/bin/env bash
# Hudumika restore (M8 ops readiness). Restores a pg_dump -Fc backup into the
# DATABASE_URL target and runs a smoke count on users. Refuses to run when
# ENV=production: prod restores are a manual, rehearsed operation (runbook 2.3).
#   DATABASE_URL=postgres://host/target BACKUP_FILE=./backups/hudumika-*.dump ./scripts/restore.sh
set -euo pipefail

if [[ "${ENV:-}" == "production" ]]; then
  echo "restore.sh: REFUSING to run with ENV=production — restore is only ever a rehearsed, manual operation" >&2
  exit 1
fi

DATABASE_URL="${DATABASE_URL:-}"
BACKUP_FILE="${BACKUP_FILE:-}"

if [[ -z "$DATABASE_URL" ]]; then
  echo "restore.sh: DATABASE_URL (restore target) is required" >&2
  exit 1
fi
if [[ -z "$BACKUP_FILE" ]]; then
  echo "restore.sh: BACKUP_FILE (pg_dump -Fc dump) is required" >&2
  exit 1
fi
if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "restore.sh: backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

echo "restore.sh: pg_restore --clean --if-exists -d <target> $BACKUP_FILE"
if ! pg_restore --clean --if-exists -d "$DATABASE_URL" "$BACKUP_FILE"; then
  echo "restore.sh: FAILED pg_restore (see error above)" >&2
  exit 1
fi

if ! count="$(psql -d "$DATABASE_URL" -tAc "SELECT count(*) FROM users;")"; then
  echo "restore.sh: FAILED smoke query — users table missing in the restored DB?" >&2
  exit 1
fi
echo "restore.sh: restore OK — smoke SELECT count(*) FROM users = $count"
