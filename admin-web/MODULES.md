# Private HUDumika Admin Web — Modules

React + Vite + TypeScript private operations console. Never linked from the public web; runs on a separate protected hostname. All data comes from the backend `/admin/*` API surface (see `API.md` and `backend/API-CONTRACT.yaml`).

## Module list

| # | Module | Purpose | Primary roles |
| --- | --- | --- | --- |
| 1 | Operations overview | Live metrics: active orders/bookings, pending approvals, open tickets, payout exceptions, stuck dispatch items | Super admin, ops manager |
| 2 | Customers | Search customers, view order/booking history, status flags (suspended, disputed), support tickets | Support, ops, compliance |
| 3 | Merchants | Applications, verification states, documents, commercial terms, suspension | Merchant ops, compliance, finance |
| 4 | Providers | Applications, verification, qualifications, trade/service areas, reliability scores | Provider ops, compliance |
| 5 | Riders | Applications, verification, vehicle, documents, reliability scores, online history, COD reconciliation | Rider ops, finance, compliance |
| 6 | Cities and service areas | Create/edit cities and service area polygons, coverage status | Content manager, ops |
| 7 | Service catalogue | Categories, services, pricing model (per_order/per_hour/per_visit), visibility | Content manager |
| 8 | Orders | Search all orders, status timeline, refunds, cancellations, dispute resolution, manual override assignment; dine-in orders in scope | Ops, finance, support |
| 9 | Bookings | Search all bookings, provider assignment view, no-show handling, disputes; reservations in scope | Ops, finance, support |
| 10 | Dispatch monitor | Stuck orders, acceptance timeouts, rider pool depth per city, escalation actions | Ops manager |
| 11 | Payments, refunds, payouts | Intents, refunds, payout batches, exceptions, reconciliation | Finance, ops |
| 12 | Reviews and moderation | Pending reviews, reports, publish/hide/delete, author velocity flags | Compliance reviewer, ops |
| 13 | Support tickets | Queue with SLAs, assignment, prioritization, escalation | Support agents, ops |
| 14 | Promotions | Campaign types, moderation queue, coupon campaign oversight, budgets | Content manager, ops |
| 15 | Content and SEO | Marketing copy, banners, service content, site metadata | Content manager |
| 16 | Audit logs | Immutable log query, export (permissioned and audited) | Compliance reviewer, super admin |
| 17 | Group buy operations | Deal queue, moderation decisions, sold voucher views, extension requests, expiry/refund edge cases | Content manager, ops |
| 18 | Voucher operations | Staff verification for disputes, verification history, refund handling | Support, ops |
| 19 | Messages and chat oversight | Read-only conversation search, message history review (masked), blocking with reason, abuse report routing | Support, ops, compliance |
| 20 | Enterprise chains | Chain list with tier/SLA/account manager view, monthly volume, suspension | Ops manager, finance, super admin |
| 21 | Integrations and webhooks health | Failing webhook monitor, integration disconnect oversight, retry backoff view | Ops manager, super admin |
| 22 | Data export queue | Export job queue, approval decisions, re-run, audited downloads | Compliance, finance, super admin |
| 23 | Fleet control tower | All riders across hubs, regions, and fleet types: live totals (`activeRiders`, `onlineRiders`, `activeOrders`, `inTransit`, `anomalies`, `openSos`), per-fleet-type and per-hub breakdown, drill into any rider; crash/fatigue/rest status | Ops manager, rider ops, super admin |
| 24 | Hubs & line-haul oversight | Hub list/CRUD, consignment monitor (manifesting/in_transit/at_hub/delivered/cancelled), missing-order queue, seal-broken incidents | Ops manager, logistics operations |
| 25 | Waybill & custody audit | Per-order scan trail, custody chain, damage-claim attribution | Ops manager, logistics operations, compliance |
| 26 | Logistics control tower | Network totals (`activeShipments`, `delayed`, `exceptions`, `atRisk`, `activeTrips`), live trips per hub, critical exceptions queue (`wrong_hub_scan`, `vehicle_delayed`, `package_missing`, `rider_no_show`, `seal_broken`, `reconciliation_failed`) | Ops manager, logistics operations, super admin |
| 27 | Reconciliation & custody audit | Consignment reconcile outcomes (matched/mismatch + `missingOrderIds`), custody-chain queries (`GET /shipments/{id}/custody`), logistics anomalies (`logistics_anomalies`) | Ops manager, logistics operations, compliance |
| 28 | Regional warehouses | Warehouse CRUD, serving cities, stock levels, stock-low monitor, fulfillment routing (`fulfillmentSource: warehouse`), bulk-inbound oversight | Warehouse manager, ops manager, logistics operations, super admin |
| 29 | Carrier management | Third-party carrier registry (CRUD), regions/modes coverage, status (`active`/`paused`/`suspended`), handoff monitor (`carrier.handoff_required`), pickup/drop-off scan oversight | Carrier manager, ops manager, logistics operations, super admin |
| 30 | Facilities & whitelists | Facility CRUD (geofence, `accessPolicy`), rider whitelist management (`PUT /facilities/{id}/whitelist`), entry logs, `NOT_WHITELISTED` incidents | Facility manager, ops manager, logistics operations, super admin |
| 31 | Fleet accounts | Fleet master accounts (create/update/suspend), driver sub-accounts (`RiderPrivate.fleetAccountId`), vehicles, regions, permissions, consolidated billing | Fleet account manager, rider ops, ops manager, super admin |
| 32 | Fleet management | Vehicle fleet by type, active/maintenance/offline/restricted status, vehicle detail (driver, capacity, compartments, current trip, maintenance, insurance, registration) | Rider ops, ops manager, dispatch manager, super admin |
| 33 | Hub operations | Hub dashboard (load, sortation, capacity, staff, vehicles, exceptions), hub performance | Ops manager, dispatch manager, regional ops manager |
| 34 | Trust & risk cases | Risk dashboard, cases, investigations, review actions (dismiss/block_user/block_provider/escalate/hold) | Risk & fraud, trust & safety, ops manager, super admin |
| 35 | Integration health | Integration health registry (9 categories: payment/maps/sms/email/pos/logistics/erp/crm/webhooks), healthy/degraded/down | Technical operations, ops manager, super admin |

## Module 5 — Riders: COD reconciliation

- Per-rider shift view from `GET /admin/riders/{riderId}/cod?from=&to=` → `RiderCodReconciliation`: `shifts[{shiftId, date, expectedTZS, collectedTZS, status, note?}]` and `totals {expectedTZS, collectedTZS, varianceTZS}`.
- Shift status: `reconciled` (declared cash matches owed COD), `pending` (not yet reviewed), `mismatch` (variance flagged for finance follow-up); mismatch rows carry a `note`.
- Ties to the rider's clock-out reconciliation (rider `SHIFT_CASH_MISMATCH`, rider EARNINGS.md): the shift's `cashCollectedTZS` / `cashReconciled` state feeds `expectedTZS` vs `collectedTZS` here. `COD_RECONCILIATION_UNAVAILABLE` renders an empty state (no shifts in range).
- Money renders `TZS x,xxx` integer with separators; `varianceTZS` is signed (expected − collected); mismatch decisions are audited (`cod.*`).

## Module 8 — Orders: manual override assignment

- `POST /admin/orders/{orderId}/assign-rider` `{riderId, reason}` (reason max 500) lets dispatch assign an open order to a specific rider for VIP/complex cases.
- The target must be online and in zone: otherwise `ASSIGN_RIDER_UNAVAILABLE`. Staff-only (ops manager + rider ops); 403 without permission.
- Every override appends an order event and an audit entry (`assignment.*`); the rider is notified. Used when auto-dispatch stalls (dispatch monitor) or the case needs a named rider.

## Modules 8 and 9 notes — dine-in and reservations
- **Dine-in orders** (`DineInOrder`) surface in order search. Statuses: `open` → `billing` → `paid` → `closed`, plus `cancelled`. Detail shows table, items, totals, and `paidAt`; the table's `currentOrderId` links bill to table.
- **Reservations** (`Reservation`) surface in booking search. Statuses: `pending`, `confirmed`, `seated`, `completed`, `cancelled`, `no_show`. Detail shows `partySize`, `scheduledFor`, table assignment, and note.

## Module 14 — Promotions

Campaign types (`PromotionType`):

| Type | Behavior | Oversight focus |
| --- | --- | --- |
| `discount` | Percentage or fixed discount on items | Discount depth vs margin |
| `spend_based` | Reward when an order total crosses a threshold | Threshold vs basket size |
| `instant_discount` | Immediate checkout discount | Discount + budget |
| `bargain` | Customer-driven haggling to a merchant-set floor price | Floor-price abuse |
| `coupon` | Coupon campaign distributed to customers | Quantity vs claimed |
| `traffic` | Platform-wide exposure the merchant buys into | Spend vs attributed revenue |

- **Queue and decisions**: `GET /admin/promotions?state=` filters `pending_review` / `live` / `paused` / `rejected` / `ended`. `POST /admin/promotions/{promotionId}/decision` takes `approved` / `rejected` / `paused` plus a required `reason` (max 1000). Every decision writes an audit entry and notifies the merchant (`promotion.moderated`). `paused` also applies to live campaigns (ops only).
- **Coupon campaign oversight**: compare `quantity` vs `claimedCount`; watch `COUPON_CAMPAIGN_SOLD_OUT` and `COUPON_ALREADY_CLAIMED` paths. Campaign status: `draft` / `live` / `ended`.
- **Budget anomalies**: track `budgetTZS` against `redeemCount` / `spendTZS`; flag `PROMOTION_BUDGET_EXCEEDED` and overlapping campaigns (`PROMOTION_CONFLICT_ACTIVE`). Performance view (`PromotionPerformance`) shows `impressions`, `clicks`, `redeemCount`, `spendTZS`, `attributedRevenueTZS`, `roiPercent`.

## Module 17 — Group buy operations

- **Deal queue**: `GET /admin/group-buys?state=` over `GroupBuyStatus`: `draft`, `pending_review`, `live`, `extended`, `delisted`, `ended`, `rejected`.
- **Moderation decisions**: `POST /admin/group-buys/{groupId}/decision` with `approved` / `rejected` / `delisted` + required `reason` (max 1000). Delist applies to live deals; merchant notified (`group_buy.moderated`); audit entry per decision.
- **Sold voucher views**: per-deal `GET /group-buys/{groupId}/vouchers` (status filter) shows what was sold; compare `soldCount` vs `quantity` on the deal.
- **Extension requests**: `POST /group-buys/{groupId}/extend` with `newEndsAt`; invalid windows rejected (`GROUP_BUY_EXTEND_INVALID`). Relist applications (`/relist`) return the deal to moderation.
- **Expiry/refund edge cases**: vouchers expire per `validityDays`; expired vouchers refund the customer and reverse the receivable. Watch `GROUP_BUY_QUANTITY_EXCEEDED`, `GROUP_BUY_ENDED`, `VOUCHER_REFUND_PENDING`.

## Module 18 — Voucher operations

- **Staff verification**: `POST /admin/vouchers/verify` with `{voucherCode}` for customer/merchant disputes; returns the `Voucher` or a stable code (`VOUCHER_INVALID_CODE`, `VOUCHER_ALREADY_USED`, `VOUCHER_EXPIRED`, `VOUCHER_NOT_REDEEMABLE_AT_MERCHANT`).
- **Verification history**: append-only per-store history; `result` is `redeemed` / `invalid` / `expired` / `already_used`. Staff verifications record the acting user.
- **Refund handling**: after a dispute decision, vouchers move from `unused` / `expired` to `refunded`; refunds follow payment rules and finance thresholds; every step is audited.

## Module 19 — Messages and chat oversight

- **Read-only search**: `GET /admin/conversations` filters by `merchantId` and `status` (`open` / `archived` / `blocked`) with cursor pagination. Rows are `ConversationDetail`: participants with `role` (`customer` / `merchant_staff` / `system`) and `maskedPhone`; customer and merchant data is masked by default.
- **Message history**: per-conversation messages from `GET /conversations/{conversationId}/messages` (`ChatMessage`, `authorRole` `customer` / `merchant_staff` / `system`). Used for oversight and review only; there is no reply path.
- **Blocking**: `POST /conversations/{conversationId}/block` requires a `reason` (max 500). Once blocked, both parties receive `CONVERSATION_BLOCKED`; both are notified (`conversation.blocked`); the action writes an audit entry (`conversation.*`). The block mutation lives outside the `/admin/*` prefix but is staff-only and MFA-gated by contract.
- **Abuse report routing**: reports and blocks route to moderation; staff may open a linked support ticket from the conversation for follow-up and SLA tracking.
- **Compliance access**: blocked-conversation history (participants, message history, block reason, actor, timestamps) is available to the compliance reviewer; messages remain append-only.

Staff never impersonate customers or merchants in chat: admin-web has no send-message path inside customer-merchant conversations. Replies happen only through the support ticket channel under the staff user's own identity.

## Module 20 — Enterprise chains

- **Chain list**: `GET /admin/chain` returns `ChainAccountAdmin` rows: `merchantGroupId`, `name`, `storesCount`, `tier` (`standard` / `enterprise`), `slaLevel`, `accountManager`, `monthlyVolumeTZS`, `status` (`active` / `suspended`).
- **Tier/SLA/account manager view**: read-only overview per chain; `tier` and `slaLevel` define the support commitment and `accountManager` names the owning staff member. The view flags `standard` chains whose `monthlyVolumeTZS` approaches the `enterprise` threshold for upgrade review.
- **Monthly volume**: `monthlyVolumeTZS` is the basis for tier eligibility checks and enterprise commercial reviews.
- **Suspend**: suspending a chain is a status mutation and requires a `reason`; it writes an audit entry (`chain.*`) and disables merchant-group operations. Suspension is ops-manager-and-above only; the decision is never client-composed.

## Module 21 — Integrations and webhooks health

- **Failing webhook monitor**: `GET /admin/webhooks?failingOnly=true` lists `WebhookDelivery` rows (`status` `success` / `failed` / `retrying`, `attempts`, `statusCode`, `nextRetryAt`, `deliveredAt`); omit the filter for the full delivery stream.
- **Integration disconnect oversight**: `integration.disconnected` notifications surface disconnected integrations (POS, ERP, accounting, payroll, delivery partner); admin-web renders the notification trail and routes follow-up to the merchant owner.
- **Retry backoff view**: `retrying` deliveries show `attempts` and `nextRetryAt` so ops can judge backoff progress; persistent failures surface `WEBHOOK_DELIVERY_FAILED` and the `webhook.delivery_failed` notification to the merchant owner.

## Module 22 — Data export queue

- **Job queue**: `GET /admin/data-exports` lists `DataExportJob` rows: `scope` (`all` / `orders` / `customers` / `catalogue` / `financial`), `format` (`csv` / `xlsx` / `json`), `status` (`queued` / `processing` / `ready` / `failed`), `downloadUrl`, `expiresInSeconds`, `createdAt`, `completedAt`.
- **Approve / re-run**: large and enterprise-scope exports require an approval decision with a `reason`; re-runs resubmit `failed` or expired-`ready` jobs. Approvals and re-runs are server-gated and audited (`export.*`); the requester is notified (`data_export.ready`) with the `downloadUrl`.
- **Audit**: every download is logged (actor, scope, row count, timestamp); `DATA_EXPORT_IN_PROGRESS`, `DATA_EXPORT_SCOPE_INVALID`, and `DATA_EXPORT_RATE_LIMITED` render alongside the queue state.

## Module 23 — Fleet control tower

- **Overview**: `GET /admin/fleet/control-tower?hubId=&fleetType=` → `FleetOverview`: `totals {activeRiders, onlineRiders, activeOrders, inTransit, anomalies, openSos}`, `byFleetType[]` (`captive` / `contracted` / `outsourced` / `hybrid` with counts), and `hubs[]` (`hubId`, `name`, `region`, `activeRiders`, `activeOrders`, `anomalies`).
- **Filters**: `hubId` and `fleetType` round-trip server-side; `CONTROL_TOWER_UNAVAILABLE` renders an empty state with retry.
- **Drill-in**: each hub row opens its rider list; a rider row links to the Riders module (module 5) with safety context — open SOS (`openSos`), anomaly flags, and mandatory-rest state (`RiderShift.forcedRestUntil` — `REST_ENFORCED` blocks new offers).
- **Safety entry points**: crash/fatigue safety events (rider `safety-events` API) surface here as `anomalies`/`openSos` so ops can run the crash-response runbook (WORKFLOWS.md workflow 19) and rest enforcement (workflow 20).
- **States**: loading (stat skeletons) → empty (no data in range / `CONTROL_TOWER_UNAVAILABLE`) → error (retry) → success (totals + hub/fleet-type breakdown).

## Module 24 — Hubs & line-haul oversight

- **Hub list/CRUD**: `GET /hubs` (all authenticated staff) lists `Hub` rows (`id`, `name`, `cityId`, `address`, `capacity?`, `active`); `POST /hubs` (admin) creates/updates hubs via a drawer (name, city picker, address, capacity). Errors: `HUB_NOT_FOUND` (404), `HUB_FULL` (409, capacity). Every create/update writes an audit entry (`hub.*`).
- **Consignment monitor**: `GET /linehaul/consignments?status=` covers `manifesting`/`in_transit`/`at_hub`/`delivered`/`cancelled`; rows show corridor (`fromHubId` → `toHubId`), `transportMode` (`van`/`linehaul_bus`/`linehaul_truck`), `carrierId`, `orderCount`, `scheduledDeparture`, `departedAt`, `arrivedAt`; detail opens the manifest (per-order `waybillNumber` + `section` `standard`/`fragile`/`cold_chain`/`documents`/`high_value` with `scannedIn`/`scannedOut`).
- **Missing-order queue**: `CONSIGNMENT_MISSING_ORDERS` / `CONSIGNMENT_ORDER_MISMATCH` arrivals surface as exceptions (workflow 21); each row links the consignment + manifest difference.
- **Seal-broken incidents**: `HANDOFF_SEAL_BROKEN` handoffs flag the leg and order (workflow 22); the incident row shows the custody record (`from`/`to`/`at`, `sealIntact: false`) and links to the waybill trail.
- **States**: loading (list skeletons) → empty (no consignments in filter) → error (retry) → success (filter chips + table); exceptions carry a banner + CTA to the runbook.

## Module 25 — Waybill & custody audit

- **Per-order scan trail**: any order (module 8 access) opens `GET /orders/{orderId}/waybill` — append-only `WaybillEvent[]` (`scanned`/`handoff`/`loaded`/`departed`/`arrived`/`sorted`/`exception`/`delivered`) with `location`, `actor`, local time.
- **Custody chain**: each handoff records `from → to`, scan code, `sealIntact`, `conditionPhotoUrl`, and `at`; used to attribute responsibility for damage/loss claims — the handoff where the seal was last verified intact is the reference point.
- **Damage-claim attribution**: an order opened from the damage-claim queue shows its route (`GET /orders/{orderId}/route`, read-only) and custody chain side by side.
- **States**: loading (timeline skeletons) → empty (no events yet) → error (retry) → success (timeline + custody records). Read-only module; all views are audited (`waybill.*`, `handoff.*`).

## Module 26 — Logistics control tower (full spec)

The live network view of the Logistics OS: shipments, trips, exceptions and
at-risk items across all corridors. Data: `GET /admin/logistics/control-tower`
→ `ControlTower`. Roles: ops manager, logistics operations, super admin
(read-only).

### Metrics (every field, exact)

`totals`:

| Field | Meaning | Rendering |
| --- | --- | --- |
| `activeShipments` | shipments not yet delivered/cancelled (`planned`/`picked_up`/`at_hub`/`in_transit`/`out_for_delivery`) | headline stat card |
| `delayed` | shipments past their leg/window ETA | amber stat card |
| `exceptions` | shipments with `status: exception` or open logistics exceptions | red stat card |
| `atRisk` | shipments at risk of missing the delivery window (ETA within threshold, or on delayed trips) | orange stat card |
| `activeTrips` | trips in `planned`/`loading`/`in_transit`/`unloading` | stat card |

`tripsByHub[]` — the live network map:

| Field | Meaning | Rendering |
| --- | --- | --- |
| `hubName` | hub display name | map node + legend |
| `trips` | count of active trips touching that hub | node badge; node size scales with count |

The trips-by-hub map renders hubs as nodes with active-trip counts, connecting
corridors for `in_transit` trips; rows list every hub with its count for the
table view. `generatedAt` timestamps the snapshot.

### Critical exceptions queue (the 6 exception types)

`criticalExceptions[]` — `{shipmentId, type, detail?}`:

| Type | What it means | Detail examples | Row action |
| --- | --- | --- | --- |
| `wrong_hub_scan` | package scanned at a hub it was not expected at (`wrong_hub_scan` anomaly) | expected hub vs scanned hub | open shipment custody chain (module 27); workflow 24 |
| `vehicle_delayed` | a trip's vehicle running late past the window | trip id, minutes late | open trip; workflow 23/24 |
| `package_missing` | package not found at reconciliation/arrival | `missingOrderIds` context | open custody chain; workflow 23 |
| `rider_no_show` | assigned rider/driver failed to appear for pickup/loading | assignment id, window | reassign/replan; workflow 24 |
| `seal_broken` | handoff with `sealIntact: false` | handoff record id | open custody record; workflow 22 |
| `reconciliation_failed` | consignment reconcile `mismatch` | expected vs scanned, missing ids | open reconciliation; workflow 23 |

Each row: severity styling, `shipmentId`, `type` pill, `detail`; links to the
shipment custody chain (module 27) and the matching runbook (workflows 23–24).
The queue is machine-fed from the exception/anomaly stream — never manually
composed.

### States

Loading (stat skeletons) → empty (no network data in range — "No logistics data")
→ error (retry; `CONTROL_TOWER_UNAVAILABLE` → empty state + retry) → success
(totals + trips-by-hub + exception queue). Read-only for the listed roles;
403 `FORBIDDEN` handled per checklist.

### Platform operations control tower (`GET /admin/control-tower`)

The platform-level complement to the logistics tower: one screen for the whole
network (delivery + service). Data: `GET /admin/control-tower` →
`OperationsControlTower`. Roles: ops manager, dispatch manager, regional ops
manager, risk & fraud, trust & safety, super admin (view-only). Sits in the
Overview navigation group; every metric card links to the owning module.

`totals`:

| Field | Meaning | Rendering |
| --- | --- | --- |
| `ordersToday` | orders created today | headline stat card |
| `activeDeliveries` | deliveries in flight | stat card |
| `activeServiceJobs` | service bookings in flight | stat card |
| `providersOnline` | providers online now | stat card |
| `ridersOnline` | riders online now | stat card |
| `openIncidents` | open incidents (SOS, safety, escalations) | red stat card |
| `delayedShipments` | shipments past window | amber stat card |
| `pendingDisputes` | disputes awaiting decision | amber stat card |

`networkHealth` — the two network health splits (percentages; server-computed):

| Split | Fields | Rendering |
| --- | --- | --- |
| `deliveryNetwork` | `normalPct` / `delayedPct` / `criticalPct` | stacked health bar + legend |
| `serviceNetwork` | `normalPct` / `capacityIssuePct` / `criticalPct` | stacked health bar + legend |

`criticalActions` — the intervention queue (each count links to the matching
queue):

| Field | Links to | Row action |
| --- | --- | --- |
| `shipmentExceptions` | logistics control tower / delivery exceptions queue | open exception queue (module 26/27) |
| `providerIncidents` | provider incidents surface | open incidents |
| `paymentFailures` | payments module failure queue | open payment failures |
| `fraudCases` | risk cases (`GET /admin/risk/cases`) | open risk dashboard (module 34) |
| `slaBreaches` | SLA breach queue (`admin.sla_breach`) | open SLA queue |
| `hubCapacityWarnings` | hub dashboards (`GET /admin/hubs/{id}/dashboard`) | open hub list (module 33) |

`generatedAt` timestamps the snapshot. States: loading (stat skeletons) →
empty (no data — tower degrades to empty state on 5xx) → error (retry) →
success (totals + network health + critical actions). Read-only; 403
`FORBIDDEN` without permission. Response to critical alerts follows workflow
33.

## Module 27 — Reconciliation & custody audit (full spec)

The audit surface for the reconciliation engine and the custody ledger. Roles:
ops manager, logistics operations, compliance reviewer (read-only).

### Reconcile outcomes

Consignment reconcile runs (`POST /linehaul/consignments/{id}/reconcile` results)
render as an audit table:

| Column | Source |
| --- | --- |
| Consignment | `consignmentNumber` |
| Expected | `expected` (manifest units) |
| Scanned | `scanned` (units scanned at loading/unloading) |
| Missing | `missingOrderIds[]` |
| Status | `matched` (green) / `mismatch` (red) |
| Trip closed | `tripClosed` (boolean) |

- `RECONCILIATION_FAILED` / `RECONCILIATION_MISSING_PACKAGES` rows link to
  workflow 23 (identify → locate via custody → reroute or declare lost → close
  trip → notify → audit).
- The trip cannot close (`TRIP_CANNOT_CLOSE`) until a row flips to
  `matched` + `tripClosed: true` — the module surfaces open trips with pending
  reconciliations as a separate filter.

### Custody-chain queries

Any shipment opens `GET /shipments/{id}/custody` → `CustodyEntry[]`:

| Field | Use |
| --- | --- |
| `eventType` | timeline row label (`picked_up`/`hub_in`/`sorted`/`container_loaded`/`vehicle_loaded`/`departed`/`arrived`/`unloaded`/`handoff`/`out_for_delivery`/`delivered`) |
| `actorId` / `actorType` | who scanned (`rider`/`driver`/`hub_worker`/`carrier`/`system`) |
| `deviceId` | scan-device binding evidence |
| `previousState` → `newState` | state transition shown as an arrow |
| `evidence` | photo/seal reference |
| `lat`/`lon`, `at` | GPS + local timestamp |

Supports "where was the package at 15:00?" queries (search by time → nearest
entry) and damage/loss attribution (the last-intact-seal handoff is the
reference point).

### Logistics anomalies review

`logistics_anomalies` render as a queue:

| Column | Source |
| --- | --- |
| Type | `scan_gps_mismatch` / `scan_vehicle_static` / `wrong_hub_scan` / `scan_before_pickup` |
| Severity | `low` / `medium` / `high` |
| Shipment | `shipmentId` → custody chain link |
| Resolved | boolean pill; unresolved rows sort first |

Each row links to the shipment and to workflow 24 (verify device/actor →
block/freeze → audit); anomalies are never resolved client-side.

### States

Loading (table skeletons) → empty ("No reconciliation records" / "No anomalies")
→ error (retry) → success (tables + detail drawers). Read-only module; all views
are audited (`shipment.*`, `trip.*`, `reconciliation.*`, `anomaly.*` — AUDIT.md).

### Delivery-exceptions queue (extends modules 26 and 27)

Both modules surface the platform-wide exception catalog
(`/delivery-exceptions`, 18 kinds). Module 26 shows the live queue next to the
critical exceptions; module 27 shows the audit/resolution view.

`GET /delivery-exceptions?kind=&status=` → `DeliveryException[]`:

| Column | Source |
| --- | --- |
| Kind | 18-value enum (`missing_package`, `wrong_package`, `wrong_hub`, `wrong_vehicle`, `scan_failure`, `damaged_package`, `late_vehicle`, `vehicle_breakdown`, `rider_unavailable`, `bus_cancellation`, `hub_congestion`, `weather_disruption`, `road_closure`, `customer_unavailable`, `package_refused`, `route_deviation`, `security_incident`, `reconciliation_failure`) |
| Context | `shipmentId` / `orderId` / `tripId` (nullable) — each links to the shipment/trip view |
| Description | `description` (max 1000) |
| Reported by | `reportedBy` |
| Status | `open` / `resolving` / `resolved` / `escalated` pill |
| Auto-replanned | `autoReplanned` badge — plan recalculated automatically |
| Outcome | `outcome` (max 1000) + `resolvedAt` |

Filters: `kind` (18 chips), `status` (4 pills). Queue rules:

- **Priority ordering**: `escalated` first, then `open` (oldest first), then
  `resolving`; `resolved` rows collapse into the audit view (module 27).
- **Row actions**: open detail (`GET /delivery-exceptions/{exceptionId}`), open
  the linked shipment custody chain, run the resolution runbook (workflow 25).
- **Resolution**: `PATCH /delivery-exceptions/{exceptionId}` `{status, outcome?}`
  — `open → resolving → resolved | escalated`; `EXCEPTION_ALREADY_RESOLVED`
  (409) blocks re-opening (terminal states are terminal); every status change
  requires a `reason`-carrying outcome where the runbook demands it and writes
  an `exception.*` audit entry.
- **Escalation**: `status: escalated` sends `exception.escalated` (critical
  push) to ops managers — reserved for incidents (`security_incident`) and
  unresolvable-in-window cases; the customer app never renders exception
  internals (customer ORDER-FLOW.md).
- **Auto-replan flag**: `autoReplanned: true` rows link to the replan record
  (alternate trip/vehicle) and the `plan.replanned` / `plan.optimized`
  notifications; the customer ETA update (`intercity.eta_updated`) is asserted
  in the resolution flow.
- **States**: loading (queue skeletons) → empty ("No exceptions") → error
  (retry; `EXCEPTION_NOT_FOUND` on stale refs → refetch) → success (filter
  chips + queue table).

## Module 28 — Regional warehouses (full spec)

The regional warehouse registry drives next-day/day-after fulfillment
(pre-positioned inventory, `fulfillmentSource: warehouse`). Data:
`GET /warehouses` + `GET /warehouses/{warehouseId}`; mutations
`POST /warehouses`, `PATCH /warehouses/{warehouseId}`,
`PUT /warehouses/{warehouseId}/stock`. Roles: warehouse manager, ops manager,
logistics operations, super admin (workflow 26).

### Warehouse list

`GET /warehouses` → `Warehouse[]` — table columns:

| Column | Source |
| --- | --- |
| Name | `name` (max 120) |
| City | `cityId` → city name |
| Address | `address` (max 300) |
| Coordinates | `lat`/`lon` (nullable) |
| Serving cities | `servingCities[]` (count + chips) |
| Stock units | server-computed total of `stock[].quantity` |
| Status | `active` / `full` / `maintenance` pill |

Filters: `cityId`, `status`, free-text name search. Row → detail drawer.

### Warehouse create/update

- **Create** (`POST /warehouses`): name (required), `cityId` (required),
  address, `lat`/`lon`, `servingCities[]`, status. 201 → detail.
- **Update** (`PATCH /warehouses/{warehouseId}`): any field incl. `servingCities`
  and `status` (`maintenance` excludes the warehouse from fulfillment; `full`
  warns on inbound). Every mutation requires a `reason` and writes an
  `warehouse.*` audit entry.
- Errors: `WAREHOUSE_NOT_FOUND` (404 → empty variant), `VALIDATION_FAILED`
  (422 → inline field errors), 403 `FORBIDDEN` (roles outside the module).

### Stock levels and bulk-inbound oversight

- `GET /warehouses/{warehouseId}` returns `stock[]` (`{catalogueItemId,
  quantity}`); the detail Stock tab renders item rows with quantities + low
  pills (below the serving threshold — `warehouse.stock_low` in-app to merchant
  + ops).
- Bulk inbound: `PUT /warehouses/{warehouseId}/stock` `{items:
  [{catalogueItemId, delta}]}` — the same endpoint the merchant console uses.
  Admin may run it on the merchant's behalf (e.g. after a received shipment):
  positive `delta` = inbound, negative = write-off/return (reason captured,
  `INVENTORY_NEGATIVE_STOCK` guard).
- Stock-low monitor: rows from `warehouse.stock_low` notifications render as a
  list with the warehouse, item, quantity, and "Merchant to replenish" CTA
  (notification to the merchant owner).

### Fulfillment routing

- Orders fulfill from the nearest serving warehouse via
  `POST /warehouses/{warehouseId}/fulfill` `{orderId}` (order tag — the run is
  server-driven; admin-web renders the routing state, never calls fulfill on
  behalf of a customer order).
- Routing state surfaces per order: `Order.fulfillmentSource` (`merchant` /
  `warehouse`), `Order.dispatchStrategy: warehouse`, the `warehouse.fulfilled`
  notification trail, and — when routing failed — `WAREHOUSE_STOCK_UNAVAILABLE`
  / `WAREHOUSE_OUT_OF_SERVICE` fallback records (order fulfilled from the
  merchant store instead).
- The module shows serving-city coverage per warehouse (which cities get the
  next-day promise from which warehouse) and the last-fulfillment log.

### States

Loading (table skeletons) → empty ("No warehouses" + Create CTA) → error
(retry; 404 → empty variant) → success (list + detail drawer + stock tab +
routing view). Every mutation: reason prompt → loading → success toast →
audit entry visible on the timeline.

## Module 29 — Carrier management (full spec)

Third-party line-haul carrier registry (SF-style integrations). Data:
`GET /carriers`, `POST /carriers`, `PATCH /carriers/{carrierId}`. Roles:
carrier manager, ops manager, logistics operations, super admin (workflow 27).

### Carrier registry

`GET /carriers` → `Carrier[]` — table columns:

| Column | Source |
| --- | --- |
| Name | `name` (max 120) |
| Modes | `modes[]` — `van` / `linehaul_bus` / `linehaul_truck` / `refrigerated_truck` / `train` / `air` |
| Regions | `regions[]` |
| Integration | `apiIntegration` (nullable — webhook/API handle) |
| Status | `active` / `paused` / `suspended` pill |

### Create/update

- **Create** (`POST /carriers`): name (required), `modes[]` (required), optional
  `regions[]`, `apiIntegration`. 201 → detail.
- **Update** (`PATCH /carriers/{carrierId}`): status/config changes — `paused`
  stops new handoffs to the carrier; `suspended` blocks all operations. Every
  mutation requires a `reason` and writes a `carrier.*` audit entry.
- Errors: `CARRIER_NOT_FOUND` (404), `CARRIER_UNAVAILABLE` (409 — region/mode
  not served by the carrier → pick another or expand the carrier's
  regions/modes), 403 `FORBIDDEN`.

### Handoff monitor

- `carrier.handoff_required` (push + in-app) fires when a line-haul consignment
  (`Consignment.carrierId` set) is ready for the carrier pickup. The monitor
  lists: consignment, corridor (`fromHubId` → `toHubId`), mode, scheduled
  pickup, status (`awaiting_pickup` → `picked_up` → `in_transit` →
  `dropped_off`), and the pickup/drop-off scan records (manual scans or webhook
  integration — `actorType: carrier` custody entries).
- Pickup/drop-off oversight: custody entries with `actorType: carrier` render
  in the consignment detail; missing scans past the SLA surface as
  `consignment.exception`-style rows → workflow 27 escalation.
- Coverage view: regions × modes matrix per carrier, showing where the platform
  may hand off line-haul legs (`CARRIER_UNAVAILABLE` when the pairing is
  missing).

### States

Loading (table skeletons) → empty ("No carriers" + Register CTA) → error
(retry) → success (registry table + detail drawer + handoff monitor + coverage
matrix).

## Module 30 — Facilities & whitelists (full spec)

Gated communities and business parks with fixed-rider credential access. Data:
`GET /facilities`, `POST /facilities`, `PUT /facilities/{facilityId}/whitelist`.
Roles: facility manager, ops manager, logistics operations, super admin
(workflow 28).

### Facility list

`GET /facilities` → `Facility[]` — table columns:

| Column | Source |
| --- | --- |
| Name | `name` (max 120) |
| Address | `address` (max 300) |
| Geofence | `geofence[]` (polygon vertices, `"lon,lat"`) |
| Whitelisted riders | `whitelistRiderIds[]` (count + chips) |
| Access policy | `accessPolicy` — `whitelist_only` (default) / `whitelist_or_otp` / `open` |
| Status context | derived: geofence completeness (empty geofence warning), recent `NOT_WHITELISTED` incidents |

### Create/update

- **Create** (`POST /facilities`): name (required), address (required), optional
  `geofence[]`, `accessPolicy` (default `whitelist_only`). 201 → detail.
- **Whitelist management**: `PUT /facilities/{facilityId}/whitelist`
  `{riderIds: uuid[]}` — the full replacement list (add/remove riders). Effects:
  `facility.whitelist_granted` (in-app) to newly added riders,
  `facility.whitelist_revoked` (in-app) to removed riders. Every mutation
  requires a `reason` and writes a `facility.*` audit entry.
- Errors: `FACILITY_NOT_FOUND` (404), `FACILITY_WHITELIST_EXISTS` (409, duplicate
  entry), 403 `FORBIDDEN`.

### Entry logs and NOT_WHITELISTED incidents

- **Entry logs**: geofenced entry scans (bind rider → facility → delivery) render
  as an append-only list: rider, facility, scan GPS vs geofence, custody entry
  link, result (granted / blocked).
- **Blocked entries**: `NOT_WHITELISTED` (403) incidents list the rider, facility,
  and the "Request access" ticket trail (if the rider opened one). Resolve by
  adding the rider to the whitelist (grant notification fires) or dismissing
  with a `reason`.
- **OTP fallback**: under `whitelist_or_otp`, one-time entry codes are issued
  and validated server-side; the module shows code issue/use records (masked).

### States

Loading (table skeletons) → empty ("No facilities" + Register CTA) → error
(retry) → success (list + detail drawer + whitelist editor + entry-log table +
incidents queue).

## Module 31 — Fleet accounts (full spec)

Fleet master accounts with driver sub-accounts (delivery companies). Data:
`GET /fleet/accounts`, `POST /fleet/accounts`, `PATCH /fleet/accounts/{id}`.
Roles: fleet account manager, rider ops, ops manager, super admin (workflow 29).

### Fleet account list

`GET /fleet/accounts` → `FleetAccount[]` — table columns:

| Column | Source |
| --- | --- |
| Name | `name` (max 120) |
| Owner | `ownerUserId` |
| Drivers | `driverSubAccountIds[]` (count + chips) — `RiderPrivate.fleetAccountId` links each driver |
| Vehicles | `vehicles[]` (count + chips) |
| Regions | `regions[]` |
| Permissions | `permissions` map (badge per capability) |
| Status | `active` / `suspended` pill |

### Create/update

- **Create** (`POST /fleet/accounts`): name (required), `ownerUserId`,
  `vehicles[]`, `regions[]`, `permissions`. 201 → detail.
- **Update** (`PATCH /fleet/accounts/{id}`): sub-account permissions, vehicles,
  regions, status. `suspended` disables master-dependent operations
  (`FLEET_ACCOUNT_SUSPENDED`). Every mutation requires a `reason` and writes a
  `fleet.*` audit entry.
- Errors: `FLEET_ACCOUNT_NOT_FOUND` (404), `FLEET_ACCOUNT_SUSPENDED` (409),
  403 `FORBIDDEN`.

### Sub-account drill-in

- Each `driverSubAccountId` links to the Riders module (module 5) — the driver's
  verification, service model (`serviceModel: fleet`), ratings, and reliability.
- **Driver linkage**: setting a rider's `serviceModel: fleet` +
  `fleetAccountId` is a rider-record mutation (rider ops, audited `rider.*`);
  the module surfaces the linkage state per driver.
- **Billing**: consolidated billing view per master — settlement totals across
  sub-accounts for the cycle (server-computed, money `TZS x,xxx` integer with
  separators); per-driver ledger rows link to the rider's payout view
  (finance role). The driver app never sees master totals (rider SECURITY.md).

### Vehicle and region ownership

- `vehicles[]` = company registry (Vehicle records the master owns); the module
  links to the vehicle detail (capacity, compartments, weight/volume ceilings —
  module 26 fleet context).
- `regions[]` = operating regions the master may dispatch in; the driver's
  `deliveryZone` must stay inside the master's regions where the master
  configures it (server-enforced).

### States

Loading (table skeletons) → empty ("No fleet accounts" + Create CTA) → error
(retry) → success (list + detail drawer + sub-account drill-in + billing view).

## Module 32 — Fleet management (full spec)

The vehicle fleet across the platform: every vehicle from motorcycle to
line-haul truck, with operational status and full vehicle context. Data:
`GET /vehicles` (registry; admin + rider tags). Roles: rider ops, ops
manager, dispatch manager, super admin (view-only in admin-web — vehicle
mutations stay rider/fleet-owner scoped; admin-web renders state, never
`PATCH /vehicles/{vehicleId}`).

### Vehicle list

`GET /vehicles` → `Vehicle[]` — table columns:

| Column | Source |
| --- | --- |
| ID / registration | `id` / `registration` |
| Type | `vehicleType` — `motorcycle` / `e_bike` / `bicycle` / `car` / `van` / `linehaul_bus` / `linehaul_truck` / `refrigerated_truck` |
| Driver | `operatorId` (driver/rider or carrier) → rider/vehicle link |
| Status | `active` / `on_trip` / `maintenance` / `retired` pill |
| Capacity | `capacity.totalUnits` + `maxWeightKg`/`maxVolumeL` (nullable) |
| Temperature | `temperatureCapable` badge |
| Security | `securityCapability` — `none` / `lockbox` / `cage` / `armored` |
| Current trip | `currentTripId` → trip view |

Filters: `vehicleType`, `status`, free-text registration/operator search.
Status grouping: **active** (online and available), **maintenance**,
**offline** (not reporting; derived from location staleness), **restricted**
(permitted-route/geofence restrictions or operator-rest).

**Vehicle type groups** (the fleet tree): **Motorcycles** (`motorcycle`,
`e_bike`, `bicycle`) · **Cars** (`car`) · **Vans** (`van`) ·
**Buses** (`linehaul_bus`) · **Trucks** (`linehaul_truck`,
`refrigerated_truck`) · Other — with Active / Maintenance / Offline /
Restricted status views per group.

### Vehicle detail

- **Driver**: `operatorId` — the assigned rider/driver (link to the Riders
  module, module 5) or carrier (module 29).
- **Capacity**: `capacity.totalUnits`, `maxWeightKg`, `maxVolumeL`, and
  per-compartment `compartments[]` — `standard` / `fragile` / `cold_chain` /
  `documents` / `high_value` with `capacity`/`used`/`usedWeightKg`/
  `usedVolumeL`; weight/volume usage bars.
- **Current trip**: `currentTripId` → trip detail (manifest summary,
  status `planned`/`loading`/`in_transit`/`unloading`/`completed`/
  `cancelled`, departure times); vehicle click on the live map opens this.
- **Location**: `currentLocation {lat, lon, updatedAt}` with staleness
  warning when the location is old (offline detection).
- **Maintenance**: vehicle status `maintenance` + the rider-side maintenance
  surface (`/riders/me/vehicle/maintenance`); the module renders the
  maintenance state and, where the contract exposes it, the maintenance
  record reference.
- **Insurance**: insurance/registration evidence surfaces per vehicle
  (document references rendered masked; expiry feeds
  `admin.compliance_expiring`).
- **Permitted routes**: `permittedRoutes[]` → routes (`GET /routes`) the
  vehicle may serve; route/type mismatches flag `TRANSPORT_MODE_INVALID`
  context.

### Compartment compatibility view

For each vehicle the module renders the compartment matrix against package
attributes (temperature, fragile, hazardous, highValue, maxTransitHours,
allowedModes): a package that needs `cold_chain` shows which vehicles can
carry it (`COMPARTMENT_INCOMPATIBLE` context when none in a corridor).

### States

Loading (table skeletons) → empty ("No vehicles") → error (retry;
`VEHICLE_NOT_FOUND` on stale refs) → success (list + detail drawer +
compartment matrix + map marker layer). View-only; `PATCH /vehicles/{id}` is
never called from admin-web (status/registration/capacity mutations are
rider/fleet-owner scoped; the module flags them as out-of-scope).

## Module 33 — Hub operations (full spec)

The hub operations dashboard + hub list with performance. Data:
`GET /hubs` (list) + `GET /admin/hubs/{hubId}/dashboard` (dashboard). Roles:
ops manager, dispatch manager, regional ops manager, logistics operations
(view-only); hub CRUD remains as module 24 (`hub.*` audit).

### Hub list

`GET /hubs` → `Hub[]` — table columns:

| Column | Source |
| --- | --- |
| Name | `name` |
| City | `cityId` → city name |
| Address | `address` |
| Capacity | `capacity?` (nullable) |
| Status | `active` pill |

Row → hub dashboard. Filters: `cityId`, free-text name search.

### Hub dashboard

Hub navigation tree: **Hub Overview · Incoming · Outgoing · Sorting ·
Containers · Capacity · Staff · Vehicles · Exceptions · Performance**.

`GET /admin/hubs/{hubId}/dashboard` → `HubDashboard`:

`load` — headline cards:

| Field | Meaning | Rendering |
| --- | --- | --- |
| `incoming` | inbound shipments/consignments | stat card |
| `outgoing` | outbound shipments/consignments | stat card |
| `awaitingSort` | units waiting in the sortation area (**awaiting sort**) | amber card when non-zero |
| `exceptions` | open exceptions at this hub | red card; links to module 26/27 |
| `capacityPct` | capacity utilization percentage | gauge; > 100 → capacity warning + control-tower `hubCapacityWarnings` |

`sortationQueues[]` — per-zone queue depth table (`zone`, `count`); zones
with deep queues render amber.

`staffOnDuty` — staffing level; low staffing vs load flags a review.

`vehiclesPresent` — vehicles at the hub; links to the fleet module (32) and
trip state.

`updatedAt` — snapshot timestamp; the dashboard polls for freshness.

### Performance

Hub performance views (derived): inbound/outbound throughput by shift,
sortation completion, exception rate, capacity trend; region aggregates for
regional ops managers.

### Errors and states

`HUB_NOT_FOUND` (404) → empty variant; `HUB_DASHBOARD_UNAVAILABLE` → empty
state + retry; 403 `FORBIDDEN` without permission. Loading (stat skeletons)
→ empty → error (retry) → success (load cards + sortation table + staff/
vehicles + exceptions link).

## Module 34 — Trust & risk cases (full spec)

The risk dashboard and case management surface. Data:
`GET /admin/risk/cases?status=&severity=` + `POST /admin/risk/cases/{caseId}/review`.
Roles: risk & fraud, trust & safety, ops manager, super admin. Every review
action requires a `reason` (max 1000) and writes a `risk_case.*` audit entry
(workflow 32).

### Risk dashboard

- Severity × status matrix: counts by `severity` (`low` / `medium` / `high` /
  `critical`) × `status` (`open` / `investigating` / `resolved` /
  `dismissed`); `critical` + `open` cells render red.
- Fraud-spike monitor: case-creation velocity per window; spikes surface on
  the platform control tower (`fraudCases`).
- Queue: `GET /admin/risk/cases?status=&severity=` with filter chips for both
  dimensions; rows: severity pill, `signals[]` chips, `status` pill, related
  entity counts, `createdAt`.

### Case detail

`RiskCase` fields render as:

| Section | Source |
| --- | --- |
| Severity | `severity` pill (`low`/`medium`/`high`/`critical`) |
| Signals | `signals[]` — `multiple_accounts`, `refund_ratio`, `refund_velocity`, `large_refund`, `withdrawal_anomaly`, `login_risk`, `unusual_order_pattern`, `order_delay`, `rider_inactivity`, `suspicious_cancellation`, `gps_spoof`, `rapid_decline`, `impossible_speed`, `multi_device`, `payment_abuse`, … |
| Related entities | `related` — `customerUserId`, `providerId`, `riderId`, `orderIds[]`, `deviceIds[]`, `ipHistory[]`; each link opens the universal entity view |
| Status | `status` pill (`open`/`investigating`/`resolved`/`dismissed`) |
| Outcome | `decidedAction` + `reason` (after a decision) |
| Audit trail | `createdBy`, `createdAt`, and `risk_case.*` audit entries |

### Review actions

`POST /admin/risk/cases/{caseId}/review` `{action, reason}`:

| Action | Effect | Notes |
| --- | --- | --- |
| `dismiss` | Case → `dismissed`; no entity changes | reason records why it was a false positive |
| `block_user` | Block the linked customer (`risk.block` required) | suspension path; reason required |
| `block_provider` | Block the linked provider (`risk.block` required) | suspension path; reason required |
| `escalate` | Route to ops manager / risk lead | unresolved-in-window cases; linked escalation notification |
| `hold` | Freeze the case while more signals gather | case stays `investigating`/`open` with a hold note |

Errors: `RISK_CASE_NOT_FOUND` (404), `RISK_CASE_ALREADY_DECIDED` (409 —
already-decided cases are terminal), 403 `FORBIDDEN`.

### States

Loading (dashboard skeletons) → empty ("No cases") → error (retry) →
success (matrix + queue + case drawer with the review stepper). Every
mutation: reason input first → loading → success toast → audit entry visible
on the case timeline.

## Module 35 — Integration health (full spec)

The platform integration health registry. Data: `GET /admin/integrations`.
Roles: technical operations, ops manager, super admin (view-only); payments
role sees the `payment` category in detail.

### Registry

`GET /admin/integrations` → rows `{provider, category, health,
lastCheckedAt, error?}` — table columns:

| Column | Source |
| --- | --- |
| Provider | `provider` (e.g. payment gateway, maps provider, SMS gateway…) |
| Category | `category` chip — `payment` / `maps` / `sms` / `email` / `pos` / `logistics` / `erp` / `crm` / `webhooks` |
| Health | `health` traffic-light pill — `healthy` (green) / `degraded` (amber) / `down` (red) |
| Last checked | `lastCheckedAt` |
| Error | `error` detail (nullable) |

### Behavior

- **Degraded**: partial availability; the row renders amber with the `error`
  hint and routes follow-up to the owning team (technical operations).
- **Down**: red pill; fires the admin "integration failure" alert (push
  critical); payment-category `down` fires the "payment provider down" alert
  and surfaces payment failures on the control tower.
- **History**: health-state transitions render on the integration timeline
  (audit `integration_health.*` reads; state changes logged by the
  monitor).
- Errors: `INTEGRATION_HEALTH_UNAVAILABLE` → empty state + retry; 403
  `FORBIDDEN`.

### States

Loading (registry skeletons) → empty ("No integrations") → error (retry) →
success (registry table + category filter chips + detail drawer with error
context and state history).

## Cross-module behaviors

- Every module list supports: filters, cursor pagination, export (permissioned), and row-level detail drawers.
- Every mutation requires a reason field (money, status, and moderation actions). Promotion and group buy approvals require reason + audit by contract.
- Sensitive fields (phones, payout accounts, documents) are masked by default; unmask is permissioned and audited.
- All views read from `/admin/*` endpoints only; admin-web never queries public endpoints.

## Provider-platform ops modules

- **Provider directory** — all registered providers with search/filter, performance monitoring, compliance tracking, suspension, blacklist.
- **Customer directory** — all customers with support and blacklist.
- **Territories** — service-area/zone configuration per category (planned).
- **Commission withholding** — settlement-level deduction visibility (finance).
