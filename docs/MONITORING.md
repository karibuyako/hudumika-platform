# Hudumika Monitoring & Observability

Status legend: `[LIVE]` works today, `[EXPECTED]` lands with the backend
migrations work (backend agent), `[PLANNED]` to build with this doc.

Audit baseline: backend emits structured JSON logs via `slog` with `request_id`
per line `[LIVE]`; `/healthz` exists `[LIVE]`; `/readyz` exists `[LIVE]`;
`/metrics` and HTTP tracing shipped with the observability milestone `[LIVE]`.

## Logs

| Aspect | Status | Detail |
| --- | --- | --- |
| Format | LIVE | JSON via `slog.NewJSONHandler` to stdout; `slog.LevelInfo` default |
| Correlation | LIVE | `request_id` on every request log line (chi RequestID middleware); errors carry `requestId` in API error bodies |
| Fields | LIVE | `method`, `path`, `status`, `duration_ms`, `request_id` (+ actor/route on business logs) |
| dev | LIVE | stdout of `docker compose logs api` |
| staging | LIVE | host stdout; capture into the host log collector (rotated files) |
| production | PLANNED | stdout shipped to a central log sink (Loki/CloudWatch equivalent); query by `request_id` and `status` |

Log hygiene: no PII beyond request context (OTP codes never logged); money
fields logged in minor units only.

## Metrics

Expose a Prometheus `/metrics` endpoint `[LIVE]` (API port, text exposition
format 0.0.4). Counters/labels shipped:

| Metric | Status | Type | Labels | Notes |
| --- | --- | --- | --- | --- |
| `http_requests_total` | LIVE | counter | `method`, `path`, `status` | Split by 2xx/4xx/5xx; base for error-rate alerts. `path` is the chi route pattern; `/metrics` excludes itself |
| `http_request_duration_seconds` | LIVE | histogram | `method`, `path` | p50/p95/p99 from this (buckets 5 ms..10 s) |
| `otp_requests_total` | LIVE | counter | `channel`, `outcome` | Outcome: issued / verified / failed / rate_limited. Wired from the OTP handlers |
| `idempotency_hits_total` | LIVE | counter | `operation` | Cache hits on idempotency keys (payments, orders). Wired from the replay path |
| `active_sessions` | LIVE | gauge | none | Current authenticated sessions (refresh token store); polled every 15 s |
| `queue_depth` | PLANNED | gauge | `queue` | Dispatch queue depth |
| `payout_failures_total` | PLANNED | counter | `provider` | Payout batch exceptions |

Exporters: Prometheus pull via `/metrics` on the API port `[LIVE]`; alertmanager
for routing `[PLANNED]`.

## Alert rules

| Rule | Condition | For | Severity | Action (RUNBOOKS 3–4) |
| --- | --- | --- | --- | --- |
| High latency | p99 > 1 s | 5 min | SEV2 | Identify slow path, rollback if regression |
| Error rate | 5xx + error-code rate > 1% | 5 min | SEV2 | Inspect logs by `request_id`, rollback |
| Queue depth | dispatch queue > 100 | 5 min | SEV2 | Drain, re-enqueue, verify rider pools |
| Readyz down | `/readyz` returns 503 | 2 min | SEV1 | DB/Redis check, connection pool saturation |
| Payment webhook | unprocessed > 5 min | — | SEV1 | Replay outbox, alert finance |
| Payout exception | batch failures | — | SEV1 | Finance review, manual settlement |

Thresholds match `backend/DEPLOYMENT.md` observability table.

The rules above ship as live Prometheus alerting rules in
`backend/app/dashboards/alerts.yml` (groups `hudumika_api` /
`hudumika_platform`); rules for metrics that do not exist yet
(`queue_depth`, payment webhook backlog, `payout_failures_total`) stay
commented placeholders in that file. The drift-pin test
(`backend/app/internal/api/alerts_test.go`) enforces that every rule
references a metric actually exported by `backend/app/internal/api/metrics.go`.

## Tracing

- OpenTelemetry HTTP spans `[LIVE]` — one span per request, named
  `<METHOD> <route>`, carrying `request_id`, `http.method`, `http.route`,
  `http.status_code`, so traces correlate to log lines by `request_id`.
- Export `[LIVE]` via OTLP/HTTP to the collector at
  `OTEL_EXPORTER_OTLP_ENDPOINT`; with the env var unset the provider is a
  no-op. PostgreSQL, Redis and provider (SMS/payment) spans `[PLANNED]`.
- Sampling `[LIVE]`: 100% on errors (5xx), 10% otherwise. The error side is
  enforced at export time (`errorAwareExporter` promotes 5xx spans, which
  OTel cannot judge at span start); healthy traffic honors the 10% ratio.

## Dashboards and alert rules `[LIVE]`

All five dashboards ship as Grafana JSON (schemaVersion 39, Prometheus
datasource) in `backend/app/dashboards/grafana/`:

1. `api-overview.json` — RPS, p50/p95/p99, error rate by status and endpoint, active sessions.
2. `errors.json` — top 5xx paths, contract error-code distribution, 501 regressions.
3. `dispatch.json` — queue depth (constant-0 fallback until the metric ships), rider pool online/offline, offer accept rate.
4. `money.json` — webhook backlog, payout failures by provider, idempotency hit rate.
5. `mobile-otp.json` — OTP request/verify funnel, provider failure split (for staging channel telemetry).

Alert rules are live Prometheus rules in `backend/app/dashboards/alerts.yml`
and map 1:1 to the Alert rules table above. `queue_depth`,
`payment_webhook_backlog` and `payout_failures_total` rules are commented
placeholders there until the metrics land. Every rule and dashboard is
drift-pinned to the metric names in `backend/app/internal/api/metrics.go` by
`backend/app/internal/api/alerts_test.go` (alert metrics + rule fields; JSON
parseability of all five dashboards).

Green-for-24h on staging of dashboards 1–2 is a release gate (`backend/DEPLOYMENT.md`).

## On-call expectations

- SEV1/2 paged 24/7; acknowledge within the RUNBOOKS 3.1 window.
- On-call checks: `/healthz`, `/readyz`, error rate, p99, queue depth, then logs by `request_id`.
- Escalate: backend owner → engineering lead → finance (money incidents only).
- Every SEV1/2 gets a postmortem (template in RUNBOOKS 3.4) within 3 working days.
- Staging alerting mirrors prod (lower thresholds ok) so nothing is learned about alerting first in prod.
