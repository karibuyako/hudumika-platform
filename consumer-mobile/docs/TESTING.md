# Customer App — Testing

Strategy: Jest (unit: price math + state machines), React Native Testing Library (component),
MSW contract tests (parity with `backend/API-CONTRACT.yaml`), Detox (E2E happy paths).

## 1. Jest unit tests

- **Price math** (`PAYMENTS.md` breakdown): build `PriceBreakdown` rows from integer TZS inputs;
  asserts subtotal/delivery/platform/tax/discount/total; no floats; formatting
  (`TZS 12,500`, `en-TZ` grouping).
- **State machines**: pure reducers mirroring `OrderStatus` and `BookingStatus` transitions used by
  timeline components.
  - Order: every allowed step, terminal jumps (`cancelled`, `refunded`, `failed`, `disputed`).
  - Booking: `awaiting_customer_confirmation` → `completed` only via customer action; `declined`,
    `no_show` handling.
  - Dine-in: `open` → `billing` → `paid` → `closed` rendering; reservation statuses
    (`pending`/`confirmed`/`seated`/`completed`/`cancelled`/`no_show`).
  - Invalid transitions never render (server rejects with `CONFLICT`; UI refetches).
- **Voucher/coupon logic**: quantity bound 1–20 (group buy), status rendering per
  `VoucherStatus`/`CouponStatus`; minimum-spend pre-check math (`subtotalTZS` vs
  `minimumSpendTZS`) with server override.
- **Idempotency key generation**: stable key for retry of the same attempt, new key for a new
  action, no key reuse across distinct mutations.
- **Date/currency helpers**: UTC parsing, local rendering, `scheduledFor` round-trip.

## 2. Component tests (RNTL)

- Status pill/timeline rendering for each `OrderStatus` and `BookingStatus` value.
- Cart quantity bounds (1–99), option selection, subtotal preview.
- Empty/error/retry states for every list and detail component (checklist below).
- Checkout validation: no pay button without valid address + total (PRODUCT.md acceptance).
- Bilingual pill rendering and locale switch.

## 3. MSW contract tests

- Handlers in `src/mocks/` are generated/verified against `backend/API-CONTRACT.yaml`
  (endpoints, request/response schemas, enums, status codes).
- Test assertions: every endpoint the app calls (see `API.md`) has a mock; enum values in mocks
  match the contract exactly; error shapes are `{code, message, requestId}`.
- CI job fails when the contract changes and mocks are out of parity (no hand-written endpoint
  drift).
- Dev mode uses the same mocks, so the app is fully exercisable offline.

## 4. Detox E2E (happy paths)

| Suite | Path |
| --- | --- |
| Order happy path | OTP login → city picker → browse merchant → catalogue → cart → checkout → M-Pesa intent (mock provider) → paid → timeline `paid → … → delivered → completed` → review prompt |
| Booking happy path | Service search → provider detail → booking form (`scheduledFor` + duration) → pay → `paid` → `provider_accepted` → `awaiting_customer_confirmation` → `POST /bookings/{id}/complete` → `completed` → review |
| Cancellation | Before-acceptance full refund dialog; after-acceptance fee dialog; `409` path |
| Role switch | Verify OTP for second role; data isolation assertion |
| Dine-in | QR scan (`hudumika:dinein:table:{id}`) → validate payload → table menu → add items → `POST /dine-in/orders` → request bill (mock asserts merchant receives `dine_in.bill_requested`) → merchant confirm → `paid` → close → `closed` → bill history |
| Group buy | Deals feed → detail (savings badge `priceTZS` vs `originalPriceTZS`) → purchase quantity → vouchers `unused` in wallet → present code/QR at merchant (mock verify `redeemed`) → wallet flips `redeemed` |
| Coupon | Merchant page `GET /promotions` → claim (`POST /coupons/{id}/claim`) → wallet `claimed` → apply at checkout → `COUPON_MINIMUM_SPEND_NOT_MET` path + success discount in `discountTZS` |
| Favorites | Heart on merchant detail → `GET /favorites` lists it → unfavorite → removed |
| Rush | Active order (`merchant_accepted`/`preparing`) → rush → 204 → mock asserts `order.rush_requested` notified; `ORDER_RUSH_NOT_ALLOWED` path |
| Advance order | Checkout schedule picker → `scheduledAt` → order listed with scheduled time → `order.scheduled_reminder` (mock) |
| Reservation | Reserve form (`partySize`, `scheduledFor`) → `pending` → `confirmed` → cancel (`RESERVATION_NOT_CANCELLABLE` path) |
| Chat from order | Order detail → "Chat about this order" → subject auto-prefilled, `orderId` linked → `POST /conversations` → thread sends message → mock merchant reply (asserts `message.received` emitted) → unread badge appears on conversation list → reopen thread → `/read` → badge clears; `MESSAGE_EMPTY`/`MESSAGE_TOO_LONG`/`MESSAGE_ATTACHMENT_INVALID` validation paths |
| Blocked chat | Mock conversation `blocked` (status + `conversation.blocked` notification) → thread renders read-only (banner, no composer, `system` notice); send returns 409 `CONVERSATION_BLOCKED` → composer stays hidden |
| Intercity tracking | Intercity order (`fulfillmentType: intercity`, `waybillNumber`) → route timeline renders all legs with per-leg `etaAt` and Day-1/Day-2 phases → `leg.started`, `handoff.completed`, `consignment.departed`/`consignment.arrived` advance the timeline → waybill trail shows `scanned` → `departed` → `arrived` → `sorted` → `delivered` → `intercity.eta_updated` refreshes ETAs → delivery-window promise ("Arrives Day 2, 09:00–14:00") derives from leg ETAs; 404 on route/waybill → "Tracking unavailable" + retry |
| Intercity exception | MSW arrival scan misses one manifest order → `CONSIGNMENT_MISSING_ORDERS` → `waybill.updated` `exception` row on the timeline + ops notified (`consignment.exception`) → new ETA via `intercity.eta_updated` → updated window renders; seal-broken variant (`HANDOFF_SEAL_BROKEN` at handoff) follows the same exception path |
| Intercity tracking phases | Intercity order → `GET /orders/{orderId}/tracking-phases` renders the 6-phase timeline (`confirmed` → `picked_up` → `in_transit` → `arrived_city` → `out_for_delivery` → `delivered`) with `pending`/`active`/`completed` pills and per-phase `at`/`eta`; phases advance from physical events (`package.scanned`, `trip.departed`, `consignment.arrived`, delivery scan) without exposing leg internals; delivery-window promise renders from leg ETAs; shipment number behind the "Advanced" disclosure; 404 → "Tracking unavailable" + retry |
| Tracking-phase exception update | MSW exception on a leg → `waybill.updated` `exception` event → amber delay banner + the active phase `eta` updates (`intercity.eta_updated`) → window re-renders; no fabricated single ETA |
| Warehouse-fulfilled order | Order with `fulfillmentSource: warehouse` + `dispatchStrategy: warehouse` → "Ships from a local warehouse" chip + warehouse city + server strategy label ("Arrives today via nearest warehouse") → `warehouse.fulfilled` push → warehouse pickup scan (`order.picked_up`) → `out_for_delivery` → `delivered`; checkout stock-driven availability (`ORDER_ITEM_UNAVAILABLE`, never `WAREHOUSE_*` codes); `warehouse.stock_low` asserted merchant/ops-only (T5 full flow) |
| Delivery exception → new ETA | Mock `vehicle_breakdown` (`exception.created` ops-side) → `intercity.eta_updated` new window → amber banner + phase `eta` re-render; escalated variant (`exception.escalated`) → stronger banner + prefilled support ticket; exception internals never render (T6 full flow) |

- E2E runs against MSW-backed build in CI and against staging on release candidates.

- **Detox scaffolding (2026-08)**: the Detox suite now lives in
  `app/e2e/` (`detox.config.js` + `e2e/jest.config.js` + `e2e/*.e2e.ts`),
  run via `npm run e2e:build` / `npm run e2e:test` (android emulator
  config `android.emu`, debug APK via `npx expo run:android`). Mapping to
  this section: `auth-flow.e2e.ts` (cold start + OTP login + logout),
  `order-flow.e2e.ts` (order happy path), `booking-flow.e2e.ts`,
  `cancel-flow.e2e.ts`, `dinein-flow.e2e.ts`, `groupbuy-coupon.e2e.ts`,
  `chat-blocked.e2e.ts`, `intercity-tracking.e2e.ts` (T1/T2/T4; T3/T6
  delay-banner assertions are written and skipped until the
  `simulateIntercityDelay` trigger gets a UI/dev entry point),
  `reservation-rush.e2e.ts` (reservation + favorites + rush; the rush
  positive path awaits a rushable seed order). Each spec header documents
  the exact labels/text it targets and every seed gap it needs.

### Intercity tracking — complete E2E flows

#### T1 — Full intercity tracking timeline

1. Seed: paid intercity order (`fulfillmentType: intercity`, `waybillNumber` set) with a leg plan (first_mile → linehaul → hub_transfer → last_mile), hubs A/B, and leg ETAs spanning two days.
2. Order detail renders the intercity header: waybill number, origin → destination cities, delivery-window promise card ("Arrives Day 2, 09:00–14:00"), six-phase strip all `pending` except `confirmed` (`completed` with timestamp).
3. Mock pickup scan → `package.scanned` → `picked_up` phase completes with its `at`; push + in-app notification mapped.
4. Mock `trip.departed` → `in_transit` phase `completed` with corridor + window; route timeline line-haul leg `in_progress`.
5. Mock `consignment.arrived` at the destination hub → `arrived_city` phase `active`; sortation note renders; `consignment.arrived` in-app row.
6. Mock last-mile assignment → `out_for_delivery` phase `completed` + rider-assigned copy.
7. Mock delivery scan → `delivered` phase `completed`; `order.delivered` push; review CTA appears.
8. Assert per phase: completed phases show `at`; the active phase highlights; `pending` phases show no fabricated time; all timestamps local.
9. Waybill trail disclosure: expandable list shows `scanned → departed → arrived → sorted → delivered` with locations and local times.
10. "Advanced" disclosure shows the shipment number (SH-…); package/container/trip ids never render.

#### T2 — Multi-day window and overnight legs

1. Seed legs with overnight linehaul (`etaAt` next day) → "Day 1"/"Day 2" sections render from the leg plan.
2. `intercity.eta_updated` (push) with a later window → active phase `eta` re-renders; the promise card updates; no fabricated single ETA anywhere.
3. Timeline stays alive overnight: mock `leg.completed`/`handoff.completed` overnight → phases advance without a manual refetch.

#### T3 — Exception → new ETA (missing package)

1. Mock `CONSIGNMENT_MISSING_ORDERS` at arrival → amber banner "Your delivery is delayed"; waybill gains an `exception` row (`waybill.updated` in-app); ops gets `consignment.exception` (critical — assert no customer row for it).
2. `intercity.eta_updated` delivers the new window → banner + active phase `eta` update; the six-phase position is kept.
3. Variant: `HANDOFF_SEAL_BROKEN` at a handoff follows the same exception path.

#### T4 — Tracking-phases endpoint contract

1. `GET /orders/{orderId}/tracking-phases` returns all six phases in contract order with `pending`/`active`/`completed` pills, `at`/`eta` per the schema (API.md); enum values exactly match the contract.
2. 404 → "Tracking unavailable" + retry; network error → error + retry; empty (`[]`) → "No tracking phases yet".
3. Phase advance asserts the physical-event mapping: pickup scan → `picked_up`; `trip.departed` → `in_transit`; `consignment.arrived` → `arrived_city`; delivery scan → `delivered` — leg internals never exposed.

#### T5 — Warehouse-fulfilled order flow (regional warehouse model)

1. Seed: paid order with `fulfillmentSource: warehouse`,
   `dispatchStrategy: warehouse`, `fulfillmentType: local`, warehouse in the
   delivery city (MSW `warehouse_stock` covering all items).
2. Checkout renders no warehouse choice (server-selected); order detail shows
   the "Ships from a local warehouse" chip + warehouse city + the strategy
   label "Arrives today via nearest warehouse" (server copy — asserted as
   server-provided, never client-composed).
3. Mock `warehouse.fulfilled` (push + in-app) → order refetches; tracking
   phases: `confirmed` completed, `picked_up` completes on the warehouse pickup
   scan (`order.picked_up`), `out_for_delivery` on last-mile assignment, then
   `delivered`; the six-phase strip always renders in fixed order (fast
   phases are marked per the server statuses, never client-invented skips).
4. The pickup origin on tracking = the warehouse (not the merchant storefront);
   the merchant name remains the seller.
5. Stock-driven availability: seed the serving warehouse out of stock for an
   item → checkout shows the standard `ORDER_ITEM_UNAVAILABLE` path (item sold
   out) — raw `WAREHOUSE_*` codes never render.
6. Cross-city variant: seed `fulfillmentType: intercity` with the warehouse in
   the origin city → full six-phase journey with the warehouse as the first-mile
   origin and the Day-2 window ("Arrives Day 2, 09:00–14:00") from leg ETAs.
7. `warehouse.stock_low` asserted as merchant/ops-only (never delivered to the
   customer mock).

#### T6 — Delivery exception → new ETA (customer surface)

1. Seed an intercity order mid-journey; mock a `vehicle_breakdown` exception
   (`autoReplanned: true`, `exception.created` on the ops side — asserted as
   never reaching the customer app).
2. `plan.replanned` (internal) → `intercity.eta_updated` (push + in-app) with
   the new window → amber delay banner "Your delivery is delayed — new window:
   {window}"; the six-phase position is kept; the active phase `eta` re-renders
   from the server value — no fabricated single ETA anywhere.
3. Variant — escalated incident: mock `exception.escalated` (critical, ops
   manager) → the delay banner strengthens ("Your delivery has a problem — we
   are handling it") + a support CTA opens a prefilled ticket (`orderId` +
   `requestId` context); exception kinds/statuses never render.
4. Variant — resolved: mock `exception.resolved` + `intercity.eta_updated` →
   banner clears or the window renders; `waybill.updated` gains an `exception`
   row in the advanced trail only.
5. Assert exception internals (`DeliveryException`, `autoReplanned`,
   `EXCEPTION_*` codes) never appear in any customer payload rendered.

## Per-screen state checklist

Every screen must verify (automated where possible):

| State | Assert |
| --- | --- |
| Loading | Skeletons render; no flicker of content/empty state |
| Empty | Correct empty copy + illustration + primary CTA (e.g. "Browse") |
| Error | Error card, no crash, stable `code` mapping (never raw message) |
| Retry | Retry re-runs the query; transient failure recovers |
| Success | Data renders; status pills correct; toast where specified |
Screens covered: city picker, home, explore, merchant list/detail, catalogue, cart,
checkout, payment, order detail, tracking, order list, booking form/detail/list,
completion confirm, reviews, notification center/preferences, support tickets,
account/addresses, dine-in (scan/menu/bill/history), reservations, group buy
(feed/detail/purchase), voucher wallet, coupon wallet/claim, checkout coupon row,
membership, favorites, chat (conversation list, thread, new conversation),
intercity route timeline (per-leg ETAs, Day phases), waybill trail, tracking-phases
timeline (6 phases, window promise, exception banner), warehouse source chip +
strategy label (order detail), warehouse-origin tracking phases, exception delay
banner + escalated-incident support CTA.

## CI gate

`jest` unit+component → MSW contract parity → Detox (smoke) on PRs; full E2E on release branch.
No build/test runs in docs scope; commands live in app `package.json`.
