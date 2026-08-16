# Customer App — Roadmap

Aligned with `functionalities/ROADMAP.md` phases P0–P7. Clients build against MSW mocks of the
contract until backend APIs ship — never wait on a deployed backend.

## Phases

| Phase | Scope | Backend dependency | Exit criteria |
| --- | --- | --- | --- |
| **P0 — Foundations** | Scaffold (Expo SDK + TS strict), OTP login (`request-otp`/`verify-otp`/`refresh`/`logout`), session handling, city picker (`GET /cities`), tabs | M1 auth + users | Login → city → home works; tokens in SecureStore; MSW parity |
| **P1 — Marketplace** | Explore (`GET /services`), merchant list/detail (`GET /merchants`, `/catalogues/{id}`), provider list (`GET /providers`), saved addresses | M2 cities/services/leads/approvals | Browse + search + filters; empty/error states per screen |
| **P2 — Transactions** | Cart, checkout, order create (`POST /orders`, Idempotency-Key), payment intent (`POST /payments/intent`), order history (`GET /orders/me`), order detail, cancel (`POST /orders/{id}/cancel`) | M3 orders + payments (sandbox) | Order happy path E2E green; price breakdown exact; refund pre-acceptance |
| **P3 — Bookings** | Booking form (`scheduledFor`, `durationMinutes`), booking create (`POST /bookings`), booking list/detail, customer completion (`POST /bookings/{id}/complete`), cancel | M4 bookings | Booking happy path E2E green; confirmation step blocks `completed` |
| **P4 — Dispatch** | Live tracking screen (`GET /orders/{id}/track`, `TrackingEvent`), rider map, ETA | M5 dispatch | Tracking renders rider location + estimate; stale/error states |
| **P5 — Money** | Refund display (intent `refunded`/`partially_refunded`), refund status on order/booking detail, payment method records | M6 payouts + ledger | Refund states visible on order/booking detail |
| **P6 — Engagement** | Reviews (`POST /reviews`, `report`), support tickets (create/list/detail/reply), chat with merchants (`POST /conversations`, messages list/send, `/read`, `/archive`, unread-count badge, blocked read-only state), notification center + preferences, push tokens | M7 reviews/support/notifications + conversations | Review after `completed`/`delivered`; ticket from order/booking; chat E2E green (open from order → send/receive → unread badge → mark read; blocked shows read-only); push events mapped |
| **P6b — Dine-in** | QR menu scan + payload validation (`hudumika:dinein:table:{id}`), dine-in order create (`POST /dine-in/orders`), bill pay + history (`/dine-in/orders/me`), table reservations (create/me/cancel) | M7b dine-in + reservations | QR → order → pay → close E2E green; reservation statuses rendered; split-bill marked planned |
| **P6c — Group buy + wallet** | Deals feed/detail (`GET /group-buys`), purchase (`POST /group-buys/{id}/purchase`), voucher wallet (`GET /vouchers/me`), coupon discovery (`GET /promotions`), claim (`POST /coupons/{id}/claim`), coupon wallet + checkout row, favorites | M7c group buy + promotions | Purchase → voucher → redeem E2E green; coupon discount in totals; red packets IMPLEMENTED (mock-until-adopted contract addition) |
| **P6d — Membership** | Platform membership card (`GET /memberships/me`: points, level, benefits); merchant loyalty explainer + consent copy; points accrual mapping deferred | M7d loyalty + staff + wallet | Membership screen live; loyalty copy with consent; points earning marked planned (membership IMPLEMENTED; points earning still planned) |
| **P6e — Super-app verticals (blueprint Phase 5)** | Hotels (search/detail/book + my bookings), travel (intercity bus/ferry/flight search/book), entertainment events (+ tickets), AI assistant chat, voice/image search, wallet withdrawals, invoices/receipts (list/detail/download), rider tips, referral + birthday rewards, live deals zone | M7e super-app contract surfaces (hotels/travel/events/assistant/rewards/finance/marketing) | All verticals IMPLEMENTED — screens + live repos (`src/repos/api/{hotels,travel,events,assistant,rewards,wallet,finance,orders,marketing}.ts`); rideshare stays out of scope |
| **P7 — Admin + launch** | Release readiness: perf, accessibility audit, stores submission, live payment certs | M8 admin API + hardening | Store release live; contract tests green against staging; rollback plan rehearsed |
| **P8 — Intercity tracking** | Route timeline (`GET /orders/{id}/route` — per-leg ETAs, Day-1/Day-2 phases), waybill trail (`GET /orders/{id}/waybill`), tracking-phases timeline (`GET /orders/{id}/tracking-phases` — `confirmed` → `picked_up` → `in_transit` → `arrived_city` → `out_for_delivery` → `delivered`, ORDER-FLOW.md), multi-day delivery-window promise, exception → new-ETA handling (`intercity.eta_updated`, `waybill.updated` exception rows) | M11 logistics lane (hubs, route legs, consignments, handoffs — `backend/INTERCITY-LOGISTICS.md`, definitive spec `backend/LOGISTICS-OS.md`) | Intercity order renders the full multi-leg timeline + waybill events; the 6-phase tracking timeline renders from physical legs; an exception updates the ETA end-to-end; E2E green (TESTING.md) |
| **P8b — Warehouse fulfillment** | Warehouse source chip + warehouse city (`fulfillmentSource: warehouse`), server strategy label (`dispatchStrategy` — e.g. "Arrives today via nearest warehouse"), warehouse-origin tracking phases, `warehouse.fulfilled` handling, stock-driven availability at checkout, customer-safe exception surface (banner + new ETA only) | M11b deep logistics lane (`backend/LOGISTICS-OS.md` section 19; `/warehouses` registry is admin/merchant-scoped — the customer app consumes only order/tracking payloads) | T5–T6 E2E flows green (warehouse-fulfilled order flow; exception → new ETA); `warehouse.*`/`exception.*` internals never render customer-side (ORDER-FLOW.md, TESTING.md) |

### P8 — Tracking phase deliverables (full list)

1. **Intercity order header**: `fulfillmentType: intercity` badge, waybill number, origin → destination cities, delivery-window promise card.
2. **Six-phase timeline**: fixed strip `confirmed → picked_up → in_transit → arrived_city → out_for_delivery → delivered` with `pending`/`active`/`completed` pills and per-phase `at`/`eta` (no fabricated times on pending phases).
3. **Route timeline**: full leg journey (first_mile → linehaul → hub_transfer → last_mile) with `mode`, hubs, status pills, per-leg `etaAt`.
4. **Day sections**: "Day 1"/"Day 2" grouping from the leg plan; overnight legs stay alive via `leg.completed`/`handoff.completed`.
5. **Waybill trail**: expandable append-only events (`scanned`/`departed`/`arrived`/`sorted`/`delivered`/`exception`) with location + local time.
6. **Exception → new ETA**: amber delay banner, `waybill.updated` exception rows, window refresh from `intercity.eta_updated`; never a silent stall.
7. **Shipment ID "Advanced" disclosure**: SH-… number for support/claims, hidden by default; internal ids never shown.
8. **Per-screen states**: loading/empty/error/retry/success on every tracking screen; 404 → "Tracking unavailable" + retry.

Exit criteria additions: T1–T4 E2E flows green (full timeline, multi-day window, exception → new ETA, tracking-phases contract); MSW parity for the three endpoints.

### P8b — Warehouse fulfillment (regional warehouse model)

Backend gate: deep logistics lane (live in `backend/API-CONTRACT.yaml`;
`backend/LOGISTICS-OS.md` section 19 — regional warehouse model). Customer
deliverables:

1. **Warehouse source chip**: order detail renders "Ships from a local
   warehouse" + warehouse city when `Order.fulfillmentSource: warehouse`
   (read-only, server-set).
2. **Strategy label**: server-provided label for `Order.dispatchStrategy`
   (`warehouse` → e.g. "Arrives today via nearest warehouse"; other strategies
   render per the label table in ORDER-FLOW.md) — the app never composes
   strategy copy.
3. **Warehouse-origin tracking**: same six-phase strip with the warehouse as the
   journey origin (local: `picked_up` at the warehouse → `out_for_delivery` →
   `delivered`; cross-city: full `in_transit`/`arrived_city` journey with the
   Day-2 window).
4. **`warehouse.fulfilled`** (push + in-app) → refetch order + phases.
5. **Stock-driven availability**: checkout reflects warehouse stock through the
   standard `ORDER_ITEM_UNAVAILABLE` path; `WAREHOUSE_*` codes never render.
6. **Exception surface (customer-safe)**: `exception.created` / `exception.escalated`
   / `autoReplanned` never reach the customer app — delays render only as the
   amber banner + new ETA (`intercity.eta_updated`) and, for escalated
   incidents, the stronger banner + prefilled support ticket.

Exit criteria: T5–T6 E2E flows green (warehouse-fulfilled order flow;
delivery exception → new ETA); MSW parity for the order/tracking payloads;
assertions that `warehouse.stock_low`, `exception.*`, and `warehouse.*` internals
never render customer-side.

## Dependencies

- Contract frozen in P0 (payment methods, price model) — any schema change re-negotiated through
  `backend/API-CONTRACT.yaml`, never client-side.
- Payment sandbox (P2) gates real money tests; live provider certification gates launch.
- Reviews require `completed`/`delivered` eligibility server-side before the UI enables them.
- Chat (P6) builds on the `conversations` group of the same M7 milestone; `block` is staff-only
  (never called by the app) and the unread badge drives `message.received` push handling.
- Red packets, split-bill, and coupon-on-`OrderCreate` are contract additions — blocked on the
  contract, not on a deployed backend (feature flags until shipped).
- Group buy purchase and voucher flows build on MSW mocks of M7c endpoints from P6c; redemption
  verification is merchant-side and simulated in E2E only.

## Standing rules (from shared ROADMAP.md)

1. Follow the contract exactly; propose changes, never invent endpoints.
2. Every screen has loading / empty / error / retry / success states.
3. Every mutation sends an `Idempotency-Key`.
4. All money TZS with thousands separators.
5. English first; `sw` ready; `ar` capable.
6. No hardcoded URLs, phones, emails, or ratings — environment-driven.
7. Staff routes never appear in the customer app.

## Launch definition (customer app)

- Builds on TestFlight + Play internal tested against staging; production submitted.
- OTP login, order+pay, booking+confirm, tracking, reviews, tickets all E2E green.
- Push (production APNs/FCM) verified; deep links verified on cold start.
- Backend live with payments certification done; contract test suites green.
