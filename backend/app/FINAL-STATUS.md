# Hudumika Backend — FINAL STATUS (Closing Audit)

Module `github.com/hudumika/api-backend`, Go `1.25.7` (`app/go.mod`).
Audited: 2026-08-16, after the final parallel wave. All numbers recorded verbatim from the commands listed.

## 1. Build & vet

| Check | Result |
| --- | --- |
| `go build ./...` | **PASS** (exit 0) |
| `go vet ./...` | **PASS** (exit 0) |
| `go vet ./tools/... ./internal/ws/ ./internal/metrics/` (new packages) | **PASS** (exit 0) |

Note: during the audit the parallel wave was still writing files (mtimes advancing on
`internal/api/*.go`, `tools/seed/*`, `go.mod`); two `-tags integration` builds transiently failed
on mid-write files (`log/slog` unused, `undefined: http`, `undefined: time`). Re-runs after the
wave settled pass cleanly. No code was modified by the audit.

## 2. Unit suite

`go test ./... -count=1` → **13 packages `ok`, 0 failures**:

```
ok  github.com/hudumika/api-backend/cmd/api                0.266s
ok  github.com/hudumika/api-backend/internal/api           28.465s
ok  github.com/hudumika/api-backend/internal/audit          0.086s
ok  github.com/hudumika/api-backend/internal/config         0.110s
ok  github.com/hudumika/api-backend/internal/metrics        0.054s
ok  github.com/hudumika/api-backend/internal/notifications  0.852s
ok  github.com/hudumika/api-backend/internal/payments       0.050s
ok  github.com/hudumika/api-backend/internal/store          0.287s
ok  github.com/hudumika/api-backend/internal/sweeper        0.034s
ok  github.com/hudumika/api-backend/internal/tracing        0.050s
ok  github.com/hudumika/api-backend/internal/webhooks       0.050s
ok  github.com/hudumika/api-backend/internal/ws             2.886s
ok  github.com/hudumika/api-backend/tools/mock-gateway      0.079s
```

## 3. Coverage pin

`go test ./internal/api/ -run TestAllContractPathsReturnDefinedShape -count=1` → **PASS**:

```
contract paths checked: 464, operations checked: 580, not implemented (501): 1, undefined shapes: 0
501: GET /events?after=0
```

Per-package statement coverage (`go test ./... -count=1 -cover`):

| Package | Coverage |
| --- | --- |
| cmd/api | 0.0% |
| internal/api | 15.1% |
| internal/audit | 21.4% |
| internal/config | 91.8% |
| internal/metrics | 75.0% |
| internal/notifications | 55.4% |
| internal/payments | 31.9% |
| internal/store | 35.2% |
| internal/sweeper | 3.4% |
| internal/tracing | 80.0% |
| internal/webhooks | 20.7% |
| internal/ws | 73.4% |
| tools/mock-gateway | 68.8% |

(The contract-shape walk is the documented coverage pin; the percentage figures are the
`-cover` statement counts, service-free unit runs only.)

## 4. Error-code pin

`go test ./internal/api/ -run TestErrorCodes -count=1` → **PASS**:
`TestErrorCodesUsedExistInCatalog` PASS, `TestErrorCodesCatalogIsStable` PASS.

## 5. Migrations

`go run ./cmd/migrate -status` → **migrations OK** (consistent).

- Max applied version: **00061_customer_sync.sql** (applied 2026-08-16).
- Applied rows: 60 (00001–00061 minus 00054).
- Files on disk: **60** (`ls migrations/*.sql | wc -l`).
- Numbering gap 00054 is consistent between disk and DB (never created, never applied) — not a
  drift.

## 6. Leftover markers

`TODO`/`FIXME` in `internal/` (excluding `internal/gen` and `_test.go`): **0**.
`panic(`: **3**, all in metrics recovery paths (re-panic after metrics capture):

```
internal/metrics/queuedepth.go:37:   panic(err)
internal/api/metrics.go:103:         panic(p)
internal/api/metrics.go:265:         panic(p)
```

## 7. Integration pin

`go test -tags integration ./internal/api/ -run 'TestAuthStateSurvivesRestart|TestAllContractPaths' -count=1`
(against real PostgreSQL + Redis) → **PASS**:
`TestAllContractPathsReturnDefinedShape` PASS, `TestAuthStateSurvivesRestart` PASS, `ok`.

## 8. Test inventory

- Test functions: **1163** (`grep -rc "func Test" --include="*_test.go" internal tools cmd`).
- Files carrying the `integration` build tag: **94** (the "25 suites" label in `backend/TESTING.md`
  is a documented TODO to reconcile with the per-file count — inventory is larger than the label).
- Integration suites cover: auth restart-survival, contract shape, webhooks, outbox, prefs, push,
  SMTP, gateway failover, payouts, sweepers (dispatch/expansion/settlements), WS live push.

## 9. Discipline checklist — all LIVE

| Discipline | Status | Evidence (one line) |
| --- | --- | --- |
| Idempotency | **LIVE** | Redis idempotency keys (`internal/store/idempotency_redis.go`), guarded `UPDATE ... WHERE status = <expected>` transitions (409 on 0 rows), customer/rider sync high-water marks. |
| Money | **LIVE** | Integer TZS only (`bigint` storage, `AmountTZS int64` in `internal/payments/payments.go:31`), immutable append-only payout ledger with advisory-lock serialized balances, escrow + refunds, HMAC-signed webhooks. |
| RBAC | **LIVE** | Role-based route policy enforced in `RequireAuth` (`internal/api/auth.go:144`, `enforcePolicy`), MFA-verified staff gate on `/admin/*`, `ADMIN_ALLOWED_IPS` fails closed. |
| PII | **LIVE** | OTPs Redis-hashed (constant-time verify, 5-attempt lockout), refresh tokens stored SHA-256 (`internal/auth/repo.go:97`), PII unmasked only on the documented public surface. |
| Audit | **LIVE** | `audit_logs` written on every guarded mutation (`internal/audit/audit.go:55` INSERT), audit middleware on the API tree, audit query surface. |
| Outbox | **LIVE** | `notifications_outbox` with `FOR UPDATE SKIP LOCKED` claims (`internal/notifications/package.go:3`), encrypted payloads, backoff + dead-letter. |
| Sweepers | **LIVE** | `internal/sweeper` 30 s cadence, idempotent jobs: auto-cancel, voucher expiry, pre-order reminders, closure-protection, dispatch auto-assignment, settlements, export queue, promotion ticks, scheduled store reopen (`ReopenScheduledStores`). |
| Observability | **LIVE** | Prometheus `/metrics` + `internal/metrics` (dashboards drift-pinned by tests), OTel spans over HTTP/PG/Redis/provider, `/healthz` + `/readyz` (PostgreSQL + Redis). |
| Ops | **LIVE** | `scripts/`: backup, restore, verify-release, dashboard-smoke, staging-drill, selfcheck-24h; graceful shutdown; signed drill records in `backups/`. |

## 10. Known limitations (documented)

1. **`/events` without deps**: the single 501 state is `GET /events?after=0` when neither Redis
   nor PostgreSQL is configured — a dependency state, not a missing feature (explicit and counted,
   never a blank route). With PostgreSQL present the `event_log` fallback serves it
   (`internal/api/events_pg.go`).
2. **Vendor credentials pending**: live vendor delivery is env-gated — webhooks 503 while
   `PAYMENT_WEBHOOK_SECRET` is unset; Expo push falls back to the in-app mirror stub without
   `EXPO_PUSH_ACCESS_TOKEN`; masked numbers use a deterministic placeholder without
   `MASKED_CALL_GATEWAY_URL` (fail-open by design). Mock provider sandbox (`tools/mock-gateway`)
   covers local E2E until credentials land.
3. **Standing staging pending**: only the two recorded drill runs (2026-08-14/15, local stand-in)
   exist; `DEPLOYMENT.md` notes a standing staging environment is not yet provisioned, and the
   staging-bootstrap script skips `tools/seed` with a warning while that tool is pending.
4. **WS topic auth scope**: `/ws` authenticates at connection level (bearer/`?token=`, expiry
   enforced); `SubscribeTopic` registers any topic string (`internal/ws/hub.go:223`) — no per-topic
   ownership/role validation.
5. **Documented extensions**: the surface intentionally exceeds the contract — customer offline
   sync `POST /sync/batch`, `/docs` + `/docs/openapi.yaml` (spec served as JSON bytes with
   `application/yaml`), `/internal/simulate/*` (staging/dev only, `SIMULATOR_KEY` gate), scheduled
   store reopen marker inside `store_settings.opening_hours` (sweeper-side convention).
6. **Minor docs drift**: `backend/TESTING.md` "25 integration suites" label vs the 94
   integration-tagged files; loadsmoke p99 numbers last recorded locally (97 ms, 0% errors at
   ~465 req/s) — re-run pending.

## 11. Audit outcome

**READ + VERIFY: PASS.** No build-breaking issue in the final state; no code was modified. The
only failures observed were transient mid-write states of the concurrent final wave, all green on
re-run after quiescence.
