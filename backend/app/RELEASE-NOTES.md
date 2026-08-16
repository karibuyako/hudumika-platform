# Hudumika Platform — Backend Release Notes

Module: `github.com/hudumika/api-backend` (Go 1.25) · Milestone: platform-wide M1–M8 (auth → real-time → ops)
Artifact for client teams (consumer-mobile, merchant, rider-mobile, provider, admin-web) and ops.

This milestone ships the production-shaped backend behind the API contract
(`backend/API-CONTRACT.yaml`): every contract operation answers a defined
shape (the contract-shape pin passes — zero undefined responses), state
machines are guarded and idempotent, money is exact, and the operationally
critical jobs (sweeper) now include the long-documented scheduled store
reopen. Client teams can switch off the mock repositories in the order
listed below.

---

## What shipped (auth → real-time → ops)

**Auth & identity.** OTP login (Redis-hashed codes, constant-time verify,
5-attempt lockout, per-IP rate limits, dev code `123456` outside
production), opaque refresh tokens (SHA-256 stored, atomic rotation,
reuse-rejected), access/refresh TTLs (`ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL`),
role-based route policy, MFA-verified staff gate on `/admin/*`, and admin
network isolation (`ADMIN_ALLOWED_IPS`, fails closed when set).

**Marketplaces.** One merchant/provider application per owner; staff
approval workflow with reasons; public merchant directory and profiles.
New in this release: the approval workflow is now **single-winner under
concurrency** and `changes_requested` has an explicit resubmission path
(see the compatibility notes — this is a client-visible flow change).

**Orders & commerce.** Orders (server-side price recompute, guarded
transitions, append-only events, scheduled/advance orders with pre-order
reminders), dine-in (tables, QR, reservations), group-buys and vouchers,
promotions/coupons, loyalty, catalogues (public + merchant-owned, bulk
import/export), search, favorites, reviews + moderation, chat.

**Money.** Payment intents (idempotent, amount server-side), HMAC-signed
provider webhooks with constant-time verification, escrow release, refunds,
an immutable append-only payout ledger with advisory-lock serialized
balances and statements, wallet projections (top-ups now create real
payment intents), QR payments, finance (cards, invoices, settlements,
reconciliation).

**Logistics & dispatch.** Hubs/vehicles/containers, shipments with waybill
+ custody state machines, trips and route legs, warehouse stock with
reserved/locked adjustments, consignments, admin control tower, rider
shifts/breaks/swap/trip bundles/trip sharing, rider offline sync replay
(sequence-gapped batches apply guarded transitions).

**Real-time.** `/ws` WebSocket endpoint (bearer or `?token=` auth, ping/pong
keepalive, sync-after replay, live push via Redis pub/sub — at-least-once),
`/events` long-poll (with a PostgreSQL event-log fallback when Redis is
absent), Expo Push delivery, outbound webhooks with a delivery worker
(FOR UPDATE SKIP LOCKED claims, HMAC-signed, backoff, dead-letter).

**Ops.** Sweeper jobs in the API process: auto-cancel stale orders, voucher
expiry, pre-order reminders, promotion/deal ticks, closure-protection
renewal, dispatch auto-assignment, settlements, export queue — and the new
**scheduled store reopen**. OTel spans over HTTP/PostgreSQL/Redis/provider
calls, Prometheus `/metrics`, Grafana dashboards, `/healthz` + `/readyz`,
graceful shutdown, backup/restore/verify-release drills.

---

## Client-compatibility notes

### Base path — `/api/v1`

The `/api/v1` prefix is owned by the contract `servers` block and terminated
by the API gateway; contract paths themselves are relative. Native apps must
point `EXPO_PUBLIC_API_URL` at the live backend **including** `/api/v1`
(e.g. `https://api.hudumika.co.tz/api/v1`); the dev mock gateway is the bare
host. Never hardcode `/api/v1` in app code. See `docs/API-BASE-CONVENTION.md`.

### Mocks that can now be switched off

All repositories are implemented against the live API. Switch them off one
at a time via the documented env switches (single switch per repo family,
default ON; production builds keep mocks off):

| App | Switch | Covers |
| --- | --- | --- |
| consumer-mobile | `EXPO_PUBLIC_MOCK_AUTH` | auth + users |
| consumer-mobile | `EXPO_PUBLIC_MOCK_HOME` | home feed + search |
| consumer-mobile | `EXPO_PUBLIC_MOCK_ORDERS` | orders, payments, bookings, reviews, notifications, support, conversations, merchants, providers |
| consumer-mobile | `EXPO_PUBLIC_MOCK_WALLET` | wallet, coupons, favorites, memberships, group-buy, dine-in, reservations |
| consumer-mobile | `EXPO_PUBLIC_MOCK_ASSISTANT` | assistant chat |
| rider-mobile | `EXPO_PUBLIC_MOCK_AUTH` / `_JOBS` / `_EARNINGS` / `_SUPPORT` / `_SAFETY` / `_VEHICLE` | per repository family |
| admin-web | `VITE_USE_MOCKS` (`'false'` → live), `VITE_ADMIN_API_URL` | global MSW switch |

Web apps keep the `VITE_MOCK_*` per-endpoint overrides; the native switch is
`src/repos/factories.ts` — screens never touch Mock/Api implementations
directly. Mock handlers register contract-relative paths under the dev-only
`/api/*` alias (an MSW alias for `/api/v1`). See `docs/MOBILE-MOCK-PATTERN.md`
and `docs/ENV-VARS.md`.

### Error-code stability

Every error carries `{code, message, requestId}`. Codes are stable and
clients must **switch on `code`, never on `message` text**. The full registry
lives in `backend/ERROR-CODES.md` (global codes: `VALIDATION_FAILED` 422,
`UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409,
`RATE_LIMITED` 429 with Retry-After, `INTERNAL_ERROR` 500). Contract paths
without a manual handler answer the honest `NOT_IMPLEMENTED` 501 envelope —
never a blank 404.

### Money is integers

All monetary values are **integer TZS** (`bigint` in storage, integer
schemas): order/item amounts, fees, tips, payout amounts, wallet balances,
top-up/withdrawal minimums. Commissions are integer basis points
(`commissionRateBps`). Never send or expect floats for money.

### Timestamps are UTC RFC3339

All timestamps are `timestamptz` (UTC) serialized as RFC3339, e.g.
`2026-08-16T06:30:00Z`. `expiresAt` on sessions/call intents and every
`scheduledAt`/`deadlineAt` follow the same rule. Schedule anything in UTC;
merchant-local display is the client's job (`store_settings.timezone` is
exposed for merchants).

### New public (unauthenticated) paths

These contract routes are auth-exempt and PII-unmasked — gateways/caches may
serve them hot:

- `GET /cities`, `GET /services`
- `GET /promotions`, `GET /group-buys` (public discovery only)
- `GET /merchants`, `GET /merchants/{merchantId}` (public profile)
- `GET /catalogues/...` (public catalogue reads)
- `/payments/webhooks/...` (provider webhooks — verify signatures server-side)
- `POST /monitoring/errors` (client error reporting)

### WebSocket `/ws`

Dial `ws(s)://<host>/ws` — the route sits outside the auth-wrapped tree and
authenticates itself: `Authorization: Bearer <token>` header or `?token=` for
browsers; failed auth is a plain JSON 401 before upgrade. Ping/pong keepalive
(60 s read grace), send buffer 16, max inbound frame 4 KiB. Reconnect with
the documented sync-after replay to fill the gap; live events arrive
at-least-once via Redis pub/sub relay.

### Merchant approval flow change (read this)

`changes_requested` is now a **terminal** staff decision. A merchant in that
state **resubmits by editing the application** (`PATCH /merchants/me`): the
profile update returns the row to `pending` (reason cleared) and staff can
decide again. Deciding an un-resubmitted `changes_requested` row answers
`409 MERCHANT_STATUS_CONFLICT`. Concurrent decisions are single-winner —
exactly one staff decision per application round succeeds, the rest get 409
(no silent overwrites).

### Scheduled store reopen (ops convention)

Merchants schedule a reopen by storing `{"scheduled_reopen": "<RFC3339>"}`
inside `store_settings.opening_hours` (sweeper-side convention only — the
merchant app never sets it, and the store-settings PATCH replaces
`opening_hours` wholesale, so re-set the marker after any hours edit). Once
the time passes and the chain store is inactive (`chain_stores.active =
false`), the sweeper flips the store active and removes the marker.

### Internal simulator key

`/internal/simulate/{order,chat,rush}` (staging/dev only, never production)
answers `403 FORBIDDEN` unless `SIMULATOR_KEY` is set and the request sends
`x-internal-key: <SIMULATOR_KEY>` (constant-time compare). The endpoints
drive the real order/chat/rush state machines end-to-end, including the
signed webhook path.

### Environment variables the client teams must know

- `EXPO_PUBLIC_API_URL` — live base **including `/api/v1`** (native); trailing `/` stripped.
- `EXPO_PUBLIC_MOCK_*` / `VITE_USE_MOCKS` / `VITE_MOCK_*` — mock switches (above).
- `VITE_ADMIN_API_URL` — admin live-API override when not same-origin.
- Backend-side (ops configures; clients feel the effects): `JWT_SECRET`,
  `OTP_DEV_CODE` (dev-only `123456`), `OTP_PAYLOAD_KEY`,
  `PAYMENT_WEBHOOK_SECRET` (webhooks 503 while unset), `SIMULATOR_KEY`,
  `MASKED_CALL_GATEWAY_URL` (masked numbers fall back to a deterministic
  placeholder while unset — fail-open), `EXPO_PUSH_ACCESS_TOKEN` (real push
  when set, in-app mirror stub otherwise), `ADMIN_ALLOWED_IPS`.
  Full registry: `docs/ENV-VARS.md`.

---

## Ops runbook pointers

- Deploy / secrets / rolling restart: `backend/DEPLOYMENT.md` (also `docs/ENVIRONMENTS.md`).
- Drills with signed records: `app/scripts/staging-drill.sh`,
  `app/scripts/dashboard-smoke.sh`, `app/scripts/selfcheck-24h.sh`; release
  gate `app/scripts/verify-release.sh`; backup/restore
  `app/scripts/backup.sh` / `app/scripts/restore.sh`; `docs/RUNBOOKS.md`.
- Migrations are deploy-step goose files (`app/migrations/`), never run at
  boot (`make migrate`); 00001–00058 applied. No new migration in this release.
- Sweeper cadence: `defaultInterval` 30 s in `app/internal/sweeper`; jobs are
  idempotent (crash mid-run healed by the next tick); one failing job never
  blocks the others (per-job logs).
- Observability: Prometheus `/metrics`, OTel export via
  `OTEL_EXPORTER_OTLP_ENDPOINT`, `app/dashboards/` (Grafana, drift-pinned by
  tests), health gates `/healthz` + `/readyz` (PostgreSQL + Redis).
- Simulator gate: set `SIMULATOR_KEY` on staging/dev boxes only; production
  must never set it (the whole surface 403s while unset).
- Error-code registry, auth, payments and the data model: `backend/ERROR-CODES.md`,
  `backend/AUTH.md`, `backend/PAYMENTS.md`, `backend/DATA-MODEL.md`.
