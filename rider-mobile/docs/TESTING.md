# HUDumika RIDER — Testing

Strategy: Jest unit tests, React Native Testing Library (RNTL) component tests, MSW contract tests matching `backend/API-CONTRACT.yaml`, Detox E2E for the critical delivery path.

## Layered strategy

| Layer | Tool | Covers |
| --- | --- | --- |
| Unit | Jest | i18n catalogs, TZS formatter, offer countdown, API client/error mapping |
| Component | RNTL + Jest | per-screen states (loading/empty/error/retry/success), navigation actions |
| Contract | MSW (handlers generated from `backend/API-CONTRACT.yaml`) | every endpoint in API.md returns contract-shaped data; status transitions |
| E2E | Detox | happy path: accept → pickup → delivered; online toggle; offer timeout |

## MSW contract tests

- `msw/` handlers mirror the contract exactly: paths, statuses, `ErrorResponse`/`ValidationResponse` shapes, cursor pagination, `OrderStatus` transitions.
- Same handlers serve dev (MSW in dev, `EXPO_PUBLIC_MSW_ENABLED`) and tests, so parity is a single source.
- Contract checks: a schema-assertion layer (e.g. `zod` or generated types) validates every mocked response against the contract — a contract change breaks the mocks, not the app silently.
- Scenario mocks: OTP request/verify, rider application → `LeadCreated`, `verification` transitions, dispatch push offer, `advanceOrder` 200/409, payout statuses, notifications pagination, `reject-reasons` catalog, `me/location` 204/429/422, `me/missions` statuses, `proof-of-delivery` 200/409, `failed-delivery`/`reschedule` transitions, `transfer` 202/409, `/sos` 201/429, `orders/{orderId}/tip` 200/409, `orders/issue-reasons` catalog, `riders/me/shifts` clock-in/clock-out 200/409, `dispatch/available-orders` feed 200, `orders/{orderId}/fare` 200/404, `orders/{orderId}/hold`/`unhold` 200/409, `orders/{orderId}/add-items` 202/409, `riders/me/trips/{orderId}/share` 201 + `TRIP_SHARE_EXPIRED`, `riders/me/shifts/{shiftId}/swap-request` 201/409, `riders/me/shifts/{shiftId}/break` 200/409, `riders/me/performance` 200/404, `riders/me/leaderboard` 200/404, `dispatch/heatmap` 200 + `HEATMAP_INVALID` error case, `riders/me/trips` 200/404, `riders/me/trips/{tripId}` 200/404, `riders/me/trips/{tripId}/reorder` 200 + `REORDER_INVALID`/`REORDER_NOT_ALLOWED`, promo order (`Order.promoCode`) completion → `bonus` credit + `trip.completed`, chat message send with attachments (`image`/`document`/`voice`/`location`, max 4, `MEDIA_TYPE_INVALID`), `riders/me/performance` with `level` + `levelBenefits[]`, `dispatch/forecast` 200 + `FORECAST_UNAVAILABLE`, `riders/me/safety-events` 201/422/429, `riders/me/sync/batch` 200/422 + `SYNC_SEQUENCE_GAP`, `riders/me/sync/status` 200, `riders/me/destination-filter` 200/204/422 (`DEST_FILTER_INVALID`), `orders/{orderId}/masked-call` 201 + `MASKED_CALL_NOT_ALLOWED`/`MASKED_CALL_EXPIRED`, rating filter via `PATCH /riders/me` + `RATING_FILTER_INVALID`, `riders/me/vehicle/maintenance` 200/201 + `MAINTENANCE_INVALID`, `riders/me/goals` 200 + `GOALS_INVALID`, `riders/me/expenses` 200/201 + `EXPENSE_INVALID`, `riders/me/contacts` 200/201/204 + `CONTACT_LIMIT_REACHED`, `riders/me/exports` 202 + `EXPORT_IN_PROGRESS`, `riders/me/training` 200 + `riders/me/training/{moduleId}/complete` 200/404 (`TRAINING_MODULE_NOT_FOUND`), `riders/me/security` 200, `help/articles` 200, `RiderPerformance.deliveryStreak`/`securityScore`, `TicketCreate.category`/`urgency`.

## Unit test examples

- `formatTZS(12500)` → `TZS 12,500`; never float; locale fallback.
- Countdown: 120 s window ticks, expires → offer dismissed event.
- API client: 401 → single refresh → retry; refresh failure → session cleared.
- Error mapping: `ErrorResponse` → typed screen error; `VALIDATION_FAILED` → field errors.
- i18n: every `en` key present in `sw` and `ar` catalogs.

## Component test examples (per screen)

- OTP screen: loading on submit, 429 → resend timer, success → Home/onboarding gate.
- Online toggle: PUT success flips `RiderPrivate.online`; failure keeps old state + retry toast.
- OfferModal: shows fee + merchant + countdown; accept dismisses; timeout path.
- DeliveryDetail: status-dependent actions (pickup only when `rider_assigned`); 409 → refetch.
- Earnings: empty period, paid/failed/exception payout pills, statement rows with signed amounts.
- Notification center: unread dot, mark-read, deep-link navigation.

## Detox E2E — happy path (full 7-stage flow)

Scenario (single build, mocked/contract API where backend is not deployed):

1. Launch → OTP login → rider `approved` (MSW state).
2. Home → toggle online → `online: true`.
3. Dispatch push `order.rider_assigned` → OfferModal → accept.
4. DeliveryDetail → arrive at merchant (`rider_arrived_pickup`) → confirm pickup (`picked_up`) → navigate → `delivering` → arrive at customer (`rider_arrived_dropoff`) → POD (OTP) → `delivered` → `completed` in history.
5. Earnings shows the `delivery_fee` entry; payout list shows `pending`.

Second scenario: offer times out at 120 s and the order returns to the queue (card absent, no error state).

## Detox E2E — rider operations (P10)

- **Failed delivery → RTO → returned**: at `delivering`, "Delivery failed" → reason `customer_unavailable` + note + photo → `failed_delivery` → `returning` card state → delivered-back at merchant; earnings show no `delivery_fee` for the failed leg.
- **POD OTP wrong**: submit `proof-of-delivery` with wrong OTP → `POD_OTP_INVALID` inline error, draft kept; correct OTP → 200 `ProofOfDelivery` (`verified: false`) → `delivered`.
- **POD duplicate**: second submit → `POD_ALREADY_SUBMITTED` → refetch shows submitted state, no duplicate UI.
- **Transfer on in-transit order**: on `delivering`, `POST /orders/{orderId}/transfer` → 202 `{transferId, status: requested}`; MSW re-assigns → card removed via re-assign event; non-transit order → `TRANSFER_NOT_ALLOWED` → button hidden; duplicate → `TRANSFER_ALREADY_REQUESTED` → pending state shown.
- **Mission completion → bonus credit**: MSW mission progress reaches `targetDeliveries` on `delivered` → `rider.mission_completed` push → mission card `completed` + `bonus` ledger entry (sign +, `rewardTZS` `TZS x,xxx`).
- **SOS → acknowledged**: tap SOS → `POST /sos` → 201 `open`; MSW safety ops acknowledges → `sos.acknowledged` in-app banner, alert screen shows `acknowledged`; duplicate tap → `SOS_RATE_LIMITED` → "Alert already sent" with existing id.

## Detox E2E — drop-off options and background check (final audit)

- **Leave-at-door requires photo POD**: an order with `dropoffOption: leave_at_door` — the ProofOfDelivery screen requires `type: photo` with `dropoffOption: leave_at_door`; submit without the captured photo → inline "Photo required" error, order stays `rider_arrived_dropoff`; with photo + `gpsStamp` → 200 `ProofOfDelivery` → `delivered`.
- **Hand-to-customer without photo allowed**: `dropoffOption: hand_to_customer` — `signature` or `otp` POD (or `photo`) submits with no photo; the drop-off option renders on DeliveryDetail before arrival.
- **Background check pending blocks going online**: MSW returns the verification screen with a background check `pending` / `in_progress` (verification not `approved`) → Home online toggle disabled; the check clears → `verification: approved` → toggle enabled; `flagged` → `rejected` / `changes_requested` path with "fix issues" re-submission (ONBOARDING.md).

## Detox E2E — tips and shifts (P10)

- **Tip after completion → tip ledger credit**: after `delivered` → `completed`, MSW emits `tip.received`; Earnings shows the `tip` entry (sign +, `TZS x,xxx`) and order detail shows `Order.tipTZS`; a pre-completion tip attempt returns `TIP_NOT_ALLOWED` (shown as refetched order state, no rider action).
- **Shift lifecycle**: Home shift card `scheduled` → clock-in (`POST /riders/me/shifts/clock-in` `{shiftId, lat, lon}`) → `active` + `shift.started`; duplicate clock-in → `SHIFT_ALREADY_ACTIVE`.
- **Clock-out with cash mismatch → reconcile**: clock-out with `cashCollectedTZS` not reconciled → `SHIFT_CASH_MISMATCH`, shift stays `active` with reconciliation notice; re-submit with `cashReconciled: true` → `completed` + `shift.ended`; clock-out without clock-in → `SHIFT_CLOCKOUT_WITHOUT_CLOCKIN`.
- **Issue report with reason catalog**: DeliveryDetail → Report issue → `GET /orders/issue-reasons` renders chips (`restaurant_not_ready`, `customer_not_responding`, `wrong_address`, `payment_issue`, `other`) → prefilled ticket `open` with `orderId`.

## Detox E2E — grab mode and fare breakdown (P10b)

- **Grab offer within radius → accept → assignment**: rider online in a grab-mode city (MSW config) → Home shows "Available orders" → `GET /dispatch/available-orders?lat=&lon=&radiusKm=&limit=` returns `DispatchOffer[]` → offer card shows pickup/drop-off, `distanceKm`, `estimatedEarningsTZS` (`TZS x,xxx`), `itemsSummary`, `paymentMethod`, countdown → accept within the window → order `rider_assigned` → standard pickup flow.
- **Offer expiry → OFFER_NOT_FOUND**: let the `expiresAt` countdown reach zero before accepting → 404 `OFFER_NOT_FOUND` → "Offer no longer available", card removed, feed refetched (no error state).
- **Fare breakdown matches ledger**: after `delivered` → `completed`, `GET /orders/{orderId}/fare` rows (`baseTZS` + `distanceTZS` + `timeTZS` + `surgeTZS` + `tipTZS` + `codFeeTZS` + `bonusTZS`) sum to `totalTZS`, and the sum matches the `delivery_fee` + `tip` ledger entries for the order; Delivery History row deep-links to the breakdown.
- **COD fee on COD fare**: a `paymentMethod: cod` order's fare shows `codFeeTZS > 0` as a line; collected cash stays `totals.totalTZS` (PAYMENTS.md); an order not assigned to this rider → 404 `FARE_NOT_AVAILABLE` → Fare row hidden.

## Detox E2E — fleet management (P10c)

- **Hold/unhold cycle**: on `rider_assigned`, hold with reason → 200 `Order` + `order.held` → card shows "On hold"; no new offers reference the held order (feed excludes it); `until` reached → card refetches, pill clears; duplicate hold → `HOLD_ALREADY_ACTIVE` → pending hold shown; unhold → 200 + `order.unheld` → normal flow resumes; hold on a delivered order → `HOLD_NOT_ALLOWED` → button hidden per status.
- **Heat zone shows surge multiplier**: `GET /dispatch/heatmap` returns zones → polygons render with `demandLevel` colors and `surgeMultiplier` badge (e.g. `critical` ×1.8); `activeOrders`/`activeRiders` counts shown; `surge.active` push refreshes the map; invalid params → `HEATMAP_INVALID` inline error.
- **Add-items approval flow**: on `delivering`, add item from the merchant catalogue → 202 `{requestId, status: pending_merchant_approval}` → pending card; duplicate submit → `ADD_ITEMS_PENDING` → "approval in progress"; MSW merchant approves → `order.add_items_approved` → order refetch shows updated `items[]` + `totals` (read-only); declined variant → `order.add_items_declined` banner, order unchanged; add on a delivered order → `ADD_ITEMS_NOT_ALLOWED`.
- **Trip share token expiry**: share with 2 recipients + `includeRoute: false` → 201 `{shareToken, expiresAt}` + `trip.shared`; countdown ticks; stale share attempt → `TRIP_SHARE_EXPIRED` → "generate fresh share" flow; `recipients` > 5 → `VALIDATION_FAILED` inline error.
- **Shift swap request → approved**: request swap with a target rider → 201 `{swapRequestId, status: pending}` + `shift.swap_requested` (target side); duplicate → `SWAP_ALREADY_REQUESTED`; MSW target approves → `shift.swap_decided` → status `approved` shown to requester; non-swappable shift → `SWAP_NOT_ALLOWED` → action hidden.
- **Break start/end**: `POST /riders/me/shifts/{shiftId}/break {action: start}` → 200 `RiderShift` + `shift.break_started` → break card (offers paused); duplicate → `BREAK_ALREADY_ACTIVE` → running state shown; `{action: end}` → 200 + `shift.break_ended` → offers resume; break outside an active shift → `BREAK_NOT_ALLOWED`.
- **Performance scorecard matches ledger**: after `delivered` → `completed`, `GET /riders/me/performance` `earningsTZS` equals the sum of `delivery_fee` + `tip` + `bonus` ledger entries in the same `from`/`to` window (MSW derived view consistent with statement); gauges render `safetyScore`/`reliabilityScore`; `behaviorScore: null` renders the planned state; empty window → empty-state copy; 404 `PERFORMANCE_UNAVAILABLE` variant.
- **Leaderboard myEntry rank**: `metric=earnings&period=weekly` returns top entries + `myEntry` — myEntry renders pinned with its rank even when outside the top `limit` rows; metric/period switcher refetches with the new params; `leaderboard.updated` digest banner refreshes; 404 `LEADERBOARD_UNAVAILABLE` → empty variant.

## Detox E2E — batch trips, priority, promos (P10c)

- **Batch trip accept → reorder → complete → summary**: MSW assigns 2 orders into one active trip; `GET /riders/me/trips` returns `Trip` with both `orderIds` and per-order pickup/drop-off stops → Trip summary renders the sequence → drag-and-drop reorder `POST /riders/me/trips/{tripId}/reorder {orderIds}` → 200 `Trip` with re-sequenced stops → advance stops (`arrived` → `done` per stop via the normal order actions) → final stop `done` → trip `completed` + `trip.completed` in-app summary; `earningsTZS` renders `TZS x,xxx` and matches the trip's `delivery_fee` + `tip` + `bonus` ledger entries (server-derived, never client-summed).
- **Priority VIP order sorts first**: order list and initial trip sequence show the `vip` order ahead of `normal` with its priority badge (`express` behaves the same); badges render per DESIGN-SYSTEM (`accent` gold tiny badge for `vip`, `brand-600` for `express`, none for `normal`).
- **Promo order → bonus credited**: an order with `Order.promoCode` completes → `bonus` ledger entry (sign +) with the promo reference in the statement row; Order Detail shows `promoCode` read-only; order-level unknown/expired code → `PROMO_INVALID` (never a rider-side validation).
- **REORDER_NOT_ALLOWED after completion**: after the trip is `completed`, a reorder attempt → 409 `REORDER_NOT_ALLOWED` → reorder action hidden, trip unchanged; variant: reorder with an order id outside the trip → 409 `REORDER_INVALID` → previous sequence restored + inline error.

## Detox E2E — Phase 3 (AI dispatch, safety, offline sync)

- **Offline backlog 200 events → highWaterMark + gap**: MSW goes offline; the rider performs 200 queued events (status advances, POD, location, safety event, COD cash); reconnect → `POST /riders/me/sync/batch` batches them → `{accepted, rejected[], highWaterMark}` → local queue drops events `≤ highWaterMark`; a missing span returns `SYNC_SEQUENCE_GAP` → resend → `sync.completed` toast + `GET /riders/me/sync/status` shows `pendingCount: 0`.
- **Crash drill**: MSW emits crash context → app posts `safety-events` (`crash_detected`, `severity: critical`) → 10 s "Are you OK?" countdown → no tap → auto-SOS + `safety.crash_detected` (rider + dispatch) → active orders cancelled/re-assigned server-side → rider confirms safe → `safety.crash_acknowledged` notifies dispatch + emergency contacts; "I'm OK" within 10 s acknowledges without escalation; duplicate → `SAFETY_EVENT_RATE_LIMITED`.
- **Fatigue → forced rest blocks offers**: `safety.fatigue_detected` → "Take a Break" → break start → repeated detection escalates → `RiderShift.forcedRestUntil` set → `safety.rest_enforced` push → offer attempt returns `REST_ENFORCED` ("Mandatory rest until {local time}") → countdown card; when `forcedRestUntil` passes, offers resume automatically.
- **Forecast returns zones with confidence**: `GET /dispatch/forecast?horizonMinutes=15` → zones with `predictedDemand`, `predictedSurgeMultiplier`, `confidence`, `windowFrom`/`windowTo` render on the Predictive Heat Map; `forecast.surge_incoming` refreshes; `FORECAST_UNAVAILABLE` → empty state + retry.
- **Offer prep-time + address confidence**: an offer with `predictedPrepMinutes` shows "Ready in ~{n} min"; `addressConfidence` below threshold shows "Confirm pickup address"; null fields render no claim.

## Detox E2E — enterprise-final pass (filters, masked calls)

- **Destination filter blocks out-of-detour offers**: `PUT /riders/me/destination-filter` with `maxDetourKm: 5` → 200; MSW dispatch emits an offer whose drop-off exceeds the detour → it never surfaces (no OfferModal, no feed card); a within-detour offer arrives normally; `DELETE` clears and out-of-detour offers return; bad coords → `DEST_FILTER_INVALID` inline error, draft kept.
- **Masked call session expiry → recreate**: Call Customer → 201 `MaskedCallSession` with `maskedNumber` + `direction: rider_to_customer`; dial uses the proxy number (the real phone is never present in state); session past `expiresAt` → `MASKED_CALL_EXPIRED` → "Call link expired" → re-create via fresh POST → dial succeeds; unassigned order → `MASKED_CALL_NOT_ALLOWED` → action hidden.
- **Rating filter floor**: set `ratingFilterMin` via `PATCH /riders/me` → `RiderPrivate.ratingFilterMin` reflects it; an order from a customer below the floor is not offered; out-of-range value → `RATING_FILTER_INVALID` inline error, previous value kept.
- **Edge-state rendering**: `risk.event_detected` (e.g. `suspicious_cancellation`) → fraud warning banner on Home + risk detail; `RiderPerformance.acceptanceRate` below threshold → low-acceptance warning on the Performance tab; document `status`/expiry → re-upload banner on Profile; each renders loading/empty/error/retry/success and surfaces `requestId` on failure.

## Detox E2E — vehicle tools and professional pass (blueprint)

- **Maintenance record → nextDueAt reminder**: Vehicle & Maintenance renders the history list; Add record (`type: oil_change`, `performedAt`, `mileageKm`, `costTZS` `TZS x,xxx`) → 201 → list refetches with the record first; MSW returns `nextDueAt` inside the reminder window → due-soon banner + "Due {local date}" badge; `MAINTENANCE_INVALID` → inline error, draft kept.
- **Goals progress bar updates**: `PUT /riders/me/goals` (`earningsGoalTZS`, `hoursGoalPerWeek`, `weeklyAvailability`, `peakHourAlerts`) → 200; the scorecard renders the weekly-goal progress bar at `earningsTZS` vs goal ratio; changing the goal refetches both views; `GOALS_INVALID` → inline error.
- **Export tax PDF job**: Export Center `reportType: tax`, `format: pdf`, window → 202 `{jobId, status: queued}` → `processing` pill; duplicate submit → `EXPORT_IN_PROGRESS` → the running job card is shown; MSW `data_export.ready` resolves the card to `ready` (no invented poll endpoint).
- **Training module complete → certificate + reward**: open module → `in_progress`; Complete → 200 `TrainingModule` `status: certified` + `certificateUrl`; certificate card shows `rewardTZS` `TZS x,xxx` and the statement gains the `bonus` entry with the module reference; unknown module → `TRAINING_MODULE_NOT_FOUND` → card removed + list refetch.
- **Trusted contact notified on SOS drill**: add contact (`notifiedOnSos: true`, `shareLocation`) → 201; SOS drill (`POST /sos`) → alert screen shows "Emergency contacts notified"; contacts at cap → `CONTACT_LIMIT_REACHED` → Add disabled, list unchanged; delete → 204.
- **Security score reflects fraud alert**: MSW `risk.event_detected` → `GET /riders/me/security` returns a lower `securityScore` + `alerts[]` (`type: unusual_location`, `severity: high`, `at`) → Security screen gauge + alert row; scorecard `RiderPerformance.securityScore` mirrors it; alert → prefilled ticket link.

## Detox E2E — deep-pass features (LIVE)

- **Wait timer → waitPayTZS in fare**: "Order not ready — start wait" → countdown on DeliveryDetail; MSW advances `Order.waitSeconds` → stops on `picked_up` (elapsed time in the pickup `note`); after `delivered`, `GET /orders/{orderId}/fare` returns `waitPayTZS > 0` — fare breakdown + Earnings summary show the wait-pay row (`TZS x,xxx`) and the sum rule incl. `waitPayTZS` holds; cancel/failed delivery discards the timer, no wait-pay row.
- **Items-checked flag**: confirm a subset of items in POD → `Order.itemsChecked: false`, checklist resumes from the confirmed subset; confirm all → refetch shows `itemsChecked: true` + "Items verified" badge.
- **Auto-accept preference auto-accepts next offer**: `autoAccept: true` (PUT 200) → `order.rider_assigned` without an OfferModal + "Auto-accepted" toast → DeliveryDetail; concurrent manual accept → server picks, single order state (no double-post); toggle off → modal returns; bad payload → `PREFERENCES_INVALID` inline, previous values kept.
- **Suggested areas render on the map**: `GET /dispatch/forecast` returns `suggestedAreas: ["Kariakoo", "Buguruni"]` → chips over the predictive heat map; tap → external maps deep link; `FORECAST_UNAVAILABLE` → chips hidden (no crash).
- **Mission claim flow**: mission at `targetDeliveries` → `canClaim: true` → Claim → `claimed: true` + `bonus` ledger entry with the mission reference; claim before the threshold → `PROMOTION_NOT_CLAIMABLE` inline + refetch (disabled button state).
- **Chat queued offline → replayed via sync/batch**: offline → send chat message → enqueued as a `chat_send` action with a `clientActionId` (pending state in the thread); reconnect → `POST /riders/me/sync/batch` includes it → `applied`/`highWaterMark` → sent state; MSW duplicate replay → `duplicate` status → local copy dropped, no duplicate message.

## Detox E2E — appeals flow (planned)

Scenario: penalty → appeal ticket → decision → notification.

1. MSW dispatch flags a repeated decline; server emits `penalty.issued` → rider sees the penalty card + warning banner.
2. Rider opens an appeal: prefilled ticket (`POST /support/tickets`) referencing the penalty and order; submit → ticket `open`.
3. MSW admin (rider operations) resolves the appeal: ticket `resolved` with decision; `appeal.resolved` emitted; mocked reliability score recalculated.
4. App shows the decision in the ticket thread and notification center; the score card reflects the new value.

## Detox E2E — rich-media chat and rider level (P10c)

- **Chat with location pin**: in the order conversation, attach a `location` message with `locationPin {lat, lon, label}` → sent with up to 4 attachments → the pin renders on the embedded map; > 4 attachments → `VALIDATION_FAILED`; unknown `mediaType` → `MEDIA_TYPE_INVALID` inline error, draft kept.
- **Voice note upload**: record → attach `mediaType: voice` → message sends with the audio URL → plays inline on the thread; failed upload keeps the draft with retry.
- **Level badge reflects performance tier**: `GET /riders/me/performance` returns `level: gold` + `levelBenefits[]` → Profile shows the gold badge and the benefit list; MSW tier change emits the level-up notification → badge refetches to `platinum`.

## Detox E2E — intercity, line-haul & relay (M11 logistics lane)

- **Consignment lifecycle with full manifest verified**: a `linehaul_bus` rider (MSW `transportMode`) sees the Consignments tab; create a consignment from orders (`POST /linehaul/consignments` with hub pickers from `GET /hubs`, `transportMode: linehaul_bus`) → 201 → detail groups the manifest by `section` (`standard`/`fragile`/`cold_chain`/`documents`/`high_value`) with per-order `waybillNumber`; departure scan → `in_transit` + `departedAt`; arrival scan with `verifiedOrderIds` equal to the manifest → `at_hub`; per-order sortation; last-mile handoff; the waybill trail shows `scanned` → `departed` → `arrived` → `sorted` events; `consignment.departed`/`consignment.arrived` in-app notifications refresh the list.
- **Missing order → CONSIGNMENT_MISSING_ORDERS exception**: arrive with `verifiedOrderIds` missing one manifest order → 409 `CONSIGNMENT_MISSING_ORDERS` → exception banner, `waybill.updated` (exception event) row on the waybill trail, ops notified (`consignment.exception`); the manifest difference is listed; retry after resolution succeeds. Variant: `verifiedOrderIds` containing an order not on the manifest → 409 `CONSIGNMENT_ORDER_MISMATCH` → difference list shown, no state change.
- **Seal broken blocks handoff**: `POST /orders/{orderId}/handoff` with `sealIntact: false` → 409 `HANDOFF_SEAL_BROKEN` → leg stays `in_progress`, ops flag rendered, no advance; re-scan with seal intact + `conditionPhotoUrl` → 201 `Handoff` → leg completes; variant: wrong `scanCode` → 409 `HANDOFF_SCAN_MISMATCH` → re-scan prompt, draft kept.
- **Relay handoff at a meeting point**: a `relay` rider receives a chain assignment (normal offer, 120 s window) → navigates to the meeting point → handoff (scan + seal + photo, `location` = meet point) → `handoff.completed` → receiving rider's leg flips `in_progress`; duplicate/completed leg advance → 409 `LEG_ALREADY_COMPLETED` → refetch shows completed.
- **Transport-mode mismatch never offered**: MSW matching rejects a `linehaul_bus` leg for a `local_motorcycle` rider (`TRANSPORT_MODE_INVALID` server-side) — no OfferModal, no feed card; `RiderPrivate.transportMode` renders on Profile and gates the Consignments tab visibility.

## Detox E2E — Logistics OS (M11b) — full step-by-step flows

### Scenario L1 — Full shipment lifecycle: create → scan → seal → load → depart → arrive → reconcile → close

Setup: MSW seeded with a paid order (`fulfillmentType: intercity`), a route
(Dar es Salaam → Mwanza), vehicles (Bus 15 `linehaul_bus` with standard/fragile/
documents/high_value compartments; Bus 16 refrigerated), and hubs A/B. Actors:
pickup rider, hub courier (hub A), driver (linehaul_bus), hub courier (hub B).

1. **Create shipment**: pickup rider opens the order → Create shipment
   (`POST /shipments` `{orderId, packageCount: 2}`) → 201 `Shipment`
   `status: planned` with `packages[]` (PKG-… × 2, `status: prepared`).
2. **Duplicate guard**: second POST → 409 `SHIPMENT_ALREADY_EXISTS` → app opens
   the existing shipment, no duplicate UI.
3. **Pickup scan**: scan screen step 1 scans PKG-1 → step 2 hub A bin → step 3
   seal (n/a at pickup) + photo + GPS → `POST /shipments/{id}/scan`
   `{scanType: pickup, ...}` → 201 `CustodyEntry` `eventType: picked_up`;
   shipment `picked_up`, package `scannedIn: true`; custody timeline shows the
   entry with `actorType: rider`, `deviceId`, GPS, local time.
4. **Hub in + sort**: hub courier A scans both packages (`hub_in`) → shipment
   `at_hub`; sort into sections (PKG-1 standard, PKG-2 documents).
5. **Container build + seal**: Container screen → kind `bag`, section `standard`
   → scan PKG-1 → `POST /containers` → 201 unsealed → SEAL → `sealed: true`,
   `sealCode` + `sealedAt` shown; duplicate seal attempt → 409
   `CONTAINER_ALREADY_SEALED` → sealed state shown.
6. **Trip loading**: driver opens TRP-9912 (`status: planned`,
   `manifestSummary {expectedUnits: 2, verifiedUnits: 0, exceptions: 0}`) →
   START LOADING → `loading` → scan package into `standard` compartment
   (`vehicle_load` + `vehicleId: bus-15`) → 201 `vehicle_loaded` custody entry;
   cargo summary `verifiedUnits: 1`.
7. **Depart**: DEPART → confirm → trip `in_transit` + `departedAt`; vehicle
   `on_trip` with `currentTripId`; `trip.departed` push refreshes the trip
   screen; plan frozen.
8. **Arrive**: ARRIVE → trip `unloading` + `arrivedAt`; `trip.arrived` push.
9. **Unload + reconcile**: UNLOAD → scan both packages out (`vehicle_unload`)
   → RECONCILE with `scannedOrderIds` = both → 200 `ReconciliationResult`
   `{expected: 2, scanned: 2, missingOrderIds: [], status: matched,
   tripClosed: true}` → COMPLETE → trip `completed`; trip summary shows final
   `manifestSummary` and timestamps.
10. **Last mile + delivery**: hub courier B scans (`hub_in`), last-mile rider
    scans (`out_for_delivery` → `out_for_delivery`), delivery scan
    (`scanType: delivery`) → shipment `delivered`; custody chain ends with the
    `delivered` entry.

### Scenario L2 — Reconciliation mismatch: find missing → close

1. Follow L1 steps 1–8 but unload only one of two packages.
2. RECONCILE with one `scannedOrderIds` → 409 `RECONCILIATION_FAILED` with
   `missingOrderIds: [PKG-2's order]`; screen shows expected 2 vs scanned 1 and
   the missing list.
3. Attempt COMPLETE → 409 `TRIP_CANNOT_CLOSE` → button disabled with "open
   reconciliation" copy.
4. LOCATE: open `GET /shipments/{id}/custody` for the missing package — last
   entry is `vehicle_loaded` on Bus 15 (actor, deviceId, GPS) → search the bus
   → find the package → re-scan (`vehicle_unload`) → custody entry `unloaded`.
5. RECONCILE again → 200 `matched` + `tripClosed: true` → COMPLETE → `completed`.
6. Variant: package not found → escalate via support ticket → admin workflow 23
   (replan on next corridor or declare lost) — rider sees `plan.replanned` or
   `intercity.eta_updated`; reconciliation stays blocked until ops resolves.

### Scenario L3 — Blocked wrong-vehicle handoff (multi-factor)

1. Package PKG-1 is planned on TRP-9912 (Bus 22).
2. At the loading bay the hub courier scans PKG-1 with `vehicleId: bus-19`
   (TRP-9909) → 409 `HANDOFF_VERIFICATION_FAILED` — "Package is planned for a
   different vehicle"; custody ledger unchanged (no failed entry); ops flagged;
   inline block shows `ErrorResponse.message` + `requestId`.
3. The scan screen shows the expected vehicle (Bus 22) → re-scan with
   `vehicleId: bus-22` → 201 `vehicle_loaded` → loads correctly.
4. Variant: seal broken → 409 `HANDOFF_SEAL_BROKEN` → leg blocked, ops flag;
   re-scan after re-sealing succeeds. Variant: wrong barcode → 409
   `HANDOFF_SCAN_MISMATCH` → re-scan prompt, draft kept.

### Scenario L4 — Compartment incompatibility and capacity

1. A `cold_chain` package (attributes `temperature: cold_chain`,
   `allowedModes: ["refrigerated_truck"]`) is loaded onto Bus 15
   (`temperatureCapable: false`) → 409 `COMPARTMENT_INCOMPATIBLE` — rejected
   even though the standard compartment has free space; the compartment row
   renders "blocked (no refrigeration)".
2. Load the same package onto Bus 16 (`refrigerated_truck`,
   `temperatureCapable: true`) → 201; `verifiedUnits` climbs.
3. Over-capacity: fill the `standard` compartment to `capacity`; one more
   `vehicle_load` → 409 `VEHICLE_CAPACITY_EXCEEDED` → no state change.
4. Variant: `highValue` package onto a vehicle with `securityCapability: none`
   → 409 `COMPARTMENT_INCOMPATIBLE`; onto the `lockbox`-capable vehicle →
   success with the ID-check handoff step.

### Scenario L5 — Replan after breakdown

1. TRP-9912's vehicle goes `maintenance` before departure; consignment C-1
   still `manifesting`.
2. Dispatcher opens replan → alternate trip TRP-9913 (Bus 16) →
   `POST /linehaul/consignments/{id}/replan` `{reason, alternateTripId}` →
   200 `Consignment` re-assigned; `plan.replanned` push (driver + hubs); the
   consignment appears on TRP-9913's manifest.
3. After TRP-9912 departed: same call → 409 `PLAN_NOT_MUTABLE` → inline block,
   plan unchanged.
4. Customer ETA updates via `intercity.eta_updated`; waybill gains no invented
   events.

### Scenario L6 — Anomaly awareness

1. MSW returns `SCAN_GPS_MISMATCH` on a hub scan (actor GPS 70 km from the hub)
   → 409 inline block + `logistics.anomaly` critical push (ops + trust &
   safety); no custody entry written; the app never blind-retries.
2. `SCAN_VEHICLE_STATIC`: scan recorded onto a bus that never moved since
   departure → 409 + anomaly; resolution is ops-owned (admin workflow 24) —
   the rider renders the block with `requestId` only.

### Scenario L7 — Bus-operator trip surface states

Walk TRP-9912 through all six states and assert per state: `planned` shows
START LOADING only; `loading` shows DEPART; `in_transit` shows ARRIVE;
`unloading` shows UNLOAD + COMPLETE (blocked until matched); `completed` and
`cancelled` render read-only summaries. Wrong-state actions return 409
`TRIP_ALREADY_ACTIVE` → refetch shows the real state; each screen renders
loading/empty/error/retry/success.

## Detox E2E — deep logistics pass (service models, fleets, facilities, exceptions, weight/volume)

### Scenario D1 — Whitelisted entry at a gated facility

Setup: MSW seeded with a facility (`accessPolicy: whitelist_only`, geofence
polygon around the gate) whose `whitelistRiderIds` contains the test rider, and
an assigned delivery with drop-off inside the facility.

1. Rider arrives at the gate → starts the delivery scan (`scanType: delivery`)
   with GPS inside the geofence → server checks whitelist membership → 201
   `CustodyEntry` → "Entry granted" prompt; the custody entry records the
   `rider → facility → delivery` binding.
2. `facility.whitelist_granted` (in-app) is asserted in the notification center;
   the Facility whitelist status screen shows the facility with the grant pill
   + policy label (`whitelist_only`).
3. Variant `whitelist_or_otp`: same flow without whitelist membership but with a
   valid one-time code → entry granted; variant `open`: no membership needed.
4. Geofence variant: scan with GPS **outside** the polygon → scan rejected
   (`SCAN_GPS_MISMATCH`-style anomaly block with `requestId`), no custody entry.

### Scenario D2 — NOT_WHITELISTED blocked

1. MSW removes the rider from `whitelistRiderIds` (`facility.whitelist_revoked`
   in-app asserted) → whitelist status screen shows the revoke pill.
2. Rider attempts the entry scan anyway → 403 `NOT_WHITELISTED` → inline block
   with the facility name + `requestId`; "Request access" opens a prefilled
   support ticket (order + facility context); the app never blind-retries.
3. After admin grants again (`facility.whitelist_granted`), the scan succeeds →
   201 + "Entry granted".

### Scenario D3 — Exception report → resolve

1. On a shipment mid-trip, rider taps Report exception → 18 kind chips render
   from the catalog → pick `damaged_package` + description (≤ 1000) + auto-linked
   shipment/order/trip → `POST /delivery-exceptions` → 201 `{status: open,
   autoReplanned: false}` → exception card with id + `requestId`.
2. `exception.created` (push/in-app) asserted on ops side (mock); the rider's
   exception list shows the row with the `open` pill.
3. Ops PATCHes `{status: resolving}` → list refetches to `resolving`.
4. Ops resolves: `{status: resolved, outcome}` → `exception.resolved` → the
   rider's exception detail shows `resolved` + `outcome` + `resolvedAt`.
5. Duplicate resolution attempt (already `resolved`) → 409
   `EXCEPTION_ALREADY_RESOLVED` → refetch shows the terminal state; there is no
   reopen UI.
6. Variant: submit without kind/description → 422 `VALIDATION_FAILED` → inline
   field errors, draft kept.

### Scenario D4 — Auto-replan after breakdown

1. MSW marks the trip's vehicle `maintenance` before departure; the engine
   creates a `vehicle_breakdown` exception (`autoReplanned: true`) and moves the
   consignment to TRP-9913.
2. The driver receives `plan.replanned` (+ `plan.optimized` when the optimizer
   re-runs) → the trip screen shows "Route replanned — TRP-9913 replaces
   TRP-9912" banner → refetch shows the consignment on TRP-9913's manifest.
3. The exception detail shows `autoReplanned: true`, kind `vehicle_breakdown`,
   and the outcome text; the custody chain is unchanged (no invented events).
4. Customer-side mock asserts `intercity.eta_updated` with the new window.
5. Variant: the original trip had already departed → no replan possible
   (`PLAN_NOT_MUTABLE` on the dispatch side); the exception resolves via the
   locate/loss path — the rider sees only the resolution outcome.

### Scenario D5 — Weight capacity rejection

1. Seed a van with `maxWeightKg: 800`; package A (`weightKg: 40`) loaded
   (`usedWeightKg: 780` after prior loads).
2. Load package A → 409 `CAPACITY_WEIGHT_EXCEEDED` — rejected despite free
   `used` slots; no custody entry; the compartment weight bar shows
   `780/800` and the rejected package row explains the block with `requestId`.
3. Offload 20 kg (unload a package, `usedWeightKg: 760`) → retry the load →
   201; counters update: 760 + 40 = 800 ≤ `maxWeightKg: 800` → accepted,
   `usedWeightKg: 800`. Variant: offload only 10 kg (`usedWeightKg: 770`) →
   retry still fails (770 + 40 = 810 > 800) until the load fits.
4. Volume variant: `maxVolumeL: 6000`, compartment `usedVolumeL: 5900`, package
   `volumeL: 200` → 409 `CAPACITY_VOLUME_EXCEEDED`.
5. Null variant: package without `weightKg`/`volumeL` passes the weight/volume
   checks (unit check only); counters are not fabricated (no 0 defaults
   rendered).

### Scenario D6 — Fleet sub-account provisioning

1. Admin-side mock: `POST /fleet/accounts` creates the master; rider ops sets
   `serviceModel: fleet` + `fleetAccountId` on the rider record (audit
   `fleet.*` / `rider.*` asserted server-side).
2. Driver logs in → `GET /riders/me` returns `serviceModel: fleet` +
   `fleetAccountId` → Profile renders the fleet badge + linkage chip (id only —
   no master name/vehicles/billing anywhere in the response or UI).
3. Assert the fields are not editable: no PUT path exists in the app; a forced
   `PATCH /riders/me` with those fields is ignored (they are not in
   `RiderUpdate`).
4. Master suspended (`FLEET_ACCOUNT_SUSPENDED`): dependent admin surfaces
   reject; the driver's own profile remains readable; a dependent call renders
   the block with `requestId` (no crash).
5. Service-model matching: MSW dispatch returns a guaranteed-priority offer to
   an eligible `specialized` rider before the `crowdsourced` pool — asserted by
   offer order in the mock; `SERVICE_MODEL_INVALID` variant rejected on the
   admin mutation only.

### Scenario D7 — Warehouse pickup and carrier handoff context

1. A warehouse-fulfilled order (`dispatchStrategy: warehouse`,
   `fulfillmentSource: warehouse`): the order detail renders the warehouse as
   the pickup point (name/address from server data, not the merchant storefront)
   + the strategy chip; first-mile leg origin = warehouse.
2. `warehouse.fulfilled` is asserted on the customer-side mock (never in the
   rider app); `warehouse.stock_low` never targets the rider.
3. A carrier-leg consignment (`Consignment.carrierId` set,
   `RouteSegment.handledBy: carrierId`): the consignment detail shows the
   carrier leg pill; `carrier.handoff_required` (push + in-app) surfaces at the
   handoff point; the platform rider's handoff scan follows the standard
   multi-factor flow (Scenario L3-style verification still applies).
4. Read-only assertions: the rider app never calls `/warehouses`,
   `/carriers`, `/facilities`, `/fleet/accounts`, or the admin reassign/escalate
   endpoints (MSW asserts no requests to those paths from the app).

## Per-screen checklist (required by ROADMAP standing rule 2)

| State | Assertions |
| --- | --- |
| Loading | skeleton/indicator shown; no action buttons enabled that depend on data |
| Empty | empty-state copy (localized); no crash; correct CTA (e.g. online toggle, upload docs) |
| Error | `ErrorResponse.message` shown; `requestId` available for support; no partial stale data |
| Retry | retry action refetches; states recover without app restart |
| Success | data rendered from server shape; money `TZS x,xxx`; statuses use contract enums |

Screens covered: OTP, onboarding/verification, business mapping, Home (online toggle + active list + shift card + available-orders entry + heat map entry), OfferModal + reject reasons, available orders feed + offer card, fare breakdown, batch pickup card, DeliveryDetail (hold, add-items, share trip), pickup, arrival statuses, proof of delivery (item-wise + PDF), failed delivery/RTO, reschedule, transfer, issue-report sheet, missions, shifts (clock-in/out + reconciliation, swap, break), SOS, tips, earnings summary/statement, earnings analytics, wallet v2 + COD reconciliation, performance scorecard + compare + safety detail, leaderboard, heat map, notifications, preferences, tickets (list/create/detail), help center (articles), settings, logout, penalty detail + appeal (planned), academy courses (planned), trip summary + reorder, order list v2 (priority badges + sorting), order detail v2 (priority badge + surge indicator + chat link), in-app chat (rich media + location pin + voice), rider level badge, earnings ticker, vehicle & maintenance, goals & schedule, expenses, export center, training center, trusted contacts, security score, consignment list/detail + create, departure/arrival scans, route/legs view, handoff screen, waybill timeline, trip screen (manifest summary + load/depart/arrive/unload), shipment list/detail + create, scan/verify (3-step), custody timeline, reconciliation screen, container build, service model badge + guaranteed-hours card + available-orders feed (D1–D7), fleet badge/linkage, facility whitelist status + entry scan (D1–D2), exception report/list/status (D3–D4), trip weight/volume cargo summary (D5), warehouse pickup context + carrier handoff context (D7).

## CI gates

- `npm run lint`, `tsc --noEmit`, `jest` (unit + component + MSW contract), `detox build/e2e` on EAS/CI per release candidate.
- Contract test suite must be green against staging (launch definition, per `ROADMAP.md`).
