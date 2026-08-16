# HUDumika Rider — Navigation Blueprint

Screen-to-screen structure for the rider mobile app (mobile only). Modelled on
the production-rider MVP screen inventory, adapted to the contract. Every node
maps to real contract endpoints; nothing beyond `backend/API-CONTRACT.yaml`.

## State machine, not pages

The app is a state machine with a flow graph, not a page list: `Offline → Online → Accept → Pickup → Delivery → Complete → repeat`. Every screen is a view over one machine state; exceptions branch the graph (failed delivery, reschedule, transfer, hold, break). Transitions call `POST /orders/{orderId}/status` and render the server-returned `Order` (never optimistic).

## 1. Onboarding & authentication flow

```
Splash ──▶ (optional) Onboarding intro screens ──▶ Login / Register
Login (OTP) ──▶ Document Upload ──▶ Verification (OTP; facial recognition planned)
──▶ Training & Test (planned, EDUCATION.md) ──▶ Home/Dashboard
```

- **Splash**: brand mark + version footer (`app.json` version); routes to
  `/dashboard` when a session exists, else `/login`; respects reduced-motion.
- **Onboarding intro** (optional): 3 swipes — orders on the go / earnings /
  safety; skipped after first launch (stored locally).
- **Login** (`POST /auth/request-otp` + `/auth/verify-otp`): phone-first,
  6-digit code, resend countdown, debug-code box in staging; "Forgot password"
  reuses the OTP flow (`purpose: password_reset`).
- **Register** (`POST /riders` application): profile → document upload (National
  ID, driver's licence, vehicle registration/photo, health certificate,
  insurance) → OTP verify → `VerificationState` pending → dashboard when
  approved; onboarding wizard mirrors the merchant `/onboarding/*` pattern.
- **Business/role mapping**: after login, `RiderPrivate.merchantIds` binds the
  rider to associated business(es); profile shows the businesses overview.

## 2. Main app flow (bottom tabs: Home | Orders | Earnings | Performance | Profile)

```
Home ──┬─ Online/Offline toggle  (PUT /riders/me/availability)
       ├─ Available orders (grab feed, only when grab mode enabled for the city;
       │    GET /dispatch/available-orders → offer cards with countdown, surge badge)
       ├─ Order list tabs (New/Assigned · Picked Up · In Progress · Delivered)
       ├─ Quick stats (completed today, total earnings)
       ├─ Time online (session duration since the current shift's
       │    `clockedInAt`, beside live earnings on the status panel)
       ├─ Today's shift card (GET /riders/me/shifts?scope=current; Clock In/Out, break)
       ├─ Heat map entry (GET /dispatch/heatmap)
       └─ Earnings summary (today's earnings + tips)
Orders ──▶ order cards (batch pickup card for grouped orders) ──▶ Order Detail
          └─▶ Trip summary (active batch trip: stops, reorder, batch earnings)
Earnings ──▶ Earnings Dashboard (Daily/Weekly/Monthly) ──▶ Earnings Analytics
          ──▶ Wallet v2 ──▶ Withdraw · COD reconciliation
          └─▶ Delivery History ──▶ /payouts/me/statement (per-order fare
                                  breakdown via GET /orders/{orderId}/fare)
Performance ──▶ Scorecard (GET /riders/me/performance) ──▶ Metric detail
             ──▶ Compare (team/fleet) ──▶ Safety detail ──▶ Leaderboard
             (GET /riders/me/leaderboard: metric × period switcher)
Profile ──▶ Profile edit ──▶ Business overview ──▶ Safety Center ──▶ Shift & Schedule
         ──▶ Settings ──▶ Help/Support ──▶ Logout
```

## 3. Order detail → delivery flow

```
Order Detail
├── Customer card (masked phone, address + pin, items + special instructions,
│                  payment method incl. COD)
├── Fare row (GET /orders/{orderId}/fare → FareBreakdown; hidden on
│              FARE_NOT_AVAILABLE)
├── Action bar: Navigate (external maps) · Call Customer · Update Status
├── Accept / Reject (GET /riders/reject-reasons; POST /orders/{id}/accept|reject)
├── Stage actions (PATCH /orders/{id}/status):
│    rider_assigned → rider_arrived_pickup → picked_up → delivering
│    → rider_arrived_dropoff → delivered → completed
├── Proof of delivery (POST /orders/{id}/proof-of-delivery: photo/signature/OTP)
├── COD: collect cash → QR presentation (POST /payments/qr) → cash ledger
├── Exceptions:
│    Failed/RTO (POST /orders/{id}/failed-delivery) ──▶ returning ──▶ delivered
│    Reschedule (POST /orders/{id}/reschedule) ──▶ rescheduled
│    Transfer (POST /orders/{id}/transfer) ──▶ requested → re_assigned
│    Report issue (ticket + GET /orders/issue-reasons)
└── Safety: SOS button (POST /sos) — always visible in header while delivering
```

## 4. Core flows (compact sequences)

**Registration** — splash → register → profile → documents → OTP → review → dashboard.
**Delivery** — online → push assignment (120 s window) → accept → navigate → pickup → POD/COD → delivered → completed → (optional) tip received (section 3).
**Grab mode** — online → available-orders feed (`GET /dispatch/available-orders`, per-city) → accept within countdown; expired → `OFFER_NOT_FOUND` → refetch (DISPATCH-FLOW.md).
**Batch trip** — batch assigned → Trip summary → per-stop arrive/pickup/drop-off → reorder → final stop `done` → `trip.completed` batch summary (section 6).
**Failed delivery** — customer unavailable at drop-off → `failed_delivery` + reason + photo → `returning` → returned; refund rules (DELIVERY-FLOW.md).
**Shift** — Clock In → online → Clock Out (COD reconciled; `SHIFT_CASH_MISMATCH`, EARNINGS.md); while the current shift is `active` with `clockedInAt` set, Home shows time online (now − `clockedInAt`, session duration) next to live earnings.

## 5. Screen states

Every screen: loading skeleton → empty state ("No orders yet — go online to
receive assignments") → error + retry → success. Mutations show in-flight
spinner with server rollback; 429 honored with `Retry-After`.

## Offline home variant

Home renders without network from the last-fetched cache: "Go Online" button
(disabled while `verification !== approved`), last-session earnings, notifications,
promotions — mutations disabled with the sync badge (`SyncStatus.pendingCount`, ARCHITECTURE.md).

## Destination filter screen

Settings → Destination filter: `PUT /riders/me/destination-filter` with `enabled`, `area` + `lat`/`lon`, optional `windowFrom`/`windowTo`, `maxDetourKm` (default 5) → 200 `DestinationFilter`; `DELETE` → 204 clears. Dispatch skips offers whose drop-off exceeds `maxDetourKm`, auto-clears at `windowTo` or manual clear; `DEST_FILTER_INVALID` (422) → inline field error, draft kept (DISPATCH-FLOW.md).

## System events (edge states) — thirteen rare-but-required states, mapped to contract data:

| Edge state | Contract source |
| --- | --- |
| Order cancelled / payment failed | `Order.status: cancelled`; payment intent failed |
| App offline / GPS down | `SyncStatus.pendingCount`; `LOCATION_INVALID` / `LOCATION_RATE_LIMITED` |
| Identity re-verification / suspension | `VerificationState` recheck; `VerificationState: suspended` |
| Fraud warning / document expiry | `risk.event_detected` → `RiskEvent`; qualification/vehicle document `status` + expiry → re-upload |
| Low acceptance rate / incentive unlock | `RiderPerformance.acceptanceRate`; `RiderMission` target |
| Surge area alert / customer unreachable | `forecast.surge_incoming` + heatmap `surgeMultiplier`; failed-delivery flow (`customer_unavailable`) |
| Delivery exception open / auto-replan | `DeliveryException.status` (`open`/`resolving`/`resolved`/`escalated`) + `autoReplanned`; `exception.created` / `exception.resolved` / `exception.escalated`; `plan.replanned` / `plan.optimized` |
| Facility entry blocked | `NOT_WHITELISTED` (403) at the entry scan; `facility.whitelist_granted` / `facility.whitelist_revoked` (in-app) |
| Load rejected on weight/volume | `CAPACITY_WEIGHT_EXCEEDED` / `CAPACITY_VOLUME_EXCEEDED` (409) inline at `vehicle_load` |

## 6. Phase-2 screens (fleet management)

All phase-2 screens follow the state checklist above; per-screen specifics in
PERFORMANCE.md, DISPATCH-FLOW.md, DELIVERY-FLOW.md.

| Screen | Entry | Data | Key actions |
| --- | --- | --- | --- |
| **Performance tab** | tab 4 | `GET /riders/me/performance` (scorecard, benchmarks, trends) + `GET /riders/me/leaderboard` | metric × period switcher (deliveries/rating/earnings/on_time; daily/weekly/monthly), scorecard → metric detail → compare (team/fleet + percentile) → safety detail → leaderboard (`myEntry` pinned); `leaderboard.updated` weekly digest banner |
| **Heat Map** | Home entry | `GET /dispatch/heatmap?lat=&lon=&radiusKm=` → `HeatmapZone[]` | zone polygons with `demandLevel` fill + `surgeMultiplier` badge, `activeOrders`/`activeRiders` counts; "Navigate to zone" via external maps; `surge.active` refresh |
| **Safety Center** | Profile entry | SOS status + trip shares + resources | SOS (`POST /sos` lifecycle, SECURITY.md); Share trip (`POST /riders/me/trips/{orderId}/share` — recipients ≤ 5, `includeRoute` toggle, `expiresInHours`, share token + countdown, `TRIP_SHARE_EXPIRED` → re-share); static safety resources (road-safety academy link, support ticket) |
| **Shift & Schedule** | Profile → calendar | `GET /riders/me/shifts?scope=` (scheduled/active/completed) | Swap request (`POST /riders/me/shifts/{shiftId}/swap-request` `{targetRiderId, note?}` → pending; target rider is a picker from riders online in the same pool, server-filtered; statuses `pending → approved/declined/cancelled`; `SWAP_ALREADY_REQUESTED` blocks duplicates, `SWAP_NOT_ALLOWED` hides the action per shift status; `shift.swap_requested`/`shift.swap_decided` refresh); Break (`POST /riders/me/shifts/{shiftId}/break` `{action: start|end}`, `BREAK_ALREADY_ACTIVE` shows the running break) |
| **Earnings Analytics** | Earnings tab | ledger statement + fare history | day/week/month filter segments (display filters on `GET /payouts/me/statement?from=&to=`); surge rows (`surgeMultiplier` × `surgeTZS`), zone boost `bonus` entries, tips, payouts |
| **Wallet v2** | Earnings → Wallet | `GET /payouts/me` + shift reconciliation state | balance + payout cards; COD reconciliation view per shift (reconcile cash at clock-out, `SHIFT_CASH_MISMATCH` path, EARNINGS.md); withdraw action unchanged |
| **Order Detail (enhanced)** | order card / offer | `GET /orders/{orderId}` (multi-stop route from order context) | multi-stop route view (pickup → batch stops → drop-off, read-only sequence), in-order chat (`ChatMessage.authorRole` incl. `rider`, `dispatch`, `system`), surge badge on the fare row, hold (`POST /orders/{orderId}/hold`/`unhold`), add-items (`POST /orders/{orderId}/add-items`), share-trip entry, SOS in header |
| **Order List v2** | Orders tab | `GET /orders/me` + `GET /riders/me/trips` | priority badges (`Order.priority` `normal`/`express`/`vip`), server-sorted by deadline/distance, batch grouping per active trip |
| **Trip summary** | Orders tab / active trip card | `GET /riders/me/trips/{tripId}` | multi-stop route view (per-stop `pickup`/`dropoff`), per-stop status (`pending`/`arrived`/`done`/`failed`), batch earnings (`Trip.earningsTZS`), drag-and-drop reorder (`POST /riders/me/trips/{tripId}/reorder`) |
| **Order Detail v2** | order card | `GET /orders/{orderId}` | priority badge (`express`/`vip`), surge indicator on the fare row, chat quick link |
| **Real-time earnings ticker** | Earnings header | events-driven | `order.delivered`, `tip.received`, `bonus` credits, and `trip.completed` trigger a summary refetch — the ticker never computes locally |
| **In-App Chat** | Order Detail → chat quick link | `ChatMessage` / `ChatMessageCreate` | rich media send/view: `image`, `document`, `voice`, `location` (max 4 attachments per message, `MEDIA_TYPE_INVALID` inline); location pins render `locationPin {lat, lon, label}` on the embedded map; voice notes play inline; dispatch/system lines read-only |
| **Rider level** | Profile header | `RiderPerformance.level` + `levelBenefits[]` | level badge `bronze`/`silver`/`gold`/`platinum` (Meituan-style star tiers) with the config-driven benefit list; level-up notification banners the new tier and refetches |

## 7. Phase-3 screens (AI dispatch, safety, offline sync)

| Screen | Entry | Data | Key actions |
| --- | --- | --- | --- |
| **Predictive Heat Map** | Home entry | `GET /dispatch/forecast?lat=&lon=&horizonMinutes=` → `PredictiveDemandZone[]` | 15-min-ahead zone polygons with `predictedDemand` fill, `predictedSurgeMultiplier` badge, `confidence`, `windowFrom`–`windowTo`; "Navigate to zone"; `forecast.surge_incoming` refresh; `FORECAST_UNAVAILABLE` → empty state + retry |
| **Surge/Bonus Zone Map** | Predictive Heat Map → zone | forecast + `GET /dispatch/heatmap` | predicted vs live surge comparison per zone; zone-boost context (EARNINGS.md) |
| **Safety Center v2** | Profile entry | safety-event history + SOS status | fatigue/crash status cards (last event, `acknowledged` state), emergency contacts (trip share), rest state (`RiderShift.forcedRestUntil`) |
| **AI Performance Coach** | Performance tab | `RiderPerformance` + forecast context | personalized recommendations (planned — PERFORMANCE.md); nothing rendered until the model ships |
| **Home v3** | tab 1 | forecast + active orders | predictive alert banner (`forecast.surge_incoming`), earnings forecast chip (planned, EARNINGS.md), offline sync indicator |
| **Earnings v3** | tab 3 | forecast + ledger | surge-timing recommendations (reposition before predicted surge), earnings forecast card (planned) |
| **Profile v3** | tab 5 | `RiderPrivate` + telemetry | behavior analytics (speeding/hard-braking — planned, telemetry consent, SECURITY.md), AI coach entry |
| **Offline sync indicator** | all tabs (header) | `GET /riders/me/sync/status` | pending-count badge; `sync.completed` toast on flush; gap resolution (ARCHITECTURE.md) |

## 8. Blueprint pass — rider tools (Profile hub)

All screens follow the shared state checklist and are documented in VEHICLE-TOOLS.md, PERFORMANCE.md, SECURITY.md, API.md. Entry: Profile → Tools (except where noted).

| Screen | Entry | Data | Key actions |
| --- | --- | --- | --- |
| **Vehicle & Maintenance** | Profile → Tools | `GET /riders/me/vehicle/maintenance` | service history (type chips, `mileageKm`, `costTZS`, `nextDueAt` due badge + due-soon banner); Add record (`POST` → 201); `MAINTENANCE_INVALID` inline |
| **Goals & Schedule** | Profile → Tools | `GET`/`PUT /riders/me/goals` | week-hour + earnings sliders, per-day availability (`dayOfWeek`/`startTime`/`endTime`), `peakHourAlerts` switch; PUT saves; scorecard progress bar refetches (PERFORMANCE.md); `GOALS_INVALID` inline |
| **Expenses** | Profile → Tools | `GET /riders/me/expenses?from=&to=` | period filter, category chips, `deductible` toggle, receipt capture → `receiptUrl`; Add expense (`POST` → 201); `EXPENSE_INVALID` inline; deep-link to Export Center tax report |
| **Export Center** | Profile → Tools | `POST /riders/me/exports` | `reportType` (tax/earnings/trips) × `format` (csv/pdf/json) + date window → 202 `{jobId, status}` card; `EXPORT_IN_PROGRESS` guard; tax export ties into deductible expenses |
| **Training Center** | Profile → Tools | `GET /riders/me/training` + `POST /riders/me/training/{moduleId}/complete` | module cards by category (safety/onboarding/skills/platform), `progressPct` bars; complete → `certified` + certificate link + `rewardTZS`; `TRAINING_MODULE_NOT_FOUND` refetch; academy core (EDUCATION.md) |
| **Help Center** | Profile → Help/Support | `GET /help/articles?q=&category=` | search + category chips → article list → detail (`body`); article → prefilled ticket link |
| **Trusted contacts** | Safety Center entry | `GET`/`POST /riders/me/contacts`, `DELETE /riders/me/contacts/{contactId}` | add (name, phone, `relationship`, `notifiedOnSos`, `shareLocation`), remove with confirm; `CONTACT_LIMIT_REACHED` cap; SOS marks `notifiedOnSos` contacts notified (SECURITY.md) |
| **Security score** | Profile → Safety Center | `GET /riders/me/security` | score gauge + `alerts[]` (severity pills, local-time `at`); alert → explanation + prefilled ticket; scorecard mirrors `RiderPerformance.securityScore` |

## 9. Deep-pass screens (LIVE)

All screens follow the shared state checklist; data per DISPATCH-FLOW.md, EARNINGS.md, SECURITY.md.

| Screen | Entry | Data | Key actions |
| --- | --- | --- | --- |
| **Preferences** | Settings → Preferences | `GET/PUT /riders/me/preferences` → `RiderPreferences` | toggles: `soundNotifications`; `autoAccept` (auto-accepts offers within the window — off by default; conflicts with manual accept → server picks); `longDistance`; `wifiOnlyMaps` (data saver — tiles on Wi-Fi only); `destinationFilters` chip list (saved areas, add/remove); `language` picker (en/sw/ar); PUT saves; `PREFERENCES_INVALID` inline, previous values kept |
| **Suggested areas chips** | Home map (predictive heat map) | `GET /dispatch/forecast` → `suggestedAreas: string[]` | AI positioning suggestions as map chips ("Move toward — {area}"); tap → external maps; `FORECAST_UNAVAILABLE` → chips hidden; suggestions never auto-assign |
| **Claimable missions** | Home / Earnings → Missions | `GET /riders/me/missions` → `RiderMission.claimed`/`canClaim` | Claim button when `canClaim: true` → `claimed: true` + `bonus` ledger entry; disabled with progress copy while `canClaim: false`; premature claim → `PROMOTION_NOT_CLAIMABLE` inline + refetch |

## 10. Intercity, line-haul & relay screens (M11 logistics lane)

Entry is role-dependent: local riders keep the single-order flow; `linehaul_bus`/`linehaul_truck` riders get a Consignments tab; `relay` riders get relay-chain assignments on Home. Every screen follows the shared state checklist (section 5); full operating detail in LONG-HAUL-RELAY.md.

| Screen | Entry | Data | Key actions |
| --- | --- | --- | --- |
| **Consignment list** | tab (line-haul modes) | `GET /linehaul/consignments?status=` → `Consignment[]` | status filter chips (`manifesting`/`in_transit`/`at_hub`/`delivered`/`cancelled`); empty "No consignments"; cards: `consignmentNumber`, corridor, `orderCount`, `scheduledDeparture`; tap → detail |
| **Consignment detail** | list → row | `GET /linehaul/consignments/{id}` | manifest grouped by `section` (`standard`/`fragile`/`cold_chain`/`documents`/`high_value`) with per-order `scannedIn`/`scannedOut`; Create → Depart → Arrive per status; `CONSIGNMENT_NOT_FOUND` → empty variant + retry |
| **Create consignment** | detail → create | hub pickers (`GET /hubs`), order multi-select, `transportMode` (`van`/`linehaul_bus`/`linehaul_truck`) | `POST /linehaul/consignments`; `CONSIGNMENT_FULL` inline; hub list states: loading → "No hubs" → retry → success |
| **Departure scan** | detail (`manifesting`) | consignment + manifest | confirm sheet → `POST .../depart` → `in_transit` + `departedAt`; `CONSIGNMENT_ALREADY_DEPARTED` → refetch |
| **Arrival scan** | detail (`in_transit`) | manifest | scan barcodes into `verifiedOrderIds` (must equal manifest); `CONSIGNMENT_ORDER_MISMATCH` lists the difference; missing → `CONSIGNMENT_MISSING_ORDERS` exception banner → ops runbook |
| **Route / legs view** | order context (assigned leg) | `GET /orders/{orderId}/route` | leg timeline: `sequence`, `type`, `mode`, hubs, `handledBy`, status pills (`pending`/`in_progress`/`completed`/`skipped`), per-leg `etaAt`; advance per leg (`POST .../legs/{legId}/advance` `start`/`complete`); `LEG_ALREADY_COMPLETED` → refetch |
| **Handoff screen** | route view → transfer point | `POST /orders/{orderId}/handoff` | barcode scan (`scanCode`) → tamper-seal check (`sealIntact`) → condition photo → custody record (`from`/`to`/`at`); `HANDOFF_SEAL_BROKEN`/`HANDOFF_SCAN_MISMATCH` block the leg + flag ops; relay handoffs use the same flow at a meeting point |
| **Waybill timeline** | order detail → waybill | `GET /orders/{orderId}/waybill` | append-only trail: `scanned`/`handoff`/`loaded`/`departed`/`arrived`/`sorted`/`exception`/`delivered` with `location`, `actor`, local time; read-only; refresh on `waybill.updated` |

## 11. Logistics OS screens (M11b) — full depth

Every screen follows the shared state checklist (section 5); operating detail in LONG-HAUL-RELAY.md. Entry points are capability-driven: drivers get the Trips tab; hub couriers get the Hub Worker surface; pickup/transfer riders get the shipment scan flow from their assignments.

### 11.1 Trip screen (driver surface)

- **Entry**: Trips tab (bus/van/truck operator surface) → trip card → detail.
- **Data**: `GET /trips?status=` / `GET /trips/{tripId}` → `Trip` + `manifestSummary {expectedUnits, verifiedUnits, exceptions}` + compartments.
- **Layout**: header (TRP-…, route A → B, vehicle, `scheduledDeparture`, status pill) → cargo summary cards (expected / verified / exceptions) → compartment section (name, `capacity`/`used` bars, incompatible-blocked compartments) → action bar.
- **Actions** (per state): `planned` → START LOADING; `loading` → DEPART (+ CONFIRM LOAD); `in_transit` → ARRIVE; `unloading` → UNLOAD then COMPLETE (blocked by `TRIP_CANNOT_CLOSE` until reconciliation matches); `completed`/`cancelled` → read-only summary.
- **Events**: `trip.departed` / `trip.arrived` refresh; `container.sealed` updates the container list; `reconciliation.failed` (critical) surfaces the missing list.
- **States**: loading (cargo skeletons) → empty (`TRIP_NOT_FOUND` / no trips → "No trips assigned") → error (`TRIP_ALREADY_ACTIVE` → refetch; 404 → empty variant) → retry → success (summary + enabled actions).

### 11.2 Shipment list / detail

- **Entry**: Shipments tab or assignment context (pickup rider list, hub inbound/outbound, last-mile queue).
- **Data**: `GET /shipments?status=` (status filter chips: `planned`/`picked_up`/`at_hub`/`in_transit`/`out_for_delivery`/`delivered`/`exception`) / `GET /shipments/{shipmentId}`.
- **List card**: `shipmentNumber` (SH-…), `packages[]` count + PKG-… rows, `containerId`, status pill; `exception` cards carry a banner + CTA to the custody timeline.
- **Detail**: shipment header, packages table (per-package `attributes`, `status`, `scannedIn`/`scannedOut`), actions: SCAN (→ 11.3), CUSTODY (→ 11.5), CONTAINER (→ 11.4, where granted).
- **Create**: from an order context → `POST /shipments` `{orderId, packageCount, containerId?}` → 201 → detail; `SHIPMENT_ALREADY_EXISTS` (409) inline → open the existing shipment.
- **States**: loading (card skeletons) → empty ("No shipments" + filter hint) → error (retry) → success.

### 11.3 Package scan / verify screen (3-step)

- **Entry**: shipment detail → SCAN, or handoff assignment.
- **Data**: `POST /shipments/{shipmentId}/scan`.
- **Flow**: 3-step stepper —
  1. Scan package/shipment barcode (camera) → system verifies the expected next handler.
  2. Scan destination bin/hub + vehicle/rider ID (two more scans; the screen shows the expected vehicle/leg so the operator can self-correct).
  3. Seal check toggle (`sealIntact` must be true) + condition photo (when required) + GPS auto-attach → submit.
- **Step transitions**: each step's success renders the next; failure blocks inline with `ErrorResponse.message` + `requestId` and keeps the draft.
- **Blocks**: `HANDOFF_VERIFICATION_FAILED` (wrong vehicle/hub — e.g. package planned on Bus 22 scanned on Bus 19), `HANDOFF_SEAL_BROKEN` (leg blocked, ops flagged), `HANDOFF_SCAN_MISMATCH` (re-scan prompt), `SCAN_GPS_MISMATCH` / `SCAN_VEHICLE_STATIC` (anomaly — never blind-retry; ops owns resolution), `VEHICLE_CAPACITY_EXCEEDED`, `COMPARTMENT_INCOMPATIBLE` (loads).
- **Success**: 201 `CustodyEntry` → next-step prompt ("Hand over to Hub A" / "Load on Bus 22"); on `delivery` scans the shipment flips `delivered`.
- **States**: scanner loading → no camera permission → error + retry → success.

### 11.4 Container build / seal screen

- **Entry**: shipment/consignment context (hub courier surface).
- **Data**: `POST /containers`.
- **Flow**: kind picker (`bag`/`cage`/`pallet`/`lockbox`/`refrigerated_unit`) → section picker (`standard`/`fragile`/`cold_chain`/`documents`/`high_value` — sections never mix) → scan packages into `packageIds[]` → load confirm → 201 (unsealed) → SEAL confirm → `sealed: true` + `sealCode` + `sealedAt` displayed; `container.sealed` fires.
- **Errors**: `CONTAINER_ALREADY_SEALED` (409) → refetch, show sealed state; `PACKAGE_NOT_FOUND` (404).
- **States**: loading (skeleton) → empty (no packages for the section → disabled build) → error (retry) → success (seal code screen).

### 11.5 Custody timeline screen

- **Entry**: shipment detail → CUSTODY.
- **Data**: `GET /shipments/{shipmentId}/custody` → `CustodyEntry[]`.
- **Layout**: vertical append-only timeline, newest-first toggle; each row: `eventType` label, `actorType` + actor id, `deviceId`, `previousState → newState`, `evidence` (photo/seal reference), GPS, local time. A search box answers "where at <time>?" by scanning the timeline.
- **Behavior**: read-only; refreshes on `package.scanned` events; the last entry is the live answer for support queries.
- **States**: loading (timeline skeletons) → empty ("No custody events yet") → error (retry) → success.

### 11.6 Reconciliation screen

- **Entry**: consignment detail (arrival) or trip detail (unloading).
- **Data**: `POST /linehaul/consignments/{consignmentId}/reconcile` `{scannedOrderIds}` → `ReconciliationResult`.
- **Layout**: manifest list with `scannedIn`/`scannedOut` per row; expected vs scanned counters; scan-in the unloaded units; RECONCILE button.
- **Outcomes**: `matched` + `tripClosed: true` → success summary, trip can complete; `RECONCILIATION_FAILED` / `RECONCILIATION_MISSING_PACKAGES` (409) → missing list (`missingOrderIds[]`) + LOCATE via custody timeline (11.5) + re-scan; `TRIP_CANNOT_CLOSE` blocks the trip close until matched.
- **States**: loading (result skeleton) → empty (no manifest) → error (reconciliation failure state with missing list) → retry (re-reconcile after locating) → success.

### 11.7 Vehicle / Route screens (fleet)

- **Entry**: Profile → Fleet (drivers, hub couriers, fleet owners) or Trips tab context.
- **Data**: `GET /vehicles` → `Vehicle[]`; `GET /routes` → `Route[]`.
- **Vehicle list**: cards with `vehicleType`, `registration`, `operatorId`, `status` pill (`active`/`on_trip`/`maintenance`/`retired`), `currentTripId`; detail shows `capacity` compartments with `capacity`/`used` bars, `temperatureCapable`, `securityCapability`, `permittedRoutes`.
- **Vehicle detail actions**: registration/status/route updates only where granted (`POST`/`PATCH /vehicles` are admin/fleet-owner; couriers see read-only).
- **Route list**: corridors `name` (e.g. "Dar es Salaam → Mwanza"), `fromHubId`/`toHubId`, `estimatedHours`, `scheduledDepartures[]`, `permittedVehicles[]`, `active`.
- **States**: loading (card skeletons) → empty ("No vehicles" / "No routes") → error (retry) → success.

## 12. Deep logistics pass screens (service models, fleets, facilities, exceptions, weight/volume, warehouses/carriers)

Every screen follows the shared state checklist (section 5); full operating detail in LONG-HAUL-RELAY.md sections 13–19; data per API.md. Entry points are capability- and profile-driven: the service-model chip renders for every rider; the fleet badge renders only when `fleetAccountId` is present; facility/exception surfaces render from assignments and notifications.

| Screen | Entry | Data | Key actions |
| --- | --- | --- | --- |
| **Service model / Fleet badge** | Profile header | `RiderPrivate.serviceModel` (`specialized`/`crowdsourced`/`errand`/`fleet`) + `fleetAccountId` (nullable) | model chip renders the employment type; `fleet` riders additionally see the fleet linkage chip (id only — master name/vehicles/regions/billing are never rider-callable, SECURITY.md); tap → help article; no edit path (fields are server-set, `SERVICE_MODEL_INVALID` guard on admin side) |
| **Guaranteed-hours card (specialized)** | Home | shift + assignment surfaces (rider_shifts) | clock-in/out, break, swap per the shift contract (EARNINGS.md); specialized riders see guaranteed assignments first (dispatch priority is server-side) |
| **Available-orders feed (crowdsourced/errand)** | Home | `GET /dispatch/available-orders` (per-city grab mode) | offer cards with countdown; `OFFER_NOT_FOUND` on expiry removes the card (DISPATCH-FLOW.md) |
| **Facility whitelist status** | Profile → Safety Center → Facility access (or notification deep link) | `facility.whitelist_granted` / `facility.whitelist_revoked` (in-app) + last entry-scan outcomes — **no dedicated rider GET endpoint exists** (honest rendering) | rows: facility name, policy label (`whitelist_only`/`whitelist_or_otp`/`open`), granted/revoked pill + timestamp, last scan result; "Request access" prefilled ticket; revoked riders see the block consequence copy |
| **Entry scan at facility** | Delivery flow (scan step) | `POST /shipments/{id}/scan` with GPS | geofenced entry scan binds rider → facility → delivery; `NOT_WHITELISTED` (403) block + "Request access" CTA; `SCAN_GPS_MISMATCH` if outside the geofence; success → 201 `CustodyEntry` + "Entry granted" |
| **Exception reporting** | Order/Shipment/Trip detail → Report exception | `POST /delivery-exceptions` (kind chips = the 18-kind catalog, description ≤ 1000, context auto-linked) | submit → 201 exception card (id + `requestId`); `VALIDATION_FAILED` inline; `EXCEPTION_ALREADY_RESOLVED` → refetch |
| **Exception status** | Notification deep link / Exception list | `GET /delivery-exceptions?status=` + `GET /delivery-exceptions/{exceptionId}` | kind + status pills (`open`/`resolving`/`resolved`/`escalated`), `outcome`, `resolvedAt`, `autoReplanned` badge; replan banner when the plan was recalculated |
| **Replan banner** | Trip/Consignment screen | `plan.replanned` / `plan.optimized` events | "Route replanned — TRP-9913 replaces TRP-9912" banner; refetch trip/consignment; custody chain unchanged |
| **Trip cargo summary (weight/volume)** | Trip detail | `GET /trips/{tripId}` | unit bars + weight bar (`usedWeightKg/maxWeightKg`) + volume bar (`usedVolumeL/maxVolumeL`) + per-compartment counters; `CAPACITY_WEIGHT_EXCEEDED` / `CAPACITY_VOLUME_EXCEEDED` inline blocks on load scans |
| **Warehouse pickup context** | Order detail / first-mile leg (warehouse-fulfilled orders) | `Order.dispatchStrategy: warehouse` + `Order.fulfillmentSource: warehouse` (read-only) | pickup point renders the warehouse name/address instead of the merchant storefront; strategy chip renders from server data; `DISPATCH_STRATEGY_INVALID` never reachable client-side |
| **Carrier handoff context** | Consignment detail / route view | `Consignment.carrierId` + `RouteSegment.handledBy: carrierId` + `carrier.handoff_required` (push + in-app) | carrier leg pill; platform rider hands off at the hub with the standard handoff scan (LONG-HAUL-RELAY.md 12.4); carrier exceptions resolve on the admin side (module 29 / workflow 27) |
| **Vehicle/Package weight-volume readout** | Package detail / Vehicle detail | `Package.attributes.weightKg`/`volumeL`; `Vehicle.capacity.maxWeightKg`/`maxVolumeL` + compartment `usedWeightKg`/`usedVolumeL` | read-only counters; declaration at package creation (`POST /shipments` context) where granted |
