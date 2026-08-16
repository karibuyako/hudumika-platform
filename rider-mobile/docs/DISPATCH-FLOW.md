# HUDumika RIDER — Dispatch Flow

Server-driven assignment lifecycle per `backend/DISPATCH.md`. The rider never picks orders; dispatch scores candidates and assigns the top one (grab mode — a server-curated feed the rider chooses from — is a per-city config, section below).

## Online/offline state

- Toggle on Home calls `PUT /riders/me/availability` with `{online: true|false}` (204); the displayed state always reflects `RiderPrivate.online` from `GET /riders/me`, never a local flag.
- Constraint before going online: `verification === approved`; otherwise the toggle is disabled with the verification state shown.
- Offline: no offers; active deliveries are unaffected (toggle implies "stop new offers", never abandons deliveries).
- Failure handling: PUT fails → stay on the previous state + retry toast with the `ErrorResponse.message`. Background location off while online → Home warning ("Location sharing is off while online").

## Assignment lifecycle

```text
online → dispatch picks rider (server-side scoring)
  → push event order.rider_assigned + notification
  → OfferModal (120 s acceptance window)
      ├── Accept → implicit (dispatch applies rider_assigned); load GET /orders/{orderId}
      └── Reject / timeout → offer dismissed; next candidate tried server-side
```

- Accept: no POST needed — confirm to dispatch by tapping accept; then load `GET /orders/{orderId}` for detail. If 404/403 (offer stale), show "Offer no longer available".
- Reject: dismiss modal; pick a reason from `GET /riders/reject-reasons` (catalog below). Declines are not charged; repeated declines within one hour trigger a reliability penalty and — on high-demand orders — server-side fare escalation (section below).
- `advanceOrder` is used only from `picked_up` onward.

## Intercity lane (intercity & relay fulfillment)

- Orders with `Order.fulfillmentType: intercity` route through **legs**, not the local offer queue: dispatch builds the route (`routeSegments[]`: first_mile → linehaul → hub_transfer → last_mile, backend `INTERCITY-LOGISTICS.md`), and each leg is advanced by its assigned handler via `POST /orders/{orderId}/legs/{legId}/advance` (`start`/`complete`). Local riders see only the legs they handle (first_mile/last_mile/hub_transfer); line-haul riders see consignments + manifests, never individual customer orders (LONG-HAUL-RELAY.md).
- Transport-mode validation in matching: dispatch validates the rider's `RiderPrivate.transportMode` against the leg `mode` before assignment — a `local_motorcycle` rider is never offered a `linehaul_bus` leg; a misconfigured pool surfaces `TRANSPORT_MODE_INVALID` server-side. Matching is server-scored as always; the app never filters legs locally.
- Relay chains (`fulfillmentType: relay`): sequential riders within a region; each relay assignment is a normal dispatch offer (120 s window, same reliability rules), and the transfer between riders is a custody handoff (`POST /orders/{orderId}/handoff`) at a meeting point.
- Line-haul riders (`transportMode` `linehaul_bus`/`linehaul_truck`) go online as usual; Home shows the consignment feed (`GET /linehaul/consignments?status=`) instead of single-order offers. Local dispatch, line-haul scheduling, and hub sortation are independent queues (backend `DISPATCH.md`).
- Intercity legs count toward the active-delivery cap per assignment; ETAs come from the leg plan (`RouteSegment.etaAt`, `intercity.eta_updated`), never client-computed.

## Logistics OS dispatch lane (shipments, trips, vehicles)

The Logistics OS lane is a third independent queue beside local dispatch and
line-haul scheduling: **shipment-level** work (pickup/handoff/delivery scans),
**trip-level** work (loading/depart/arrive/unload), and **fleet-level** work
(vehicle/route assignment). Shipments flow through dispatch differently from
local orders — the unit of work is the physical package, not the commercial order.

### How shipments flow through dispatch vs local orders

| Dimension | Local order | Logistics shipment |
| --- | --- | --- |
| Unit of assignment | order (`POST /orders/{id}/accept`) | shipment/package (scan assignments, `POST /shipments/{id}/scan`) |
| Work surface | OfferModal (120 s window) | assignment card + scan screen (no accept window; scan completes the step) |
| Assignment proof | acceptance | the custody entry (actor + device + GPS + time) |
| Status authority | `OrderStatus` | shipment/package status enums + `CustodyEntry` chain |
| Capacity control | 3-delivery cap | compartment `capacity`/`used` on the vehicle |
| Error correction | POD/OTP verification | multi-factor handoff verification (3-step scan) |
| Audit trail | `order_events` | `custody_entries` (append-only) + `waybill_events` |

Dispatch assigns each shipment step to the role that must perform it:
- **Pickup step** → pickup rider (capability `shipment.pickup`), scoped by zone.
- **Hub steps** (`hub_in`/`hub_out`) → hub courier, scoped `shipment.current_hub == worker.hub`.
- **Line-haul step** → the trip's driver (trip assignment, not per-order offer).
- **Handoff step** → the receiving party of the next leg (three-step scan).
- **Last-mile step** → last-mile rider, only after the shipment reaches the destination hub (ABAC: the final address is revealed only when the last-mile leg starts).

### Transport-mode matching (exact rules)

- Matching validates `RiderPrivate.transportMode` against the leg `mode` before any assignment:
  - `local_motorcycle` / `local_car` → `first_mile`, `last_mile`, `hub_transfer` legs only.
  - `van` → first/last mile + short line-haul (`van` legs).
  - `linehaul_bus` → `linehaul` legs on bus routes (`Route.permittedVehicles` contains `linehaul_bus`).
  - `linehaul_truck` → `linehaul` legs on truck routes (`permittedVehicles` contains `linehaul_truck`).
  - `relay` → relay-chain assignments (sequential handoffs within a region).
- A mismatch is rejected server-side with `TRANSPORT_MODE_INVALID` — the offer never renders.
- Package-level constraint: `Package.attributes.allowedModes` and `compatible` also gate the leg mode; a `cold_chain` package with `allowedModes: ["refrigerated_truck"]` cannot be routed on a `linehaul_bus` leg (`COMPARTMENT_INCOMPATIBLE` at load, `INTERCITY_UNAVAILABLE`-style routing rejection earlier).

### Trip creation flow (dispatch)

1. **Corridor confirmed**: a `Route` exists for the city pair with `scheduledDepartures[]` and `permittedVehicles[]`; no route → `INTERCITY_UNAVAILABLE`.
2. **Consignments formed**: line-haul riders/carriers create consignments (`POST /linehaul/consignments` with `transportMode` matching the route's `permittedVehicles`); capacity per consignment (`CONSIGNMENT_FULL`).
3. **Vehicle assigned**: a `Vehicle` with `status: active`, compatible `temperatureCapable`/`securityCapability` for the cargo, and `permittedRoutes` containing the route.
4. **Trip created**: `POST /trips` `{routeId, vehicleId, consignmentIds[], scheduledDeparture?}` → 201 `Trip` `{status: planned, manifestSummary: {expectedUnits, verifiedUnits: 0, exceptions: 0}}`; `TRIP_ALREADY_ACTIVE` if the vehicle is already on another trip.
5. **Driver bound**: the trip appears in the assigned driver's Trips tab; dispatch may bind `driverId` at creation or hand the trip to an available driver of the matching mode.
6. **Loading**: `start_loading` → packages scan into compartments (`vehicle_load`), capacity/compatibility enforced; `verifiedUnits` climbs.
7. **Depart**: `depart` freezes the plan (`PLAN_NOT_MUTABLE` from here); `trip.departed` notifies hubs.
8. **Arrive/unload/complete**: `arrive` → `start_unloading` → scans out (`vehicle_unload`) → `reconcile` → `matched` → `complete`.

### Dispatch duties on the lane

- **UNASSIGNED / ACTIVE / AT RISK** triage (dispatcher UI): unassigned trips, active trips on corridor, at-risk trips (delayed past window, exceptions, `vehicle.status: maintenance`).
- **Reassign**: replan a consignment to an alternate trip/vehicle (`POST /linehaul/consignments/{id}/replan` `{reason, alternateTripId?, alternateVehicleId?}`); `PLAN_NOT_MUTABLE` once departed.
- **Escalate**: reconciliation failures (`TRIP_CANNOT_CLOSE`), anomalies (`SCAN_GPS_MISMATCH` / `SCAN_VEHICLE_STATIC`), seal-broken handoffs → ops workflows 23–24 (admin-web WORKFLOWS.md).
- **Capacity balance**: compartment `used` counts feed the dispatch view; never load past `capacity`.

## Reject-reasons and issue-reasons catalogs

- `GET /riders/reject-reasons` and `GET /orders/issue-reasons` return server-maintained `string[]` (e.g. `too_far`, `on_break`, `vehicle_issue`, `other`; `restaurant_not_ready`, `customer_not_responding`, `wrong_address`, `payment_issue`, `other`). The app never hardcodes either list.
- Reject sheet: loading (skeleton chips) → success (chips, tap submits decline) → empty (single "Decline" confirmation fallback) → error (retry; decline still allowed without a reason).
- Report-issue sheet on DeliveryDetail: reason chips → prefilled support ticket (`POST /support/tickets`, `orderId` set). Catalogs are context only; they never change order status.

## Order transfer (in-transit only)

- Transfer button on DeliveryDetail when the order is in-transit (`delivering`): `POST /orders/{orderId}/transfer` `{reason}` → 202 `{transferId, status: requested}`. Lifecycle: `requested` → `re_assigned` (card leaves the rider's list) or `cancelled` (rider keeps the order); `order.transfer_requested` notifies dispatch/ops.
- `TRANSFER_NOT_ALLOWED` (409): not in-transit — hide/disable per current status. `TRANSFER_ALREADY_REQUESTED` (409): transfer pending — show its `transferId`, no new request. Transfer never happens client-side; the rider always keeps the order until dispatch confirms.

## Task hold (fleet management)

- Hold button on DeliveryDetail: `POST /orders/{orderId}/hold` `{reason, until?}` → 200 `Order`; resume via `POST /orders/{orderId}/unhold` → 200 `Order` (`until` is a self-resume time, not a cancellation). One active hold per order (`HOLD_ALREADY_ACTIVE` 409 → show "Order already on hold"); `HOLD_NOT_ALLOWED` (409) outside the assignable window → button hidden per status. While held, the order is excluded from new offers and from the rider's feed; the hold clock shows "On hold until {local time}".
- `order.held` / `order.unheld` in-app notifications refresh rider + dispatch views; a held order reaching `until` resumes automatically server-side (card refetches on the next event). States: confirm sheet (reason required) → submitting → success (held pill) → error (retry; `HOLD_ALREADY_ACTIVE` → show pending hold instead).

## Heat zones and surge

- `GET /dispatch/heatmap?lat=&lon=&radiusKm=` (default radius 10) → `HeatmapZone[]` `{zoneId, name, polygon ("lon,lat" points), demandLevel, surgeMultiplier, activeOrders, activeRiders}` — `demandLevel` ∈ `low | medium | high | critical`; `surgeMultiplier` is the zone's active boost factor (1.0 = none); `activeOrders`/`activeRiders` are zone counts. Polygon edges render on the map; demand fills per level color (low muted → critical `danger` band).
- Positioning intent: the map guides idle riders toward `high`/`critical` zones — it never auto-assigns and never reveals individual rider positions (aggregate counts only).
- `surge.active` (zone boost started) push/in-app notifies riders in the zone; the map refreshes on the event.
- Errors: `HEATMAP_INVALID` (bad lat/lon) → inline error, retry; loading (map skeleton + zone chips), empty (no zones in radius — "No demand zones nearby"), success (zones + legend + surge badges).
- Surge on offers: when an offer lands in a surged zone, the OfferModal shows the zone's `surgeMultiplier` badge; exact money appears only after assignment via `GET /orders/{orderId}/fare` (`FareBreakdown.surgeMultiplier` factor + `surgeTZS` line, EARNINGS.md).

## Predictive demand and surge alerts (Phase 3)
- `GET /dispatch/forecast?lat=&lon=&horizonMinutes=` (default 15, 5–60) → `{generatedAt, zones[]}` of `PredictiveDemandZone` `{zoneId, name, polygon, predictedDemand: low|medium|high|critical, predictedSurgeMultiplier, confidence (0–1), windowFrom, windowTo}` (15-min-ahead, model-derived — quality per `backend/AI-LAYER.md`).
- Positioning: the Predictive Heat Map (NAVIGATION.md) shows where demand is predicted; idle riders reposition toward `high`/`critical` zones before demand lands — the forecast guides, it never auto-assigns.
- `forecast.surge_incoming` (push/in-app, 15 min ahead) alerts riders in a predicted-surge zone; the map refetches on the event.
- Render `confidence` and the `windowFrom`–`windowTo` range (low-confidence zones render muted). States: loading (zone skeletons) → `FORECAST_UNAVAILABLE` (model not ready) → empty-state variant + retry → success (predicted zones with `predictedSurgeMultiplier` badges).

## Prep-time and address confidence on offers (Phase 3)

- `DispatchOffer.predictedPrepMinutes` (nullable, ML merchant prep-time) renders on the OfferModal as "Ready in ~{n} min" — dispatch times pickup so the rider arrives as the order becomes ready; when null, no claim is rendered. `DispatchOffer.addressConfidence` (0–1, nullable) marks address-disambiguation confidence: below a server threshold the offer shows "Confirm pickup address" before acceptance; the value itself is never rendered raw (copy only). Fare escalation, scoring, and the 3-delivery cap are unchanged by prep-time predictions (server-side timing only).

## Fare escalation and scoring

- Fare escalation: when an offer is declined `n` times, dispatch raises the fare by a configured step, up to a cap (server-side, `backend/DISPATCH.md`); a re-offered order may therefore carry a higher `estimatedEarningsTZS` — the app renders whatever dispatch sends, never assumes a base value.
- Vehicle-type factor: dispatch scoring includes the rider's `vehicle` (dispatch-eligibility only; never visible in fares). The app shows "Riding: {vehicle}" on profile and never explains scoring details beyond the copy in Performance. Reliability scoring stays per `DISPATCH.md` anti-gaming (declines, cancellations after acceptance, no-shows).

## Mandatory rest and breaks (Phase 3)
- `RiderPrivate.availability.maxHoursPerDay` (default 12) drives rest reminders: after extended continuous driving the server pushes `rest.reminder` (push) with a break prompt; `RiderShift.continuousDrivingMinutes` shows the running count.
- Break action: `POST /riders/me/shifts/{shiftId}/break` `{action: start|end}` → 200 `RiderShift`. Errors: `BREAK_NOT_ALLOWED` (not during an active shift/not online) → inline message; `BREAK_ALREADY_ACTIVE` (409) → show the running break state. During a break, new offers pause server-side; the rider stays in the same shift (break ≠ clock-out).
- Mandatory rest: fatigue escalation or max-hours sweepers set `RiderShift.forcedRestUntil`; new offers are blocked with `REST_ENFORCED` ("Mandatory rest until {local time}") and `safety.rest_enforced` (push) fires with a rest countdown card; the counter resets after rest and offers resume automatically when `forcedRestUntil` passes. Opt-out: `rest.reminder` respects notification preferences (SECURITY.md); the break action stays available while the shift is `active`.

## Geofence auto-status and stage ETAs (Phase 3)
- Geofence auto-arrival: when the rider's position enters the merchant/customer geofence and speed checks confirm a stop, the server auto-advances `rider_arrived_pickup` / `rider_arrived_dropoff` (`backend/DISPATCH.md`); the app shows an auto-detected arrival banner and keeps the manual "I'm here" fallback. The auto-status is server-applied — the app renders the returned `Order`, never an optimistic local state.
- Stage ETAs: `GET /orders/{orderId}/track` → `TrackingEvent.stageEtas` `{merchantArrival?, pickup?, dropoff?}` (minutes, model-derived) — DeliveryDetail renders the current stage ETA and the next stage; the app never computes ETAs.

## Location reporting contract

- `POST /riders/me/location` `{lat, lon, accuracyM?, activity?, reportedAt?}` → 204. Throttled server-side: `LOCATION_RATE_LIMITED` (429) → drop the sample and back off (double the interval), never queue-and-spam. `LOCATION_INVALID` → discard and re-arm the sensor.
- `activity` ∈ `stationary | walking | cycling | driving`; uploads pause while `stationary` (battery), resuming on movement. Feeds `rider_locations` (dispatch ETA + customer `track`); the rider app renders nothing computed locally, and locations are never logged client-side.

## Missions display

- `GET /riders/me/missions?status=active|completed|expired` → `RiderMission[]`; card: title, progress (`completedDeliveries`/`targetDeliveries`), reward `TZS x,xxx` (separators, never floats), status pill (`active` `success`, `completed` neutral, `expired` muted).
- States: loading (card skeleton) → empty ("No missions" + filter toggle) → error (retry) → success (mission list); completion refreshes on `rider.mission_completed` (EARNINGS.md).

## Acceptance window (120 s)

- Countdown from the push payload time + 120 s (contract-defined, `DISPATCH.md`), never assumed server-local. At 0: modal auto-dismisses, next candidate tried — not an error state. Push while backgrounded: critical/priority notification + local "new offer" sound; deep-link opens the offer.

## Grab mode (available orders feed)

- Per-city config (rollout planned — ROADMAP P10b); when enabled Home shows "Available orders" alongside the online toggle.
- Feed: `GET /dispatch/available-orders?lat=&lon=&radiusKm=&limit=` → `DispatchOffer[]` — offer card: pickup/drop-off, `distanceKm` (pickup + drop-off), `predictedPrepMinutes` ("Ready in ~{n} min" when present), `estimatedEarningsTZS` (server-computed), `itemsSummary`, `paymentMethod`, `expiresAt` countdown, surge badge when in a surged zone.
- Fare estimate hint is static copy ("Base + distance fee + surge when applicable"); exact `FareBreakdown` only after assignment via `GET /orders/{orderId}/fare`. Expired offer → 404 `OFFER_NOT_FOUND` → "Offer no longer available", remove card, refetch feed; accepted offer → `rider_assigned` → standard pickup flow with the same scoring, reliability, 3-delivery-cap, and hold-exclusion rules as push offers.
- States: loading (card skeletons) → empty ("No available orders nearby — check back soon") → error (retry, `ErrorResponse.message` + `requestId`) → success (server-ordered cards).

## Batch/group orders

- Cap of 3 concurrent deliveries unchanged; dispatch never offers beyond it, in grab or push mode.
- Group-order pickup (Meituan 并单 / 顺路单 pattern): two or more assigned orders sharing a merchant or route → one batch pickup card: merchant, `paymentMethod`, per-order rows (id, status pill, items summary), "Pick up all" walks each pickup confirmation in sequence. Orders advance independently (`picked_up` → `delivering` → `delivered` per order, DELIVERY-FLOW.md); drop-off stays per-customer. Automatic route optimization is planned; until then the server provides the sequence and the rider may reorder manually (Batch trips below).

## Batch trips (multi-stop)

- Active batch trip resource: `GET /riders/me/trips` → `Trip` `{id, riderId, orderIds, status (active|completed|cancelled), stops[{orderId, sequence, stopType (pickup|dropoff), status (pending|arrived|done|failed)}], routeOptimized, earningsTZS, startedAt, completedAt?}`; full detail via `GET /riders/me/trips/{tripId}`. 404 `TRIP_NOT_FOUND` (no active trip) → empty state "No active trip" + online CTA. Stop statuses mirror the work: `pending` → `arrived` → `done` / `failed`; the trip completes server-side when the final stop is `done` and emits `trip.completed` (batch summary with `earningsTZS`, EARNINGS.md).
- Manual route reordering: Trip summary lists stops in sequence; drag-and-drop reorder → `POST /riders/me/trips/{tripId}/reorder` `{orderIds: [...]}` (new sequence — subset or full set of the trip's orders) → 200 updated `Trip` with re-sequenced stops (audited server-side). Errors: `REORDER_INVALID` (409 — order id not in the trip) → revert to the last server sequence + inline error; `REORDER_NOT_ALLOWED` (409 — trip completed) → reorder hidden once `status: completed`.
- States: loading (route skeleton) → empty (`TRIP_NOT_FOUND`) → error (retry) → success (stop list + route + earnings summary; reorder saves with a spinner, failure restores the previous sequence).

## Priority tagging and promo orders

- `Order.priority` ∈ `normal | express | vip`: VIP/express orders take precedence in dispatch (offered first, sequenced earlier in trips) and in list sorting (server sorts by deadline/distance). Order cards render a priority badge — `vip` `accent` gold tiny badge, `express` `brand-600` badge, `normal` no badge (DESIGN-SYSTEM.md); `normal` never claims a priority.
- Promo orders: `Order.promoCode` marks a rider promo order — the bonus is credited on completion as a `bonus` ledger entry referencing the code (EARNINGS.md). The rider app never validates or applies codes; `PROMO_INVALID` rejects unknown/expired codes at order level, and `promoCode` renders as read-only context on Order Detail.

## Active deliveries

- Home active list: `GET /orders/me?status=rider_assigned` (+ `picked_up`, `delivering`), up to 3. Card: merchant, order id, `deliveryFeeTZS`, status pill (`rider_assigned` → "Pickup pending", `picked_up` → "En route to customer", `delivering` → "Delivering", held → "On hold"). Push invalidates on `order.picked_up`, `order.delivered`, `order.cancelled`, `order.completed`, `order.held`, `order.unheld`.
- States: loading (card skeletons) → empty ("No active deliveries" + online CTA) → error (retry) → success (cards as above).

## Pickup → delivered

| Step | Trigger | Endpoint call | UI |
| --- | --- | --- | --- |
| `rider_assigned` | assignment accepted | — (dispatch applied) | Offer → DeliveryDetail |
| `picked_up` | rider at merchant, confirms (code/scan or manual + `note`) | `POST /orders/{orderId}/status {status: picked_up}` | PickupConfirm |
| `delivering` | after pickup, navigation starts | `POST /orders/{orderId}/status {status: delivering}` | NavToCustomer |
| `delivered` | proof of delivery confirmed | `POST /orders/{orderId}/status {status: delivered}` | ProofOfDelivery → DeliveredSummary |

- Each call returns the updated `Order`; the UI renders that, never an optimistic status. `409` → refetch the order and show its real status. 404 on detail after acceptance → toast + back to Home.

## Timeouts and fallbacks (`DISPATCH.md` table)

| Stage | Timeout | Rider app behavior |
| --- | --- | --- |
| Offer accept | 120 s | auto-dismiss, next candidate |
| Pickup | 15 min after `merchant_accepted` | warning banner + timer on DeliveryDetail; ops escalates server-side |
| Hold | `until` reached | card refetches, hold pill clears (auto-resume) |
| Mandatory rest | `forcedRestUntil` reached | offers resume automatically; rest countdown card clears |
| Re-assignment | on timeout/cancellation/rider failure | push event; card removed, toast explains |
| ETA to customer | updated on pickup | server updates `estimateMinutes` + `stageEtas`; app renders nothing computed |

## Re-assignment and ETA

- If the rider is removed, the order leaves the list via push (`order.cancelled` or a re-assign event); the app refetches `orders/me` and removes the card without requiring action. Re-assignment always appends an `order_events` row server-side.
- ETA comes from `GET /orders/{orderId}/track` → `TrackingEvent.estimateMinutes` and per-stage `stageEtas`; background location keeps `riderLocation` current so the customer sees movement.

## Destination filter (rider preference)

- `PUT /riders/me/destination-filter` `{enabled, lat?, lon?, area?, windowFrom?, windowTo?, maxDetourKm? (default 5)}` → 200 `DestinationFilter`; `DELETE` → 204 clears (Settings entry, NAVIGATION.md).
- Behavior: offers whose drop-off exceeds `maxDetourKm` from the destination are skipped before scoring — the rider never sees them, on push or grab surfaces; the filter auto-clears at `windowTo` or on manual clear. `DEST_FILTER_INVALID` (422, bad area/coords) → inline field error, previous filter kept; the active filter shows as context on the OfferModal (e.g. "Filter: home zone").

## Rating filter (customer floor)

- `RiderUpdate.ratingFilterMin` (nullable) via `PATCH /riders/me` → `RiderPrivate.ratingFilterMin`; orders from customers rated below the floor are not offered. `RATING_FILTER_INVALID` (422, out of range) → inline error, previous value kept; `null` clears the filter.

## Preferences screen (dispatch-related)

- `GET/PUT /riders/me/preferences` → `RiderPreferences` `{soundNotifications, autoAccept, longDistance, wifiOnlyMaps, destinationFilters[], language}` (`soundNotifications` required; defaults: `autoAccept: false`, `longDistance: true`, `wifiOnlyMaps: false`, `language: en`). `PREFERENCES_INVALID` (422, bad payload) → inline field error, previous values kept.
- `autoAccept` (default `false`): when enabled, incoming offers auto-accept within the acceptance window — no OfferModal; the app receives the assigned order (`order.rider_assigned`) and shows a brief "Auto-accepted" toast before opening DeliveryDetail. If the rider also taps accept manually, the server picks the outcome (first write wins — the app renders the returned order, never double-posts). Disabling restores the modal on the next offer; the 120 s window is unchanged.
- `longDistance` (default `true`): when off, long-distance offers are filtered server-side before scoring — never seen on push or grab surfaces (no client-side distance judgment).
- `destinationFilters` (`string[]`, empty default): saved destination-filter areas on the Preferences screen (chips with add/remove) — dispatch avoids offering orders away from a saved destination (same semantics as `PUT /riders/me/destination-filter` above: one live filter, multiple saved areas); `DEST_FILTER_INVALID` surfaces on the live-filter save, not the list edit.

## Suggested areas (AI positioning)

- `GET /dispatch/forecast` adds `suggestedAreas: string[]` — AI positioning suggestions ("areas to move toward", model-derived per `backend/AI-LAYER.md`). Home map renders them as chips over the predictive heat map (e.g. "Move toward — Kariakoo"): tap → external maps deep link. Suggestions, never assignments — the rider stays free to ignore them; `FORECAST_UNAVAILABLE` → chips hidden (same empty-variant as the forecast section).
