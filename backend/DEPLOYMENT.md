# HUDumika Backend Deployment

## Environments

| Environment | Hostname | Purpose |
| --- | --- | --- |
| dev | localhost / dev-api.hudumika.co.tz | feature work, MSW parity |
| staging | staging-api.hudumika.co.tz | integration with all client apps, contract tests |
| production | api.hudumika.co.tz | live traffic |

Admin API surface (`/admin/*`) is reachable only via a **separate protected
hostname** (e.g. `ops-api.hudumika.co.tz`) or network policy — never exposed on
the public API hostname.

## Delivery

- CI builds an OCI image, runs `go vet`, unit + integration tests, contract check.
- Migrations run as a separate deploy step (`make -C app migrate` → `cmd/migrate` with embedded goose migrations) — never inside the app process.
- Deploy strategy: rolling update with `/healthz` + `/readyz` gates (`/readyz` returns 503 when PostgreSQL or Redis is down, or when nothing is configured); rollback by redeploying the previous image.
- DB changes: forward migrations; destructive schema changes are split across two releases; `down` migrations are tested but never run in production.

## Configuration

- Config via environment variables, injected at deploy time (no config files in repo). `ENV` must be `development` | `staging` | `production`; anything else is a hard boot failure. Register every variable in `docs/ENV-VARS.md` in the same PR.
- Required vars: `ENV`, `JWT_SECRET` (alias `JWT_SIGNING_KEY`, ≥ 32 bytes in prod), `DATABASE_URL`, `REDIS_URL`, `OTP_PAYLOAD_KEY` (payload encryption), `PAYMENT_WEBHOOK_SECRET` (webhook HMAC fallback), plus per-integration vars:
  - `OTP_SMS_GATEWAY_URL` / `OTP_SMS_GATEWAY_API_KEY` / `OTP_SMS_GATEWAY_SENDER` and `EMAIL_GATEWAY_URL` / `EMAIL_GATEWAY_API_KEY` / `EMAIL_GATEWAY_SENDER` (configurable HTTP SMS/email gateways, env-driven fail-over chain).
  - Per-provider webhook signing secrets: `MPESA_WEBHOOK_SECRET`, `TIGO_WEBHOOK_SECRET`, `AIRTEL_WEBHOOK_SECRET`, `CARD_WEBHOOK_SECRET`.
  - `EXPO_PUSH_ACCESS_TOKEN` (+ optional `EXPO_PUSH_BASE_URL`) for the push outbox channel.
  - `S3_*`, `ADMIN_ALLOWED_IPS` (exact IPs/CIDRs; production: locked to ops ranges — the `/admin/*` allow-list fails closed when set).
  - `SIMULATOR_KEY` is staging-only (customer simulator for E2E). TODO: not found in the backend code — no env read exists; verify before relying on it.
- Production guards at boot: weak/default JWT secrets refused, `CORS_ORIGINS=*` refused, dev OTP code refused.
- Secrets live in the secret manager of the hosting platform; never in git.

## Observability

| Concern | Solution |
| --- | --- |
| Logs | Structured JSON via slog; every line has requestId + actor + route |
| Traces | OpenTelemetry (HTTP spans; PostgreSQL, Redis and provider spans as those domains land). TODO: code inspection shows HTTP spans only (`internal/api/metrics.go`) — PG/Redis/provider instrumentation not found; re-verify |
| Metrics | Prometheus `/metrics`: latency percentiles, error rate by code, OTP funnel, idempotency hits, active sessions |
| Health | `/healthz` (process) and `/readyz` (db, redis) |
| Alerts | p99 latency > 1 s, error rate > 1%, dispatch queue depth > 100, webhook verification failures |

## Runbooks (must exist before launch)

1. Payment webhook down → queue backlog, replay outbox, alert finance.
2. Dispatch queue stuck → drain, re-enqueue, verify rider pools.
3. DB connection saturation → read replica for list endpoints.
4. OTP gateway outage → switch SMS provider via config, verify rates.
5. Payout batch exception → finance review workflow, manual settlement.

## Release checklist

1. Migrations reviewed and backward-compatible.
2. Contract check passed against latest `API-CONTRACT.yaml` (`TestAllContractPathsReturnDefinedShape`: all 580 operations answer defined shapes).
3. Client apps on staging pass MSW-parity suites.
4. Audit + metrics dashboards green for 24 h on staging. Tooling: run `scripts/staging-drill.sh` against the standing staging instance, then `scripts/dashboard-smoke.sh` against it (both executable; they produce the signed records below and in `docs/RUNBOOKS.md` → `## Drill status`). Dashboard smoke is the last gate before the 24 h green window.
5. Release notes include client-compatibility notes.

> TODO: the checklist notes call for staging drill + dashboard smoke before every staging promotion; only the two recorded runs (2026-08-14/15, local stand-in) exist — a standing staging environment is not yet provisioned.

### Signed execution record

- Date: 2026-08-14 (drills: 12:37–13:05 EAT / 09:37–10:05 UTC)
- Signed by: Team 6 backend agent
- Checks run (via `backend/app/scripts/verify-release.sh` and the
  backup/restore scripts from `docs/RUNBOOKS.md` § Drill status):
  - Backup drill: `pg_dump -Fc` OK — `backups/hudumika-20260814-123704.dump`
    (15,059 bytes); redis `SAVE` OK (RDB copy warn-only: root-owned
    `/var/lib/redis`, Postgres backup unaffected). PASSED.
  - Restore drill: `pg_restore --clean --if-exists` into scratch DB
    `hudumika_restore_test`, smoke `SELECT count(*) FROM users` = 2 (matches
    source), scratch DB dropped. PASSED.
  - `readyz`: HTTP 200 (db + redis reachable). PASSED.
  - `/metrics`: exposes `http_requests_total` and
    `http_request_duration_seconds`. PASSED.
  - Migrations: `cmd/migrate -status` reports version 9 (≥ 9 gate). PASSED.
  - Signed summary: `verify-release: ENV=development PORT=8098 healthz=200
    readyz=200 metrics=ok migrate_version=9 by=Team 6 backend agent at
    2026-08-14T10:05:49Z`. Exit 0.
- Reference: `docs/RUNBOOKS.md` → `## Drill status` (commands + verbatim
  output); rerun `scripts/verify-release.sh` with production env vars before
  each prod release to exercise the production-only gates.

### Signed execution record — staging drill (2 of 2)

- Date: 2026-08-15 (staging drill 23:38–23:41 EAT / 20:38–20:41 UTC)
- Signed by: Team 6 backend agent
- Checks run (via `backend/app/scripts/staging-drill.sh` and
  `backend/app/scripts/dashboard-smoke.sh`, both executable; records in
  `docs/RUNBOOKS.md` → `## Drill status`):
  - Staging drill (`ENV=staging`, `PORT=8099`, local PostgreSQL/Redis
    stand-in, no docker): built `cmd/api`; booted with staging env (32+ char
    `JWT_SECRET`, 64-hex `OTP_PAYLOAD_KEY`,
    `CORS_ORIGINS=https://staging.hudumika.co.tz`, M-Pesa/SMS dummy secrets);
    `/healthz` + `/readyz` 200; CORS origin echo; 401 `UNAUTHORIZED` envelope
    on authed routes without tokens; full `request-otp → verify-otp` flow for
    a fresh destination (dev OTP code); authed idempotency-key replay on
    `GET /home` (identical replayed body). PASSED.
  - `scripts/verify-release.sh` against the running instance with
    `ENV=staging` (production guards skipped by design): healthz=200,
    readyz=200, metrics ok, migrate_version=57 (≥ 9 gate). PASSED.
  - Metrics captured from `/metrics`: `http_requests_total=14`,
    `http_request_duration_seconds_count=14`,
    `otp_requests_total` issued=1 verified=1, `active_sessions=153`. PASSED.
  - API stopped cleanly (SIGTERM) after a 45 s external-smoke hold; binary
    left stopped.
  - Dashboard smoke against the drilled instance: all five
    `dashboards/grafana/*.json` parse; `alerts.yml` declares HighLatency,
    ErrorRate, ReadyzDown; every metric token referenced by active rules
    (`http_request_duration_seconds_bucket`, `http_requests_total`,
    `otp_requests_total`, `idempotency_hits_total`) exposed by live
    `/metrics`. PASSED — the last gate before the 24 h green-dashboard
    window (release checklist item 4).
  - Backup/restore re-drill (runbooks 2.1–2.3):
    `backups/hudumika-20260815-234001.dump` (581,596 bytes); `pg_restore`
    into scratch DB `hudumika_restore_test`, smoke `users = 229` (matches
    source), scratch DB dropped. PASSED.
  - Signed summaries:
    - `verify-release: ENV=staging PORT=8099 healthz=200 readyz=200
      metrics=ok migrate_version=57 by=Team 6 backend agent at
      2026-08-15T20:38:16Z`. Exit 0.
    - `staging-drill: timestamp=2026-08-15T20:39:02Z env=staging port=8099
      healthz=200 readyz=200 smoke=ok(otp issued=1 verified=1
      idem_replay=ok) verify=ok migrate_version=57 http_requests_total=14
      http_request_duration_seconds_count=14 active_sessions=153
      hold_after_metrics=45s by=Team 6 backend agent
      (scripts/staging-drill.sh)`. Exit 0.
    - `dashboard-smoke: timestamp=2026-08-15T20:38:18Z
      base=http://127.0.0.1:8099 dashboards_json=ok
      alerts(HighLatency,ErrorRate,ReadyzDown)=ok
      metrics_http_request_duration_seconds_bucket,http_requests_total,idempotency_hits_total,otp_requests_total=present
      by=Team 6 backend agent (scripts/dashboard-smoke.sh)`. Exit 0.
- Reference: `docs/RUNBOOKS.md` → `## Drill status` (commands + verbatim
  output for all three drills); rerun `scripts/staging-drill.sh` and
  `scripts/dashboard-smoke.sh` before each staging promotion, and
  `scripts/verify-release.sh` with production env vars before each prod
  release to exercise the production-only gates.
