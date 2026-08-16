# STAGING 24H GATE — Operator Runbook

The staging release gate (backend/DEPLOYMENT.md release checklist item 4:
"Audit + metrics dashboards green for 24 h on staging") as it is run on this
repo host. Two scripts drive it:

- `backend/app/scripts/staging-bootstrap.sh` — ONE command that provisions a
  staging database, migrates + seeds it, boots a staging-grade API instance,
  warms the auth/OTP/idempotency counters, verifies and smokes it, and leaves
  it **running** for the gate.
- `backend/app/scripts/selfcheck-24h.sh` — the gate poller: every 5 minutes
  over a configurable window it asserts the API-level stand-ins for the
  dashboard-green conditions and appends a durable report.

No docker, no Go code changes — everything is scripts + env vars against the
local PostgreSQL/Redis stand-in.

## Prerequisites

| Requirement | Where / value |
| --- | --- |
| PostgreSQL | `postgres://hudumika:hudumika@localhost:5432/hudumika` (bootstrap defaults to a **separate** `hudumika_staging` DB — it refuses to bootstrap into the dev DB) |
| Redis | `redis://localhost:6379/0` |
| Build toolchain | Go 1.25.x (`go build ./cmd/api`), plus `openssl` + `psql` |
| Mock gateway | **optional** — the bootstrap defaults `OTP_SMS_GATEWAY_URL`/`EXPO_PUSH_BASE_URL` to `http://127.0.0.1:3100/...`; with no mock listening the OTP flow still works via the fixed dev OTP code (`123456`, non-prod only) |
| Prometheus | **optional** — only needed for the presence check; see below |

Ports: the staging API defaults to **8092** (`STAGING_PORT`). The Prometheus
presence check listens on **9091**. Ports 8080/9090 stay reserved for the
compose-network mapping of the provisioning artifacts.

## 1. Bootstrap

```bash
# from backend/app
./scripts/staging-bootstrap.sh
# or with an explicit staging port / maintenance DB URL (app role lacks CREATEDB):
STAGING_PORT=8092 ADMIN_DB_URL=postgres://postgres:...@localhost:5432/postgres \
  ./scripts/staging-bootstrap.sh
```

The bootstrap runs 10 steps (safety → create DB → migrate → seed → build+start
→ wait ready → auth smoke → verify-release → dashboard-smoke → signed
summary). It **leaves the API running** (pidfile
`/tmp/opencode/staging-api.pid`, log `/tmp/opencode/staging-api.log`) and
appends a `SIGNED staging-bootstrap:` line to
`backend/app/backups/staging-bootstrap-<ts>.log`. Stop it with
`pkill -f staging-api` when done.

## 2. The 24h window

```bash
# from backend/app — 24h window, 5 min poll (defaults), API on 8092:
BASE=http://127.0.0.1:8092 SELFCHECK_MINUTES=1440 ./scripts/selfcheck-24h.sh
```

Poll interval stays 5 minutes (`SELFCHECK_INTERVAL=300`), window length is
`SELFCHECK_MINUTES` (default 1440 = 24h). Every cycle polls `$BASE`:

- `/healthz` and `/readyz` → 200
- `/metrics` → 200 and exposing the **five base metric families**
  (`http_requests_total`, `http_request_duration_seconds_count`,
  `otp_requests_total`, `idempotency_hits_total`, `active_sessions` — the
  names behind dashboards 1–2, drift-pinned by
  `backend/app/internal/api/alerts_test.go`)
- 5xx error-rate proxy: the increase of
  `http_requests_total{status=~"5.."}` between consecutive polls must stay
  ≤ 1% of the total `http_requests_total` increase (matches the `ErrorRate`
  alert threshold, 5m > 1%)

On completion the script appends a durable report to
**`backend/app/backups/selfcheck-report-<date>.txt`** (per-cycle summaries +
final line) and prints/records:

```
SELFCHECK PASS: checks=N ok=N failures=0 window=1440m
```

Exit 0 = green window completed; exit 1 = any failure. The rolling log
(`/tmp/opencode/selfcheck-24h.log`, newest 500 lines) has the per-check detail.

### Optional Prometheus presence check

When `PROMETHEUS_BIN` is set (and the binary exists) **and** the Prometheus
config exists, the script additionally verifies the provisioning path once per
run: it starts a throwaway Prometheus with
`--config.file` (default `backend/app/monitoring/prometheus.yml`),
`--storage.tsdb.path=/tmp/hudumika-prom`, `--web.listen-address=:9091`, waits
10 s, queries `up{job="hudumika-api"}` and requires `"value":[...,"1"]`, then
kills the instance.

```bash
PROMETHEUS_BIN=/usr/local/bin/prometheus BASE=http://127.0.0.1:8092 \
  SELFCHECK_MINUTES=1440 ./scripts/selfcheck-24h.sh
```

- The repo config scrapes `localhost:8080`; when the API runs on 8092, point
  `PROMETHEUS_CONFIG` at a copy with the target swapped (or run the API on
  8080). Otherwise the check legitimately reports `up=0`.
- Absent binary or config → the check is **skipped with a note** in the log
  and report (`prometheus=skipped`); it never fails or blocks a run.

## 3. What "green" means

| Condition | Threshold | Checked by |
| --- | --- | --- |
| `/healthz`, `/readyz` | HTTP 200 every poll | selfcheck cycle |
| Five base metric families | all present in `/metrics` every poll | selfcheck cycle |
| 5xx delta | ≤ 1% of total traffic between polls | selfcheck cycle |
| Prometheus wiring (optional) | `up{job="hudumika-api"}` == 1 | selfcheck presence check |
| `queue_depth` | present when the dispatch metric is wired | manual — the metric + its alert rule are commented placeholders until they ship (`docs/MONITORING.md`); the check will not fail on it today |

All conditions must hold for every poll of the whole window — a single FAIL
poll fails the gate (the 5xx check needs two polls; the first poll records the
baseline).

## 4. Prometheus / Grafana provisioning

Provisionable artifacts (no docker executed on this host; the compose mapping
is documented in-file):

- `backend/app/monitoring/prometheus.yml` — scrape job `hudumika-api` →
  `localhost:8080/metrics`, `scrape_interval: 15s`, `rule_files` loads
  `../dashboards/alerts.yml`.
- `backend/app/monitoring/grafana/provisioning/datasources/prometheus.yml` —
  datasource `uid: prometheus`, `isDefault: true` (every dashboard JSON
  references this uid).
- `backend/app/monitoring/grafana/provisioning/dashboards/dashboards.yml` —
  file provider over `backend/app/dashboards/grafana/`, folder `Hudumika`,
  `disableDeletion: true`.
- Dashboards: all five JSONs in `backend/app/dashboards/grafana/`; alert
  rules in `backend/app/dashboards/alerts.yml`; both drift-pinned by
  `backend/app/internal/api/alerts_test.go`.

Under the compose deployment (`backend/app/docker-compose.yml`) the same files
map to service hostnames (`api:8080`, `prometheus:9090`).

## 5. Sign-off checklist (release)

From backend/DEPLOYMENT.md release checklist:

1. Migrations reviewed and backward-compatible.
2. Contract check passed against latest `API-CONTRACT.yaml` (all 580
   operations answer defined shapes).
3. Client apps on staging pass MSW-parity suites.
4. **This gate**: `staging-bootstrap.sh` up (API on 8092, healthz/readyz 200)
   → `dashboard-smoke.sh` green → 24 h selfcheck window green (`SELFCHECK
   PASS` line + `backend/app/backups/selfcheck-report-<date>.txt`) → drill
   records in `docs/RUNBOOKS.md` → `## Drill status`.
5. Release notes include client-compatibility notes.

Reference run recorded 2026-08-16 (3-min window stand-in, API on 8092):
`SELFCHECK PASS: checks=17 ok=17 failures=0 window=3m`, report
`backend/app/backups/selfcheck-report-2026-08-16.txt` (an earlier cold run
correctly FAILed on the two metric families that only appear after the OTP +
idempotency-replay smoke — warm the counters before judging a FAIL).

## 6. Tear-down

```bash
pkill -f staging-api        # stop the gate instance
rm -rf /tmp/hudumika-prom   # throwaway Prometheus TSDB (if the check ran)
```

Leave no processes running: verify with `ss -tlnp | grep 8092` and
`pgrep -af prometheus`.
