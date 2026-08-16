#!/usr/bin/env bash
# Hudumika staging drill (M8 ops readiness). Drills the API exactly as staging
# would be run: build the binary, boot it with STAGING-style env against the
# LOCAL PostgreSQL/Redis stand-in, smoke health/metrics/auth/OTP, run
# verify-release.sh (ENV=staging — production guards skipped by design),
# capture metrics, stop the API cleanly, and print a signed summary line.
# Exit 0 = every step passed; exit 1 = failed steps listed.
#
#   PORT=8099 DATABASE_URL=postgres://... REDIS_URL=redis://... ./scripts/staging-drill.sh
#
# OTP note: no SMS gateway exists on the staging stand-in, so the drill uses
# the fixed development OTP code (OTP_DEV_CODE=123456, active in every
# non-production env) to complete a full request-otp -> verify-otp flow for a
# fresh destination. Authed-route protection is asserted via the 401
# UNAUTHORIZED envelope on contract routes hit without a bearer token
# (merchant-token catalogue creation is covered by that gate on this stand-in;
# real merchant tokens are minted by the staging OTP flow in the full env).
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# HOLD_AFTER_METRICS (seconds, default 0): keep the API running after the
# metrics capture and before the clean stop, so an external smoke (e.g.
# scripts/dashboard-smoke.sh) can run against the drilled instance while it
# is still live. The signed summary records the hold when non-zero.
PORT="${PORT:-8099}"
BASE="http://127.0.0.1:$PORT"
BIN="${BIN:-/tmp/opencode/staging-api}"
LOG="${LOG:-/tmp/opencode/staging-drill-api.log}"
HOLD_AFTER_METRICS="${HOLD_AFTER_METRICS:-0}"

DATABASE_URL="${DATABASE_URL:-postgres://hudumika:hudumika@localhost:5432/hudumika}"
REDIS_URL="${REDIS_URL:-redis://localhost:6379/0}"
JWT_SECRET="${JWT_SECRET:-staging-drill-jwt-secret-2026-08-15-m8-ops-readiness}"
OTP_PAYLOAD_KEY="${OTP_PAYLOAD_KEY:-6a511e15169ab58f7876b2dd126d92a751571712d86e3630a0bb819ded6a0ae8}"
OTP_DEV_CODE="${OTP_DEV_CODE:-123456}"
CORS_ORIGINS="${CORS_ORIGINS:-https://staging.hudumika.co.tz}"
MPESA_WEBHOOK_SECRET="${MPESA_WEBHOOK_SECRET:-staging-mpesa-webhook-secret}"
MPESA_CONSUMER_KEY="${MPESA_CONSUMER_KEY:-staging-mpesa-consumer-key}"
MPESA_CONSUMER_SECRET="${MPESA_CONSUMER_SECRET:-staging-mpesa-consumer-secret}"
OTP_SMS_GATEWAY_API_KEY="${OTP_SMS_GATEWAY_API_KEY:-staging-sms-gateway-api-key}"

failures=()
API_PID=""
migrate_version="?"
http_requests_total=""
dur_count=""
otp_issued=""
otp_verified=""
active_sessions=""

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

fail() { failures+=("$1"); echo "  FAILED: $1" >&2; }

cleanup() {
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    echo "cleanup: stopping API (pid $API_PID)" >&2
    kill -TERM "$API_PID" 2>/dev/null || true
    sleep 2
    kill -KILL "$API_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

step_build() {
  echo "== [1/8] build API binary: go build -o $BIN ./cmd/api"
  if ! (cd "$APP_DIR" && go build -o "$BIN" ./cmd/api); then
    fail "go build -o $BIN ./cmd/api failed"
    return 1
  fi
  echo "   OK: $BIN ($(stat -c '%s' "$BIN") bytes)"
}

step_start() {
  echo "== [2/8] start API (ENV=staging, PORT=$PORT, log: $LOG)"
  if curl -s -o /dev/null --max-time 1 "$BASE/healthz" 2>/dev/null; then
    fail "port $PORT is already serving — a drill instance is running; aborting"
    return 1
  fi
  rm -f "$LOG"
  ENV=staging PORT="$PORT" \
    DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" \
    JWT_SECRET="$JWT_SECRET" OTP_PAYLOAD_KEY="$OTP_PAYLOAD_KEY" \
    OTP_DEV_CODE="$OTP_DEV_CODE" CORS_ORIGINS="$CORS_ORIGINS" \
    MPESA_WEBHOOK_SECRET="$MPESA_WEBHOOK_SECRET" \
    MPESA_CONSUMER_KEY="$MPESA_CONSUMER_KEY" \
    MPESA_CONSUMER_SECRET="$MPESA_CONSUMER_SECRET" \
    OTP_SMS_GATEWAY_API_KEY="$OTP_SMS_GATEWAY_API_KEY" \
    "$BIN" >>"$LOG" 2>&1 &
  API_PID=$!
  echo "   API pid $API_PID"
}

step_wait_ready() {
  echo "== [3/8] wait for /healthz + /readyz == 200 (20x1s)"
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
  echo "   OK: /healthz=200 /readyz=200"
}

step_smoke() {
  echo "== [4/8] smoke flow via curl"
  local bad=0

  local hz rz mt
  hz="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/healthz")"
  rz="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/readyz")"
  mt="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/metrics")"
  if [[ "$hz" == "200" && "$rz" == "200" && "$mt" == "200" ]]; then
    echo "   OK: /healthz=$hz /readyz=$rz /metrics=$mt"
  else
    echo "   FAILED: healthz=$hz readyz=$rz metrics=$mt" >&2; bad=1
  fi

  local cors
  cors="$(curl -s -D - -o /dev/null --max-time 5 -H "Origin: https://staging.hudumika.co.tz" "$BASE/healthz" | tr -d '\r' | grep -i '^access-control-allow-origin:' | head -n 1)"
  if [[ "$cors" == *"https://staging.hudumika.co.tz"* ]]; then
    echo "   OK: CORS origin echo: $cors"
  else
    echo "   FAILED: CORS origin not echoed (got: ${cors:-<none>})" >&2; bad=1
  fi

  local st code body
  body="$(curl -s --max-time 5 -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/catalogue-items")"
  st="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/catalogue-items")"
  code="$(printf '%s' "$body" | grep -oE '"code"[[:space:]]*:[[:space:]]*"[A-Z_]+"' | head -n 1 | sed -E 's/.*"([A-Z_]+)"/\1/')"
  if [[ "$st" == "401" && "$code" == "UNAUTHORIZED" ]]; then
    echo "   OK: POST /catalogue-items without token -> 401 $code envelope"
  else
    echo "   FAILED: POST /catalogue-items without token -> $st code=$code" >&2; bad=1
  fi

  st="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/catalogues/me")"
  if [[ "$st" == "401" ]]; then
    echo "   OK: GET /catalogues/me without token -> 401"
  else
    echo "   FAILED: GET /catalogues/me without token -> $st" >&2; bad=1
  fi

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
    -d "{\"requestId\":\"$req_id\",\"code\":\"$OTP_DEV_CODE\"}" \
    "$BASE/auth/verify-otp")"
  at="$(printf '%s' "$verify" | grep -oE '"accessToken"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n 1 | sed -E 's/.*"accessToken"[[:space:]]*:[[:space:]]*"([^"]+)"/\1/')"
  rt="$(printf '%s' "$verify" | grep -oE '"refreshToken"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n 1 | sed -E 's/.*"refreshToken"[[:space:]]*:[[:space:]]*"([^"]+)"/\1/')"
  if [[ -n "$at" && -n "$rt" ]]; then
    echo "   OK: verify-otp (dev code) -> session accessToken + refreshToken issued"
  else
    echo "   FAILED: verify-otp returned no session tokens (body: $verify)" >&2; bad=1
  fi

  # Authed idempotency replay: exercise an implemented authed route with an
  # Idempotency-Key twice. The second request must replay the stored response
  # (identical body) and increment idempotency_hits_total, which the
  # dashboards and dashboard-smoke.sh expect on /metrics.
  local h1 h2 d1 d2
  h1="$(curl -s -o /tmp/opencode/idem1.json -w '%{http_code}' --max-time 10 \
    -H "Authorization: Bearer $at" -H "Idempotency-Key: drill-$dest" "$BASE/home")"
  h2="$(curl -s -o /tmp/opencode/idem2.json -w '%{http_code}' --max-time 10 \
    -H "Authorization: Bearer $at" -H "Idempotency-Key: drill-$dest" "$BASE/home")"
  d1="$(md5sum < /tmp/opencode/idem1.json 2>/dev/null | cut -d' ' -f1)"
  d2="$(md5sum < /tmp/opencode/idem2.json 2>/dev/null | cut -d' ' -f1)"
  if [[ "$h1" == "200" && "$h2" == "200" && -n "$d1" && "$d1" == "$d2" ]]; then
    echo "   OK: authed GET /home -> 200, idempotency replay -> 200 (identical body, md5 $d1)"
  else
    echo "   FAILED: authed GET /home statuses $h1/$h2, body md5 $d1/$d2 (idempotency replay)" >&2; bad=1
  fi

  [[ "$bad" -eq 0 ]] || { fail "smoke flow failed (see FAILED lines above)"; return 1; }
}

step_verify() {
  echo "== [5/8] verify-release.sh (ENV=staging) against the running instance"
  local out rc
  out="$(ENV=staging PORT="$PORT" DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" \
    JWT_SECRET="$JWT_SECRET" OTP_PAYLOAD_KEY="$OTP_PAYLOAD_KEY" \
    CORS_ORIGINS="$CORS_ORIGINS" "$APP_DIR/scripts/verify-release.sh" 2>&1)"
  rc=$?
  printf '%s\n' "$out"
  if [[ $rc -ne 0 ]]; then
    fail "verify-release.sh exited $rc"
    return 1
  fi
  migrate_version="$(printf '%s\n' "$out" | grep -oE 'migrate_version=[0-9]+' | head -n 1 | cut -d= -f2)"
  [[ -n "$migrate_version" ]] || migrate_version="?"
}

step_metrics() {
  echo "== [6/8] capture /metrics"
  local m attempt
  m=""
  for attempt in 1 2 3; do
    m="$(curl -s --max-time 10 "$BASE/metrics")"
    [[ -n "$m" ]] && break
    echo "   retrying $BASE/metrics (attempt $attempt)..." >&2
    sleep 2
  done
  if [[ -z "$m" ]]; then
    fail "metrics fetch failed"
    return 1
  fi
  http_requests_total="$(grep -E '^http_requests_total\{' <<<"$m" | awk '{s+=$NF} END {print s+0}')"
  dur_count="$(grep -E '^http_request_duration_seconds_count\{' <<<"$m" | awk '{s+=$NF} END {print s+0}')"
  otp_issued="$(grep -E '^otp_requests_total\{[^}]*outcome="issued"' <<<"$m" | awk '{s+=$NF} END {print s+0}')"
  otp_verified="$(grep -E '^otp_requests_total\{[^}]*outcome="verified"' <<<"$m" | awk '{s+=$NF} END {print s+0}')"
  active_sessions="$(grep -E '^active_sessions ' <<<"$m" | awk '{print $NF}')"
  echo "   http_requests_total=$http_requests_total"
  echo "   http_request_duration_seconds_count=$dur_count"
  echo "   otp_requests_total{outcome=issued}=$otp_issued {outcome=verified}=$otp_verified"
  echo "   active_sessions=$active_sessions"
}

step_stop() {
  echo "== [7/8] stop API cleanly (SIGTERM)"
  if [[ -n "$HOLD_AFTER_METRICS" && "$HOLD_AFTER_METRICS" -gt 0 ]]; then
    echo "   holding API up for $HOLD_AFTER_METRICS s (external smoke window) at $(ts)"
    sleep "$HOLD_AFTER_METRICS"
  fi
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill -TERM "$API_PID" 2>/dev/null || true
    local i
    for i in $(seq 1 10); do
      kill -0 "$API_PID" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$API_PID" 2>/dev/null; then
      kill -KILL "$API_PID" 2>/dev/null || true
      fail "API did not stop on SIGTERM — SIGKILL used"
    else
      echo "   OK: API stopped"
    fi
  else
    echo "   OK: API already stopped"
  fi
  API_PID=""
}

step_summary() {
  echo "== [8/8] signed summary"
  if [[ ${#failures[@]} -gt 0 ]]; then
    echo "FAILED steps:" >&2
    printf ' - %s\n' "${failures[@]}" >&2
    return 1
  fi
  echo "SIGNED staging-drill: timestamp=$(ts) env=staging port=$PORT healthz=200 readyz=200 smoke=ok(otp issued=$otp_issued verified=$otp_verified idem_replay=ok) verify=ok migrate_version=$migrate_version http_requests_total=$http_requests_total http_request_duration_seconds_count=$dur_count active_sessions=$active_sessions hold_after_metrics=${HOLD_AFTER_METRICS}s by=Team 6 backend agent (scripts/staging-drill.sh)"
}

main() {
  step_build || true
  step_start || true
  step_wait_ready || true
  step_smoke || true
  step_verify || true
  step_metrics || true
  step_stop
  step_summary
  exit $?
}
main
