#!/usr/bin/env bash
# Hudumika staging bootstrap (M8 ops readiness, 24h gate stand-in). ONE command
# provisions a fresh staging database and starts a staging-grade API instance:
#   - creates the staging database if it does not exist (never the dev DB)
#   - applies goose migrations (cmd/migrate -up) to it
#   - loads idempotent demo data via tools/seed (skipped with a warning when
#     the tool is not present yet)
#   - boots the API with staging-grade env (fresh 48-char JWT secret, per-run
#     OTP_PAYLOAD_KEY, provider webhook secrets, SIMULATOR_KEY, mock SMS/Expo
#     gateway URLs, admin IP allow-list, staging CORS origin)
#   - waits for /healthz + /readyz == 200, warms the auth counters with an
#     OTP + idempotency-replay smoke (the dev OTP code 123456, non-prod only),
#     runs verify-release.sh (ENV=staging) and dashboard-smoke.sh, prints a
#     SIGNED summary and appends it to backups/staging-bootstrap-<ts>.log
#   - leaves the API RUNNING for the 24h gate (see "stopping the instance")
# Usage:
#   STAGING_DB_URL=postgres://... STAGING_PORT=8092 ./scripts/staging-bootstrap.sh
# Creating the database needs CREATEDB. The app role is tried first; when it
# lacks CREATEDB, set ADMIN_DB_URL to a superuser/maintenance URL and the
# database is created there with the app role as owner:
#   ADMIN_DB_URL=postgres://postgres:...@localhost:5432/postgres ./scripts/staging-bootstrap.sh
# Exit 0 = provisioned + verified + left running (summary line); exit 1 = any
# step failed (the started instance is stopped on failure — fail closed).
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DEV_DB_URL="${DEV_DB_URL:-postgres://hudumika:hudumika@localhost:5432/hudumika}"
STAGING_DB_URL="${STAGING_DB_URL:-postgres://hudumika:hudumika@localhost:5432/hudumika_staging}"
ADMIN_DB_URL="${ADMIN_DB_URL:-}"
REDIS_URL="${REDIS_URL:-redis://localhost:6379/0}"
STAGING_PORT="${STAGING_PORT:-8092}"
BASE="http://127.0.0.1:$STAGING_PORT"
BIN="${BIN:-/tmp/opencode/staging-api}"
LOG="${LOG:-/tmp/opencode/staging-api.log}"
PIDFILE="${PIDFILE:-/tmp/opencode/staging-api.pid}"
ALLOW_DEV="${ALLOW_DEV:-0}"

failures=()
API_PID=""
DB_NAME=""
migrate_version="?"
seed_status="skipped"
verify_out=""
smoke_out=""
started_at=""
ready_hz=""
ready_rz=""

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

fail() { failures+=("$1"); echo "  FAILED: $1" >&2; }

# db_name_of extracts the database name from a postgres URL (the path
# component after the last '/', query string stripped).
db_name_of() {
  local url="$1" name
  name="${url##*/}"
  name="${name%%\?*}"
  [[ -n "$name" ]] && printf '%s' "$name"
}

# db_user_of extracts the role name from a postgres URL.
db_user_of() {
  local url="$1" user
  user="${url#*://}"
  user="${user%%@*}"
  printf '%s' "${user%%:*}"
}

# maint_url_of swaps the target database for the maintenance database
# "postgres" (same credentials and host).
maint_url_of() {
  local url="$1"
  printf '%s' "${url%/*}/postgres"
}

step_safety() {
  echo "== [1/10] safety: staging target must not be the dev database"
  DB_NAME="$(db_name_of "$STAGING_DB_URL")"
  DEV_NAME="$(db_name_of "$DEV_DB_URL")"
  echo "   staging target: $STAGING_DB_URL (db: $DB_NAME)"
  if [[ "$STAGING_DB_URL" == "$DEV_DB_URL" || "$DB_NAME" == "$DEV_NAME" ]]; then
    if [[ "$ALLOW_DEV" == "1" ]]; then
      echo "   WARNING: target is the dev database ($DEV_DB_URL) — proceeding because --allow-dev was passed"
    else
      fail "refusing to bootstrap against the dev database ($DEV_DB_URL); pass --allow-dev to override"
      return 1
    fi
  else
    echo "   OK: target differs from dev database"
  fi
  if [[ -n "${DATABASE_URL:-}" ]]; then
    echo "   NOTE: DATABASE_URL is set in this shell ($DATABASE_URL); the API still runs against STAGING_DB_URL ($STAGING_DB_URL)"
  fi
}

step_create_db() {
  echo "== [2/10] create staging database if missing: $DB_NAME"
  local maint_url app_user
  maint_url="$(maint_url_of "$STAGING_DB_URL")"
  app_user="$(db_user_of "$STAGING_DB_URL")"
  if psql "$STAGING_DB_URL" -tAc "SELECT 1" >/dev/null 2>&1; then
    echo "   OK: database '$DB_NAME' already exists (reachable)"
    return 0
  fi
  # Try the app role first (works when it has CREATEDB)...
  if psql "$maint_url" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB_NAME\"" >/dev/null 2>&1; then
    echo "   OK: created database '$DB_NAME' (as $app_user via $maint_url)"
    return 0
  fi
  # ...then fall back to ADMIN_DB_URL (superuser/maintenance URL), keeping the
  # app role as the database owner so migrations/seed/API work as the app user.
  if [[ -n "$ADMIN_DB_URL" ]]; then
    if psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$app_user\"" >/dev/null 2>&1; then
      echo "   OK: created database '$DB_NAME' (owner $app_user, via ADMIN_DB_URL)"
      return 0
    fi
    fail "CREATE DATABASE via ADMIN_DB_URL failed"
    return 1
  fi
  fail "role '$app_user' lacks CREATEDB and ADMIN_DB_URL is unset — pass ADMIN_DB_URL=postgres://superuser:...@host:5432/postgres to let the bootstrap create databases"
  return 1
}

step_migrate() {
  echo "== [3/10] migrations: go run ./cmd/migrate -up against $DB_NAME"
  if ! (cd "$APP_DIR" && DATABASE_URL="$STAGING_DB_URL" go run ./cmd/migrate -up) 2>&1; then
    fail "migrate -up against $STAGING_DB_URL failed"
    return 1
  fi
  echo "   OK: migrations applied"
}

step_seed() {
  echo "== [4/10] seed: go run ./tools/seed --url \"$STAGING_DB_URL\" (idempotent demo data)"
  if [[ -d "$APP_DIR/tools/seed" ]]; then
    if ! (cd "$APP_DIR" && go run ./tools/seed --url "$STAGING_DB_URL") 2>&1; then
      fail "tools/seed failed against $STAGING_DB_URL"
      return 1
    fi
    seed_status="applied"
    echo "   OK: seed data loaded"
  else
    echo "   WARNING: tools/seed is not present yet (another agent is writing it in this wave) — seed step skipped"
    seed_status="skipped (tool pending)"
  fi
}

step_start() {
  echo "== [5/10] build + start API (ENV=staging, PORT=$STAGING_PORT, log: $LOG)"
  if curl -s -o /dev/null --max-time 1 "$BASE/healthz" 2>/dev/null; then
    fail "port $STAGING_PORT is already serving — a staging instance is running; aborting"
    return 1
  fi
  if ! (cd "$APP_DIR" && go build -o "$BIN" ./cmd/api); then
    fail "go build -o $BIN ./cmd/api failed"
    return 1
  fi
  echo "   OK: built $BIN ($(stat -c '%s' "$BIN") bytes)"
  rm -f "$LOG" "$PIDFILE"

  # Per-run secrets: 48-char JWT secret (openssl rand -hex 24), hex AES-256
  # OTP payload key, per-provider webhook signing secrets, simulator key.
  jwt_secret="$(openssl rand -hex 24)"
  otp_payload_key="$(openssl rand -hex 32)"
  webhook_secret="$(openssl rand -hex 16)"
  mpesa_secret="$(openssl rand -hex 16)"
  tigo_secret="$(openssl rand -hex 16)"
  airtel_secret="$(openssl rand -hex 16)"
  card_secret="$(openssl rand -hex 16)"
  simulator_key="$(openssl rand -hex 16)"

  ENV=staging PORT="$STAGING_PORT" \
    DATABASE_URL="$STAGING_DB_URL" REDIS_URL="$REDIS_URL" \
    JWT_SECRET="$jwt_secret" \
    OTP_PAYLOAD_KEY="$otp_payload_key" \
    CORS_ORIGINS="https://staging.hudumika.co.tz" \
    ADMIN_ALLOWED_IPS="${ADMIN_ALLOWED_IPS:-127.0.0.1}" \
    PAYMENT_WEBHOOK_SECRET="$webhook_secret" \
    MPESA_WEBHOOK_SECRET="$mpesa_secret" \
    TIGO_WEBHOOK_SECRET="$tigo_secret" \
    AIRTEL_WEBHOOK_SECRET="$airtel_secret" \
    CARD_WEBHOOK_SECRET="$card_secret" \
    SIMULATOR_KEY="$simulator_key" \
    OTP_SMS_GATEWAY_URL="http://127.0.0.1:3100/sms" \
    EXPO_PUSH_BASE_URL="http://127.0.0.1:3100/push/send" \
    "$BIN" >>"$LOG" 2>&1 &
  API_PID=$!
  printf '%s\n' "$API_PID" >"$PIDFILE"
  echo "   OK: API pid $API_PID (pidfile $PIDFILE)"
}

step_wait_ready() {
  echo "== [6/10] wait for /healthz + /readyz == 200 (20x1s)"
  local i hz="" rz=""
  for i in $(seq 1 20); do
    hz="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/healthz" 2>/dev/null || true)"
    rz="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/readyz" 2>/dev/null || true)"
    [[ "$hz" == "200" && "$rz" == "200" ]] && break
    sleep 1
  done
  if [[ "$hz" != "200" || "$rz" != "200" ]]; then
    fail "API did not become ready — healthz=$hz readyz=$rz"
    echo "   tail of $LOG:" >&2
    tail -n 20 "$LOG" >&2 || true
    return 1
  fi
  ready_hz="$hz"; ready_rz="$rz"
  echo "   OK: /healthz=$hz /readyz=$rz"
}

step_smoke() {
  echo "== [7/10] auth smoke warm-up (OTP + idempotency replay — warms the counters dashboard-smoke expects on a cold instance)"
  local bad=0

  local cors
  cors="$(curl -s -D - -o /dev/null --max-time 5 -H "Origin: https://staging.hudumika.co.tz" "$BASE/healthz" | tr -d '\r' | grep -i '^access-control-allow-origin:' | head -n 1)"
  if [[ "$cors" == *"https://staging.hudumika.co.tz"* ]]; then
    echo "   OK: CORS origin echo: $cors"
  else
    echo "   FAILED: CORS origin not echoed (got: ${cors:-<none>})" >&2; bad=1
  fi

  local st code
  st="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/catalogue-items")"
  code="$(curl -s --max-time 5 -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/catalogue-items" | grep -oE '"code"[[:space:]]*:[[:space:]]*"[A-Z_]+"' | head -n 1 | sed -E 's/.*"([A-Z_]+)"/\1/')"
  if [[ "$st" == "401" && "$code" == "UNAUTHORIZED" ]]; then
    echo "   OK: POST /catalogue-items without token -> 401 UNAUTHORIZED envelope"
  else
    echo "   FAILED: POST /catalogue-items without token -> $st code=$code" >&2; bad=1
  fi

  # OTP flow with the fixed development code (123456, active in every
  # non-production env): request -> verify -> session. This is what makes
  # otp_requests_total{outcome=issued|verified} appear on /metrics.
  local dest req req_id verify at rt
  dest="+2557$(date +%s | tail -c 9)"
  echo "   OTP flow: fresh destination $dest"
  req="$(curl -s --max-time 5 -X POST -H 'Content-Type: application/json' \
    -d "{\"channel\":\"phone\",\"destination\":\"$dest\",\"purpose\":\"login\"}" \
    "$BASE/auth/request-otp")"
  req_id="$(printf '%s' "$req" | grep -oE '"requestId"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n 1 | sed -E 's/.*"requestId"[[:space:]]*:[[:space:]]*"([^"]+)"/\1/')"
  if [[ -z "$req_id" ]]; then
    echo "   FAILED: request-otp returned no requestId (body: $req)" >&2; bad=1
  else
    echo "   OK: request-otp -> requestId $req_id"
  fi

  verify="$(curl -s --max-time 5 -X POST -H 'Content-Type: application/json' \
    -d "{\"requestId\":\"$req_id\",\"code\":\"123456\"}" \
    "$BASE/auth/verify-otp")"
  at="$(printf '%s' "$verify" | grep -oE '"accessToken"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n 1 | sed -E 's/.*"accessToken"[[:space:]]*:[[:space:]]*"([^"]+)"/\1/')"
  rt="$(printf '%s' "$verify" | grep -oE '"refreshToken"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n 1 | sed -E 's/.*"refreshToken"[[:space:]]*:[[:space:]]*"([^"]+)"/\1/')"
  if [[ -n "$at" && -n "$rt" ]]; then
    echo "   OK: verify-otp (dev code) -> session accessToken + refreshToken issued"
  else
    echo "   FAILED: verify-otp returned no session tokens (body: $verify)" >&2; bad=1
  fi

  # Idempotency replay on an authed route: second identical request replays
  # the stored response (identical body) — this is what makes
  # idempotency_hits_total appear on /metrics.
  local h1 h2 d1 d2
  h1="$(curl -s -o /tmp/opencode/bootstrap-idem1.json -w '%{http_code}' --max-time 10 \
    -H "Authorization: Bearer $at" -H "Idempotency-Key: bootstrap-$dest" "$BASE/home")"
  h2="$(curl -s -o /tmp/opencode/bootstrap-idem2.json -w '%{http_code}' --max-time 10 \
    -H "Authorization: Bearer $at" -H "Idempotency-Key: bootstrap-$dest" "$BASE/home")"
  d1="$(md5sum < /tmp/opencode/bootstrap-idem1.json 2>/dev/null | cut -d' ' -f1)"
  d2="$(md5sum < /tmp/opencode/bootstrap-idem2.json 2>/dev/null | cut -d' ' -f1)"
  if [[ "$h1" == "200" && "$h2" == "200" && -n "$d1" && "$d1" == "$d2" ]]; then
    echo "   OK: authed GET /home -> 200, idempotency replay -> 200 (identical body, md5 $d1)"
  else
    echo "   FAILED: authed GET /home statuses $h1/$h2, body md5 $d1/$d2 (idempotency replay)" >&2; bad=1
  fi

  if [[ "$bad" -ne 0 ]]; then
    fail "auth smoke warm-up failed (see FAILED lines above)"
    return 1
  fi
}

step_verify() {
  echo "== [8/10] scripts/verify-release.sh (ENV=staging) against the running instance"
  verify_out="$(ENV=staging PORT="$STAGING_PORT" DATABASE_URL="$STAGING_DB_URL" REDIS_URL="$REDIS_URL" \
    JWT_SECRET="$jwt_secret" OTP_PAYLOAD_KEY="$otp_payload_key" \
    CORS_ORIGINS="https://staging.hudumika.co.tz" "$APP_DIR/scripts/verify-release.sh" 2>&1)"
  local rc=$?
  printf '%s\n' "$verify_out"
  if [[ $rc -ne 0 ]]; then
    fail "verify-release.sh exited $rc"
    return 1
  fi
  migrate_version="$(printf '%s\n' "$verify_out" | grep -oE 'migrate_version=[0-9]+' | head -n 1 | cut -d= -f2)"
  [[ -n "$migrate_version" ]] || migrate_version="?"
}

step_smoke_dash() {
  echo "== [9/10] scripts/dashboard-smoke.sh against the running instance"
  smoke_out="$(BASE="$BASE" "$APP_DIR/scripts/dashboard-smoke.sh" 2>&1)"
  local rc=$?
  printf '%s\n' "$smoke_out"
  if [[ $rc -ne 0 ]]; then
    fail "dashboard-smoke.sh exited $rc"
    return 1
  fi
}

step_summary() {
  echo "== [10/10] signed summary"
  local log_file="$APP_DIR/backups/staging-bootstrap-$(date +%Y%m%d-%H%M%S).log"
  if [[ ${#failures[@]} -gt 0 ]]; then
    echo "FAILED steps:" >&2
    printf ' - %s\n' "${failures[@]}" >&2
    return 1
  fi
  local summary
  summary="SIGNED staging-bootstrap: timestamp=$(ts) env=staging port=$STAGING_PORT api_url=$BASE db=${STAGING_DB_URL/\/\/[^@]*@/\/\/***@} db_name=$DB_NAME healthz=$ready_hz readyz=$ready_rz migrate_version=$migrate_version seed=$seed_status verify=ok dashboard_smoke=ok api_pid=$API_PID log=$LOG by=Team 6 backend agent (scripts/staging-bootstrap.sh)"
  printf '%s\n' "$summary"
  printf '%s\n' "$summary" >>"$log_file"
  echo "   summary appended to $log_file"
  echo "   instance LEFT RUNNING for the 24h gate (pid $API_PID)"
  echo "   stop it with: pkill -f staging-api   (or: kill $API_PID / kill %1 if run interactively)"
}

stop_api() {
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    echo "cleanup: stopping API (pid $API_PID) — fail-closed" >&2
    kill -TERM "$API_PID" 2>/dev/null || true
    local i
    for i in $(seq 1 10); do
      kill -0 "$API_PID" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$API_PID" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
}

main() {
  for a in "$@"; do
    case "$a" in
      --allow-dev) ALLOW_DEV=1 ;;
      -h|--help)
        echo "usage: $0 [--allow-dev]"
        echo "  STAGING_DB_URL (default postgres://hudumika:hudumika@localhost:5432/hudumika_staging)"
        echo "  STAGING_PORT  (default 8092)"
        echo "  REDIS_URL     (default redis://localhost:6379/0)"
        echo "  ADMIN_DB_URL  (optional) superuser/maintenance URL used to create the"
        echo "                database when the app role lacks CREATEDB"
        echo "  --allow-dev   permit bootstrapping against the dev database (dangerous)"
        return 0 ;;
    esac
  done

  step_safety || { stop_api; step_summary; exit 1; }
  step_create_db || { stop_api; step_summary; exit 1; }
  step_migrate || { stop_api; step_summary; exit 1; }
  step_seed || { stop_api; step_summary; exit 1; }
  step_start || { stop_api; step_summary; exit 1; }
  step_wait_ready || { stop_api; step_summary; exit 1; }
  step_smoke || { stop_api; step_summary; exit 1; }
  step_verify || { stop_api; step_summary; exit 1; }
  step_smoke_dash || { stop_api; step_summary; exit 1; }
  step_summary
  exit $?
}
main "$@"
