# Customer App — Order Flow (Products)

Lifecycle per `SHARED-FLOWS.md` and `OrderStatus`/`OrderEvent` from the contract. Every screen has
loading / empty / error / retry / success states.

## Screen sequence

```
Home → Explore → Merchant list → Merchant detail → Catalogue → Cart
     → Checkout (address + payment method) → Payment → Order detail → Tracking
```

## Step-by-step

| Step | Screen | Calls | Notes |
| --- | --- | --- | --- |
| 1 | City picker | `GET /cities` | Persist city + service area; empty → "No service in this city" state. |
| 2 | Explore | `GET /services`, `GET /merchants` | Filter by category, distance, rating, price, availability, delivery time, verified. |
| 3 | Merchant detail | `GET /merchants/{id}` | `isOpen` gates cart actions; closed → banner + disabled add-to-cart. |
| 4 | Catalogue | `GET /catalogues/{merchantId}` | Item cards: name, `priceTZS`, `available`, options; `available: false` → disabled. |
| 5 | Cart | local (Zustand) | Line items `{catalogueItemId, quantity, options}`; quantity 1–99; edit substitutions/notes. |
| 6 | Checkout | — | Address selection (saved or new `AddressSnapshot`), delivery instructions, payment method. |
| 7 | Confirm | `POST /orders` + `POST /payments/intent` | See `PAYMENTS.md`; totals revalidated server-side (`ORDER_PRICE_CHANGED` → refresh catalogue). |
| 8 | Payment | — | Per-method UX; webhook moves status, never client callback. |
| 9 | Order detail | `GET /orders/{id}` | Timeline from `events[]` (by: system/merchant/rider/customer). |
| 10 | Tracking | `GET /orders/{id}/track` | Live map when `riderLocation` present; `estimateMinutes`. |

## Status timeline rendering

From `OrderStatus`, events rendered as timeline rows (`status`, `at` local, `by`, `note`):

```
draft → pending_payment → paid → merchant_accepted → preparing → rider_assigned
     → picked_up → delivering → delivered → completed
```

Terminal: `cancelled`, `refunded`, `failed`, `disputed` (danger pill + reason/support CTA).

- Active step highlighted with `brand-600`; completed steps `success`; skipped steps muted.
- Status changes arrive via push/in-app notification; on deep link the detail screen refetches.

## Live tracking screen

- Poll `GET /orders/{orderId}/track` (React Query refetchInterval ~15 s) or WebSocket when available.
- Render `TrackingEvent`: status chip, `riderLocation` marker, `estimateMinutes` ("~25 min"),
  `updatedAt` local time.
- Errors: stale `TrackingEvent` after timeout → "Location unavailable" + retry; network error →
  error state + retry; keep last known position on screen.
- App backgrounded: tracking continues via push events (`order.picked_up`, `order.delivering`).

## Intercity orders and multi-leg tracking

`Order.fulfillmentType` (`local` | `intercity` | `relay`) is server-determined — checkout never asks for it. `intercity` orders travel hub-to-hub (first_mile → linehaul → hub_transfer → last_mile) over one or more days; `relay` orders move through sequential rider handoffs within a region.

- Route timeline: `GET /orders/{orderId}/route` → `RouteSegment[]` renders the whole journey as a leg timeline — `type` (`first_mile`/`linehaul`/`hub_transfer`/`last_mile`/`return`), `mode`, `fromHubId`/`toHubId`, status pills (`pending`/`in_progress`/`completed`/`skipped`), and per-leg `etaAt` (local time). `leg.started`/`leg.completed` and `handoff.completed` advance the timeline without a manual refetch.
- Day phases: multi-day promises render as "Day 1" / "Day 2" sections derived from the leg plan; the delivery promise is a window ("Arrives Day 2, 09:00–14:00") from the leg ETAs — never a fabricated single ETA. `intercity.eta_updated` (push + in-app) refreshes the per-leg ETAs and the window.
- Waybill events: `GET /orders/{orderId}/waybill` → `{waybillNumber, events[]}` renders the tracking trail — `scanned`/`handoff`/`loaded`/`departed`/`arrived`/`sorted`/`exception`/`delivered` with location, actor, and local time; `Order.waybillNumber` shows on the order header for intercity orders.
- Exceptions: a missing order at arrival (`CONSIGNMENT_MISSING_ORDERS`) or a seal issue at handoff (`HANDOFF_SEAL_BROKEN`) raises `waybill.updated` with an `exception` event — the timeline shows the exception row, ops is notified (`consignment.exception`), and the customer receives a new ETA via `intercity.eta_updated`. The order never silently stalls.
- States: route and waybill screens follow the shared checklist — loading skeletons → empty ("No tracking events yet") → error + retry → success (timeline); 404 on either endpoint renders "Tracking unavailable" + retry.

## Logical tracking phases (intercity) — full operating spec

Customers see `GET /orders/{orderId}/tracking-phases` → `TrackingPhase[]` — six logical phases mapped from physical legs (the leg/vehicle states behind them are hidden: privacy + simplicity).

```
confirmed → picked_up → in_transit → arrived_city → out_for_delivery → delivered
```

### Phase table — what each phase shows

| Phase | Driven by (physical) | Renders (label + copy) | Customer-visible details |
| --- | --- | --- | --- |
| `confirmed` | order paid + shipment planned | "Order confirmed" | order number, waybill number, delivery-window promise, pickup origin city |
| `picked_up` | first_mile pickup scan (`package.scanned`) | "Picked up" | timestamp of pickup (local), origin hub, window promise updated |
| `in_transit` | line-haul trip `in_transit` (`trip.departed`) | "Traveling" | departure time, corridor ("Dar es Salaam → Mwanza"), expected arrival day/window |
| `arrived_city` | consignment arrival scan at the destination hub | "Arrived in your city" | arrival time at destination hub, sortation in progress, next phase ETA |
| `out_for_delivery` | last-mile assignment / shipment `out_for_delivery` | "Out for delivery" | rider assigned, live window ("Delivering today, 09:00–14:00") |
| `delivered` | delivery scan | "Delivered" | delivery timestamp, delivered-to (address confirmed), review prompt |

### Phase fields (exact)

`TrackingPhase`: `{phase: confirmed | picked_up | in_transit | arrived_city | out_for_delivery | delivered, label: string (server copy), status: pending | active | completed, at: date-time | null (local time when completed), eta: date-time | null (per phase)}`.

- The active phase highlights (`brand-600`); completed phases show timestamps; `pending` phases show **no fabricated time** — the ETA column renders only when the server provides `eta`.
- The timeline always renders all six phases as a fixed horizontal/vertical strip so the customer sees the journey shape from day one.

### Per-phase notifications

| Phase | Event | Channel | UI mapping |
| --- | --- | --- | --- |
| `confirmed` | `order.created` / `payment.success` | in-app + push | order detail opens; phase 1 active |
| `picked_up` | `package.scanned` (pickup) | push + in-app | phase 2 completes with timestamp; "Picked up" pill |
| `in_transit` | `trip.departed` | push + in-app | phase 3 completes; corridor + window shown |
| `arrived_city` | `consignment.arrived` | in-app | phase 4 completes; sortation note |
| `out_for_delivery` | `consignment.arrived` sortation → last-mile assignment | push + in-app | phase 5 completes; rider assigned |
| `delivered` | `order.delivered` | push + in-app | phase 6 completes; review prompt |

Secondary events that refresh the timeline without changing phases: `handoff.completed` (in-app), `consignment.departed` (in-app), `waybill.updated` (in-app), `intercity.eta_updated` (push + in-app).

### Delivery-window promise (multi-day)

- The ETA is a **window** derived from the leg plan — "Arrives Day 2, 09:00–14:00" — never a fabricated single ETA.
- The window renders on the order header and next to the active phase; it updates only from server events (`intercity.eta_updated`), never from local computation.
- Overnight legs are normal: the timeline stays alive overnight via `leg.completed`/`handoff.completed` events; "Day 1"/"Day 2" sections come from the leg plan.

### Shipment ID display

- The `shipmentNumber` (SH-…) renders behind an **"Advanced" disclosure** on the intercity order detail for support/claims reference — hidden by default; package/container internal IDs (PKG-…, BAG-…, TRP-…) are never shown.

### Exception handling (missing / late → new ETA)

| Exception | Physical trigger | Customer experience |
| --- | --- | --- |
| Missing package at arrival | `CONSIGNMENT_MISSING_ORDERS` | amber banner "Your delivery is delayed"; waybill gains an `exception` row; new window via `intercity.eta_updated` |
| Seal broken at handoff | `HANDOFF_SEAL_BROKEN` | same amber banner + new ETA; ops resolves (re-seal or damage claim) |
| Replan to alternate trip | `plan.replanned` | corridor/window updates; `intercity.eta_updated` refreshes phases |
| Vehicle breakdown / late departure | `trip.departed` delayed or `vehicle_delayed` exception | window slides via `intercity.eta_updated`; the active phase `eta` re-renders |

- The timeline keeps the phase position and never silently stalls; the order never shows a stale single ETA.

### Tracking timeline UI (full description)

The intercity tracking screen renders, top to bottom:

1. **Order header**: order id, waybill number, `fulfillmentType: intercity` badge, origin → destination cities, the delivery-window promise card ("Arrives Day 2, 09:00–14:00") with the last-updated time.
2. **Six-phase timeline**: fixed strip of `confirmed → picked_up → in_transit → arrived_city → out_for_delivery → delivered`; each phase row shows the label, status pill (`completed` green check, `active` brand highlight, `pending` muted), and — only when the server provides it — `at` (local time) or `eta`.
3. **Day sections**: "Day 1"/"Day 2" grouping from the leg plan; overnight legs split the sections.
4. **Delay banner** (when present): amber, "Your delivery is delayed — new window: {window}"; CTA opens support with the order id prefilled.
5. **Waybill trail disclosure**: expandable append-only event list (scanned/departed/arrived/sorted/delivered with location + local time) for advanced users.
6. **Actions**: support CTA, "Advanced" disclosure for the shipment number, review CTA after `delivered`.

States: loading (phase skeletons) → empty ("No tracking phases yet" — only before the shipment is planned) → error + retry → success (full timeline). 404 on the endpoint → "Tracking unavailable" + retry.

## Warehouse-fulfilled orders (regional warehouse model)

When a merchant pre-positions inventory in a target-city warehouse, the server
can fulfill the customer's order from the **nearest warehouse** instead of the
merchant's own store. The customer never chooses this — it is server-selected
and communicated transparently.

### How the customer sees it

| Order field | Value | Customer rendering |
| --- | --- | --- |
| `Order.fulfillmentSource` | `warehouse` (vs `merchant`) | order header chip "Ships from a local warehouse" + warehouse city |
| `Order.dispatchStrategy` | `warehouse` | label on the order header / tracking screen — e.g. "Arrives today via nearest warehouse" (server copy; the app never composes the label from parts) |
| `Order.waybillNumber` | set | standard waybill display |
| `Order.fulfillmentType` | `local` (warehouse in the delivery city) or `intercity` (warehouse in another city) | standard local or intercity tracking surfaces |

### Stock-driven availability

- Warehouse inventory is pre-positioned stock (`warehouse_stock` per catalogue
  item); the server deducts stock when the order is fulfilled from the
  warehouse (`POST /warehouses/{id}/fulfill`, order tag).
- **The customer never sees warehouse stock counts.** Availability is expressed
  through the normal catalogue surface: an item without stock at both the
  merchant and the nearest serving warehouse is simply unavailable/sold out at
  checkout (`ORDER_ITEM_UNAVAILABLE`). If the nearest warehouse runs out after
  the merchant pre-positioned it, the server falls back to merchant fulfillment
  or declines with the standard item-unavailable path — never a partial order.
- `WAREHOUSE_STOCK_UNAVAILABLE` / `WAREHOUSE_NOT_FOUND` are server-internal
  paths (409/404 on the merchant/admin side); the customer app maps them to the
  standard unavailable-to-order states — never raw codes.

### The order journey (warehouse-fulfilled, same city)

```
Checkout → paid (order confirmed, "Ships from a local warehouse")
  → warehouse picks + packs → picked_up (scan at the warehouse)
  → out_for_delivery (warehouse last-mile rider assigned)
  → delivered → completed
```

- The pickup origin on the tracking screen renders the **warehouse**, not the
  merchant storefront; the merchant name remains the order's seller.
- For cross-city warehouses (`fulfillmentType: intercity`), the six-phase
  timeline is unchanged — `confirmed → picked_up → in_transit → arrived_city →
  out_for_delivery → delivered` — with the warehouse as the first-mile origin.

### Notifications

| Event | Channel | Customer UI mapping |
| --- | --- | --- |
| `warehouse.fulfilled` | push + in-app | "Your order is on its way from a local warehouse" — renders the warehouse source chip + the active phase; refetch order detail |
| `order.picked_up` (warehouse pickup scan) | push + in-app | `picked_up` phase completes with timestamp |
| `warehouse.stock_low` | merchant + ops (in-app) | never delivered to the customer app |

### Promise mechanics

- Same-city warehouse: "Arrives today" promise (delivery window from the
  last-mile leg ETA).
- Cross-city warehouse: the next-day/day-after promise — "Arrives Day 2,
  09:00–14:00" — exactly the intercity window mechanics (per-leg `etaAt`),
  with the warehouse as the origin.
- The promise is server-derived and updates only from server events
  (`intercity.eta_updated`, `warehouse.fulfilled`); the app never computes an
  arrival time.

### Warehouse fulfillment — per-screen state contract

| Screen | Loading | Empty | Error | Retry | Success |
| --- | --- | --- | --- | --- | --- |
| Order detail (warehouse source chip) | skeleton timeline | — | error + retry | retry | source chip ("Ships from a local warehouse") + warehouse city + standard timeline |
| Tracking phases (warehouse origin) | phase skeletons | "No tracking phases yet" | 404 → "Tracking unavailable" + retry | retry | six-phase strip with warehouse-origin copy on the header |
| Checkout (stock-driven) | — | — | `ORDER_ITEM_UNAVAILABLE` inline (item sold out at merchant + serving warehouses) | retry checkout after adjusting items | order created |

## Dispatch strategy labels (customer-facing)

`Order.dispatchStrategy` (`nearest | zone | multi_leg | relay | warehouse`) is
server-set and read-only for the customer. It surfaces only as a **label** on
the order header/tracking screen (server copy, localized):

| Strategy | What it means | Label rendering (server copy) |
| --- | --- | --- |
| `nearest` | instant on-demand dispatch of the nearest rider | no special label (default local flow) |
| `zone` | same-day zone coverage dispatch | "Same-day delivery" (when zone coverage applies) |
| `multi_leg` | cross-city leg plan (hub-to-hub) | standard intercity header ("Arrives Day 2, 09:00–14:00" window) |
| `relay` | sequential rider handoffs within a region | standard intercity/relay header; handoffs are invisible (logical phases only) |
| `warehouse` | nearest warehouse ships | "Arrives today via nearest warehouse" (same-city) or the Day-2 window (cross-city) |

Rules: the label renders only when the server provides it; the app never maps
strategy values to copy itself (localization + honesty — `DISPATCH_STRATEGY_INVALID`
is server-side only). Strategy is informational — it never changes cancel/refund
rules, payment flows, or support routing.

## Delivery exceptions — customer experience

The platform's 18-kind exception catalog (`/delivery-exceptions`, rider/ops
side) maps to a **small, honest customer surface**: the customer never sees
exception kinds or statuses — they see a delay banner, a new ETA, and, for
escalated incidents, a support path.

### exception.created → new ETA

| Physical trigger | Exception kinds | Customer experience |
| --- | --- | --- |
| Package missing at arrival | `missing_package` | amber banner "Your delivery is delayed"; waybill gains an `exception` row; new window via `intercity.eta_updated` |
| Wrong package / wrong hub / wrong vehicle | `wrong_package`, `wrong_hub`, `wrong_vehicle` | same amber banner + new ETA; ops re-routes (`autoReplanned`); phases keep their position |
| Vehicle breakdown / late vehicle / bus cancellation | `vehicle_breakdown`, `late_vehicle`, `bus_cancellation` | window slides via `intercity.eta_updated`; replan banner not shown to customers (the replan is internal); phases keep their position |
| Road closure / weather / hub congestion | `road_closure`, `weather_disruption`, `hub_congestion` | new window via `intercity.eta_updated`; delay banner copy stays generic ("delayed") |
| Recipient unavailable / refused | `customer_unavailable`, `package_refused` | standard failed-delivery / reschedule / RTO flow (existing exception handling below) |
| Scan/verification failure, route deviation | `scan_failure`, `route_deviation` | invisible unless it delays: then delay banner + new ETA |
| Damaged package | `damaged_package` | delay banner + new ETA; if contents are unusable, the refund/return path per payment rules |
| Security incident | `security_incident` | **escalated incident path** (below) |
| Reconciliation failure | `reconciliation_failure` | delay banner + new ETA; ops resolves via the reconciliation runbook (admin workflow 25) |

- The six-phase timeline always keeps its position; the active phase `eta`
  re-renders from `intercity.eta_updated` — never a fabricated single ETA.
- `exception.created` / `exception.resolved` notify ops and affected parties;
  the customer's own notifications are `intercity.eta_updated` (+
  `waybill.updated` in-app) only — exception internals never render.

### Escalated incidents → support contact

- `exception.escalated` (critical, ops manager) marks an incident (typically
  `security_incident`, or any exception that cannot be resolved in-window).
  The customer is **not** shown the exception — they see:
  - the delay banner with a stronger tone ("Your delivery has a problem — we
    are handling it"),
  - a support CTA that opens a prefilled ticket (`TicketCreate` with
    `orderId` + `requestId` context),
  - the order detail remains in its phase; refund/compensation follows payment
    rules if the order is ultimately lost (`refunded`/`partially_refunded`
    intent, `refund.processed` push/SMS).
- Never a silent stall: every open exception eventually resolves or escalates,
  and every resolution updates the customer timeline (`intercity.eta_updated`,
  `waybill.updated`, or the terminal order state).

### Warehouse-fulfilled exception nuance

For `fulfillmentSource: warehouse` orders, `warehouse.stock_low` alerts are
merchant/ops-only. If a warehouse runs out mid-fulfillment, the merchant fallback
path re-fulfills from the store and the customer sees the same delay banner +
new ETA — never warehouse internals.

## Cancellation rules (per SHARED-FLOWS.md)

| Window | Rule | UI |
| --- | --- | --- |
| Before merchant acceptance | Full refund (provider-timing caveat) | Confirm dialog: "Full refund" |
| After acceptance | Cancellation fee shown before confirmation | Dialog lists fee from policy; confirm sends `POST /orders/{id}/cancel` with `reason` |
| Merchant cancels | Reliability event + notify | Banner + push `order.cancelled` |
| Refund processed | — | `refund.processed` push; order shows `refunded`, amount in payments screen |

- `409` `ORDER_NOT_CANCELLABLE` → toast + refetch detail.
- Fee amounts displayed as `TZS 5,000` format; never float.

## Refund and dispute states

- `refunded` / `partially_refunded` intent → green "Refunded TZS X" card with intent `providerReference`.
- `disputed` → amber banner "Payment held while review is in progress"; support ticket CTA
  (`TicketCreate` with `orderId`); resolves to `refunded` or `completed` via `dispute.resolved`.
- `failed` → payment failed state: retry payment (new intent, same `Idempotency-Key` rules) or cancel.

## Advance (scheduled) orders

- Checkout shows a "Schedule for later" toggle → `scheduledAt` picker (future only; 422
  `ORDER_SCHEDULED_IN_PAST` renders inline under the picker).
- `OrderCreate.scheduledAt` → `Order.scheduledAt`; the order card shows the scheduled time, and
  `order.scheduled_reminder` (push + SMS, 30 min before) deep-links to the order detail.
- The status timeline is unchanged after `paid`; a scheduled order renders "Scheduled for <local
  time>" until the merchant day starts.

## Rush requests

- "Hurry up" button on active orders in `merchant_accepted` or `preparing`; one tap →
  `POST /orders/{orderId}/rush` → 204 (event recorded, merchant notified via `order.rush_requested`).
- `Order.rushRequestedAt` renders ("Rush requested at <time>"); button enters a cooldown until
  another rush is allowed.
- 409 `ORDER_RUSH_NOT_ALLOWED` → toast + refetch; button hidden on all other statuses.

## Reorder from history

- Order list/detail card action "Order again": reuses `items` (`catalogueItemId`, `quantity`,
  `options`) into the cart, then a new `POST /orders` with a fresh `Idempotency-Key`.
- `ORDER_ITEM_UNAVAILABLE` / `ORDER_PRICE_CHANGED` → refresh the catalogue and let the customer
  adjust line items before submitting.

## Favorites (saved merchants)

- Heart toggle on merchant detail: `POST /favorites` (`{merchantId}` → 204) and
  `DELETE /favorites/{merchantId}` (204); optimistic update with rollback on error.
- Saved tab lists `GET /favorites` (`MerchantPublic[]`); tapping a card opens merchant detail.
- Empty → "No favorites yet" + browse CTA.

## Rejected orders

- Merchant rejection happens before acceptance: `order.rejected` push + in-app, `Order.rejectReason`
  rendered as a banner on the order detail.
- Refund follows cancellation policy (full refund pre-acceptance; `refund.processed` push/SMS);
  the order renders terminal per `OrderStatus` (`cancelled`/`refunded`) with the reason.
- Rejection is never silent: banner + reason + support CTA (`TicketCreate` with `orderId`).

## Per-screen state contract

| Screen | Loading | Empty | Error | Retry | Success |
| --- | --- | --- | --- | --- | --- |
| Merchant list | Skeleton cards | "No merchants in this area" | Error card | Retry button | Cards grid |
| Catalogue | Skeleton items | "No items available" | Error card + retry | Retry | Item grid |
| Cart | — | Empty cart illustration + "Browse" | Checkout failure toast | Retry checkout | Cart summary |
| Checkout | Address/method skeletons | No saved addresses → add first | `ORDER_*` errors inline | Retry | Order created |
| Order detail | Skeleton timeline | — | Error + retry | Retry | Timeline + actions |
| Tracking | Map placeholder | No event yet | Location error + retry | Retry | Live map + ETA |
| Orders list | Skeleton | "No orders yet" | Error + retry | Retry | Paginated cards + status chips |
| Schedule picker | — | — | `ORDER_SCHEDULED_IN_PAST` inline | Retry | `scheduledAt` set |
| Saved (favorites) | Skeleton | "No favorites yet" | Error + retry | Retry | Merchant cards |
| Warehouse source chip (order detail) | Skeleton | — | Error + retry | Retry | "Ships from a local warehouse" chip + warehouse city + standard timeline |
| Tracking phases (warehouse origin / strategy label) | Phase skeletons | "No tracking phases yet" | 404 → "Tracking unavailable" + retry | Retry | Six-phase strip + server-provided strategy label (e.g. "Arrives today via nearest warehouse") |
| Exception delay banner | — | — | — | Retry | Amber banner + new window from `intercity.eta_updated`; escalated variant with prefilled support CTA |

Success feedback: toasts (top-positioned, per DESIGN-SYSTEM), status pill updates, haptic on order placed.
