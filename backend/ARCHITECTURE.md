# HUDumika Backend Architecture

Go service. Recommended stack: **Go 1.25+, chi router, PostgreSQL 16, Redis 7**.
Package manager: plain `go mod`. Migrations: `goose` (run as part of deploy via `make -C app migrate`, never at app boot).

## Delivered state (M1–final)

All contract domains are implemented — **580/580 contract operations** (464
paths routed via the generated chi interface) answer defined shapes, pinned by
`TestAllContractPathsReturnDefinedShape` (never a blank 404, never an empty
body). The single remaining 501 state is `GET /events` without
Redis/PostgreSQL configured — a dependency state, not a missing feature.

- **Auth**: OTP (Redis-hashed, constant-time, 5-attempt lock, 3/5 min per
  destination + 60 s resend, per-IP verify limits, dev code non-production
  only), opaque rotating refresh tokens, logout, role switching, password
  change (OTP-first — see AUTH.md).
- **Users**: profile read/update, roles.
- **Riders**: apply, profile, online/offline (Redis ZSET + DB flag), location
  pings, assigned feed; rider-ops extras (shifts, breaks, swap requests, trips,
  missions, training, offline sync batches, performance, exports).
- **Orders**: idempotent create with server-side price recompute from
  catalogue, guarded transitions (`expectedVersion` → 409), append-only events,
  immutable `order_earning` ledger entry on completion, search/timeline/rush/
  batch/damage claims/tips/proof-of-delivery.
- **Bookings**: idempotent create with server-side pricing, accept/decline/
  cancel/complete (escrow release → `booking_earning`), estimates, provider
  quotes with parts, proof-of-service with OTP verification.
- **Payments**: idempotent intents (amount server-side), confirm, **signed
  webhooks** (HMAC-SHA256, per-provider secrets, constant-time, idempotent,
  provider call log), refunds, STK-push via the outbox, QR payments, wallet
  top-up intents.
- **Payouts/ledger**: immutable append-only ledger (advisory-lock serialized
  running balances, idempotency-keyed replays), statements with
  opening/closing balances, batches, reconciliation.
- **Wallet**: customer + merchant projections of the ledger (never a second
  source of truth), withdrawals with gates, adjustment history.
- **Catalogues**: own + public catalogue (available items only), item
  create/update/soft-delete, batch import/export, change-logs.
- **Merchants/providers**: applications with admin approval workflow
  (approve/reject/request-changes), public profiles + directories, own-profile
  updates, store claims, payout accounts (masked), provider self-service
  (services, technicians, staff, capabilities, contracts, documents).
- **Reviews** (create → moderation queue → publish/hide/delete; edit/delete,
  helpful votes, reports), **support** tickets (owner+staff visibility, no
  existence leaks), **chat** (conversations, unread counters, messages,
  read/archive/block).
- **Dine-in** (tables + QR, dine-in orders, reservations), **group-buys**
  (deals, purchases with concurrent single-winner, vouchers verify/redeem),
  **promotions/coupons** (campaigns, claims, pause/performance), **loyalty**
  (merchant members, tiers, top-ups, platform points).
- **Chain** (store groups, bulk operations with staff approval), **inventory**
  (guarded adjustments, no negative stock, alerts) + **procurement**
  (suppliers, purchase orders, returns), **staff-ops** (shifts, attendance
  clock-in/out, performance, commissions).
- **Integrations/webhooks**: connector registry with disconnect, outgoing
  webhook subscriptions (auto secrets) + delivery log. TODO: the outbound
  delivery worker itself was not found in the code — subscriptions and the
  delivery log are served; actual delivery is described as dispatcher-owned in
  comments. Verify before treating outbound delivery as shipped.
- **Analytics**: dashboard/traffic/products/revenue/benchmarks/market
  aggregates, forecasts, heatmaps, operations + fleet control towers.
- **Logistics**: hubs/vehicles/containers, shipments (waybills, custody/scan
  state machines, freeze/unfreeze), **warehouses** (stock, reserved stock,
  fulfillment), **consignments** (capacity, add-order, seal/depart/arrive,
  reconcile/replan), trips with auto legs, route-leg advance + handoffs
  (seal-verified), order routes + tracking phases.
- **Approvals/tasks/risk/onboarding**: approval requests with staff decisions
  (same-actor + already-decided guards), tasks lifecycle, anomalies/
  violations/activities, risk events + review, onboarding profile/docs/submit.
- **Finance**: tokenized bank cards (PANs never stored, masked), invoices,
  daily settlements (run → payout via ledger batches), reconciliation.
- **Marketing**: platform events, flash sales, precision/dianjin campaigns,
  brand display, self-service toggles; **reports/exports**: scheduled reports,
  data export jobs (scoped, rate-limited, in-progress guard).
- **Media**: barcodes (formats/lookup/history/batch), combos, menus, videos,
  product categories, print jobs.
- **Home BFF**: consumer feed (merchants/providers/promotions/group-buys/
  recent orders/unread count) with city filter.
- **Event stream + WebSocket**: `/events` long-poll over Redis streams
  (sequence semantics) with PostgreSQL event-log fallback, plus `/ws` WebSocket
  (token auth, ping/pong, sync-after replay, live push via Redis pub/sub relay,
  at-least-once); domain events flow to WS + `/events` + the PG event log.
- **Cross-cutting live**:
  - RBAC + MFA (`mfa_verified` gate on `/admin/*`), PII masking (`MaskPII`),
    audit rows on every money/status/moderation mutation, idempotency keys
    (SETNX + replay), rate limits, immutable ledger.
  - Outbox (`notification_outbox`, AES-256-GCM payloads) + retrying worker with
    exponential backoff (SMS → email → push/Expo chain) + sweeper jobs
    (auto-cancel stale orders, voucher expiry, rider auto-assign, daily
    settlements, export-queued, pre-order reminders, promotion ticks,
    closure-protection expiry, scheduled store reopen).
  - OTel tracing + Prometheus `/metrics` + Grafana dashboards + alert rules
    (drift-pinned by tests). TODO: MONITORING.md claims PG/Redis/provider
    spans; code inspection shows HTTP spans only (`internal/api/metrics.go`) —
    re-verify.
  - Public-path exemptions: contract routes without bearerAuth (cities,
    services, promotions list, merchant profiles/catalogues, payment
    webhooks) skip auth and PII masking.
  - Admin IP allow-list: `/admin/*` honors `ADMIN_ALLOWED_IPS` (exact IPs or
    CIDRs, fails closed when set, honors `X-Forwarded-For`).
- **Hardening**: `ENV` validated at boot (hard failure on unknown values),
  production guards (weak JWT secrets, `OTP_DEV_CODE` in prod,
  `CORS_ORIGINS=*`, missing `DATABASE_URL`/`REDIS_URL`/`OTP_PAYLOAD_KEY`/
  `PAYMENT_WEBHOOK_SECRET`), Docker base pinned to `golang:1.25-alpine`,
  `/healthz` + `/readyz` (503 when a configured dependency is down or nothing
  is configured), graceful shutdown.
- **Persistence** (`internal/auth`, `internal/audit`): goose migrations
  (00001–00058 — every domain plus logistics, masked calls, the PG event log
  and entity linkage), auth service mirroring hot state to durable rows,
  `migrate` CLI as a deploy step (never at boot).
- **Entity linkage**: orders/catalogues/group-buys/dine-in/loyalty/promotions
  store **real `merchants` row ids**; bookings/provider surfaces store **real
  `providers` row ids**; legacy user-id values stay readable
  (resolve-compatible ownership checks); legacy FKs dropped via migration
  00058.
- **Observability**: Prometheus `/metrics` (`http_requests_total`,
  `http_request_duration_seconds`, `otp_requests_total`,
  `idempotency_hits_total`, `active_sessions`), OpenTelemetry HTTP spans
  correlated with `request_id` (OTLP export when configured, 100% sampling on
  errors), structured JSON slog.

## Repository layout

```text
services/api/
├── cmd/
│   └── api/
│       └── main.go            # wiring, config, server start
├── internal/
│   ├── auth/                  # OTP, sessions, RBAC middleware
│   ├── users/
│   ├── cities/
│   ├── services/              # service catalogue + categories
│   ├── merchants/             # profiles, applications, approval
│   ├── providers/             # profiles, availability, matching
│   ├── riders/                # profiles, online state
│   ├── catalogue/             # merchant catalogue + items
│   ├── orders/                # order state machine
│   ├── bookings/              # booking state machine
│   ├── dinein/                # tables, QR ordering, dine-in orders, reservations
│   ├── groupbuy/              # deals, vouchers, verification
│   ├── promotions/            # campaigns, coupons, performance
│   ├── loyalty/               # merchant members, tiers, top-ups, platform points
│   ├── staff/                 # merchant staff roles + devices (printers, POS)
│   ├── staffops/              # shifts, attendance, performance, commissions
│   ├── approvals/             # multi-level approval workflows
│   ├── inventory/             # stock, adjustments, alerts, sync config
│   ├── procurement/           # suppliers, purchase orders, returns
│   ├── chain/                 # multi-store groups, bulk operations, chain analytics
│   ├── integrations/          # POS/ERP/accounting/payroll connectors, webhooks
│   ├── reporting/             # scheduled reports, exports
│   ├── crm/                   # segments, journeys (phased M8c)
│   ├── tasks/                 # anomalies, violations, activities, setup guide
│   ├── risk/                  # risk event detection + review
│   ├── barcode/               # barcode formats, lookup, batch import
│   ├── combos/                # combo meals
│   ├── onboarding/            # wizard progress, qualification upload
│   ├── finance/               # bank cards, invoices, daily settlements, reconciliation
│   ├── storeops/              # kitchen camera, QR codes, receipt templates, self-pickup
│   ├── wallet/                # merchant wallet projection + withdrawals
│   ├── analytics/             # dashboard, traffic, products, revenue, benchmarks, exports
│   ├── payments/              # intents, provider adapters, webhooks
│   ├── payouts/               # ledger, batches, reconciliation
│   ├── dispatch/              # rider assignment + provider matching
│   ├── reviews/               # review lifecycle + moderation
│   ├── notifications/         # in-app, push, SMS, email
│   ├── support/               # tickets
│   ├── chat/                  # 1:1 conversations + messages (customer ↔ merchant)
│   ├── admin/                 # staff queries and actions
│   ├── audit/                 # audit log writer and reader
│   ├── platform/              # config, idempotency, request id, errors, pagination, money
│   └── storage/               # db, redis, s3 clients, migrations
├── migrations/                # SQL migrations (one file per change)
├── openapi/
│   └── api-contract.yaml      # canonical copy of backend/API-CONTRACT.yaml
├── tools/                     # codegen, seed scripts
└── go.mod
```

Rule: one folder per bounded context. Domain folders contain handler, service, store (repository), and state machine files.

> TODO (layout drift): the tree above is the target layout; the actual
> `internal/` today is: `api`, `audit`, `auth`, `bookings`, `catalogues`,
> `cities`, `config`, `db`, `dinein`, `gen`, `groupbuy`, `inventory`,
> `logistics` (hubs/shipments/warehouses/consignments/trips), `loyalty`,
> `merchants`, `notifications`, `orders`, `payments`, `payouts`, `promotions`,
> `provider`, `reviews`, `riders`, `store`, `support`, `sweeper`, `ws` — most
> other domains (dispatch, chat, admin, analytics, finance, marketing, chain,
> approvals, risk, media, wallet, …) live as handler files inside
> `internal/api`.

## Layering rules

```text
handler (HTTP, auth, validation) -> service (business rules, transactions) -> store (SQL)
```

- Handlers never contain business rules; services never write raw SQL.
- Every service method is a transaction where more than one table changes.
- Money is `int64` minor units of TZS. Never float.
- Every handler reads the request ID from context and returns it in errors.

## Deployment topology (Phase 3)

- Each bounded context is an independently deployable **microservice** (dispatching, routing, tracking, payments, analytics) behind the API gateway.
- Multi-region active-active deployment for redundancy; stateless pods auto-scale under demand (long-term target: millions of concurrent riders).
- Encryption at rest (AES-256, KMS-managed keys) and in transit (TLS 1.3 everywhere).
- Compliance: Tanzania PDPA 2022 + GDPR-aligned portability/erasure + CCPA-style disclosure; consent records stored per user (see AUTH.md, merchant SECURITY.md).

## Logistics domain services (Logistics OS)

The logistics backend is split into independently deployable services behind the event bus:

Order · Shipment · Routing · Leg · Dispatch · Fleet · Vehicle · Hub · Manifest ·
Sorting · Tracking · Location · ETA · Capacity · Handoff · Scan · Exception ·
Notification · Identity/IAM · Trust & Safety · Payment/Settlement.

Each is a bounded context (e.g. `internal/shipment`, `internal/manifest`,
`internal/handoff`); they communicate via domain events, never direct calls —
Tracking, Dispatch, and Analytics consume the stream, and the Control Tower
aggregates it. Full model in LOGISTICS-OS.md.

## Cross-cutting concerns

| Concern | Implementation |
| --- | --- |
| Request ID | Middleware generates `X-Request-ID`, injects into context, adds to logs and error responses |
| Auth | `auth.Middleware` validates bearer JWT, loads role, enforces route permission |
| Idempotency | Redis `SETNX` on `Idempotency-Key` per user; stored response replayed on retry |
| Rate limiting | Redis token bucket per phone/IP per endpoint group (OTP: 3 per 5 min) |
| Pagination | Cursor = base64(createdAt + id), enforced in list queries |
| Validation | Per-request struct tags + shared validator; errors map to `ValidationResponse` |
| Errors | Central error type carrying stable code + HTTP status; catalog in `ERROR-CODES.md` |
| Logging | Structured JSON (slog); request ID + actor ID + route in every line |
| Observability | `/healthz` and `/readyz`; OpenTelemetry traces; Prometheus metrics |

## State machines

Order and booking statuses are enforced server-side in `orders/` and `bookings/`.
Transitions are single SQL updates guarded by `WHERE status = <expected>`; a
0-row update returns `409 ORDER_STATUS_CONFLICT`. Every transition appends an
event row and emits a notification event.

## Database

- PostgreSQL with `gen_random_uuid()`, UTC timestamps, `tzs BIGINT` money columns.
- **Geospatial**: PostGIS `GEOGRAPHY` polygons for zones/service areas and proximity-based dispatch queries (`riders(online, city_id)` + `ST_DWithin`); index zone lookups.
- Read replicas for list/feed endpoints once load requires it.
- Redis: sessions, OTP, idempotency keys, rate limits, dispatch queues, online rider sets, surge config cache.
- Message queues: Redis Streams today; RabbitMQ/Kafka adapter planned for high-volume real-time (location pings, event fan-out).
- S3 (or Cloudflare R2): document and image uploads with pre-signed URLs.

## Scaling and real-time (Phase 2)

- Container images (Docker) built in CI; Kubernetes for auto-scaling of stateless API pods; stateful services (Postgres, Redis) stay managed.
- WebSocket/Socket.IO long-lived channels for location streams and live chat; long-poll `/events` remains the fallback.
- Data compression: gzip at the edge; batched location payloads; throttled pings (activity-aware) to minimize mobile data.
- Analytics/monitoring: Prometheus + OTel tracing per service; rider performance and leaderboard views are sweeper-computed aggregates.
- Enhanced RBAC: permission sets per rider type (full-time/part-time/vehicle class) enforced server-side on every route.

## Failure handling

- Payments use outbox pattern: transaction commits event to `outbox`, a worker
  sends to the payment provider and marks intents paid on signed webhooks only.
- Dispatch is asynchronous via queue; riders see timeouts and re-assignment.
- Every external call has timeout, retry budget, and a dead-letter path.

## Real-time and offline contract (from reference apps)

- **Event stream**: `GET /events?after=<seq>` (long-poll, ~25 s hold) plus WebSocket
  `/api/ws` (`{type:'sync', merchantId, after}`). Both feed one client dispatcher;
  the event log is shared across devices/tabs so reconnecting clients catch up.
- **Idempotency**: every mutation carries `idempotency-key`; the server ignores duplicates.
- **Offline queue**: clients enqueue POST/PATCH while offline (cap 200) and replay in
  FIFO on reconnect; 409/404/403 drop, 5xx retry later, and the UI shows queue depth.
- **Optimistic concurrency**: `Order.version` + `expectedVersion` on mutations;
  `VERSION_CONFLICT` (409) → client refetches and retries once.
- **Sweeper jobs**: server-side periodic jobs (rush auto-flag, auto-accept,
  pre-order reminder, auto-cancel+refund, campaign ticks, risk engine, closure
  expiry, scheduled reopen) — see DATA-MODEL.md.
- **Customer simulator** (staging only): internal key `x-internal-key` emulates the
  customer platform (orders, chat, refunds, rush) for E2E. TODO: not found in the
  backend code — no middleware reads that header; verify before relying on it.

## Rules inherited from backend/README.md

- Version endpoints `/api/v1/...` from day one.
- Never trust price, role, commission, payout, or status from clients.
- Immutable ledger entries only for money movement.
- Request IDs everywhere.
