#!/usr/bin/env bash
# Hudumika 24h self-check (release-gate stand-in).
#
# Approximates the staging release gate "dashboards 1-2 stay green for 24h"
# (backend/DEPLOYMENT.md release checklist item 4) at the API level until a
# standing staging env exists: every SELFCHECK_INTERVAL seconds it polls
#   - /healthz and /readyz must answer 200
#   - /metrics must be 200 and expose the five base metric families
#     (http_requests_total, http_request_duration_seconds_count,
#     otp_requests_total, idempotency_hits_total, active_sessions — the
#     metric names behind dashboards 1-2, drift-pinned by
#     internal/api/alerts_test.go)
#   - 5xx error-rate proxy: http_requests_total{status=~"5.."} increases
#     between two consecutive polls must not exceed 1% of the total
#     http_requests_total increase over the same window (matches the
#     ErrorRate alert threshold in dashboards/alerts.yml, 5m > 1%)
#
# Durable report: on completion appends the per-cycle summaries plus the final
# PASS/FAIL line to SELFCHECK_REPORT (default
# backend/app/backups/selfcheck-report-<date>.txt, one file per local date,
# appended across runs).
#
# Prometheus presence check (optional, once per run): when PROMETHEUS_BIN is
# set and the binary exists and the Prometheus config exists, a throwaway
# Prometheus is started on :9091 against PROMETHEUS_CONFIG (default
# backend/app/monitoring/prometheus.yml, target localhost:8080) and the query
# up{job="hudumika-api"} must answer "1" after the scrape interval. The
# instance is killed right after. Skipped (with a note) when the binary or the
# config is absent — the check must never block a run.
#
# Rolling log: appends to SELFCHECK_LOG, keeps the newest 500 lines.
# Final line: "SELFCHECK PASS|FAIL: checks=N ok=M failures=K window=..."
# Exit 0 = all checks passed; exit 1 = any failure.
#
# Deps: curl + awk + standard shell utils only (no external packages).
# Prometheus (optional): PROMETHEUS_BIN.
#
#   SELFCHECK_MINUTES=1440 ./scripts/selfcheck-24h.sh
#   BASE=http://127.0.0.1:8093 SELFCHECK_MINUTES=2 ./scripts/selfcheck-24h.sh
#   PROMETHEUS_BIN=/usr/local/bin/prometheus BASE=http://127.0.0.1:8092 \
#     SELFCHECK_MINUTES=1440 ./scripts/selfcheck-24h.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELFCHECK_MINUTES="${SELFCHECK_MINUTES:-1440}"   # window length in minutes
SELFCHECK_INTERVAL="${SELFCHECK_INTERVAL:-300}"  # poll period in seconds (5 min default)
BASE="${BASE:-http://127.0.0.1:8080}"
SELFCHECK_LOG="${SELFCHECK_LOG:-/tmp/opencode/selfcheck-24h.log}"
SELFCHECK_REPORT="${SELFCHECK_REPORT:-$SCRIPT_DIR/../backups/selfcheck-report-$(date +%F).txt}"
PROMETHEUS_BIN="${PROMETHEUS_BIN:-}"
PROMETHEUS_CONFIG="${PROMETHEUS_CONFIG:-$SCRIPT_DIR/../monitoring/prometheus.yml}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:9091}"
PROMETHEUS_TSDB="${PROMETHEUS_TSDB:-/tmp/hudumika-prom}"

checks=0
ok=0
failures=0
prev_5xx=-1
prev_total=-1
start_epoch="$(date +%s)"
window_secs=$((SELFCHECK_MINUTES * 60))
PROM_PID=""
prom_status="not-run"
cycle_no=0
cycle_summaries=""

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$SELFCHECK_LOG"; }

cleanup_prom() {
  if [ -n "$PROM_PID" ] && kill -0 "$PROM_PID" 2>/dev/null; then
    kill "$PROM_PID" 2>/dev/null || true
    wait "$PROM_PID" 2>/dev/null || true
    PROM_PID=""
  fi
}
trap cleanup_prom EXIT

roll_log() {
  [ -f "$SELFCHECK_LOG" ] || return 0
  local n
  n="$(wc -l < "$SELFCHECK_LOG")"
  if [ "$n" -gt 500 ]; then
    tail -n 500 "$SELFCHECK_LOG" > "$SELFCHECK_LOG.tmp" && mv "$SELFCHECK_LOG.tmp" "$SELFCHECK_LOG"
  fi
}

record() {
  checks=$((checks + 1))
  if [ "$1" -eq 0 ]; then
    ok=$((ok + 1))
    log "OK:   $2 $3"
  else
    failures=$((failures + 1))
    log "FAIL: $2 $3"
  fi
}

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || true; }

check_cycle() {
  local hz rz m_code mfile
  hz="$(http_code "$BASE/healthz")"
  rz="$(http_code "$BASE/readyz")"
  mfile="$(mktemp)"
  m_code="$(curl -s -o "$mfile" -w '%{http_code}' --max-time 10 "$BASE/metrics" 2>/dev/null || true)"

  [ "$hz" = "200" ] && record 0 "healthz" "status=200" || record 1 "healthz" "status=$hz"
  [ "$rz" = "200" ] && record 0 "readyz" "status=200" || record 1 "readyz" "status=$rz"

  if [ "$m_code" = "200" ] && [ -s "$mfile" ]; then
    record 0 "metrics" "status=200"
  else
    record 1 "metrics" "status=$m_code (empty: $([ -s "$mfile" ] && echo no || echo yes))"
    rm -f "$mfile"
    return 1
  fi

  local fam
  for fam in \
    '^http_requests_total\{' \
    '^http_request_duration_seconds_count\{' \
    '^otp_requests_total\{' \
    '^idempotency_hits_total\{' \
    '^active_sessions '; do
    if awk -v pat="$fam" '$0 ~ pat { found=1 } END { exit !found }' "$mfile"; then
      record 0 "base-metric" "${fam#^}"
    else
      record 1 "base-metric" "family ${fam#^} not exposed"
    fi
  done

  local line cur5 curT d5 dT ratio
  line="$(awk '/^http_requests_total\{/ { t += $NF; if ($0 ~ /status="5[0-9][0-9]"/) f += $NF } END { print f+0, t+0 }' "$mfile")"
  cur5="${line%% *}"
  curT="${line##* }"
  rm -f "$mfile"

  if [ "$prev_total" -ge 0 ]; then
    d5=$((cur5 - prev_5xx))
    dT=$((curT - prev_total))
    if [ "$dT" -gt 0 ]; then
      ratio="$(awk -v a="$d5" -v b="$dT" 'BEGIN { printf "%.4f", a / b }')"
      if awk -v r="$ratio" 'BEGIN { exit !(r > 0.01) }'; then
        record 1 "5xx-error-rate" "5xx_delta=$d5 total_delta=$dT ratio=$ratio > 0.01"
      else
        record 0 "5xx-error-rate" "5xx_delta=$d5 total_delta=$dT ratio=$ratio <= 0.01"
      fi
    elif [ "$d5" -gt 0 ]; then
      record 1 "5xx-error-rate" "5xx_delta=$d5 total_delta=$dT (5xx grew without total traffic)"
    else
      record 0 "5xx-error-rate" "no new traffic since last poll (5xx_delta=0)"
    fi
  else
    log "info: baseline 5xx=$cur5 total=$curT (first poll; delta check starts next poll)"
  fi
  prev_5xx=$cur5
  prev_total=$curT
}

# Optional Prometheus presence check: one throwaway Prometheus per run, started
# against the repo config and killed right after. Verifies the provisioning
# path (monitoring/prometheus.yml -> API /metrics -> up == 1). Skipped with a
# note when the binary or the config is absent; absent binary is NEVER a
# failure (the gate must run on hosts without Prometheus).
prom_check() {
  if [ -z "$PROMETHEUS_BIN" ]; then
    prom_status="skipped"
    log "info: prometheus check skipped (PROMETHEUS_BIN unset)"
    return 0
  fi
  if [ ! -x "$PROMETHEUS_BIN" ]; then
    prom_status="skipped"
    log "info: prometheus check skipped (PROMETHEUS_BIN=$PROMETHEUS_BIN not executable)"
    return 0
  fi
  if [ ! -f "$PROMETHEUS_CONFIG" ]; then
    prom_status="skipped"
    log "info: prometheus check skipped (config $PROMETHEUS_CONFIG not found)"
    return 0
  fi

  log "prometheus check: start $PROMETHEUS_BIN --config.file=$PROMETHEUS_CONFIG --storage.tsdb.path=$PROMETHEUS_TSDB --web.listen-address=:9091"
  "$PROMETHEUS_BIN" --config.file="$PROMETHEUS_CONFIG" \
    --storage.tsdb.path="$PROMETHEUS_TSDB" \
    --web.listen-address=:9091 >/dev/null 2>&1 &
  PROM_PID=$!

  local i out raw
  out=""
  for i in $(seq 1 10); do
    sleep 1
    raw="$(curl -g -s --max-time 2 "$PROMETHEUS_URL/api/v1/query?query=up%7Bjob%3D%22hudumika-api%22%7D" 2>/dev/null || true)"
    if printf '%s' "$raw" | grep -Eq '"value":\[[0-9.]*,"1"\]'; then
      out="$raw"
      break
    fi
  done

  if printf '%s' "$out" | grep -Eq '"value":\[[0-9.]*,"1"\]'; then
    prom_status="ok"
    record 0 "prometheus" "up{job=\"hudumika-api\"} == 1 (via $PROMETHEUS_URL, config $PROMETHEUS_CONFIG)"
  else
    prom_status="fail"
    record 1 "prometheus" "up{job=\"hudumika-api\"} != 1 (via $PROMETHEUS_URL, raw: ${out:-<no reply>})"
  fi

  cleanup_prom
  log "prometheus check done: $prom_status (pid $PROM_PID exited)"
}

# Appends the durable report (per-cycle summaries + final verdict) to
# SELFCHECK_REPORT and leaves a breadcrumb in the rolling log.
write_report() {
  local verdict="$1"
  mkdir -p "$(dirname "$SELFCHECK_REPORT")"
  {
    printf '=== selfcheck report: start=%s end=%s base=%s interval=%ss window=%sm prometheus=%s ===\n' \
      "$(date -u -d "@$start_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BASE" "$SELFCHECK_INTERVAL" "$SELFCHECK_MINUTES" "$prom_status"
    printf '%s\n' "$cycle_summaries" | awk 'NF'
    printf 'FINAL: %s\n' "$verdict"
  } >> "$SELFCHECK_REPORT"
  log "report appended: $SELFCHECK_REPORT"
}

main() {
  mkdir -p "$(dirname "$SELFCHECK_LOG")"
  log "selfcheck start: base=$BASE interval=${SELFCHECK_INTERVAL}s window=${SELFCHECK_MINUTES}m"
  prom_check
  local now elapsed remaining nap
  while :; do
    cycle_no=$((cycle_no + 1))
    local c0 o0 f0
    c0=$checks; o0=$ok; f0=$failures
    check_cycle
    cycle_summaries="$cycle_summaries
cycle $cycle_no: time=$(date -u +%Y-%m-%dT%H:%M:%SZ) checks=$((checks - c0)) ok=$((ok - o0)) failures=$((failures - f0))"
    roll_log
    now="$(date +%s)"
    elapsed=$((now - start_epoch))
    [ "$elapsed" -ge "$window_secs" ] && break
    remaining=$((window_secs - elapsed))
    nap="$SELFCHECK_INTERVAL"
    [ "$nap" -gt "$remaining" ] && nap="$remaining"
    [ "$nap" -gt 0 ] || break
    log "sleep ${nap}s (remaining ${remaining}s of ${SELFCHECK_MINUTES}m)"
    sleep "$nap"
  done

  if [ "$failures" -gt 0 ]; then
    echo "SELFCHECK FAIL: checks=$checks ok=$ok failures=$failures window=${SELFCHECK_MINUTES}m" | tee -a "$SELFCHECK_LOG"
    write_report "SELFCHECK FAIL: checks=$checks ok=$ok failures=$failures window=${SELFCHECK_MINUTES}m"
    exit 1
  fi
  echo "SELFCHECK PASS: checks=$checks ok=$ok failures=$failures window=${SELFCHECK_MINUTES}m" | tee -a "$SELFCHECK_LOG"
  write_report "SELFCHECK PASS: checks=$checks ok=$ok failures=$failures window=${SELFCHECK_MINUTES}m"
  exit 0
}

main
