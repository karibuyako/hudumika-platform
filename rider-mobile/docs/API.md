# HUDumika RIDER — API Surface

Source of truth: `backend/API-CONTRACT.yaml`. Every path below exists in that contract verbatim; do not add endpoints. Base URL is environment-driven (`EXPO_PUBLIC_API_URL`), all paths under `/api/v1`. Timestamps are UTC ISO 8601; money is TZS integer minor units. `/admin/*` endpoints (manual override assignment, COD reconciliation) are staff-only and never callable by the rider app.

## Auth and profile

| Operation | Endpoint | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| `requestOtp` | `POST /auth/request-otp` | Send OTP (phone/email) | `{channel, destination, purpose: login\|signup\|verify_role}` | `OtpDelivery` `{requestId, expiresInSeconds, resendInSeconds}` |
| `verifyOtp` | `POST /auth/verify-otp` | Verify + issue session | `{requestId, code}` | `Session` `{accessToken, refreshToken, user}` |
| `refreshToken` | `POST /auth/refresh` | Rotate access token | `{refreshToken}` | `Session` |
| `logout` | `POST /auth/logout` | Revoke session | — | 204 |
| `getMe` | `GET /users/me` | Profile + active role | — | `User` `{id, phone, email, fullName, avatarUrl, activeRole, roles[], locale, createdAt}` |
| `updateMe` | `PATCH /users/me` | Update name/email/locale | `UserUpdate` | `User` |
| `listMyRoles` | `GET /users/me/roles` | Role switching | — | `RoleSummary[]` `{role, merchantId?, providerId?, riderId?}` |
| `getMyRider` | `GET /riders/me` | Rider profile, vehicle, verification, online, rating | — | `RiderPrivate` |
| `updateMyRider` | `PATCH /riders/me` | Change `deliveryZone`, `vehicle` | `RiderUpdate` | `RiderPrivate` |
| `setRiderAvailability` | `PUT /riders/me/availability` | Go online/offline | `{online: boolean}` | 204 |

`RiderPrivate` required: `id, name, city, vehicle, verification, online`; also `rating`, `reviewCount`, `deliveryZone`, `merchantIds` (role mapping), `employmentType` (`full_time | part_time`), `availability` `{preferredDays, preferredStart, preferredEnd, maxHoursPerDay (default 12)}` (read-only in app, ONBOARDING.md), `hubId` (distribution hub, nullable) and `fleetType` (`captive | contracted | outsourced | hybrid`, default `captive`) — hub/fleetType are also updatable via `RiderUpdate`. `RiderUpdate.ratingFilterMin` (nullable) sets the customer rating floor; `RiderPrivate.ratingFilterMin` reflects it; `RATING_FILTER_INVALID` (422, out of range) → inline error, previous value kept (DISPATCH-FLOW.md). `RiderPrivate.serviceModel` (`specialized | crowdsourced | errand | fleet`, default `specialized`) and `RiderPrivate.fleetAccountId` (uuid, nullable) are **read-only profile fields — not in `RiderUpdate`**; they are set by admin (rider ops / fleet account manager) at onboarding/employment transitions, audited (`rider.*` / `fleet.*`), and guarded by `SERVICE_MODEL_INVALID` (422) on invalid admin values (LONG-HAUL-RELAY.md sections 13–14).

## Orders (rider-scoped)

| Operation | Endpoint | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| `listMyOrders` | `GET /orders/me?status=&limit=&cursor=` | Active/history orders | `status` = `OrderStatus` filter | `Order[]` |
| `getOrder` | `GET /orders/{orderId}` | Detail + event history | — | `OrderDetail` (adds `items[]`, `deliveryAddress`, `events[]`) |
| `advanceOrder` | `POST /orders/{orderId}/status` | Advance status (rider-scoped) | `{status, note?}` | `Order` |
| `trackOrder` | `GET /orders/{orderId}/track` | Live tracking position | — | `TrackingEvent` `{status, riderLocation{lat,lon}, updatedAt, estimateMinutes, stageEtas?}` — `stageEtas` `{merchantArrival?, pickup?, dropoff?}` (minutes, nullable) |

Rider-advanceable `OrderStatus` values: `rider_arrived_pickup`, `picked_up`, `delivering`, `rider_arrived_dropoff`, `delivered` (via `advanceOrder`); `failed_delivery`, `returning`, `rescheduled` are set through the exception endpoints, never via `advanceOrder`. Read-only statuses in rider UI: `paid`, `merchant_accepted`, `preparing`, `rider_assigned`, `completed`, `cancelled`, `refunded`, `failed`, `disputed`. `OrderDetail.items[]`: `{catalogueItemId, name, quantity, unitPriceTZS}`; `deliveryAddress`: `AddressSnapshot`; `events[]`: `{status, at, by, note?}`.

## Earnings and payouts

| Operation | Endpoint | Purpose | Response |
| --- | --- | --- | --- |
| `listMyPayouts` | `GET /payouts/me?limit=&cursor=` | Payout history | `PayoutSummary[]` |
| `getMyStatement` | `GET /payouts/me/statement?from=&to=` | Ledger statement | `LedgerStatement` |

`PayoutSummary`: `{id, amountTZS, status, method?, createdAt, paidAt?}`. `LedgerEntry.type` rider-relevant: `delivery_fee` (+), `bonus` (+), `tip` (+), `adjustment` (+/−), `payout` (−).

## Dispatch feed and fare

| Operation | Endpoint | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| `listAvailableDispatchOrders` | `GET /dispatch/available-orders?lat=&lon=&radiusKm=&limit=` | Grab-mode feed (per-city config, DISPATCH-FLOW.md) | `lat`, `lon` required; `radiusKm` default 5; `limit` default 10 | `DispatchOffer[]` |
| `getOrderFareBreakdown` | `GET /orders/{orderId}/fare` | Rider fare breakdown for an assigned or completed order | — | `FareBreakdown` / 404 |

`DispatchOffer`: `{orderId, pickup, dropoff, distanceKm, predictedPrepMinutes?, addressConfidence?, estimatedEarningsTZS, itemsSummary, paymentMethod, expiresAt}` — `distanceKm` is pickup + drop-off route distance; `predictedPrepMinutes` (ML merchant prep-time, nullable) and `addressConfidence` (0–1, nullable) ride on the offer (DISPATCH-FLOW.md); `paymentMethod` ∈ `mpesa | tigo_pesa | airtel_money | ezy_pesa | halotel | card | cod | bank`. `FareBreakdown`: `{orderId, baseTZS, distanceTZS, timeTZS, surgeMultiplier, surgeTZS, tipTZS, codFeeTZS, bonusTZS, totalTZS, currency}` — `surgeMultiplier` is the peak/weather boost factor (default 1.0) applied to the base fare and `surgeTZS` its money line; sum rule and error codes in EARNINGS.md (`OFFER_NOT_FOUND` 404 — expired grab offer; `FARE_NOT_AVAILABLE` 404 — hide Fare row).

## Reviews (rating view) — no rider reviews-list endpoint exists; the rating view = `GET /riders/me` (`rating`, `reviewCount`) + `review.received`. Never add a client-side reviews endpoint.

## Notifications
| Operation | Endpoint | Purpose | Response |
| --- | --- | --- | --- |
| `listMyNotifications` | `GET /notifications/me?unreadOnly=&limit=&cursor=` | Notification center | `Notification[]` |
| `getNotificationPreferences` | `GET /notifications/me/preferences` | Read preferences | `NotificationPreferences` |
| `updateNotificationPreferences` | `PUT /notifications/me/preferences` | Update per-event toggles | `NotificationPreferences` |
| `markNotificationRead` | `POST /notifications/{notificationId}/read` | Mark one read | 204 |

`Notification`: `{id, type, title, body, deepLink?, read, createdAt}`. `NotificationPreferences`: per channel — `push`, `sms`, `email`, `inApp` → `{eventKey: boolean}`.

## Support tickets

| Operation | Endpoint | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| `createTicket` | `POST /support/tickets` | Open a ticket | `TicketCreate` `{subject, body, category?, urgency?, orderId?, bookingId?}` | 201 `Ticket` |
| `listMyTickets` | `GET /support/tickets/me` | Own tickets | — | `Ticket[]` |
| `getTicket` | `GET /support/tickets/{ticketId}` | Detail + messages | — | `TicketDetail` |
| `replyTicket` | `POST /support/tickets/{ticketId}/messages` | Reply | `{body}` (max 4000) | 201 `TicketDetail` |

`Ticket.status` ∈ `open | assigned | in_progress | resolved | closed`; `priority` ∈ `low | normal | high | critical`. `TicketDetail.messages[].authorRole` ∈ `customer | merchant | provider | rider | agent`.

`TicketCreate.category` ∈ `payment | order | account | safety | equipment | other` (default `other`) — drives routing; `urgency` ∈ `low | normal | high | critical` (default `normal`) — `high`/`critical` escalate per SUPPORT.md SLAs. The ticket form renders category chips + an urgency selector (default `normal`), never free text; `requestId` from any failed call goes into the ticket body for traceability.

## Help center (knowledge base)

| Operation | Endpoint | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| `listHelpArticles` | `GET /help/articles` | Knowledge-base articles | `q` (search), `category` filters — both optional | `{id, title, category, body}[]` |

- Help Center screen (NAVIGATION.md): search box (`q`) + category chips (`category`); results are server-filtered — the app never filters locally.
- States: loading skeletons → empty ("No articles found" + clear-filters CTA) → error + retry → success (article list → detail with `body`).
- Articles can prefill a related support ticket (e.g. a payout article pre-fills the subject); no article content is hardcoded in the app.

## Rider operations (order-stage granularity)

| Operation | Endpoint | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| `listRiderRejectReasons` | `GET /riders/reject-reasons` | Decline-reason catalog | — | `string[]` |
| `reportRiderLocation` | `POST /riders/me/location` | Throttled position report | `{lat, lon, accuracyM?, activity?, reportedAt?}` | 204 |
| `listRiderMissions` | `GET /riders/me/missions?status=` | Missions / incentives | `status` ∈ `active\|completed\|expired` | `RiderMission[]` |
| `submitProofOfDelivery` | `POST /orders/{orderId}/proof-of-delivery` | Submit POD (photo/signature/OTP) | `ProofOfDelivery` | 200 `ProofOfDelivery` |
| `failDelivery` | `POST /orders/{orderId}/failed-delivery` | Mark failed / return to origin | `{reason, note?, photoUrl?, returnToMerchant?}` | `Order` |
| `rescheduleOrder` | `POST /orders/{orderId}/reschedule` | Reschedule an attempt | `{scheduledAt, reason}` | `Order` |
| `transferOrder` | `POST /orders/{orderId}/transfer` | Request transfer (in-transit only) | `{reason}` | 202 `{transferId, status}` |
| `createSosAlert` | `POST /sos` | Emergency alert to dispatch + safety ops | `{type, note?, lat?, lon?}` | 201 `SosAlert` |
| `setDestinationFilter` | `PUT /riders/me/destination-filter` | Destination filter — dispatch skips offers away from the destination | `DestinationFilter` | 200 `DestinationFilter` |
| `clearDestinationFilter` | `DELETE /riders/me/destination-filter` | Clear the destination filter | — | 204 |
| `createMaskedCall` | `POST /orders/{orderId}/masked-call` | Masked VoIP call session with the customer (number privacy) | — | 201 `MaskedCallSession` |

- `ProofOfDelivery`: `{id, orderId, type, value, itemIds?, documentUrl?, gpsStamp?, verified, submittedAt}` — `itemIds` confirms each item separately (item-wise POD, DELIVERY-FLOW.md); `documentUrl` is an optional PDF delivery note/invoice. Errors: `POD_INVALID`, `POD_ALREADY_SUBMITTED`, `POD_OTP_INVALID`. Failed delivery: `reason` ∈ `customer_unavailable | wrong_address | refused | damaged | other`; `FAILED_DELIVERY_NOT_ALLOWED`. Reschedule: `RESCHEDULE_IN_PAST`. Transfer: `TRANSFER_NOT_ALLOWED`, `TRANSFER_ALREADY_REQUESTED`.
- `DestinationFilter`: `{enabled (required), lat?, lon?, area? (max 120), windowFrom?, windowTo?, maxDetourKm (default 5)}` — dispatch skips offers whose drop-off exceeds `maxDetourKm`; auto-clears at `windowTo` or manual clear; `DEST_FILTER_INVALID` (422, bad area/coords) (DISPATCH-FLOW.md).
- `MaskedCallSession`: `{sessionId, orderId, maskedNumber, direction: rider_to_customer | customer_to_rider, expiresAt}` — real numbers never exchanged; the app dials `maskedNumber` only; errors `MASKED_CALL_NOT_ALLOWED` (409, order not assigned to this rider → hide action), `MASKED_CALL_EXPIRED` (session expired → re-create via a fresh POST) (DELIVERY-FLOW.md).
- SOS: `type` ∈ `safety | medical | mechanical | other`; `status` ∈ `open | acknowledged | resolved`; `SOS_RATE_LIMITED`. Location: `activity` ∈ `stationary | walking | cycling | driving`; `LOCATION_INVALID`, `LOCATION_RATE_LIMITED`. Missions: reward lands as a `bonus` ledger entry; `MISSION_NOT_FOUND`; `MISSION_ALREADY_CLAIMED` reserved (planned claimable missions).

## Tips, shifts, and order-issue catalog

| Operation | Endpoint | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| `tipRider` | `POST /orders/{orderId}/tip` | Customer gratuity (customer-callable; rider reads `Order.tipTZS`) | `{amountTZS, method?, note?}` | `Order` |
| `listOrderIssueReasons` | `GET /orders/issue-reasons` | Report-issue reason catalog | — | `string[]` |
| `listRiderShifts` | `GET /riders/me/shifts?scope=` | Shift list | `scope` ∈ `current\|upcoming\|past` | `RiderShift[]` |
| `riderClockIn` | `POST /riders/me/shifts/clock-in` | Start a shift | `{shiftId, lat?, lon?}` | `RiderShift` |
| `riderClockOut` | `POST /riders/me/shifts/clock-out` | End shift + COD cash reconciliation | `{shiftId, cashCollectedTZS?, cashReconciled?}` | `RiderShift` |

- `RiderShift`: `{id, riderId, startsAt, endsAt?, status, deliveriesCompleted, earningsTZS, cashCollectedTZS, cashReconciled, clockedInAt?, clockedOutAt?, forcedRestUntil?, continuousDrivingMinutes}` — `status` ∈ `scheduled | active | completed | cancelled`; `forcedRestUntil` (nullable) is the mandatory-rest window — `REST_ENFORCED` blocks new offers until it passes (DISPATCH-FLOW.md). Errors: `SHIFT_NOT_FOUND`, `SHIFT_ALREADY_ACTIVE` (clock-in), `SHIFT_CLOCKOUT_WITHOUT_CLOCKIN`, `SHIFT_CASH_MISMATCH` (clock-out). Tip errors: `TIP_NOT_ALLOWED` (order not completed), `TIP_EXCEEDS_LIMIT`.

## Fleet management, trips (Phase 2)
| Operation | Endpoint | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| `holdOrder` | `POST /orders/{orderId}/hold` | Hold a task (rider keeps the order) | `{reason, until?}` | 200 `Order` |
| `unholdOrder` | `POST /orders/{orderId}/unhold` | Resume a held task | — | 200 `Order` |
| `addItemsToOrder` | `POST /orders/{orderId}/add-items` | Rider adds items mid-delivery (merchant approval) | `{items: [{catalogueItemId, quantity}], reason}` | 202 `{requestId, status: pending_merchant_approval}` |
| `shareTrip` | `POST /riders/me/trips/{orderId}/share` | Share live trip with trusted contacts | `{recipients (≤5, phone), includeRoute?, expiresInHours?}` | 201 `{shareToken, expiresAt}` |
| `requestShiftSwap` | `POST /riders/me/shifts/{shiftId}/swap-request` | Swap a shift with another rider | `{targetRiderId, note?}` | 201 `{swapRequestId, status: pending}` |
| `manageShiftBreak` | `POST /riders/me/shifts/{shiftId}/break` | Start/end a break within a shift | `{action: start\|end}` | 200 `RiderShift` |
| `getRiderPerformance` | `GET /riders/me/performance?from=&to=` | Scorecard with benchmarks and trends | `from`/`to` dates optional | `RiderPerformance` |
| `getRiderLeaderboard` | `GET /riders/me/leaderboard?metric=&period=&limit=` | Live leaderboard | `metric` required ∈ `deliveries\|rating\|earnings\|on_time`; `period` default `weekly`; `limit` default 10 | `Leaderboard` |
| `getDispatchHeatmap` | `GET /dispatch/heatmap?lat=&lon=&radiusKm=` | Demand/surge heat zones | `lat`/`lon` optional; `radiusKm` default 10 | `HeatmapZone[]` |
| `getActiveTrip` | `GET /riders/me/trips` | Active batch trip | — | `Trip` / 404 |
| `getTrip` | `GET /riders/me/trips/{tripId}` | Trip detail + stops + earnings | — | `Trip` / 404 |
| `reorderTripStops` | `POST /riders/me/trips/{tripId}/reorder` | Manual stop sequence (drag-and-drop) | `{orderIds}` (new sequence, subset or full set) | `Trip` / 409 |

- Hold: one active hold per order — errors `HOLD_NOT_ALLOWED` (status gate, outside the assignable window), `HOLD_ALREADY_ACTIVE`; held orders are excluded from new offers (DISPATCH-FLOW.md). Add-items: approval updates order items + totals; errors `ADD_ITEMS_NOT_ALLOWED` (status gate), `ADD_ITEMS_PENDING` (approval in flight — blocks duplicates); events `order.add_items_approved` / `order.add_items_declined`. Trip share: `recipients` max 5 phone numbers, `includeRoute` default true, `expiresInHours` default 24; errors `TRIP_SHARE_NOT_ALLOWED`, `TRIP_SHARE_EXPIRED` (stale token — generate a fresh share; errors arrive via `ErrorResponse.code`). Swap: statuses `pending | approved | declined | cancelled`; errors `SWAP_NOT_ALLOWED` (shift not swappable), `SWAP_ALREADY_REQUESTED`; events `shift.swap_requested` / `shift.swap_decided`. Break: errors `BREAK_NOT_ALLOWED`, `BREAK_ALREADY_ACTIVE`; events `shift.break_started` / `shift.break_ended`.
- `RiderPerformance`: `{acceptanceRate, onTimePct, ratingAverage, completedOrders, earningsTZS, safetyScore, behaviorScore (nullable — planned), reliabilityScore, level, levelBenefits[], benchmarks{teamAverage, fleetAverage, percentileRank} (nullable), trends[{label, value}]}` — `level` ∈ `bronze | silver | gold | platinum` (default `bronze`, Meituan-style rider star level derived from performance) and `levelBenefits[]` (config-driven benefit strings, PERFORMANCE.md); errors `PERFORMANCE_UNAVAILABLE`.
- `Leaderboard`: `{metric, period, entries[{rank, riderName, value}], myEntry{rank, value}}` — error `LEADERBOARD_UNAVAILABLE`; `leaderboard.updated` weekly digest refreshes the screen. `HeatmapZone`: `{zoneId, name, polygon ("lon,lat"), demandLevel: low|medium|high|critical, surgeMultiplier, activeOrders, activeRiders}` — error `HEATMAP_INVALID`.
- `Trip`: `{id, riderId, orderIds, status: active|completed|cancelled, stops[{orderId, sequence, stopType: pickup|dropoff, status: pending|arrived|done|failed}], routeOptimized, earningsTZS, startedAt, completedAt?}` — `earningsTZS` is the batch summary (fares + tips + bonuses, EARNINGS.md); reorder `{orderIds}` is the new stop sequence (subset or full set of the trip's orders); completed trips emit `trip.completed` with the batch summary. `Order.priority` ∈ `normal | express | vip` (dispatch and list-sorting precedence) and `Order.promoCode` (rider promo — bonus credited on completion) are read-only rider fields; errors: `TRIP_NOT_FOUND` (404), `REORDER_INVALID` (409 — unknown order in the trip), `REORDER_NOT_ALLOWED` (409 — trip completed), `PROMO_INVALID` (order-level promo code rejected) (DISPATCH-FLOW.md).

## Chat and business mapping — `ChatMessage.authorRole` enum is `customer | merchant_staff | rider | dispatch | system`; rider messages render as `rider`; dispatch/system lines are read-only in order conversations. `ChatMessage` / `ChatMessageCreate` `attachments[]` (max 4 per message) carry `mediaType` ∈ `image | document | voice | location`, `url`, and `locationPin {lat, lon, label}` for location pins — `MEDIA_TYPE_INVALID` (422) rejects unknown types. `RiderPrivate.merchantIds` — businesses this rider is mapped to (role mapping, set at login; ONBOARDING.md); business names render from the public `GET /merchants/{merchantId}` per id (approved only); missing ids render masked, never a crash.

## Phase 3 — AI dispatch, safety, offline sync
| Operation | Endpoint | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| `getDemandForecast` | `GET /dispatch/forecast?lat=&lon=&horizonMinutes=` | 15-min-ahead demand/surge forecast | `horizonMinutes` default 15 (5–60) | `{generatedAt, zones[]}` |
| `reportSafetyEvent` | `POST /riders/me/safety-events` | Device-detected fatigue/crash/fall/threat | `SafetyEvent` `{type, source, severity?, lat?, lon?, details?}` | 201 `SafetyEvent` |
| `syncRiderBatch` | `POST /riders/me/sync/batch` | Offline batch upsert (sequence-numbered, idempotent) | `{events[≤500], idempotencyKey}` | `{accepted, rejected[], highWaterMark}` |
| `getRiderSyncStatus` | `GET /riders/me/sync/status` | Server high-water mark + pending count | — | `SyncStatus` |

- `PredictiveDemandZone`: `{zoneId, name, polygon, predictedDemand: low|medium|high|critical, predictedSurgeMultiplier, confidence (0–1), windowFrom, windowTo}` — `FORECAST_UNAVAILABLE` (model not ready) → empty-state variant + retry (DISPATCH-FLOW.md). `SafetyEvent`: `type` ∈ `fatigue_detected | crash_detected | fall_detected | threat_detected | rest_enforced`; `source` ∈ `camera | accelerometer | gyroscope | gps | system | manual`; `severity` ∈ `info | warning | critical`; errors `SAFETY_EVENT_INVALID` (422), `SAFETY_EVENT_RATE_LIMITED` (429 → back off); escalation per DISPATCH-FLOW.md. Sync: `events[].type` ∈ `order_status | pod | location | safety_event | cod_cash`; `rejected[]` = `{seq, code}`; client drops local events `≤ highWaterMark`; errors `SYNC_BATCH_INVALID` (422), `SYNC_SEQUENCE_GAP` (missing span — resend, ARCHITECTURE.md). `SyncStatus`: `{highWaterMark, pendingCount, lastSyncedAt?, gaps[]}` — drives the offline indicator and `sync.completed` toast (NAVIGATION.md).

## Intercity, line-haul & relay (logistics lane)

| Operation | Endpoint | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| `listHubs` | `GET /hubs` | Consolidation hubs (hub-and-spoke) | — | `Hub[]` `{id, name, cityId, address, capacity?, active}` |
| `getOrderRoute` | `GET /orders/{orderId}/route` | Multi-leg route with per-leg status/ETA | — | `RouteSegment[]` / 404 |
| `getOrderWaybill` | `GET /orders/{orderId}/waybill` | Append-only scan/event trail | — | `{waybillNumber, events[]}` / 404 |
| `advanceRouteLeg` | `POST /orders/{orderId}/legs/{legId}/advance` | Start/complete a leg (rider/carrier) | `{action: start\|complete, location{lat, lon}?}` | 200 `RouteSegment[]` / 404, 409 |
| `recordHandoff` | `POST /orders/{orderId}/handoff` | Custody transfer (scan + seal + photo) | `Handoff` `{fromLegId, toLegId, scanCode, sealIntact, conditionPhotoUrl?, location?, from?, to?}` | 201 `Handoff` / 409 |
| `listConsignments` | `GET /linehaul/consignments?status=` | Line-haul batches | `status` ∈ `manifesting\|in_transit\|at_hub\|delivered\|cancelled` | `Consignment[]` |
| `createConsignment` | `POST /linehaul/consignments` | Create a consignment from orders (line-haul rider/carrier) | `{fromHubId, toHubId, orderIds (min 1), transportMode (van\|linehaul_bus\|linehaul_truck), scheduledDeparture?}` | 201 `Consignment` / 409 |
| `getConsignment` | `GET /linehaul/consignments/{consignmentId}` | Consignment detail + manifest | — | `Consignment` / 404 |
| `departConsignment` | `POST /linehaul/consignments/{consignmentId}/depart` | Departure scan (origin hub) | — | 200 `Consignment` / 409 |
| `arriveConsignment` | `POST /linehaul/consignments/{consignmentId}/arrive` | Arrival scan at destination hub (per-order sortation) | `{verifiedOrderIds, missingOrderIds?}` | 200 `Consignment` / 409 |

- `RouteSegment`: `{legId, sequence, type: first_mile\|linehaul\|hub_transfer\|last_mile\|return, mode: motorcycle\|car\|van\|linehaul_bus\|linehaul_truck, fromHubId?, toHubId?, handledBy?, status: pending\|in_progress\|completed\|skipped, etaAt?, startedAt?, completedAt?, custody{from, to, sealIntact, at}?}`. Leg errors: `LEG_NOT_FOUND` (404), `LEG_ALREADY_COMPLETED` (409 — refetch, show completed).
- `WaybillEvent`: `{at, type: scanned\|handoff\|loaded\|departed\|arrived\|sorted\|exception\|delivered, location, actor?, note?}` — read-only trail (LONG-HAUL-RELAY.md); `WAYBILL_INVALID` on malformed reads.
- `Handoff`: `{id, fromLegId, toLegId, scanCode, sealIntact (must be true), conditionPhotoUrl?, location?, from, to, at}` — errors: `HANDOFF_INVALID`, `HANDOFF_SEAL_BROKEN` (409, leg blocked, ops flagged), `HANDOFF_SCAN_MISMATCH` (409, re-scan).
- `Consignment`: `{id, consignmentNumber, fromHubId, toHubId, transportMode (van\|linehaul_bus\|linehaul_truck), carrierId?, orderCount, manifest[{orderId, waybillNumber, section: standard\|fragile\|cold_chain\|documents\|high_value, scannedIn, scannedOut}], status: manifesting\|in_transit\|at_hub\|delivered\|cancelled, scheduledDeparture?, departedAt?, arrivedAt?, createdBy, createdAt}`. Errors: `CONSIGNMENT_NOT_FOUND` (404), `CONSIGNMENT_FULL`, `CONSIGNMENT_ALREADY_DEPARTED`, `CONSIGNMENT_ORDER_MISMATCH` (verifiedOrderIds ≠ manifest), `CONSIGNMENT_MISSING_ORDERS` (409 — exception workflow), `INTERCITY_UNAVAILABLE` (route not configured), `HUB_NOT_FOUND`, `HUB_FULL`.
- `RiderPrivate.transportMode` (`local_motorcycle\|local_car\|van\|linehaul_bus\|linehaul_truck\|relay`, default `local_motorcycle`) gates role views: line-haul riders see consignments + manifests only; matching rejects a mode/leg mismatch with `TRANSPORT_MODE_INVALID` (ONBOARDING.md, DISPATCH-FLOW.md).

## Shipments, containers, vehicles, routes, trips (Logistics OS)

| Operation | Endpoint | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| `createShipment` | `POST /shipments` | Create a shipment from an order (commercial → physical) | `{orderId, packageCount (min 1, default 1), containerId?}` | 201 `Shipment` / 409 |
| `listShipments` | `GET /shipments?status=` | Shipments for the role | `status` ∈ `planned\|picked_up\|at_hub\|in_transit\|out_for_delivery\|delivered\|exception` | `Shipment[]` |
| `getShipment` | `GET /shipments/{shipmentId}` | Detail + packages + current logistics state | — | `Shipment` / 404 |
| `getShipmentCustody` | `GET /shipments/{shipmentId}/custody` | Custody ledger — every handoff/scan | — | `CustodyEntry[]` |
| `scanShipment` | `POST /shipments/{shipmentId}/scan` | Scan at a location (hub, vehicle, delivery) | `{scanType: pickup\|hub_in\|hub_out\|vehicle_load\|vehicle_unload\|handoff\|delivery, location, vehicleId?, hubId?, lat?, lon?}` | 201 `CustodyEntry` / 409 |
| `listContainers` / `createContainer` | `GET` / `POST /containers` | Containers (bags/cages/pallets grouping packages) | `Container` (kind, `section`, `packageIds[]`, seal state) | 200/201 `Container` |
| `listVehicles` | `GET /vehicles` | Vehicle registry (bikes to buses) | — | `Vehicle[]` |
| `listRoutes` | `GET /routes` | Route corridors | — | `Route[]` |
| `listTrips` | `GET /trips?status=` | Trips — one vehicle departure with manifest | `status` ∈ `planned\|loading\|in_transit\|unloading\|completed\|cancelled` | `Trip[]` |
| `getTrip` | `GET /trips/{tripId}` | Driver-facing trip view (manifest summary, compartments) | — | `Trip` / 404 |
| `advanceTrip` | `PATCH /trips/{tripId}` | Advance trip state (loading → depart → arrive → unload → complete) | `{action: start_loading\|depart\|arrive\|start_unloading\|complete}` | 200 `Trip` / 409 |
| `reconcileConsignment` | `POST /linehaul/consignments/{consignmentId}/reconcile` | Reconciliation — manifest vs scanned loading vs unloading | `{scannedOrderIds}` | 200 `ReconciliationResult` / 409 |
| `replanConsignment` | `POST /linehaul/consignments/{consignmentId}/replan` | Mutable plan — move to an alternate trip/vehicle | `{reason, alternateTripId?, alternateVehicleId?}` | 200 `Consignment` / 409 |

- `Shipment`: `{id, shipmentNumber (SH-…), orderId, packages[], containerId?, status, currentLegId?, declaredValueTZS?, createdAt}` — one order → one shipment → one or more packages; `SHIPMENT_ALREADY_EXISTS` (409); 404 `SHIPMENT_NOT_FOUND`.
- `Package`: `{id, packageId (PKG-…), shipmentId, containerId?, attributes{temperature (ambient\|cold_chain\|frozen), fragile, hazardous, highValue, maxTransitHours?, allowedModes[], weightKg?, volumeL?, compatible}, status, scannedIn, scannedOut}` — `weightKg`/`volumeL` (nullable numbers) are the declared weight/volume; loading checks them against the vehicle's `maxWeightKg`/`maxVolumeL` (`CAPACITY_WEIGHT_EXCEEDED` / `CAPACITY_VOLUME_EXCEEDED`, LONG-HAUL-RELAY.md section 17) — 404 `PACKAGE_NOT_FOUND`.
- `Container`: `{id, containerId (BAG-…), kind (bag\|cage\|pallet\|lockbox\|refrigerated_unit), section, packageIds[], sealed, sealCode?, sealedAt?, currentTripId?, createdAt}` — `CONTAINER_ALREADY_SEALED` (409); 404 `CONTAINER_NOT_FOUND`.
- `Vehicle`: `{id, vehicleType (motorcycle\|e_bike\|bicycle\|car\|van\|linehaul_bus\|linehaul_truck\|refrigerated_truck), registration, operatorId?, capacity{totalUnits, maxWeightKg?, maxVolumeL?, compartments[{name, capacity, used, usedWeightKg, usedVolumeL}]}, temperatureCapable, securityCapability (none\|lockbox\|cage\|armored), permittedRoutes[], status (active\|on_trip\|maintenance\|retired), currentLocation?, currentTripId?}` — `VEHICLE_CAPACITY_EXCEEDED` (unit count) / `CAPACITY_WEIGHT_EXCEEDED` / `CAPACITY_VOLUME_EXCEEDED` / `COMPARTMENT_INCOMPATIBLE` (409) on load; 404 `VEHICLE_NOT_FOUND`.
- `Route`: `{id, name, fromHubId, toHubId, estimatedHours, scheduledDepartures[], permittedVehicles[], active}` — 404 `ROUTE_NOT_FOUND`.
- `Trip`: `{id, tripNumber (TRP-…), routeId, vehicleId, consignmentIds[], status, manifestSummary{expectedUnits, verifiedUnits, exceptions}, scheduledDeparture?, departedAt?, arrivedAt?, driverId?, createdBy, createdAt}` — the driver sees the trip + manifest summary, never individual orders; `TRIP_NOT_FOUND` (404), `TRIP_ALREADY_ACTIVE`, `TRIP_CANNOT_CLOSE` (409).
- `CustodyEntry`: `{id, shipmentId, packageId?, eventType (picked_up\|hub_in\|sorted\|container_loaded\|vehicle_loaded\|departed\|arrived\|unloaded\|handoff\|out_for_delivery\|delivered), actorId, actorType (rider\|driver\|hub_worker\|carrier\|system), locationId?, vehicleId?, hubId?, lat?, lon?, deviceId?, previousState?, newState, evidence?, at}`.
- `ReconciliationResult`: `{consignmentId, expected, scanned, missingOrderIds[], status (matched\|mismatch), tripClosed}` — mismatch → `RECONCILIATION_FAILED` / `RECONCILIATION_MISSING_PACKAGES` (409); the trip cannot close until resolved. Replan: `PLAN_NOT_MUTABLE` (409) once departed. Scan errors: `HANDOFF_VERIFICATION_FAILED` (multi-factor mismatch), `SCAN_GPS_MISMATCH`, `SCAN_VEHICLE_STATIC` (anomalies raised server-side, LONG-HAUL-RELAY.md).

### Order fields — dispatch strategy and fulfillment source (read-only)

`Order.dispatchStrategy` (`nearest | zone | multi_leg | relay | warehouse`) and
`Order.fulfillmentSource` (`merchant | warehouse`, default `merchant`) are
server-set and read-only in the rider app (LONG-HAUL-RELAY.md section 3):

- `dispatchStrategy: warehouse` + `fulfillmentSource: warehouse` → the rider's
  pickup point is the regional warehouse (address shown on the order detail /
  first-mile leg); the merchant storefront is not the pickup point.
- `dispatchStrategy: multi_leg` → the order has a leg plan (`GET
  /orders/{orderId}/route`); the rider handles only their assigned leg.
- `dispatchStrategy: relay` → sequential rider handoffs; the rider's job ends at
  the handoff point.
- `dispatchStrategy: nearest` / `zone` → standard on-demand single-leg flow.
- `DISPATCH_STRATEGY_INVALID` (422) guards invalid values server-side; the app
  renders the strategy chip only from server data.

### RiderPrivate — service model and fleet linkage (read-only)

`RiderPrivate.serviceModel` (`specialized | crowdsourced | errand | fleet`,
default `specialized`) and `RiderPrivate.fleetAccountId` (uuid, nullable) are
**profile fields, not update fields**: neither exists in `RiderUpdate` — the
rider cannot change them from the app. They are set by admin (rider ops / fleet
account manager) at onboarding/employment transitions and are audited
(`rider.*` / `fleet.*`). `SERVICE_MODEL_INVALID` (422) rejects invalid values on
admin mutations. The app renders:
- Profile: service-model chip + (when `fleetAccountId` present) fleet linkage
  chip. The master account name/vehicles/regions/billing are **never** returned
  by rider endpoints (fleet data isolation, SECURITY.md).
- Dispatch: `serviceModel` affects matching priority only (specialized first —
  LONG-HAUL-RELAY.md section 13); it never changes fares or windows.

## Delivery exceptions (18 kinds) — full reference

The platform-wide exception catalog. Rider-callable (contract tags `[riders,
orders, admin]`). Every disruption is a typed record with a lifecycle
(`open → resolving → resolved | escalated`), an `outcome`, and an
`autoReplanned` flag. Full operating detail: LONG-HAUL-RELAY.md section 16.

| Operation | Endpoint | Purpose | Request | Response |
| --- | --- | --- | --- | --- |
| `listDeliveryExceptions` | `GET /delivery-exceptions?kind=&status=` | Exceptions visible to the role (riders: own/assigned shipments) | `kind` (18-value enum), `status` (`open`/`resolving`/`resolved`/`escalated`) | `DeliveryException[]` |
| `createDeliveryException` | `POST /delivery-exceptions` | Report an exception | `DeliveryException` shape (kind, description max 1000, context ids) | 201 `DeliveryException` |
| `getDeliveryException` | `GET /delivery-exceptions/{exceptionId}` | Detail | — | `DeliveryException` / 404 |
| `updateDeliveryException` | `PATCH /delivery-exceptions/{exceptionId}` | Status/outcome update (resolve/escalate) | `{status: open\|resolving\|resolved\|escalated, outcome?: string (max 1000)}` | `DeliveryException` |

`DeliveryExceptionKind` (exact 18 values): `missing_package`, `wrong_package`,
`wrong_hub`, `wrong_vehicle`, `scan_failure`, `damaged_package`, `late_vehicle`,
`vehicle_breakdown`, `rider_unavailable`, `bus_cancellation`, `hub_congestion`,
`weather_disruption`, `road_closure`, `customer_unavailable`, `package_refused`,
`route_deviation`, `security_incident`, `reconciliation_failure`.

`DeliveryException`: `{id, kind, shipmentId?, orderId?, tripId?, description
(max 1000), reportedBy, status, outcome? (max 1000), autoReplanned (bool,
default false), createdAt, resolvedAt?}`.

- Errors: 404 `EXCEPTION_NOT_FOUND` (→ empty variant + retry), 409
  `EXCEPTION_ALREADY_RESOLVED` (resolved/escalated exceptions are terminal —
  refetch and show the state; there is no reopen), 422 `VALIDATION_FAILED`
  (missing kind/description).
- Lifecycle per status: `open` (reported; `exception.created` push/in-app to
  ops + affected parties) → `resolving` (ops working it) → `resolved` (outcome
  recorded; `exception.resolved`) or `escalated` (terminal, `exception.escalated`
  critical to ops manager).
- `autoReplanned: true` means the engine recalculated the plan (breakdown, bus
  cancellation, late vehicle, wrong hub/vehicle, missing package): the rider
  sees `plan.replanned` (+ `plan.optimized` when the global optimizer re-runs)
  and a banner on the trip/consignment screen; the customer's ETA updates via
  `intercity.eta_updated` — the app never fabricates the replan.
- Who may set which status is server-enforced: riders may report any kind and
  resolve only their own scoped actions (e.g. a fixable `scan_failure`);
  escalation is ops-manager-owned.

## Warehouses, carriers, facilities, fleet accounts — visibility notes

These registries are **admin/merchant-scoped** in the contract; the rider app
never calls them. Rider-visible effects, all read-only:

| Registry | Contract | Rider app impact |
| --- | --- | --- |
| Warehouses | `GET/POST /warehouses`, `GET/PATCH /warehouses/{id}`, `PUT /warehouses/{id}/stock`, `POST /warehouses/{id}/fulfill` (tags `[admin, merchants]`) | Warehouse-fulfilled orders (`fulfillmentSource: warehouse`) show the warehouse as the pickup point on the order detail and first-mile leg; `warehouse.fulfilled` and `warehouse.stock_low` notifications never target the rider app (customer/merchant channels) |
| Carriers | `GET/POST /carriers`, `PATCH /carriers/{id}` (tag `[admin]`) | Carrier legs appear on consignments (`Consignment.carrierId`) and route segments (`handledBy: carrierId`); `carrier.handoff_required` (push + in-app) tells ops + the carrier the line-haul is ready; the platform rider hands off at the hub using the standard handoff scan (LONG-HAUL-RELAY.md 12.4) |
| Facilities | `GET/POST /facilities`, `PUT /facilities/{id}/whitelist` (tag `[admin]`) | Entry at a gated facility is checked server-side at scan time: whitelisted → scan succeeds; not → `NOT_WHITELISTED` (403) block with `requestId` + "Request access" CTA. Whitelist status renders from `facility.whitelist_granted` / `facility.whitelist_revoked` (in-app) + scan outcomes — **no dedicated rider GET endpoint exists** (honest rendering, LONG-HAUL-RELAY.md 15.5) |
| Fleet accounts | `GET/POST /fleet/accounts`, `PATCH /fleet/accounts/{id}` (tag `[admin]`) | Driver-side only: `RiderPrivate.fleetAccountId` (read-only chip). `FLEET_ACCOUNT_NOT_FOUND` / `FLEET_ACCOUNT_SUSPENDED` surface on dependent admin calls, never rider calls |
| Active reassignment / escalation | `POST /admin/shipments/{id}/reassign`, `POST /admin/shipments/{id}/escalate` (tag `[admin]`) | Staff-only. The rider receives the outcome: reassignment shows as a new assignment event + `order.rider_assigned`-style flow; escalation is incident/safety (`exception.escalated` critical). `SHIPMENT_NOT_REASSIGNABLE` / `SHIPMENT_NOT_ESCALATABLE` (status gates) render on the ops side, never the rider app |

## Errors — deep logistics additions

| Response | Code | UI behavior |
| --- | --- | --- |
| 403 | `NOT_WHITELISTED` | facility entry blocked at scan — inline block + facility name + "Request access" prefilled ticket (LONG-HAUL-RELAY.md 15) |
| 404 | `EXCEPTION_NOT_FOUND`, `WAREHOUSE_NOT_FOUND`, `CARRIER_NOT_FOUND`, `FACILITY_NOT_FOUND`, `FLEET_ACCOUNT_NOT_FOUND` | empty-state variant + retry (rider-visible codes are only those above; the rest surface on admin/merchant calls) |
| 409 | `EXCEPTION_ALREADY_RESOLVED`, `CAPACITY_WEIGHT_EXCEEDED`, `CAPACITY_VOLUME_EXCEEDED`, `SHIPMENT_NOT_REASSIGNABLE`, `SHIPMENT_NOT_ESCALATABLE` | inline block with rule copy + `requestId`; weight/volume → offload or use a capable vehicle, never blind retry |
| 422 | `VALIDATION_FAILED`, `DISPATCH_STRATEGY_INVALID`, `SERVICE_MODEL_INVALID` | inline field error; strategy/service-model values are server-set — the app renders returned data only |

## Logistics endpoints — full contract reference (Logistics OS)

Complete reference for every logistics endpoint the rider app can call. Role
permissions per endpoint are enforced server-side (RBAC + ABAC + capability);
the app renders actions only when the authenticated session may perform them.
Operating detail for every screen: LONG-HAUL-RELAY.md.

### /shipments

#### `GET /shipments?status=&limit=&cursor=`

- Purpose: shipments (physical logistics units) visible to the role.
- Query: `status` ∈ `planned | picked_up | at_hub | in_transit | out_for_delivery | delivered | exception`; `limit` (default 20); `cursor`.
- Response 200: `Shipment[]` — `{id, shipmentNumber (SH-…), orderId, packages[], containerId?, status, currentLegId?, declaredValueTZS?, createdAt}`.
- Roles: pickup rider (assigned pickups), hub courier (current_hub scope), last-mile rider (assigned legs), long-distance driver (shipments on trip), ops-manager-adjacent staff roles. 404-style invisibility: shipments outside the caller's assignment/hub/region are simply absent from the list.

#### `POST /shipments`

- Purpose: create a shipment from an order (separates commercial from physical).
- Body (required `orderId`): `{orderId: uuid, packageCount: integer (min 1, default 1), containerId: uuid | null}`.
- Response 201: `Shipment` (`status: planned`).
- Errors: 409 `SHIPMENT_ALREADY_EXISTS` (order already shipped — refetch and open the existing shipment), 404 `SHIPMENT_NOT_FOUND` (order not visible).
- Roles: merchant staff, hub couriers, dispatch (capability `shipment.create`).

#### `GET /shipments/{shipmentId}`

- Purpose: shipment detail with packages and current logistics state.
- Response 200: `Shipment`.
- Errors: 404 (missing or not visible — empty variant + retry).
- Roles: any courier with an assignment touching the shipment; hub couriers scoped to `current_hub`.

#### `GET /shipments/{shipmentId}/custody`

- Purpose: custody ledger — every handoff/scan for the shipment's packages.
- Response 200: `CustodyEntry[]` — `{id, shipmentId, packageId?, eventType (picked_up | hub_in | sorted | container_loaded | vehicle_loaded | departed | arrived | unloaded | handoff | out_for_delivery | delivered), actorId, actorType (rider | driver | hub_worker | carrier | system), locationId?, vehicleId?, hubId?, lat?, lon?, deviceId?, previousState?, newState, evidence?, at}`.
- Roles: read-only for the assigned courier, driver, hub worker; the customer never sees this endpoint (they see `tracking-phases`).

#### `POST /shipments/{shipmentId}/scan`

- Purpose: scan a shipment at a location (hub, vehicle, delivery).
- Body (required `scanType`, `location`): `{scanType: pickup | hub_in | hub_out | vehicle_load | vehicle_unload | handoff | delivery, location: string, vehicleId?: uuid, hubId?: uuid, lat?: float, lon?: float}`.
- Response 201: `CustodyEntry` (the new ledger entry).
- Errors (all 409 unless noted): `HANDOFF_VERIFICATION_FAILED` (package/hub/vehicle scan mismatch — wrong-vehicle handoff blocked), `HANDOFF_SEAL_BROKEN` (seal not intact), `HANDOFF_SCAN_MISMATCH` (wrong barcode), `HANDOFF_INVALID`, `VEHICLE_CAPACITY_EXCEEDED` (load past compartment capacity), `COMPARTMENT_INCOMPATIBLE` (package attributes vs vehicle/compartment), `SCAN_GPS_MISMATCH` (anomaly — scan location vs actor GPS), `SCAN_VEHICLE_STATIC` (anomaly — vehicle never moved), 404 `SHIPMENT_NOT_FOUND` / `PACKAGE_NOT_FOUND`.
- Roles: pickup rider (`pickup`), hub courier (`hub_in`/`hub_out`), driver/hub courier (`vehicle_load`/`vehicle_unload`), any handoff party (`handoff`), last-mile rider (`delivery`).

### /containers

#### `GET /containers`

- Purpose: logistics containers (bags/cages/pallets grouping packages).
- Response 200: `Container[]` — `{id, containerId (BAG-CN-…), kind (bag | cage | pallet | lockbox | refrigerated_unit), section (standard | fragile | cold_chain | documents | high_value), packageIds[], sealed, sealCode?, sealedAt?, currentTripId?, createdAt}`.
- Roles: hub couriers, drivers (their trip's containers), transfer riders (assigned transfers).

#### `POST /containers`

- Purpose: create a container (body is the `Container` shape; server assigns `id`/`containerId`).
- Response 201: `Container` (unsealed until the seal step).
- Errors: 409 `CONTAINER_ALREADY_SEALED` (a sealed container cannot be modified), 404 `CONTAINER_NOT_FOUND`.
- Roles: hub couriers (build + seal), transfer riders where granted. Sealing: the same endpoint records `sealed: true` + `sealCode` + `sealedAt`; emits `container.sealed`.

### /vehicles

#### `GET /vehicles`

- Purpose: vehicle registry (bikes to buses — generalized transport).
- Response 200: `Vehicle[]` — `{id, vehicleType (motorcycle | e_bike | bicycle | car | van | linehaul_bus | linehaul_truck | refrigerated_truck), registration, operatorId?, capacity {totalUnits, compartments[{name (standard | fragile | cold_chain | documents | high_value), capacity, used}]}, temperatureCapable, securityCapability (none | lockbox | cage | armored), permittedRoutes[], status (active | on_trip | maintenance | retired), currentLocation?, currentTripId?}`.
- Roles: drivers (their vehicle + corridor candidates), hub couriers (bay vehicles), fleet owners.

#### `POST /vehicles`

- Purpose: register a vehicle (admin or fleet owner).
- Body: `Vehicle` shape (vehicleType, registration, capacity, temperatureCapable, securityCapability, permittedRoutes).
- Response 201: `Vehicle`.
- Roles: admin / fleet owner only (`FORBIDDEN` for couriers).

#### `PATCH /vehicles/{vehicleId}`

- Purpose: update vehicle (status, location, capacity, permitted routes).
- Body: `Vehicle` shape (partial).
- Response 200: `Vehicle`.
- Errors: 404 `VEHICLE_NOT_FOUND`.
- Roles: admin / fleet owner only.

### /routes

#### `GET /routes`

- Purpose: transport routes/corridors (city A → city B).
- Response 200: `Route[]` — `{id, name (e.g. "Dar es Salaam → Mwanza"), fromHubId, toHubId, estimatedHours, scheduledDepartures[], permittedVehicles[], active}`.
- Roles: drivers (corridor context), hub couriers, dispatch.

#### `POST /routes`

- Purpose: create a route corridor (admin only).
- Body: `Route` shape.
- Response 201: `Route`.
- Roles: admin only.

### /trips

#### `GET /trips?status=`

- Purpose: transport trips (one vehicle departure with manifest).
- Query: `status` ∈ `planned | loading | in_transit | unloading | completed | cancelled`.
- Response 200: `Trip[]` — `{id, tripNumber (TRP-…), routeId, vehicleId, consignmentIds[], status, manifestSummary {expectedUnits, verifiedUnits, exceptions}, scheduledDeparture?, departedAt?, arrivedAt?, driverId?, createdBy, createdAt}`.
- Roles: drivers (their trips), hub couriers (inbound/outbound trips), dispatch.

#### `POST /trips`

- Purpose: create a trip from a route + vehicle + consignments.
- Body (required `routeId`, `vehicleId`, `consignmentIds` min 1): `{routeId: uuid, vehicleId: uuid, consignmentIds: uuid[], scheduledDeparture?: date-time}`.
- Response 201: `Trip` (`status: planned`, manifest summary computed).
- Errors: 409 `TRIP_ALREADY_ACTIVE` (vehicle already on another trip), `VEHICLE_CAPACITY_EXCEEDED` (consignments over vehicle capacity).
- Roles: dispatch / ops manager (capability `trip.create`).

#### `GET /trips/{tripId}`

- Purpose: trip detail — driver-facing view (manifest summary, compartments).
- Response 200: `Trip`.
- Errors: 404 `TRIP_NOT_FOUND` (or not visible — empty variant).

#### `PATCH /trips/{tripId}`

- Purpose: advance trip state (loading → depart → arrive → unload → complete).
- Body (required `action`): `{action: start_loading | depart | arrive | start_unloading | complete}`.
- Response 200: `Trip` (new state).
- Errors (409): `TRIP_NOT_FOUND` (404), `TRIP_ALREADY_ACTIVE` (refetch), `TRIP_CANNOT_CLOSE` (reconciliation pending — `complete` blocked), `VEHICLE_CAPACITY_EXCEEDED`, `COMPARTMENT_INCOMPATIBLE` (raised by load scans during `loading`).
- Roles: assigned driver only (capability `trip.advance` + assignment ABAC).

### /linehaul/consignments/{consignmentId}/reconcile

- Purpose: reconciliation — manifest vs scanned loading vs unloading.
- Body (required `scannedOrderIds`): `{scannedOrderIds: uuid[]}`.
- Response 200: `ReconciliationResult` — `{consignmentId, expected: integer, scanned: integer, missingOrderIds: uuid[], status: matched | mismatch, tripClosed: boolean}`.
- Errors (409): `RECONCILIATION_FAILED` (mismatch — `missingOrderIds[]` returned), `RECONCILIATION_MISSING_PACKAGES` (missing packages listed); `CONSIGNMENT_NOT_FOUND` (404).
- Roles: assigned driver + hub courier at the destination hub (ops also runs it via workflow 23).

### /linehaul/consignments/{consignmentId}/replan

- Purpose: mutable plan — move a consignment to an alternate trip/vehicle.
- Body (required `reason` max 500): `{reason: string, alternateTripId?: uuid, alternateVehicleId?: uuid}`.
- Response 200: `Consignment` (re-assigned).
- Errors (409): `PLAN_NOT_MUTABLE` (trip departed — the plan froze at DEPART), `CONSIGNMENT_NOT_FOUND` (404).
- Roles: dispatch / ops manager (capability `plan.replan`); driver receives `plan.replanned`.

### Errors — logistics additions

| Response | Code | UI behavior |
| --- | --- | --- |
| 404 | `SHIPMENT_NOT_FOUND`, `PACKAGE_NOT_FOUND`, `CONTAINER_NOT_FOUND`, `VEHICLE_NOT_FOUND`, `ROUTE_NOT_FOUND`, `TRIP_NOT_FOUND`, `CONSIGNMENT_NOT_FOUND`, `HUB_NOT_FOUND`, `EXCEPTION_NOT_FOUND` | empty-state variant + retry; refetch and show real state |
| 409 | `SHIPMENT_ALREADY_EXISTS`, `CONTAINER_ALREADY_SEALED`, `VEHICLE_CAPACITY_EXCEEDED`, `CAPACITY_WEIGHT_EXCEEDED`, `CAPACITY_VOLUME_EXCEEDED`, `COMPARTMENT_INCOMPATIBLE`, `TRIP_ALREADY_ACTIVE`, `TRIP_CANNOT_CLOSE`, `RECONCILIATION_FAILED`, `RECONCILIATION_MISSING_PACKAGES`, `HANDOFF_VERIFICATION_FAILED`, `HANDOFF_SEAL_BROKEN`, `HANDOFF_SCAN_MISMATCH`, `HANDOFF_INVALID`, `PLAN_NOT_MUTABLE`, `SCAN_GPS_MISMATCH`, `SCAN_VEHICLE_STATIC`, `CONSIGNMENT_FULL`, `CONSIGNMENT_ALREADY_DEPARTED`, `CONSIGNMENT_ORDER_MISMATCH`, `CONSIGNMENT_MISSING_ORDERS`, `TRANSPORT_MODE_INVALID`, `LEG_ALREADY_COMPLETED`, `EXCEPTION_ALREADY_RESOLVED` | inline block with rule copy + `requestId`; no blind retry for anomalies (ops-owned); refetch after state conflicts; weight/volume exceeded → offload or use a capable vehicle; resolved exceptions are terminal |

## Errors
| Response | Code (example) | UI behavior |
| --- | --- | --- |
| 401 Unauthorized | `UNAUTHORIZED` | refresh → retry; on failure, logout to OTP |
| 403 Forbidden | `FORBIDDEN`, `NOT_WHITELISTED` | show message; verify role still active; facility entry blocked → "Request access" prefilled ticket |
| 404 NotFound | `NOT_FOUND`, `OFFER_NOT_FOUND`, `FARE_NOT_AVAILABLE`, `PERFORMANCE_UNAVAILABLE`, `LEADERBOARD_UNAVAILABLE`, `SHIFT_NOT_FOUND`, `TRIP_NOT_FOUND`, `LEG_NOT_FOUND`, `CONSIGNMENT_NOT_FOUND`, `HUB_NOT_FOUND`, `SHIPMENT_NOT_FOUND`, `PACKAGE_NOT_FOUND`, `CONTAINER_NOT_FOUND`, `VEHICLE_NOT_FOUND`, `ROUTE_NOT_FOUND`, `EXCEPTION_NOT_FOUND` | empty-state variants (offer expired → remove card; scorecard/leaderboard → "not available yet"; no active trip → empty state; leg/consignment/hub/shipment/vehicle missing → refetch or empty variant; exception missing → empty variant) |
| 409 Conflict | `POD_ALREADY_SUBMITTED`, `FAILED_DELIVERY_NOT_ALLOWED`, `TRANSFER_ALREADY_REQUESTED`, `RESCHEDULE_IN_PAST`, `TIP_NOT_ALLOWED`, `TIP_EXCEEDS_LIMIT`, `SHIFT_ALREADY_ACTIVE`, `SHIFT_CLOCKOUT_WITHOUT_CLOCKIN`, `SHIFT_CASH_MISMATCH`, `HOLD_NOT_ALLOWED`, `HOLD_ALREADY_ACTIVE`, `ADD_ITEMS_NOT_ALLOWED`, `ADD_ITEMS_PENDING`, `SWAP_NOT_ALLOWED`, `SWAP_ALREADY_REQUESTED`, `BREAK_NOT_ALLOWED`, `BREAK_ALREADY_ACTIVE`, `REORDER_INVALID`, `REORDER_NOT_ALLOWED`, `PROMO_INVALID`, `MASKED_CALL_NOT_ALLOWED`, `MASKED_CALL_EXPIRED`, `LEG_ALREADY_COMPLETED`, `HANDOFF_INVALID`, `HANDOFF_SEAL_BROKEN`, `HANDOFF_SCAN_MISMATCH`, `CONSIGNMENT_FULL`, `CONSIGNMENT_ALREADY_DEPARTED`, `CONSIGNMENT_ORDER_MISMATCH`, `CONSIGNMENT_MISSING_ORDERS`, `TRANSPORT_MODE_INVALID`, `SHIPMENT_ALREADY_EXISTS`, `CONTAINER_ALREADY_SEALED`, `VEHICLE_CAPACITY_EXCEEDED`, `CAPACITY_WEIGHT_EXCEEDED`, `CAPACITY_VOLUME_EXCEEDED`, `COMPARTMENT_INCOMPATIBLE`, `TRIP_ALREADY_ACTIVE`, `TRIP_CANNOT_CLOSE`, `RECONCILIATION_FAILED`, `RECONCILIATION_MISSING_PACKAGES`, `HANDOFF_VERIFICATION_FAILED`, `PLAN_NOT_MUTABLE`, `SCAN_GPS_MISMATCH`, `SCAN_VEHICLE_STATIC`, `EXCEPTION_ALREADY_RESOLVED` | refetch order/shift; explain the rule (e.g. hold already active, approval in flight, reorder after trip completion); masked call expired → re-create the session; seal broken → block leg + ops flag; arrival mismatch → show the manifest difference; incompatible load / wrong-vehicle handoff / unresolved reconciliation / immutable plan / weight-volume exceeded / resolved exception → inline block with rule copy |
| 422 ValidationError | `VALIDATION_FAILED` + `errors[].field`, `MEDIA_TYPE_INVALID`, `DEST_FILTER_INVALID`, `RATING_FILTER_INVALID`, `DISPATCH_STRATEGY_INVALID`, `SERVICE_MODEL_INVALID` | inline field errors (destination filter: bad area/coords; rating filter: out of range; strategy/service-model: server-set — render returned data only) |
| 429 RateLimited | `RATE_LIMITED`, `LOCATION_RATE_LIMITED`, `SOS_RATE_LIMITED` + `retryAfterSeconds` | OTP: resend timer; location/SOS: back off silently |

All errors: `{code, message, requestId, retryAfterSeconds?}`. `requestId` is included in support ticket body for traceability.
