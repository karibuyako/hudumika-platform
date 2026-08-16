#!/usr/bin/env bash
# Hudumika dashboard smoke (M8 ops readiness). Verifies the dashboards and
# alert rules are usable against a running API instance (the staging drill):
#   1. every backend/app/dashboards/grafana/*.json parses (python3 -m json.tool)
#   2. alerts.yml declares the required alert names HighLatency, ErrorRate,
#      ReadyzDown
#   3. every metric token referenced by ACTIVE alert rules in alerts.yml is
#      exposed by the running API /metrics
# Commented placeholder rules (hudumika_platform, queue_depth / webhook /
# payout metrics) are skipped — their metrics are PLANNED (MONITORING.md).
# Tokens are filtered to metric-name shapes (Prometheus families end in
# _total/_seconds/_bucket/_hits/_count/_sum), which drops PromQL functions,
# label names and interval units. `up{job=...}` (ReadyzDown) is a
# Prometheus scrape-side construct, not an API-exported metric, and its `up`
# token does not pass the filter.
# Exit 0 = all checks passed; exit 1 = failures listed.
#   BASE=http://127.0.0.1:8099 ./scripts/dashboard-smoke.sh
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8099}"
DASH_DIR="${DASH_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../dashboards" && pwd)}"
ALERTS="$DASH_DIR/alerts.yml"
failures=()

# ---- 1. Grafana dashboard JSON parses ----
echo "== [1/3] validate dashboards/grafana/*.json"
for f in "$DASH_DIR"/grafana/*.json; do
  if python3 -m json.tool "$f" >/dev/null 2>&1; then
    echo "   OK: $(basename "$f") parses"
  else
    echo "   FAILED: $(basename "$f") is not valid JSON" >&2
    failures+=("grafana/$(basename "$f") is not valid JSON")
  fi
done

# ---- 2. Required alert names present ----
echo "== [2/3] alert names in alerts.yml"
for a in HighLatency ErrorRate ReadyzDown; do
  if grep -qE "^[[:space:]]*- alert: ${a}[[:space:]]*$" "$ALERTS"; then
    echo "   OK: alert $a"
  else
    echo "   FAILED: alert $a missing" >&2
    failures+=("alerts.yml is missing alert $a")
  fi
done

# ---- 3. Metric tokens referenced by active rules are exposed ----
echo "== [3/3] /metrics exposure of alert-rule metric tokens"
# Fetch to a file (robust against command-substitution/pipe quirks on shared
# hosts) and retry a few times for transient connection starvation.
metrics=""
metrics_file="$(mktemp)"
trap 'rm -f "$metrics_file"' EXIT
for attempt in 1 2 3; do
  if curl -s --max-time 10 "$BASE/metrics" -o "$metrics_file"; then
    metrics="$(cat "$metrics_file")"
    [[ -n "$metrics" ]] && break
  fi
  echo "   retrying $BASE/metrics (attempt $attempt)..." >&2
  sleep 2
done
if [[ -z "$metrics" ]]; then
  echo "   FAILED: no response from $BASE/metrics" >&2
  failures+=("$BASE/metrics returned no body")
  exit 1
fi

tokens="$(grep -E '^[[:space:]]*expr:' "$ALERTS" \
  | grep -oE '[a-z][a-z0-9_]*' \
  | grep -E '_(total|bucket|seconds|hits|count|sum)$' \
  | sort -u)"
missing=()
for t in $tokens; do
  if grep -qF "$t" <<<"$metrics"; then
    echo "   OK: $t exposed"
  else
    echo "   FAILED: $t not in /metrics" >&2
    missing+=("$t")
  fi
done

if [[ ${#failures[@]} -gt 0 || ${#missing[@]} -gt 0 ]]; then
  echo "FAILED dashboard smoke:" >&2
  printf ' - %s\n' "${failures[@]}" "${missing[@]/#/metric missing: }" >&2
  exit 1
fi

echo "SIGNED dashboard-smoke: timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ) base=$BASE dashboards_json=ok alerts(HighLatency,ErrorRate,ReadyzDown)=ok metrics_${tokens//$'\n'/,}=present by=Team 6 backend agent (scripts/dashboard-smoke.sh)"
