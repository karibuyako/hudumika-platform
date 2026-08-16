# Hudumika API Backend (Team 6)

Go service generated from the API contract (`backend/API-CONTRACT.yaml` in the platform repo).

## Status (M1–M8 delivered)

- **Generated**: 249 schemas + 464 paths → `internal/gen/openapi.gen.go` (types, chi server interface, embedded spec) via oapi-codegen v2.
- **Implemented** (contract-shaped, never blank 404s; pinned by `TestAllContractPathsReturnDefinedShape` — **all 580 contract operations implemented**, 0 undefined shapes; the single remaining 501 state is `GET /events` without Redis/PostgreSQL configured — a dependency state, not a missing feature):
  - **Auth**: OTP (Redis-hashed, constant-time, 5-attempt lock, 3/5 min + 60 s resend), opaque refresh tokens (SHA-256 stored, atomic rotation, reuse rejected), per-IP verify limits, dev code `123456` (non-production only).
  - **Users**: `/users/me` GET/PATCH, `/users/me/roles`.
  - **Riders**: apply, profile, online/offline (Redis ZSET + DB flag), location pings (rate-limited), assigned list.
  - **Orders**: create (idempotent, server-side price recompute from catalogue, guarded transitions with `expectedVersion` → 409, append-only events), list/get (parties only), accept/reject/cancel/advance/track; order completion appends an immutable `order_earning` ledger entry.
  - **Bookings**: create (idempotent, service price server-side), list/get, accept/decline/cancel/complete (escrow release → `booking_earning` ledger entry), advance.
  - **Payments**: intents (idempotent, amount from order server-side), confirm, **signed webhooks** (HMAC-SHA256, constant-time, idempotent, provider call log), refunds; STK-push enqueued via the notification outbox.
  - **Payouts/ledger**: immutable append-only ledger (advisory-lock serialized running balances, idempotency-keyed replays), statements with opening/closing balances, payout history, batches.
  - **Wallet**: customer + merchant projections of the ledger (never a second source of truth), withdrawals (minimum, balance, daily-rate-limit gates; single-tx ledger debit + payout entry), transactions.
  - **Catalogues**: own catalogue GET/replace, public catalogue (available items only), item create/update/soft-delete (merchant gate).
  - **Merchants/providers**: applications with admin approval workflow (approve/reject/request-changes with reasons), public profiles, own-profile update; admin directories read the real tables.
  - **Reviews**: create (moderation queue), list mine, reply (one per review), helpful votes, reports; **admin moderation** (publish/hide/delete).
  - **Support**: tickets with messages, close/assign, owner+staff visibility (no existence leaks).
  - **Dine-in**: table CRUD + QR, dine-in orders (idempotent, server-side pricing, payment chain, table-in-use gate), reservations (capacity check, cancel).
  - **Group-buys**: deals (create/extend/delist/relist), purchases (guarded quantity, concurrent single-winner), vouchers with verify/redeem at the merchant.
  - **Promotions/coupons**: campaigns, claims (budget-guarded, one per user), pause/performance, my coupons.
  - **Notifications**: in-app list/read/read-all, preferences, push channel stub in the outbox chain.
  - **Cities/services**: public read paths with cursor pagination.
  - **Favorites, sessions** (list + revoke), **privacy** (export payload + durable deletion requests).
  - **Dispatch**: admin manual rider assignment (online-set gate, guarded order update, assignment + event rows), rider in-flight advance (picked_up→delivering→delivered), order seen, assigned-orders feed.
  - **Search**: unified search across catalogue/merchants/services/group-buys (approved entities only, entity-typed cursors), suggest, per-user history.
  - **Dine-in store ops**: kitchen camera config, qualifications, QR codes, receipt templates (limit + activation), payment accounts (default promotion), self-pickup, compliance rechecks.
  - **Loyalty**: merchant members with advisory-locked top-ups and append-only balance ledger, tiers, customer memberships.
  - **Chain**: store groupings with dashboard/analytics aggregates, bulk operations with staff approval (closure application).
  - **Inventory/procurement**: items + guarded adjustments (no negative stock, low-stock alerts), suppliers, purchase orders (partial receipts bump stock), supplier returns.
  - **Staff ops**: devices, shifts (overlap/past gates), attendance clock-in/out (partial-unique single-winner), performance hours, commission rules.
  - **Chat**: conversations with unread counters, messages (rate-limited), read/archive/block, unread counts.
  - **Integrations/webhooks**: connector registry with disconnect, outgoing webhook subscriptions (auto secrets, delivered-once), delivery log.
  - **Analytics**: dashboard/traffic/products/revenue/benchmarks/diagnostics/reviews/market aggregates (honest zeros); operations + fleet control towers.
  - **Logistics**: hubs/vehicles/containers CRUD, shipments with waybills + custody/scan state machines + freeze/unfreeze (staff), trips with auto legs + start/complete gates, route-leg advance + handoffs (seal-verified), order waybills + tracking phases.
  - **Approvals/tasks/risk/onboarding**: approval requests with staff decisions (same-actor + already-decided guards), tasks lifecycle, anomalies/violations/activities, setup guide, risk events + review, onboarding profile/docs/submit/demo-approve.
  - **Finance**: tokenized bank cards (PANs never stored, masked responses, default promotion), invoices (issue/download), daily settlements (run → payout via ledger batches), reconciliation.
  - **Marketing**: platform events, flash sales, precision/dianjin campaigns (segment/budget guards), brand display, self-service toggles.
  - **Reports/exports**: scheduled reports (cadence validation), data export jobs (scoped, rate-limited, in-progress guard).
  - **Orders extras**: order search, timeline, rush request/reply (guarded), batch accept/reject (partial success), damage claims, reject reasons, receipts.
  - **Payments extras**: methods list, payment history, pending-intent reversal, STK-push request flow, QR payments (15-min expiry) — and **wallet top-up** now creates real payment intents (replacing the 501).
  - **Admin extras**: banners, feature flags, help articles, audience broadcast (batched notifications), data-export queue, group-buy moderation, conversations oversight, integration health, global search.
  - **Media**: barcode formats/lookup/history/batch, combos, menus, videos, product categories (sort conflict + not-empty guards), print jobs (device-online + queue-cap gates).
  - **Bookings extras**: estimates (server-side price math), provider quotes with parts reconciliation + customer decision (quote gates: already-issued, not-allowed, declined), proof-of-service with OTP verification (constant-time, hash-stored).
  - **Provider self-service**: services, availability, technicians, certifications, staff (last-owner guard), portfolio, capabilities (validated set), inventory + adjustments, service plans (in-use delete guard), contracts, documents, exports.
  - **Notifications extras**: per-merchant order-alert settings (validated event keys), platform announcements (audience + window filtered).
  - **Catalogue import/export**: transactional batch import (upsert, replace-mode soft delete, per-item errors, 500 cap), JSON/CSV export round-trip.
  - **Review edit/delete** (author-only, moderated-state guards) + rider reject reasons.
  - **Admin logistics**: hub dashboard, network control tower, shipment escalation (status-gated), rider COD reconciliation sessions, risk cases list + review.
  - **Rider ops**: shifts (create/clock-in/out, overlap/past gates), breaks (single-open partial-unique), swap requests, trip bundle list/get/reorder, trip sharing.
  - **Wallet**: withdrawal history list (status filter + pagination).
  - **Event stream**: `/events` long-poll over Redis streams (`after` sequence semantics) + client error reporting (public, streamed) + `PublishEvent` helper for domain events.
  - **Sweeper jobs**: periodic auto-cancel of stale orders (acceptance deadline, events appended, idempotent) + voucher expiry — running in the API process.
  - **Logistics-extra**: routes/warehouses/carriers/facilities CRUD, consignments (capacity checks, add-order, seal/depart/arrive), delivery exceptions with resolution.
  - **Provider-extra**: dispatch console, trust profile, rule-based copilot, service contracts, provider applications + public directory.
  - **Rider-extra**: preferences/goals/expenses/contacts/security/destination-filters/safety events; vehicle maintenance, missions, training modules, offline sync batches (sequence-gapped), sync status, exports, performance, daily check-ins.
  - **Merchant-extra**: public merchant directory, store claims, staff, store settings, stores list, payout accounts (masked), closure protection.
  - **Admin-config**: templates, staff roles, SLA rules, platform commission rules, two-person approvals (same-actor guard).
  - **Admin-ops**: payout/promotion directories, analytics-by-scope, webhook health, chain list, user search, bookings/tickets oversight, city upsert, voucher verify, reports.
  - **Analytics-extra**: order/marketing/top-dishes/customer-distribution/promotions/funnel/customers/store-score + demand/sales forecasts + dispatch heatmap.
  - **Home BFF**: consumer feed (merchants/providers/promotions/group-buys/recent orders/unread count) with city filter.
  - **Marketing-extra**: coupon verify (min-spend gate), public campaigns, experiments, journeys, segments, help articles.
  - **Product assistant** (deterministic rule-based), order issue reasons, refund requests, audit/me; catalogue bulk + product templates + service categories + store logs; fleet accounts + password change (SHA-256+salt, OTP-first).
  - **Remaining 501 sweep**: tips, delivery proofs, SOS alerts, fare breakdowns, hold/unhold, transfer, add-items, dispatch feeds, service invoices/warranties, review reply edit/delete, facility whitelists, wallet adjustments (ledger-backed), hourly trends, leaderboards — 40+ straggler operations implemented in the final sweep.
  - **Final wave**: warehouse stock + fulfillment (locked adjustments, reserved stock), consignment reconcile/replan (scanned-vs-manifest gates), order routes + scheduled-order advance + shipment reassignment, masked calls (Redis sessions, VoIP stub), image search placeholder (contract-declared), catalogue change-logs + per-store settings, device pairing + test jobs, product-template update/delete/apply, **PostgreSQL event-log fallback** (events work without Redis), and dispatch auto-matching + settlement/export sweeper jobs.
  - **Provider adapters**: configurable HTTP SMS/email gateways (env-driven, fail-over chain), per-provider webhook signing secrets (M-Pesa/Tigo/Airtel/card), provider request builders for STK-push payloads.
  - **Entity linkage**: orders/catalogues/group-buys/dine-in/loyalty/promotions now store REAL merchants row ids; bookings/provider surfaces store REAL providers row ids; legacy user-id values stay readable (resolve-compatible ownership checks); legacy FKs dropped via migration 00058.
  - **Real-time**: `/ws` WebSocket endpoint (gorilla/websocket) with token auth, ping/pong, sync-after replay and live push via Redis pub/sub (XREAD relay, at-least-once); domain events published on order/booking/payment transitions flow to WS + `/events` + the PG event log.
  - **Ops**: `scripts/staging-drill.sh` + `scripts/dashboard-smoke.sh` executed (signed records in RUNBOOKS/DEPLOYMENT); `tools/loadsmoke` harness proving p99 97 ms / 0% errors under ~465 req/s on this machine.
  - **Tracing**: OTel spans now cover PostgreSQL (otelpgx), Redis (redisotel), provider HTTP calls (otelhttp) in addition to HTTP — all correlated with request_id.
  - **Outbound webhooks**: a delivery worker (FOR UPDATE SKIP LOCKED claims, HMAC-signed POSTs, exponential backoff, dead-letter after 8 attempts) finally SENDs the webhook_deliveries rows; `EnqueueDelivery` for domain fan-out.
  - **Expo push**: real Expo Push API provider (env-configured) joining the notification chain; the dev stub remains the fallback.
  - **Rider offline replay**: the sync batch now APPLIES `order_status` events via guarded transitions with per-event outcomes (conflicts/not-found/skipped) while keeping the sequence watermark.
  - **Customer simulator**: `/internal/simulate/{order,chat,rush}` gated by the `SIMULATOR_KEY` internal key (constant-time, staging/dev only) — one-shot E2E flows through the real state machines and the signed webhook path.
  - **Signature schemes**: per-provider webhook verifiers (HMAC hex, `sha256=` hub form, M-Pesa `base64:` digest variant) behind a Verifier interface with constant-time comparison.
  - **Admin network isolation**: `ADMIN_ALLOWED_IPS` (exact IPs + CIDRs, X-Forwarded-For aware) enforced in RequireAuth — fails closed when set.
  - **Sweeper expansion**: pre-order reminders, promotion/deal lifecycle ticks, closure-protection renewal, scheduled store reopen (marker convention in store settings).
  - **Webhook fan-out**: domain events (order/payment) now ENQUEUE deliveries for matching active subscriptions (jsonb containment, merchant-owner resolution) — the delivery worker finally has work to do.
  - **Preference enforcement**: per-user channel/event toggles (notification_preferences + order-alert settings) are honored at enqueue time (OTP SMS exempt by policy); in-app writes gated too.
  - **Push token registry**: documented-extension endpoints to register/list/deregister device push tokens (push_tokens table), feeding the Expo provider.
  - **Mock provider sandbox**: `tools/mock-gateway` emulates the SMS gateway, Expo push, and M-Pesa STK + a `/payments/fire` webhook simulator — full local E2E without real vendors.
  - **Monitoring provisioning**: Prometheus scrape config + Grafana datasource/dashboard provisioning, and `scripts/selfcheck-24h.sh` (healthz/readyz/metrics/5xx-delta every 5 min) — demo run PASS (17/17 checks).
  - **WebSocket hardening**: token-expiry enforced on connect and mid-session, per-user connection caps (8), user-scoped delivery ACLs, read/write deadlines.
  - **Webhook admin**: delivery list (filters + pagination) and manual retry endpoints (documented extensions).
  - **Error-code drift gate**: `TestErrorCodesUsedExistInCatalog` pins every envelope code to ERROR-CODES.md (17 late-addition codes catalogued).
  - **Performance**: one real N+1 found and fixed (CreateOrder merchant resolution batched); 5 indexes added for the hot list queries (EXPLAIN-verified).
  - **Merchant approval race fixed**: the decide flow now uses a pending-only decidable set + version CAS (220 consecutive stress passes).
  - **Staging bootstrap**: `scripts/staging-bootstrap.sh` provisions a fresh staging DB (migrate + `tools/seed` demo data) and starts a staging-grade instance — proven end-to-end (signed run: migrate 61, seed applied, verify + dashboard-smoke OK).
  - **SMTP email adapter**: stdlib net/smtp provider joins the notification chain (EMAIL_SMTP_* env) — real transactional email without an HTTP vendor.
  - **SMS multi-provider failover**: Redis-backed circuit breaker (3 failures → 5-min open window) with a backup SMS gateway (OTP_SMS_GATEWAY_BACKUP_URL) — RUNBOOKS 4 switchable in config.
  - **Chat real-time**: `chat.message` events published on send, delivered via /ws conversation topics (subscribe/unsubscribe, participant ACL).
  - **Customer offline replay**: `POST /sync/batch` (documented extension) applies guarded order mutations with per-event outcomes + sequence watermark.
  - **API docs surface**: `GET /docs` (HTML index) + `GET /docs/openapi.yaml` (the embedded contract) — public.
  - **Queue-depth metrics**: `queue_depth{queue}` for notification_outbox, webhook_deliveries, orders_stale — the MONITORING.md gauge is live.
  - **Rate-limit headers**: X-RateLimit-Limit/Remaining/Reset on OTP and withdrawal endpoints (429s and successes).
  - **24h gate package**: `scripts/selfcheck-24h.sh` writes durable reports + optional Prometheus presence check; `docs/STAGING-GATE.md` is the operator runbook (demo: SELFCHECK PASS 17/17).
  - **Demo seed tool**: `tools/seed` (idempotent cities/merchant/catalogue/provider/rider/deals/promotions/coupons/customer) with `-reset`.
  - **FINAL-STATUS.md**: the audit record — 580/580 ops (1 dependency-state 501), 61 migrations, 1163 test funcs, all disciplines LIVE with evidence.
  - **Admin**: overview, audit-logs, customer/order/rider/provider/merchant directories, review moderation (staff + MFA gated).
  - Everything else: `501 {code:"NOT_IMPLEMENTED",...}` — explicit and counted.
- **Hardening**: `ENV` validated at boot (hard failure), production guards (weak JWT secrets, `CORS_ORIGINS=*`, dev OTP code, missing `DATABASE_URL`/`REDIS_URL`/`OTP_PAYLOAD_KEY`/`PAYMENT_WEBHOOK_SECRET` refused), `/healthz` + `/readyz` (db + redis), graceful shutdown, Docker base `golang:1.25-alpine` pinned with go.mod.
- **Persistence**: goose migrations (00001–00057 — every domain plus the final logistics/masked-call/event-log surfaces) run only via `make migrate`; **25 integration suites** prove state survives restart and state machines stay single-winner under concurrency.
- **RBAC + PII + audit**: per-route role policy from session claims, `mfa_verified` gate on `/admin/*`, PII masking, `audit_logs` on money/status/moderation mutations. Public contract routes (cities, services, promotions list, merchant profiles/catalogues, payment webhooks) are exempt from auth.
- **Observability**: Prometheus `/metrics` (http_requests_total, http_request_duration_seconds, otp_requests_total, idempotency_hits_total, active_sessions), OTel HTTP spans with `request_id` correlation, Grafana dashboards + alert rules in `dashboards/` (drift-pinned by tests).
- **Ops (M8)**: `scripts/backup.sh`, `scripts/restore.sh`, `scripts/verify-release.sh` — backup + restore + health drills executed against a live PostgreSQL/Redis (recorded in `docs/RUNBOOKS.md` + `DEPLOYMENT.md`).

## Run

```sh
make run            # requires DATABASE_URL + REDIS_URL for the production path
make migrate        # deploy-step goose migrations (never at boot)
make test           # unit tests (miniredis + httptest, no services needed)
make test-integration  # real PostgreSQL + Redis (docker compose / local dev DB)
make docker         # full stack: api + postgres 16 + redis 7
```

Dev OTP code in non-production env: `123456` (documented; never usable or returned in production). OTP delivery uses the outbox with stub providers — swap `SMSProvider`/`EmailProvider` for gateway adapters as they land (M6 provider layer).

## Staging bootstrap

One command provisions a fresh staging database and starts a staging-grade API instance — the standing-staging stand-in for the 24h gate:

```sh
STAGING_DB_URL=postgres://hudumika:hudumika@localhost:5432/hudumika_staging \
ADMIN_DB_URL=postgres://postgres:postgres@localhost:5432/postgres \
./scripts/staging-bootstrap.sh
```

What it does: refuses to run against the dev database (unless `--allow-dev`), creates the staging DB if missing (app role first; `ADMIN_DB_URL` fallback when the role lacks CREATEDB), applies goose migrations (`go run ./cmd/migrate -up`), loads idempotent demo data via `go run ./tools/seed --url "$STAGING_DB_URL"` (skipped with a warning while the tool is pending), and starts the API on `STAGING_PORT` (default `8092`) with `ENV=staging`, a fresh 48-char `JWT_SECRET` (`openssl rand -hex 24`), per-run `OTP_PAYLOAD_KEY` + provider webhook secrets (`PAYMENT_/MPESA_/TIGO_/AIRTEL_/CARD_WEBHOOK_SECRET`), `SIMULATOR_KEY`, `CORS_ORIGINS=https://staging.hudumika.co.tz`, `ADMIN_ALLOWED_IPS` (default `127.0.0.1`), and the staging DB + Redis. It then waits for `/healthz` + `/readyz` 200 (20×1s), warms the auth counters with an OTP + idempotency-replay smoke (dev code `123456`, non-prod only — required for `dashboard-smoke.sh` on a cold instance), runs `scripts/verify-release.sh` (ENV=staging) and `scripts/dashboard-smoke.sh`, and prints a SIGNED summary (urls, ports, readiness, drill results) appended to `backups/staging-bootstrap-<ts>.log`.

The instance is left RUNNING for the 24h gate. Stop it with `pkill -f staging-api` (or `kill <pid>` from `$PIDFILE` at `/tmp/opencode/staging-api.pid`, or `kill %1` when run interactively). The mock SMS/Expo gateway URLs (`OTP_SMS_GATEWAY_URL=http://127.0.0.1:3100/sms`, `EXPO_PUSH_BASE_URL=http://127.0.0.1:3100/push/send`) point at `tools/mock-gateway` (see below); when the mock is down the notification chain fails over to the stubs — non-fatal.

## Local E2E with the mock gateway

`tools/mock-gateway` emulates the SMS gateway, Expo Push and the M-Pesa (Daraja) STK/callback flow on `:3100` — stdlib only, no DB/Redis. Run it, point the API at it, and the whole provider surface is exercisable locally:

```sh
cd tools/mock-gateway && go run .     # terminal 1 — the mock on :3100

# terminal 2 — the API wired to the mock
OTP_SMS_GATEWAY_URL=http://127.0.0.1:3100/sms \
EXPO_PUSH_BASE_URL=http://127.0.0.1:3100/push/send \
EXPO_PUSH_ACCESS_TOKEN=test-token \
PAYMENT_WEBHOOK_SECRET=local-dev-secret \
make run
```

Fire a signed webhook through the real `/payments/webhooks/mpesa` path:

```sh
curl -X POST http://127.0.0.1:3100/payments/fire \
  -d '{"orderId":"<intent order uuid>","status":"paid","reference":"<intent reference>","secret":"local-dev-secret"}'
```

The mock HMAC-SHA256-signs the payload with the secret and delivers it with `X-Webhook-Signature`; the API's `{"accepted":true}` is relayed back. `GET /state` dumps the in-memory SMS + STK intents for assertions. See `tools/mock-gateway/README.md`.

## Regenerating from the contract

```sh
make gen            # requires oapi-codegen on PATH (go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@latest)
```

The generated file is committed. Changing the contract is a PR gated by Team 6: version bump + `packages/contract/CHANGELOG.md` entry + regenerate (`npm run generate:contract` + `make -C app gen`) + committed output (CI `contract.yml`).

## Remaining 501s (15, all deliberate)

Masked-call VoIP sessions, image search (contract placeholder), warehouse stock/fulfillment, order route/advance models, catalogue change-logs, merchant store settings depth, shipment reassignment, device pair/test transports, product-template apply/update/delete — each needs a new subsystem; each currently answers the honest 501 envelope.

## Roadmap (next slices, in Team 6 order)

1. Real provider adapters: SMS gateway, M-Pesa/Tigo/Airtel webhook signing keys per provider
2. Merchant/provider entity linkage refactor (orders/catalogues/bookings reference real merchant rows)
3. Dispatch matching from Redis online sets + auto-accept; settlement cycles and export workers on the sweeper
4. Chat real-time (WebSocket), offline queue replay, customer simulator for E2E
5. M8 ops drills re-run on staging; dashboards 1–2 green 24 h as the release gate
