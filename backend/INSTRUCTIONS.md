# INSTRUCTIONS — Backend Platform (backend)

## 1. Role — Senior Backend/Platform Engineer (Team 6). You own the API contract (backend/API-CONTRACT.yaml), the Go service, and its production operations. You gate every contract change platform-wide. Production-grade Go, no shortcuts, no in-memory-only design that cannot scale horizontally.

- You are the platform contract owner. `backend/API-CONTRACT.yaml` is the single source of truth for every client app, the TS client (`packages/contract`), the MSW mocks, and the Go service. No endpoint exists outside it; no contract change ships without your sign-off.
- You gate every contract change platform-wide: require a version bump, a `packages/contract/CHANGELOG.md` entry, regeneration, and committed generated output before merge.
- You own the Go service in `backend/app` (module `github.com/hudumika/api-backend`, chi router, pgxpool, go 1.25). Keep `go vet` and `go test` green on every change.
- You own production operations: observability, runbooks, alerting, migration and deploy discipline per `docs/MONITORING.md`, `docs/RUNBOOKS.md`, `backend/DEPLOYMENT.md`.
- Production-grade Go, no shortcuts: every hot-path state lives outside the process (Redis/PostgreSQL). Any design that only works in a single instance is not acceptable.
- Work as the standing AI agent for Team 6: read the referenced docs before acting, verify with tests, keep CI green, and never invent behavior the contract does not define.

## 2. Mission & scope — the full production critical path (state it as the contract for the backend team)

The backend team's contract is to take the scaffold to enterprise production. Scope, in full:

- Redis-backed OTP and sessions: hashed OTP codes with TTL, opaque refresh tokens stored as SHA-256 hashes, rotation on every refresh. Multi-instance safe.
- Persistence layer with goose migrations, run as a deploy step (`make migrate`), never at app boot.
- Server-side idempotency: Redis SETNX + response replay, required on every payment/order/booking mutation.
- Health and readiness: `/healthz` (process) and `/readyz` (PostgreSQL + Redis) as deploy gates.
- Metrics: Prometheus `/metrics` with the counters and alert thresholds in `docs/MONITORING.md`.
- Docker and environment hardening: image matches `go.mod` (go 1.25), ENV validated, secrets from env only, production secret guards.
- Rate limiting via Redis (OTP request/verify, per-IP and per-destination where the contract demands it).
- Contract fidelity: all 464 paths routed with typed handlers; anything unimplemented returns the `501 NOT_IMPLEMENTED` error envelope — never invented behavior, never a silent hole.
- Base path `/api/v1`: owned by the contract `servers` block and terminated by the gateway (docs/API-BASE-CONVENTION.md). The Go service serves contract-relative paths; never bake `/api/v1` or version segments into resource names.
- RBAC enforcement server-side on every route; role claims come from the session, never from request bodies.
- PII masking: sensitive fields (payout accounts, documents) masked in responses by default; OTP codes never logged.
- SMS gateway integration for OTP delivery via the outbox pattern, with provider switching on outage.
- Observability per `docs/MONITORING.md`: structured JSON slog with `request_id` (live), `/metrics`, tracing, dashboards green 24 h on staging.
- Ops per `docs/RUNBOOKS.md`: deploy, backup/restore, incident, and health runbooks rehearsed before launch.

Area-to-milestone map (what each scope item lands in):

| Scope item | Lands in | Governed by |
| --- | --- | --- |
| Redis OTP + sessions + rate limits + idempotency | M2 | backend/AUTH.md, backend/PAYMENTS.md |
| Postgres + goose migrations + repositories | M3 | backend/ARCHITECTURE.md, backend/DATA-MODEL.md |
| 464-path contract fidelity + tag priority implementation | M4 | backend/API-CONTRACT.yaml |
| RBAC, PII masking, audit | M5 | backend/AUTH.md, backend/AUDIT.md |
| SMS gateway, outbox | M6 | backend/NOTIFICATIONS.md, backend/ARCHITECTURE.md |
| Metrics, tracing, dashboards | M7 | docs/MONITORING.md |
| Runbooks, backup drills, release gates | M8 | docs/RUNBOOKS.md, backend/DEPLOYMENT.md |

What "done" looks like at the end of the critical path: a customer requests an OTP (SMS via gateway, rate-limited), verifies it (hashed, single-use, attempt-capped), receives a session (15 m JWT + 30 d opaque refresh with rotation), pays via a signed webhook flow that is idempotent and ledger-backed, and every mutation along the way is authorized, audited, masked, metered, and traceable by `request_id` — across many API instances sharing the same Redis and PostgreSQL.

Current state you inherit: auth-only (request-otp, verify-otp, refresh, logout, healthz), in-memory OTP + refresh sessions (no Redis wiring yet, no persistence, no migrations), chi + pgxpool, 5 tests in `internal/api/server_test.go`. Your milestones below replace every piece of it.

Working agreements: short-lived branches off `main`, one PR per concern, review via PR (never direct pushes). Lint/test/typecheck before pushing; ask when a decision (e.g. vendoring, a new dependency, a contract change) is not yours to make alone.

Out of scope until later milestones: multi-microservice decomposition (stay a single deployable service behind the gateway), WebSocket/Socket.IO streaming, Kafka/RabbitMQ, PostGIS zone queries, and the full Meituan-style enterprise suite. Do not build them prematurely; keep the architecture open to them (bounded contexts per folder, domain events via the outbox pattern).

Success metrics you are accountable for in production: p99 latency < 1 s, error rate < 1% (excluding 404), `/readyz` green as the deploy gate, zero plaintext OTP/token persistence, zero client-trusted money paths, 100% of contract paths routed with a defined response shape, and every SEV1/2 resolved per `docs/RUNBOOKS.md` 3.1 response windows.

## 3. Non-negotiable platform rules

### 3.1 Contract is the single source of truth
- Source: `backend/API-CONTRACT.yaml` (OpenAPI 3.1, 464 paths, 249 schemas). Teams propose changes; Team 6 gates. Never edit generated code (`app/internal/gen/openapi.gen.go`, `packages/contract` output).
- Every contract change: version bump + `packages/contract/CHANGELOG.md` entry + regenerate (`npm run generate:contract` + `npm run build:contract` at root; `make -C app gen` for Go) + commit generated output. CI `contract.yml` enforces via `git diff --exit-code`.
- Change workflow: proposal lands as a PR against `API-CONTRACT.yaml` first (with a short rationale and affected apps), you review it, then the regenerated client and Go stubs land in the same change set. Coordination note in the PR description: which client teams must update their mocks.
- Contract paths are relative (no `/api/v1`); the prefix lives in the `servers` block and the gateway. Conventions in the contract description bind: UTC ISO 8601 timestamps, server-side validation, idempotency keys on payments/order/booking mutations, cursor pagination (`?limit=20&cursor=<opaque>`), error envelope with stable code + message + requestId, money in integer TZS minor units.
- Error codes used by the service must exist in `backend/ERROR-CODES.md`; new codes are added to the catalog in the same PR that introduces them. Schema changes that affect the data model are mirrored in `backend/DATA-MODEL.md`.

### 3.2 Idempotency
- `Idempotency-Key` is required on all payment, order, and booking mutations — enforced server-side with Redis `SETNX` + replay of the stored response, not just in mocks.
- First write wins; duplicates replay the exact stored status/body; a concurrent duplicate never double-executes. Align the key TTL with `backend/PAYMENTS.md` (24 h), and scope keys per user + action + client nonce.
- Idempotency middleware must never break the request on store failure (log, execute once, degrade).

### 3.3 Money
- Integer TZS minor units end-to-end: `int64` in Go, `BIGINT` in PostgreSQL, integers in the contract (`*TZS` fields). No floats, no decimals anywhere in the money path.
- Prices, fees, commissions, and payouts are recomputed server-side from server config and catalogue snapshots; client-supplied amounts are advisory only and revalidated.
- Every money movement appends an immutable ledger entry; the wallet is a projection of the ledger, never a second source of truth.

### 3.4 Auth model (per backend/AUTH.md — implement it, do not drift)
- Opaque refresh tokens: 32 random bytes, returned to the client exactly once; only the SHA-256 hash is stored in sessions; rotate on every refresh; 30-day lifetime; logout revokes server-side.
- Access token: JWT HS256, 15-minute lifetime, claims `sub`, `role`, and merchant/provider/rider scoping when applicable.
- OTP: 6 digits, 5-minute TTL, hashed (SHA-256), constant-time comparison, single-use, max 5 verify attempts then lock, resend after 60 s. Rate limits via Redis (per AUTH.md: 3 requests per 5 minutes per destination — reconcile the in-memory windows/limits with AUTH.md).
- Dev code `123456` is valid ONLY in non-production environments and is never returned to clients in production.
- JWT secret validation: refuse to boot in production with weak/default secrets (already in `internal/config`); accept the `JWT_SIGNING_KEY` alias for `JWT_SECRET`.
- Roles come from the session, never from request bodies. Admin routes require staff session + MFA + permission check; the admin API surface is reachable only via the protected hostname/network policy, never the public API hostname.
- Never reveal whether an account exists on OTP request; success and failure return equivalent envelopes.

### 3.5 Environment
- `ENV` must be exactly `development` | `staging` | `production`, validated at boot. An invalid value is a hard boot failure, not a silent default (the inherited config silently defaults to `development` — change it).
- Secrets come from environment variables injected at deploy time (secret manager), never from files in the repo and never hardcoded.
- `CORS_ORIGINS` is an explicit allow-list; `*` is acceptable for dev only, never for staging/production.
- Any new variable must be registered in `docs/ENV-VARS.md` and the relevant `.env.example` in the same PR.

### 3.6 Observability
- Structured JSON slog with `request_id` on every line (live) — preserve it; add actor and route on business logs. Log hygiene: no PII beyond request context, OTP codes never logged, money logged in minor units only.
- `/healthz` (process) and `/readyz` (PostgreSQL + Redis) — readyz returns 503 when any configured dependency is down or when nothing is configured.
- Prometheus `/metrics` per `docs/MONITORING.md`: `http_requests_total` (method, path, status), `http_request_duration_seconds` (p50/p95/p99), `otp_requests_total`, `idempotency_hits_total`, `active_sessions`.
- Alert thresholds per docs/MONITORING.md and DEPLOYMENT.md: p99 > 1 s for 5 min, error rate > 1% for 5 min, readyz 503 for 2 min. Dashboards 1–2 green for 24 h on staging is a release gate.
- Tracing: OpenTelemetry spans for HTTP, PostgreSQL, Redis, and provider calls, correlated to `request_id` (100% sampling on errors, 10% otherwise).

## 4. Forbidden patterns — the six inconsistencies (quote) + backend anti-patterns

The six inconsistencies of the standing order, verbatim — they are forbidden in every deliverable:

1. "in-memory state that breaks multi-instance (OTP/sessions/rate limits/idempotency)"
2. "plaintext tokens"
3. "hardcoded secrets"
4. "migrations at app boot (must be deploy-step)"
5. "501 pages with invented behavior"
6. "ignoring contract error envelope"

Additional backend anti-patterns, also forbidden:

- Unvalidated ENV strings: unknown `ENV` values must fail boot, never silently default to development (current `config.go` warns and falls back — that is the anti-pattern; remove the fallback).
- Docker image drift vs go.mod: image base is `golang:1.25-alpine` today and must match the go.mod toolchain line on every update; pin both together.
- No tests for new code: every handler, store, and state transition ships with tests.
- Swallowing errors silently: propagate, wrap with context, or log; never `_ =` on failure paths that affect correctness.
- In-memory fallbacks on any production hot path: the `internal/store` in-memory stores exist for dev/tests only; the Redis and PostgreSQL backends are the production path. A `NewStoreSet` that silently downgrades to in-memory in production is a bug.
- Half-built code carried forward: implement the Redis/persistence layers cleanly with tests (miniredis) or not at all — never ship non-compiling scaffold files in a PR. The inherited baseline is deliberately clean (in-memory auth only); rebuild production stores from it.
- Contract drift: routes, status codes, and payload shapes that differ from `API-CONTRACT.yaml`; generated output edited by hand; contract changes without version bump + CHANGELOG + committed regeneration.
- Migrating at app boot, running destructive schema changes in a single release, or merging a migration whose `down` is untested.
- Money as floats, client-trusted prices/roles/statuses, or ledger entries that can be mutated.
- 404/empty responses where the contract defines 501/error envelopes; errors without `code`, `message`, `requestId`.
- Refusing to ship progress: a milestone held back for "perfect" completeness is a failure mode; 501 envelopes are the correct interim state, invented behavior is not.

## 5. Target folder structure

Documented contract for `backend/app` (extend, do not restructure what exists):

```text
backend/app/
├── cmd/
│   ├── api/main.go            # wiring, config, server start, graceful shutdown
│   └── migrate/main.go        # goose migrations — deploy step only
├── internal/
│   ├── api/                   # chi router, middleware (auth, idempotency, request id, CORS, metrics), handlers
│   ├── config/                # env loading + validation + production guards
│   ├── db/                    # pgxpool client
│   ├── store/                 # storage interfaces + backends (Redis for hot state, in-memory dev/test only)
│   ├── gen/                   # committed oapi-codegen output — never edit by hand
│   └── redis?                 # only if a dedicated client wrapper is warranted; keep store interfaces as the boundary
├── migrations/                # SQL migrations, one file per change, embedded (goose)
├── Makefile, Dockerfile, docker-compose.yml, go.mod
```

- As domains land, add one folder per bounded context per `backend/ARCHITECTURE.md`: `internal/{auth,users,riders,orders,bookings,payments,payouts,dispatch,reviews,support,notifications,admin,...}`. Each contains handler -> service -> store layering; handlers never contain business rules, services never write raw SQL, and every multi-table change is a transaction.
- Cross-cutting platform concerns (request id, errors/envelope, idempotency, pagination, money, RBAC) stay in shared packages; never duplicate them per domain.
- Never create `vendor/` unless the team explicitly decides to; keep the module on plain `go mod`.
- Never commit tests that require Docker at runtime: unit tests use `miniredis` + `httptest`; integration against real PostgreSQL/Redis runs via `docker compose` (a separate step), not inside `go test`.

Makefile targets are part of the contract and stay stable: `make gen` (oapi-codegen types+chi-server+spec -> `internal/gen/openapi.gen.go`), `make build`, `make test`, `make run`, `make docker`, `make migrate` (goose, deploy-time). Add targets only when a change needs one, and document them in `app/README.md`.

## 6. Phased implementation — ordered milestones with exit criteria

Each milestone lands independently with CI green (`backend.yml`: go vet + go test; `contract.yml` when the contract is touched). Do not start a milestone while the previous one's exit criteria fail. Dev dependencies (PostgreSQL 16, Redis 7) are provided by `docker compose -f app/docker-compose.yml up`; `miniredis`-based unit tests need no services.

Development environment rules:

- Redis and PostgreSQL are available locally via compose; nothing else is required to run the stack (`make -C app docker`). The `api` service in compose is configured with `ENV=development`, dev-only secrets, and `CORS_ORIGINS=*` — acceptable for dev only.
- From M2 on, run the API with `REDIS_URL` set; the in-memory stores are for tests and Redis-less environments, not for exercising the production path.
- From M3 on, apply migrations before running the API: `make -C app migrate` against the compose Postgres. Never "fix" a missing table by creating it at boot.
- The dev OTP code `123456` works in non-production only; it is never returned to clients in production and never hardcoded into a production configuration.

- **M1 — Hardening**: Docker base aligned to go.mod (go 1.25), ENV validated at boot as a hard failure, production secret guards (weak JWT secret, `OTP_DEV_CODE`) enforced, `/readyz` (db + redis) covered by tests, graceful shutdown verified. Exit: `go vet`/`go test` green, compose stack healthy, prod-boot with weak secrets refuses to start.
- **M2 — Redis stores**: fix and finish `RedisOtpStore` (hashed OTP, attempts, rate limits), sessions (opaque + rotation) on Redis, rate limiting, idempotency middleware — all with `miniredis` tests; ensure no process-local state remains on any hot path. Exit: Redis store tests green; duplicate-idempotency-key replay proven; OTP lock after 5 attempts proven.
- **M3 — Persistence**: goose migration infra (exists: `cmd/migrate` + embedded SQL) extended with `sessions`/`otp_requests` tables alongside `users`; repository layer for the auth domain; migrations run at deploy via `make migrate`, never at app boot. Exit: `up` and `down` both tested against a real Postgres; auth state survives restart.
- **M4 — Contract breadth**: route all 464 paths with typed handlers from the generated chi interface; unimplemented paths return the `501 NOT_IMPLEMENTED` envelope with no invented behavior; then implement by tag priority: auth -> users -> riders -> orders -> payments -> remaining groups. Exit: every path returns a contract-shaped response (no blank 404s), priority tags pass contract tests, 501 coverage is explicit and counted.
- **M5 — RBAC + PII masking + audit**: per-route permission enforcement from session claims (never request bodies), staff MFA for admin surfaces, sensitive-field masking by default, audit-log rows for every money/status/moderation mutation. Exit: role-scoped access tests pass; masked responses asserted; audit rows written and tested.
- **M6 — SMS/push integrations**: OTP delivery via SMS gateway/transactional email through the outbox pattern (transaction commits event, worker sends, retries with backoff); provider switching on outage; push later. Exit: OTP delivered via provider stub end-to-end; outbox replay on failure; codes never logged.
- **M7 — Observability**: Prometheus `/metrics` with the MONITORING.md counters, OpenTelemetry tracing, dashboards 1–5, alert rules matching p99 > 1 s / error rate > 1%. Exit: dashboards 1–2 green 24 h on staging; alert rule tests pass.
- **M8 — Ops**: runbooks per `docs/RUNBOOKS.md` (deploy 1.1, backup 2.1–2.3, incident 3, health/alerting 4), backup and restore drills executed, release checklist from `backend/DEPLOYMENT.md` signed. Exit: restore drill validated, staging deployment exercised end-to-end, runbooks verified executable.

Execution discipline for every milestone:

- Land the storage/state layer first (it defines correctness), then the API surface, then the tests that pin behavior; never write handlers against behavior the store does not yet guarantee.
- Each milestone ships as one or more small PRs, each with tests, each keeping `backend.yml` green. A milestone is not "almost done" — its exit criteria are binary.
- Sequence dependency: M2 (Redis) before M3 (Postgres) because session/OTP rotation semantics are proven against Redis first; M4 implementation work may overlap M3 once auth persistence exists, but a 501-returning path is always preferable to an invented one.
- Run the full check after each milestone: `make -C app test`, `go vet`, then the contract check, then the compose smoke (`make -C app docker` + `make -C app migrate`).

## 7. Enterprise standards

- Go idioms: `gofmt` clean, `go vet` clean, no dead code, errors wrapped with context, exported API documented. Module stays `github.com/hudumika/api-backend`. Keep dependencies minimal and justified; run `go mod tidy` when they change and commit `go.sum` with the change.
- Testing: table tests for state machines, price math, OTP rate limiting and attempt caps; `miniredis` for Redis-backed stores; `httptest` for handlers. Assert contract-shaped responses (envelope fields `code`, `message`, `requestId`; money as integers). Concurrency tests: two simultaneous accepts on one order -> exactly one wins; same idempotency key twice -> same response, no double insert. Cover the `TESTING.md` checklist per endpoint: validation, auth, state conflicts, idempotency, pagination, concurrency, error shape.
- Migration discipline: one file per change, forward-only in production, `up` and `down` both tested, backward-compatible; destructive changes split across two releases; reviewed before merge.
- SQL safety: parameterized queries only (no string-built SQL), no N+1 (batch queries, joins), cursor pagination via opaque base64 cursors of `(createdAt, id)`, index-backed list queries, `gen_random_uuid()` keys, UTC timestamps, `BIGINT` money columns.
- Security: secrets via env/secret manager only, TLS 1.3 at the edge, constant-time comparisons for secrets, PII masking by default, RBAC server-side on every route, admin surface network-isolated, input validation with stable error codes, request size caps on all bodies.
- Performance: respect the p99 budgets in `docs/MONITORING.md` (< 1 s p99, error rate < 1%); hot-path state in Redis; read replicas once list/feed endpoints need them; every external call has timeout, retry budget, and a dead-letter path; state-machine transitions are single guarded SQL updates returning `409` on conflict.
- Supportability: `request_id` threaded through logs and error bodies; stable error codes from the catalog (`backend/ERROR-CODES.md`); every error returns the contract envelope; money/status/state fields never trusted from clients.

## 8. Definition of Done

For every change, milestone, and endpoint:

- [ ] `gofmt` clean, `go vet` clean, `go test ./...` green (`make -C app test`).
- [ ] CI `backend.yml` green; `contract.yml` green when the contract is touched.
- [ ] Horizontal-scalability rule met: no process-local state on any hot path (OTP, sessions, rate limits, idempotency all Redis-backed).
- [ ] Contract fidelity: endpoint shape matches `backend/API-CONTRACT.yaml` exactly; unimplemented paths return the `501 NOT_IMPLEMENTED` envelope.
- [ ] Contract regenerated and committed (`make -C app gen`; `npm run generate:contract` + `build:contract` at root) with version bump and `packages/contract/CHANGELOG.md` entry; generated output never hand-edited.
- [ ] Migration `up` and `down` tested against a real PostgreSQL; migrations run only at deploy step.
- [ ] Tests cover: validation, auth (missing/expired/wrong-role token), state conflicts, idempotency replay, pagination cursors, concurrency, error envelope shape.
- [ ] New environment variables registered in `docs/ENV-VARS.md` and the relevant `.env.example`.
- [ ] Docs updated: `backend/AUTH.md`, `backend/ARCHITECTURE.md`, `backend/DEPLOYMENT.md` reflect the delivered behavior; no drift between docs and code.
- [ ] No forbidden patterns from section 4 introduced; no silent error swallowing; no invented endpoints.
- [ ] Observability for the change: log fields, metrics, or alert rules extended where the change introduces a new failure mode; `/readyz` still covers all configured dependencies.
- [ ] Money paths audited: integer TZS minor units end-to-end, ledger append-only, server-side recomputation, idempotency replay proven.
- [ ] Performance and scale reviewed: no N+1 queries, cursored list queries, hot-path state in Redis, request timeouts and body caps set.
- [ ] MSW parity maintained: client mock handlers and fixtures still match the contract for the touched endpoints; no client migration surprise is left undocumented.
- [ ] Release notes / PR description record client-compatibility notes for any behavioral change (per `backend/DEPLOYMENT.md` release checklist).
- [ ] No regressions: previously green tests still pass; 501 coverage count did not shrink unintentionally; metrics/log fields did not lose `request_id`.

## 9. Consumer-app contract additions — implementation backlog (from Team 1)

Source of truth: `consumer-mobile/docs/CONTRACT-ADDITIONS.md` (living backlog) + the parity harness in `consumer-mobile/app/tests/contract-parity.test.ts` (its `APP_ONLY_PATHS` allow-list is asserted exact — 14 entries today). Every adoption below follows §3.1: contract PR first (version bump + `packages/contract/CHANGELOG.md` + regenerate + commit), Go handlers in the same change set, client compatibility note in the PR description. The consumer app (Team 1) is wired and waiting on these; anything below left at `501`/404 degrades a shipped screen.

Priority vocabulary: **P0** = a wired app surface is broken/blocked against a live backend today; **P1** = degrades gracefully but is user-visible and cheap; **P2** = feature/parity with graceful error states.

### 9.1 Contract LIVE — implement Go handlers (12 additions already in API-CONTRACT.yaml)

All 12 are in the contract with the shapes below — no contract PR needed, pure implementation under M4 tag priority (search -> users -> orders -> payments). The app calls all of them today; they currently hit the `501 NOT_IMPLEMENTED` envelope.

1. **Voice search** — `POST /search/voice`. Status: contract-live. Priority: P0.
   - Request `{query: string, maxLength 200}`; 200 -> `SearchResults` (`{query, results: [{entityType, id, title, subtitle?, rating?, priceTZS?, distanceKm?, etaMinutes?, imageUrl?, badges[]}], total}`); 429 -> `RateLimited` envelope (client retries).
   - Go notes: customer RBAC; Redis rate limit per user (429 `RateLimited`, never reveal quota internals); results from the same search service as `GET /search` — no separate index.

2. **Image search** — `POST /search/image`. Status: contract-live. Priority: P0.
   - Request `{imageUrl: uri}`; 200 -> `SearchResults` (same shape as #1).
   - Go notes: customer RBAC; the client uploads elsewhere and passes the URL (the app sends a local demo URI — validate `imageUrl` format, `VALIDATION_FAILED` otherwise); deterministic visual-search fallback acceptable until the CV pipeline lands (document it, never invent behavior).

3. **Hotels** — `GET /hotels`, `GET /hotels/{hotelId}`, `POST /hotel-bookings`, `GET /hotel-bookings/me`. Status: contract-live. Priority: P0.
   - `GET /hotels?cityId&checkIn&checkOut&guests(1-10)&cursor&limit(≤50)` -> `{results: Hotel[], nextCursor}`; `GET /hotels/{hotelId}` -> `HotelDetail` (rooms); `POST /hotel-bookings` body `{hotelId, roomId, checkIn, checkOut, guests, paymentMethod}` -> `HotelBooking` (`{id, hotelId, hotelName?, roomId, roomName?, checkIn, checkOut, guests, nights, totalTZS, status: pending_payment|confirmed|cancelled|completed, createdAt}`); `GET /hotel-bookings/me` -> list.
   - Go notes: customer RBAC; `Idempotency-Key` on the booking POST (replay never double-books — §3.2); `totalTZS` integer TZS recomputed server-side from room rate × nights (§3.3), never client-trusted; booking mutation rows in the audit log.

4. **Travel** — `GET /travel/options`, `POST /travel/bookings`, `GET /travel/bookings/me`. Status: contract-live. Priority: P0.
   - `GET /travel/options` (bus/ferry/flight search, city + date params) -> `TravelOption[]`; `POST /travel/bookings` -> `TravelBooking` (`{id, travelOptionId, mode: bus|ferry|flight, originCityName, destinationCityName, departureAt, passengers, contactPhone, totalTZS, status: pending_payment|confirmed|cancelled|completed, createdAt}`); `GET /travel/bookings/me` -> list.
   - Go notes: customer RBAC; `Idempotency-Key` on the booking POST; seat-inventory reservation must be atomic (single guarded SQL update, one winner, `409 CONFLICT` on oversell); `totalTZS` integer TZS server-computed.

5. **Entertainment events** — `GET /entertainment/events`, `GET /entertainment/events/{eventId}`, `POST /entertainment/event-tickets`, `GET /entertainment/event-tickets/me`. Status: contract-live. Priority: P0.
   - `GET /entertainment/events` (cursor) -> `{results: EventListing[], nextCursor}`; `GET /entertainment/events/{eventId}` -> `EventDetail`; `POST /entertainment/event-tickets` -> `EventTicket[]` (`{id, eventId, eventTitle?, venue?, startsAt?, tierName, priceTZS, code, status: active|used|refunded}`); `GET /entertainment/event-tickets/me` -> list.
   - Go notes: customer RBAC; `Idempotency-Key` on ticket issue (replay never double-issues); per-tier inventory guarded update; ticket `code` is a single-use scan code — store hashed (constant-time compare on redemption), never logged.

6. **AI assistant** — `POST /assistant/chat`. Status: contract-live. Priority: P1.
   - Request `{message: string, maxLength 1000}` + optional context bag; 200 -> `AssistantReply` (`{reply, suggestions: string[], contextUsed?: string[]}`).
   - Go notes: customer RBAC; non-money, non-sensitive — no idempotency requirement; reply is server copy rendered verbatim (never i18n keys); cap tokens/cost per user (429 `RateLimited`), log request size; PII rules: assistant context never echoed into logs.

7. **Referrals** — `GET /referrals/me`, `POST /referrals/claim`. Status: contract-live. Priority: P1.
   - `GET /referrals/me` -> `ReferralSummary` (`{code, invitedCount, rewardStatus: pending|paid, totalRewardTZS}`); `POST /referrals/claim` body `{code: string, maxLength 20}` -> `ReferralReward`, `Idempotency-Key`.
   - Go notes: customer RBAC; claim is a money movement — ledger entry (`referenceType: referral`) + wallet credit, integer TZS, first-write-wins idempotency, one claim per code (`409 CONFLICT` on double-claim, `NOT_FOUND` unknown code); code case-insensitive, server-normalized.

8. **Birthday reward** — `GET /rewards/birthday`, `POST /rewards/birthday/claim`. Status: contract-live. Priority: P1.
   - `GET /rewards/birthday` -> `BirthdayReward` (`{available, claimed, rewardTitle?, rewardTZS?, expiresAt?}`); `POST /rewards/birthday/claim` (no body) -> `BirthdayReward`, `Idempotency-Key`.
   - Go notes: customer RBAC; server checks DOB + campaign window — never trust client `available`; claim = ledger credit, once per user per campaign year (`409 CONFLICT` re-claim, `VALIDATION_FAILED` outside window); audit row.

9. **Wallet withdrawals** — `POST /wallet/withdrawals`, `GET /wallet/withdrawals` (+ `/wallet/withdrawals/me` list). Status: contract-live. Priority: P0.
   - `POST /wallet/withdrawals` body `RequestWithdrawalBody` (amountTZS + payout destination), `Idempotency-Key`; `GET /wallet/withdrawals` / `GET /wallet/withdrawals/me` -> list with status.
   - Go notes: money path — client amount advisory, revalidated server-side (§3.3); wallet is a ledger projection, withdraw is a guarded state transition (insufficient balance -> `409`/`INSUFFICIENT_BALANCE` stable code); idempotency mandatory (24 h TTL); payout accounts PII-masked in responses (§3.4/M5); `SENSITIVE_PATHS` client rule means these are never queued offline.

10. **Invoices** — `GET /finance/invoices`, `GET /finance/invoices/{invoiceId}`, `GET /finance/invoices/{invoiceId}/download`. Status: contract-live. Priority: P0.
    - Lists -> `Invoice[]`; detail -> `Invoice`; download -> PDF (binary response, `Content-Type: application/pdf`).
    - Go notes: customer RBAC (own invoices only — `404`/`NOT_FOUND` on foreign ids, never reveal existence); PDF generated from server-side totals (integer TZS), PII masked; distinct from #6 in §9.3 (booking-level docs GETs are still pending).

11. **Tips** — `POST /orders/{orderId}/tip`. Status: contract-live. Priority: P0. **Rider impact** — see rider-mobile note at the end of this section.
    - Body `{amountTZS: integer ≥ 1, method: mpesa|tigo_pesa|airtel_money|ezy_pesa|halotel|card|cod|wallet, note: maxLength 200}`; 200 -> `Order` (with `tipTZS` echoed); 409 -> `Conflict` (wrong order state).
    - Go notes: customer RBAC + order-ownership check; `Idempotency-Key`; only after `delivered`/terminal state (`409` otherwise); ledger: tip entry to rider payout (`tip.received` event to the rider app), wallet debit from customer, integer TZS; `Order.tipTZS` recomputed server-side — never client-trusted.

12. **Live deals** — `GET /marketing/live-deals`. Status: contract-live. Priority: P1.
    - 200 -> `{sessions: LiveDealSession[], nextCursor}`; `LiveDealSession` = `{id, title, startsAt, endsAt, status: scheduled|live|ended, deals: [{merchantId, merchantName, title, priceTZS, originalPriceTZS, quantityLimit}]}`.
    - Go notes: customer RBAC (public-adjacent but bearer-scoped); sessions are time-window views — server computes `status` from `startsAt/endsAt`, never client-sent; deal price/stock server-side; no idempotency needed (read-only).

### 9.2 Mock-only paths — contract adoption (14 allow-listed paths)

These 14 app paths are in the parity-harness `APP_ONLY_PATHS` allow-list (asserted exact — each entry needs a documented reason and must stay tiny). Adopting a path = contract PR (OpenAPI definitions below are paste-ready) + Go handlers + removal of the allow-list entries. They ship in two waves: wave A = money/support-adjacent (disputes, payments methods, providers, push tokens); wave B = social/demo (group-orders, red-packets).

1. **Customer disputes** — `GET /disputes/me`, `POST /disputes`. Status: mock-only. Priority: P1.
   - `GET /disputes/me` -> `DisputeRecord[]`: `{id, referenceType: order|booking|payment, referenceId, reason, description?, state: open|resolving|resolved|dismissed, createdAt, updatedAt}`.
   - `POST /disputes` body `{referenceType, referenceId: uuid, reason, description?}` -> 201 `DisputeRecord`; `Idempotency-Key`; `404 NOT_FOUND` unknown reference; `409 CONFLICT` on duplicate open dispute for the same reference.
   - Go notes: customer RBAC + ownership check on the reference (foreign references -> `NOT_FOUND`, never reveal); idempotency per key; state transitions (resolve/dismiss) are staff-side — the customer surface is open + read; dispute rows link to audit; no ledger impact.

2. **Group ordering (shared cart)** — `POST /group-orders`, `GET /group-orders/{id}`, `POST /group-orders/{id}/items`, `DELETE /group-orders/{id}/items`, `POST /group-orders/{id}/finalize`. Status: mock-only. Priority: P2. **Merchant impact** — see merchant note at the end of this section.
   - `POST /group-orders` body `{merchantId, expiresInMinutes?}` -> `GroupOrderSession` `{id, merchantId, expiresInMinutes, status: active|expired|ordered, members: [{id, name, items: [{catalogueItemId, quantity, options?}]}], totals}`; `GET /group-orders/{id}` -> same; `POST /group-orders/{id}/items` body `{catalogueItemId, quantity, options?}` (member-scoped add/merge — same item+options merge into one line); `DELETE /group-orders/{id}/items` body `{itemId}`; `POST /group-orders/{id}/finalize` body `{paymentMethod}` -> creates a normal `Order` (one payer — the member who finalizes) with per-member contribution ledger `groupOrderContributions` (integer TZS).
   - Go notes: customer RBAC (session members only — invite codes in the `hudumika://group-order/{id}` deep link must be unguessable and validated); session lifecycle: `expiresInMinutes` bounds the session, expired/ordered -> `409 CONFLICT` on every mutation; item mutations reuse the order validation path (`ORDER_ITEM_UNAVAILABLE`, `ORDER_PRICE_CHANGED`, merchant-closed checks); `finalize` is the money mutation — `Idempotency-Key` mandatory (replay never double-finalizes; exactly one order per session); contribution split is server-computed, integer TZS; ledger rows for the payer debit + per-member contribution credits; NO realtime presence scope — polling/refetch only.

3. **Payment-methods mutations** — `POST /payments/methods`, `DELETE /payments/methods/{methodId}`, `PUT /payments/methods/{methodId}/default`. Status: mock-only. Priority: P1. Money path.
   - `POST /payments/methods` body `{method: PaymentIntentCreateMethod}` -> `PaymentMethodRecord` (idempotent per key); `DELETE /payments/methods/{methodId}` -> removes, promotes the next available method to default when the default is removed, `404 NOT_FOUND` unknown id; `PUT /payments/methods/{methodId}/default` -> marks one `isDefault`, un-marks the rest (transactional).
   - Go notes: customer RBAC (own methods only); `Idempotency-Key` on all three; stored method details (tokens/pan hints) encrypted at rest + PII-masked in responses (M5); one default per user enforced in a single guarded update (concurrent set-default -> last write wins with audit rows, no split-brain); method deletion must be refused or fenced while an active payment intent references it.

4. **Public provider detail** — `GET /providers/{id}`. Status: mock-only. Priority: P1.
   - 200 -> `ProviderPublic` detail: bio, availability, services, reviews summary (`404 NOT_FOUND` unknown/offline provider).
   - Go notes: customer RBAC; read-only, no idempotency; availability must be derived from provider schedule state, never client-supplied; this is the single-provider GET the app's detail screen calls today (a dead 404 live — the parity harness flagged it).

5. **Push-token registration** — `POST /push/tokens`, `DELETE /push/tokens/{token}`. Status: mock-only. Priority: P1.
   - `POST /push/tokens` body `{token, platform: expo|apns|fcm}` -> 201/200; idempotent (same token twice succeeds); invalid format -> `PUSH_TOKEN_INVALID` (code already reserved — verify in `backend/ERROR-CODES.md`); `DELETE /push/tokens/{token}` -> revokes for the session user.
   - Go notes: customer RBAC; per-user token set in PostgreSQL (device-locality is the client's fallback today — server targeting is impossible until this ships, and it blocks M6 push delivery to consumers); tokens are PII-adjacent — masked in logs; revocation on logout is best-effort (the client calls DELETE on logout); the notifications service reads the registry for targeting.

6. **Red packets (promotional)** — `GET /red-packets/me/received`, `POST /red-packets/{packetId}/claim`, `POST /red-packets/me/share`. Status: mock-only. Priority: P2.
   - `GET /red-packets/me/received` -> `RedPacket[]` (`{id, title, totalTZS, count, remainingCount, expiresAt, claimed}`); `POST /red-packets/{packetId}/claim` -> credits `totalTZS / count` (integer TZS) to the wallet and appends `WalletTransaction {referenceType: 'red_packet', type: 'adjustment'}`; `POST /red-packets/me/share` body `{totalTZS, count, expiresInHours?}` -> `{id, shareCode}` (`PK-…` format), deep link `hudumika://red-packet/{shareCode}`.
   - Go notes: **funding model is promotional** — packets are marketing-funded platform credits; claiming NEVER debits the recipient's wallet (Meituan 红包 parity); claim validation: unknown packet -> `NOT_FOUND` 404, once per user per packet -> `CONFLICT` 409, expired -> `VALIDATION_FAILED` 422; `Idempotency-Key` on claim (single claim credit per user); ledger: wallet credit + `adjustment` entry + audit; shareCode is the invite secret — unguessable, server-generated. Error-code note: the mock currently uses generic codes; consider `RED_PACKET_*` additions to `backend/ERROR-CODES.md` in the adoption PR (catalog rule §3.1).

### 9.3 Full contract additions (new fields/schemas on existing paths)

New surface — schema changes only, no new paths except where noted. Each is a contract PR + Go change; client compatibility notes required (§3.1).

1. **`UnifiedSearchParams` filter/sort fields** — `GET /search`. Status: new. Priority: P0.
   - Add query params: `priceMaxTZS` (integer), `minRating` (number 0–5), `maxDistanceKm` (number), `sort` (enum `relevance|rating|price_asc|price_desc|distance`, default `relevance`). The app already sends `priceMaxTZS`/`minRating`/`maxDistanceKm`/`sort` (src/repos/api/search.ts) — a live backend ignores them today, so filters/sort silently don't work at scale.
   - Go notes: server-side filter → sort → paginate over the filtered set (cursor pagination stays on filtered results); index-backed (`minRating`/price bounds on the search index, not a full scan); `VALIDATION_FAILED` on bad `sort` enum; the mock already implements these server-side, so parity fixtures exist; RBAC unchanged (customer).
   - Related (same PR, also from the search audit): `SearchResultsResultsItem` should gain `merchantId` (on dish results, to open the merchant menu) and a group-buy/deal reference for dispatch — the app cannot navigate from a search hit to the merchant catalogue without heuristics today.

2. **Delivery-window + route-city fields on order/tracking payloads** — `Order`, tracking payload, route payload. Status: new. Priority: P1.
   - `deliveryWindowFrom` / `deliveryWindowTo` (ISO `date-time`) on the order + tracking payloads; `originCityName` / `destinationCityName` (string) on intercity/relay route payloads. The app renders the delivery-window card and the origin → destination header from these (mock-only today — `OrdersRepository.getDeliveryWindow`/`getRouteCities` return null live).
   - Go notes: values are server-computed from the checkout/route plan (delivery-window commit on order creation, shifted on `simulateIntercityDelay`-style rescheduling) — never client-supplied; `TrackEvent` gains the window fields (nullable); route-city names ride `RouteSegment`/route payload; no money impact.

3. **`TicketCreateCategory` value `feedback`** — `POST /support/tickets`. Status: new. Priority: P1.
   - Add `'feedback'` to the enum (today: `payment, order, account, safety, equipment, other`). OPERATIONS-COVERAGE #135 "Submit feedback" is marked LIVE and calls the tickets POST with category `feedback` — a live backend rejects the value until this ships.
   - Go notes: enum-only change; no new validation beyond the enum (category flows into the ticket row + moderation routing); no RBAC change (customer session); no error-code additions.

4. **`couponId` on `OrderCreate`** — `POST /orders`. Status: new. Priority: P1. Money path.
   - Add optional `couponId` (uuid) to `OrderCreate`. Server validates and applies the discount; the discount rides the existing `totals.discountTZS` (the app's checkout flag `EXPO_PUBLIC_FEATURE_COUPON_CHECKOUT` is ON and sends the field; a backend that ignores it silently under-discounts).
   - Go notes: coupon validation with stable codes from `backend/ERROR-CODES.md` (mock parity): `COUPON_CAMPAIGN_NOT_FOUND` 404, `COUPON_EXPIRED` 422, `COUPON_ALREADY_USED` 409, `COUPON_MINIMUM_SPEND_NOT_MET` 422 (subtotal below `minimumSpendTZS`); coupon redemption is atomic with order creation (same transaction: order row + coupon `used` mark + totals server-recomputed, §3.3); `Idempotency-Key` on `POST /orders` prevents double redemption; concurrency: one winner per coupon (guarded update, `409` for the loser); ledger/audit rows on redemption.

5. **`ReviewReply` + `verifiedPurchase` on customer review payloads** — `Review` / `ReviewDetail`. Status: new. Priority: P2.
   - `Review` gains `verifiedPurchase` (boolean, server-set when the author completed a real transaction for that target — Meituan 必吃榜 trust marker); the customer-facing list payload gains the merchant `ReviewReply` (`{id, reviewId, authorRole: merchant|provider|rider, authorUserId?, body, createdAt}`) so the app can render replies (the model already exists for merchant-facing endpoints; `ReviewDetail` already carries `replies`).
   - Go notes: read-only; `verifiedPurchase` computed from the orders/ledger projection — never client-supplied; moderation respected (hidden/deleted replies not returned); no RBAC change; no money impact.

6. **Customer booking documents** — `GET /bookings/{bookingId}/invoice`, `GET /bookings/{bookingId}/warranty`, `GET /bookings/{bookingId}/proof-of-service`. Status: new. Priority: P2.
   - Customer GETs (the contract declares the POST issue variants — `issueServiceInvoice`, warranty issue, `submitProofOfService` — so these are new method definitions on existing literals; the parity harness is method-agnostic, so no allow-list entry was needed). 200 -> document payload (invoice: line items + subtotal/fees/total, integer TZS; warranty: coverage + expiry; proof: photos + signature status); app maps 404 -> null and shows coming-soon cards.
   - Go notes: customer RBAC + booking-ownership (foreign -> `404 NOT_FOUND`); documents generated from server-side totals only; PDF download binary; PII masking on documents; the booking must be terminal-completed to serve documents (else `404`/empty — match the mock's deterministic behavior).

7. **Customer shipment extras** — `Shipment` payload (`GET /shipments`, `GET /shipments/{shipmentId}`). Status: new. Priority: P2.
   - `Shipment` today carries only the logistics envelope (`id, shipmentNumber, orderId, packages, status, …`). Add the customer-facing trail: `waybill` (number + events), `phases` (`TrackingPhase[]`), `route` (`RouteSegment[]`) — the same data the order tracking payloads carry, so the shipment screen renders the full trail.
   - Go notes: RBAC — customer-scoped visibility (own shipments only; the current paths are ops-scoped — do not widen them, add the customer fields under the existing `getShipment`/`listShipments` with ownership checks); read-only; no money; derive from the existing tracking/route stores (no new data model).

8. **Group-order shared-cart session semantics** — with the §9.2 #2 paths. Status: new. Priority: P2.
   - Contract semantics: session invite (`hudumika://group-order/{id}`), member add/remove with per-member item lines, server-side totals, merchant confirmation surface, one payer at `finalize`, per-member contribution ledger (`groupOrderContributions`, integer TZS), expiry (`expiresInMinutes` -> `409 CONFLICT` after), and `Idempotency-Key` on finalize (exactly one order per session).
   - Go notes: RBAC = session members only; finalize creates a normal merchant order (see the merchant note at the end of this section); ledger rows per member; no realtime scope (polling only — out of scope per §2 until later milestones).

9. **Red-packet claim/share semantics** — with the §9.2 #6 paths. Status: new. Priority: P2.
   - Contract semantics: promotional funding model (claim credits the recipient's wallet, never debits it); claim once per user per packet (`409 CONFLICT`); `Idempotency-Key` on claim; share creates a `PK-…` shareCode packet; wallet transaction type `adjustment` with `referenceType: 'red_packet'`; deep link `hudumika://red-packet/{shareCode}`.
   - Go notes: ledger credits + audit rows; shareCode unguessable; consider `RED_PACKET_*` error codes in `ERROR-CODES.md` (catalog rule §3.1) — the mock currently falls back to generic codes.

### 9.4 Cross-team dependency notes

- **Rider app (Team 3)**: the tip flow touches riders — `POST /orders/{orderId}/tip` (contract-live) debits the customer and credits the rider's payout as a `tip` ledger entry with the `tip.received` event; riders render `Order.tipTZS` from server values. No rider contract changes; the rider team should be aware the consumer tip surface is live.
- **Merchant app (Team 4)**: group ordering (shared cart) finalizes into a normal merchant order — the merchant order stream will see group-orders as ordinary `POST /orders` entries (same accept/reject surface, no merchant contract changes). Merchants do not need a group-order UI; the shared-cart session is consumer-facing only.
- **Provider app (Team 5)**: no impact — none of the consumer additions touch provider surfaces except the public `GET /providers/{id}` (read-only view of provider public data).
