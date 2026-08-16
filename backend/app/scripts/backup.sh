#!/usr/bin/env bash
# Hudumika backup (M8 ops readiness). No docker required: uses pg_dump and
# redis-cli directly. Run from backend/app (or anywhere) with DATABASE_URL set:
#   DATABASE_URL=postgres://... ./scripts/backup.sh
# REDIS_URL is optional; when it points at a local instance, a SAVE is triggered
# and the RDB file is copied next to the dump (best-effort, warns on failure).
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
REDIS_URL="${REDIS_URL:-}"

if [[ -z "$DATABASE_URL" ]]; then
  echo "backup.sh: DATABASE_URL is required (postgres://host/db)" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
stamp="$(date +%Y%m%d-%H%M%S)"
dump="$BACKUP_DIR/hudumika-$stamp.dump"

echo "backup.sh: pg_dump -Fc -> $dump"
if ! pg_dump -Fc "$DATABASE_URL" -f "$dump"; then
  echo "backup.sh: FAILED pg_dump (see error above); no backup written" >&2
  exit 1
fi
size="$(stat -c '%s' "$dump" 2>/dev/null || wc -c < "$dump")"
echo "backup.sh: PostgreSQL dump OK: $dump ($size bytes)"

# Redis: best-effort local SAVE + RDB copy. Warn, never fail the backup.
if [[ -n "$REDIS_URL" ]]; then
  hostport="${REDIS_URL#redis://}"
  hostport="${hostport%%/*}"
  hostport="${hostport##*@}"
  host="${hostport%%:*}"
  host="${host#[}"
  host="${host%]}"
  case "$host" in
    localhost|127.0.0.1|::1|"")
      save_rules="$(redis-cli -u "$REDIS_URL" config get save 2>/dev/null | tail -n 1 || true)"
      if [[ -n "$save_rules" && "$save_rules" != "save" ]]; then
        echo "backup.sh: redis SAVE enabled ($save_rules) — triggering SAVE"
        if redis-cli -u "$REDIS_URL" save >/dev/null 2>&1; then
          dir="$(redis-cli -u "$REDIS_URL" config get dir 2>/dev/null | tail -n 1 || true)"
          dbfilename="$(redis-cli -u "$REDIS_URL" config get dbfilename 2>/dev/null | tail -n 1 || true)"
          rdb="$dir/$dbfilename"
          if [[ -n "$dir" && -n "$dbfilename" && -f "$rdb" ]] && cp "$rdb" "$BACKUP_DIR/redis-$stamp.rdb" 2>/dev/null; then
            rsize="$(stat -c '%s' "$BACKUP_DIR/redis-$stamp.rdb" 2>/dev/null || wc -c < "$BACKUP_DIR/redis-$stamp.rdb")"
            echo "backup.sh: redis RDB copy OK: $BACKUP_DIR/redis-$stamp.rdb ($rsize bytes)"
          else
            echo "backup.sh: WARN redis SAVE ran but RDB copy failed (permissions on $rdb?) — Postgres backup unaffected" >&2
          fi
        else
          echo "backup.sh: WARN redis SAVE failed (best-effort; Postgres backup unaffected)" >&2
        fi
      else
        echo "backup.sh: NOTE redis SAVE disabled on this instance ('save' empty) — skipping RDB copy" >&2
      fi
      ;;
    *)
      echo "backup.sh: NOTE REDIS_URL host '$host' is not local — skipping RDB copy (back up RDB on the host itself)" >&2
      ;;
  esac
fi

echo "backup.sh: done — backup file: $dump ($size bytes)"
