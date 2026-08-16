#!/usr/bin/env bash
# Hudumika release-gate verification (M8 ops readiness). Exit 0 = signed
# summary line; exit 1 = failed gates listed to stderr.
# Gates: (1) ENV is valid; (2) production secret guards; (3) live API
# /healthz, /readyz, /metrics on $PORT (default 8080); (4) migration status
# >= 9 (or the current version is printed for the sign-off).
#   ENV=development PORT=8098 DATABASE_URL=postgres://... ./scripts/verify-release.sh
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PORT="${PORT:-8080}"
BASE="http://127.0.0.1:$PORT"
failures=()
max_ver=""

# ---- Gate 1: ENV ----
ENV_VAL="${ENV:-}"
case "$ENV_VAL" in
  development|staging|production) echo "GATE ok: ENV=$ENV_VAL" ;;
  *) failures+=("ENV must be one of development/staging/production (got '${ENV_VAL:-<unset>}')") ;;
esac

# ---- Gate 2: production guards (skipped outside production) ----
if [[ "$ENV_VAL" == "production" ]]; then
  jwt="${JWT_SECRET:-$JWT_SIGNING_KEY}"
  if [[ -z "$jwt" ]]; then
    failures+=("production: JWT_SECRET (or JWT_SIGNING_KEY) must be set")
  elif [[ "${#jwt}" -lt 32 ]]; then
    failures+=("production: JWT_SECRET/JWT_SIGNING_KEY must be >= 32 chars (got ${#jwt})")
  fi
  for v in DATABASE_URL REDIS_URL OTP_PAYLOAD_KEY; do
    [[ -n "${!v:-}" ]] || failures+=("production: $v must be set")
  done
  if [[ -n "${CORS_ORIGINS:-}" ]]; then
    IFS=',' read -ra origins <<< "$CORS_ORIGINS"
    for o in "${origins[@]}"; do
      o="${o// /}"
      [[ "$o" != "*" ]] || failures+=("production: CORS_ORIGINS must not contain '*'")
    done
  fi
  echo "GATE ok: production secret guards checked"
else
  echo "GATE ok: production secret guards skipped (ENV=$ENV_VAL)"
fi

# ---- Gate 3: live API ----
check_status() { # name path
  local name="$1" path="$2" i code=""
  for i in $(seq 1 20); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$BASE$path" 2>/dev/null || true)"
    [[ "$code" == "200" ]] && { echo "GATE ok: $name $BASE$path -> 200"; return 0; }
    sleep 1
  done
  failures+=("$name $BASE$path did not return 200 (last: ${code:-no response})")
  return 1
}
check_status healthz /healthz || true
check_status readyz /readyz || true

metrics="$(curl -s --max-time 5 "$BASE/metrics" 2>/dev/null || true)"
if [[ "$metrics" == *"http_requests_total"* && "$metrics" == *"http_request_duration_seconds"* ]]; then
  echo "GATE ok: /metrics exposes http_requests_total and http_request_duration_seconds"
else
  failures+=("/metrics missing http_requests_total and/or http_request_duration_seconds")
fi

# ---- Gate 4: migration status ----
mig_out="$( (cd "$APP_DIR" && go run ./cmd/migrate -status) 2>&1 )" || true
max_ver="$(printf '%s\n' "$mig_out" | grep -oE '[0-9]{5}_[a-z0-9_.]+\.sql' | grep -oE '^[0-9]+' | sed 's/^0*//' | sort -n | tail -n 1)"
if [[ -z "$max_ver" ]]; then
  failures+=("migrate -status produced no version (is DATABASE_URL set and migrations applied?)")
else
  if [[ "$max_ver" -ge 9 ]]; then
    echo "GATE ok: migration version >= 9 (current: $max_ver)"
  else
    failures+=("migration version $max_ver is below the required >= 9")
  fi
fi

# ---- Result ----
if [[ ${#failures[@]} -eq 0 ]]; then
  echo "SIGNED verify-release: ENV=$ENV_VAL PORT=$PORT healthz=200 readyz=200 metrics=ok migrate_version=$max_ver by=Team 6 backend agent at $(date -u +%Y-%m-%dT%H:%M:%SZ) (scripts/verify-release.sh)"
  exit 0
else
  echo "FAILED gates:" >&2
  printf ' - %s\n' "${failures[@]}" >&2
  exit 1
fi
