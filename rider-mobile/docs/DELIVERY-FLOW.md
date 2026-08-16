# HUDumika RIDER — Delivery Flow

In-delivery UX from acceptance to delivered. Contract: `GET /orders/{orderId}` (`OrderDetail`), `POST /orders/{orderId}/status`, `POST /orders/{orderId}/proof-of-delivery`, `POST /orders/{orderId}/failed-delivery`, `POST /orders/{orderId}/reschedule`, `GET /orders/{orderId}/track`, `POST /orders/{orderId}/hold` / `unhold`, `POST /orders/{orderId}/add-items`, `POST /riders/me/trips/{orderId}/share`.

## Status progression (full granularity)

```text
rider_assigned → rider_arrived_pickup → picked_up → delivering
  → rider_arrived_dropoff → delivered → completed
```

Each step calls `POST /orders/{orderId}/status` with exactly that `status` value; the screen renders the server-returned `Order` (never optimistic). Exceptions branch from `delivering`: `failed_delivery` → `returning` → `delivered` (returned) or `cancelled`; `rescheduled` returns the order to the schedule (see sections below). `completed` follows `delivered` per the server state machine; the rider sees it in history, there is no rider action. Task holds and mid-delivery item additions are rider-initiated overlays on this flow (DISPATCH-FLOW.md and below).

## Navigation to merchant (pickup)

1. DeliveryDetail shows merchant pickup (from order context), delivery address (`AddressSnapshot`), and order items.
2. "Navigate" opens the installed maps app via deep link using the environment-driven maps scheme (`EXPO_PUBLIC_MAPS_SCHEME`) and coordinates; the rider app keeps its own state in the background and resumes on return.
3. Background location task runs from acceptance through delivery (ARCHITECTURE.md) so `track` stays live.
4. Pickup timeout (15 min after `merchant_accepted`, per `DISPATCH.md`): visible countdown; on expiry, banner + ops escalation happens server-side — the rider is notified, not automatically penalized.
5. On arrival at the merchant: `POST /orders/{orderId}/status {status: rider_arrived_pickup}` (notifies merchant + customer in-app). Then confirm pickup (`{status: picked_up}`) after verifying the merchant pickup code or scan where supported. If the merchant code is unavailable, manual confirm is offered with a `note`.
6. After pickup, start navigation with `{status: delivering}`; on arrival at the customer: `{status: rider_arrived_dropoff}` before opening ProofOfDelivery.

## Geofence auto-arrival and stage ETAs (Phase 3)

- When the rider's position enters the pickup/drop-off geofence and speed checks confirm a stop, the server auto-advances `rider_arrived_pickup` / `rider_arrived_dropoff` (DISPATCH-FLOW.md); the app shows an "Arrival detected" banner and continues the normal flow. Manual fallback ("I'm here") stays available in case the geofence misses; both paths render the server-returned `Order`, never an optimistic state.
- `GET /orders/{orderId}/track` → `TrackingEvent.stageEtas` `{merchantArrival?, pickup?, dropoff?}` (minutes, nullable) — DeliveryDetail shows the current stage ETA and the next one ("Arrive at merchant ~8 min"); ETAs are model-derived (`backend/AI-LAYER.md`), never computed on-device.

## Order items view

- Rendered from `OrderDetail.items[]` (`name`, `quantity`, `unitPriceTZS`, thousands separators), reference-only — price changes are never possible client-side. Order `totals` (`PriceBreakdown`) show read-only for context (e.g. COD amount); rider earnings (`deliveryFeeTZS`) appear on the earnings summary, never altered in the delivery UI.

## Customer contact policy

- Never expose the customer's raw phone number (per `PRODUCT.md` dispatch rules and SHARED-FLOWS privacy); the in-app masked dialer is backed by masked-call sessions (section below) — no copy-paste of the number.

## Drop-off options

`ProofOfDelivery.dropoffOption` ∈ `hand_to_customer | leave_at_door` (default `hand_to_customer`); the customer's choice is shown on DeliveryDetail before arrival.

- `hand_to_customer`: hand the items over; any POD method (`photo`, `signature`, `otp`) is accepted — no photo required.
- `leave_at_door`: place the items and leave; requires a `photo` POD with `dropoffOption: leave_at_door` — the app blocks submit without the captured photo, and the photo attaches the `gpsStamp` `{lat, lon, at}` from the location task (position-stamped proof; a stamp failure alone never blocks submission — contract field nullable).
- Gate codes and access instructions: customer instructions arrive via `OrderCreate.note` and `AddressSnapshot.lines` / `landmark` on `OrderDetail.deliveryAddress` — DeliveryDetail shows them in a read-only "Delivery instructions" card before and during drop-off.

## Proof of delivery (POD)

When arriving: `rider_arrived_dropoff` → ProofOfDelivery screen. Submit via `POST /orders/{orderId}/proof-of-delivery` with a `ProofOfDelivery` body; one POD per order (duplicate → `POD_ALREADY_SUBMITTED`).

| Method | Detail |
| --- | --- |
| `photo` | capture delivery photo (permission explained; stored server-side) |
| `signature` | capture signature on-screen (data URL) |
| `otp` | customer reads their OTP code; rider enters it (server verifies) |

- **Item-wise confirmation**: `itemIds` (array of item UUIDs from `OrderDetail.items[].catalogueItemId`) confirms each item separately — the POD screen lists items with checkboxes and submits only the confirmed subset; unconfirmed items are excluded from the proof, not from the order. Multi-item orders show progress ("3 of 5 confirmed") before submit.
- **PDF attachment**: `documentUrl` (URI, nullable) attaches a PDF delivery note or invoice alongside the proof; the app picks the document from the device, uploads via its own upload flow, and submits the returned URI. Render a "Document attached" row; a failed upload is an inline error, never a blocked submission (field optional).
- The app attaches `gpsStamp` `{lat, lon, at}` from the current location task; send failure of the stamp alone is tolerated (field optional in contract).
- Success → 200 `ProofOfDelivery` (`verified: false` by default) → then `POST /orders/{orderId}/status {status: delivered}` → DeliveredSummary. AI image validation is planned: a later `verified: true` is read-only confirmation, and guided photo capture (framing hints) ships with the on-device POD verification pipeline (`backend/ROADMAP.md` M10b).
- Errors: `POD_INVALID` (field problem → inline error, keep the draft), `POD_OTP_INVALID` (inline "code incorrect, try again" + re-entry), `POD_ALREADY_SUBMITTED` (refetch order; show submitted state, never a duplicate submission). Any 409 → refetch order, show real status.

## Dynamic item addition (mid-delivery)

- Rider adds items the customer wants after pickup: DeliveryDetail → "Add items" → pick from the merchant catalogue (`GET /catalogues/{merchantId}`, approved items only) → `POST /orders/{orderId}/add-items` `{items: [{catalogueItemId, quantity}], reason}` (reason max 300).
- Response 202 `{requestId, status: pending_merchant_approval}`; the order is untouched until the merchant decides. Approved: the server updates order items + totals; the detail screen refetches and shows the new `items[]` and `totals` (read-only — the rider never edits prices). Declined: banner with the merchant's outcome; the order continues unchanged. `order.add_items_approved` / `order.add_items_declined` notify the rider.
- Duplicate guard: while a request is `pending_merchant_approval`, a second submit → `ADD_ITEMS_PENDING` (409) — show "Approval already in progress" with the `requestId`; no new request. Status gate: `ADD_ITEMS_NOT_ALLOWED` (409) — order not in a mid-delivery state (e.g. `delivered`/`cancelled`): hide the entry per status.

## COD handling

- COD orders are identified by payment method `cod` on the order (from contract `OrderCreate.paymentMethod` enum: `mpesa, tigo_pesa, airtel_money, ezy_pesa, halotel, card, cod, bank`).
- At delivery, show "Collect: TZS x,xxx" (from `totals.totalTZS` — server-computed, never client-calculated; totals refresh if an add-items approval changed them).
- QR payment presentation: the rider shows a collection QR generated via `POST /payments/qr` (variable amount for the order total, or fixed amount QR where configured) so the customer can pay by scanning; the customer scans and pays — the rider app never collects mobile-money details.
- Rider records cash collected (tap "Collected") — recorded in the delivery confirmation flow; the amount is bound to the order total.
- Cash ledger reconciliation at shift end: clock-out calls `POST /riders/me/shifts/clock-out` with `{shiftId, cashCollectedTZS, cashReconciled}`; the app shows a shift summary of COD collected (sum of `totals.totalTZS` of COD orders delivered in the shift, server-derived) against the `cashCollectedTZS` the rider enters. Until `cashReconciled: true` the server returns `SHIFT_CASH_MISMATCH` and the shift stays `active` with a reconciliation notice and a support ticket path (`TicketCreate.orderId` set). The ledger itself is server-side; the app records the remittance confirmation only (EARNINGS.md Shifts).
- COD amounts are NOT added to rider earnings; earnings are the delivery fee only (`delivery_fee` ledger entry on `delivered`).

## Trip sharing (live trip)

- Safety Center / DeliveryDetail "Share trip": `POST /riders/me/trips/{orderId}/share` `{recipients, includeRoute?, expiresInHours?}` → 201 `{shareToken, expiresAt}`.
- `recipients`: up to 5 phone numbers (format `phone`); `includeRoute` default `true` (opt-in route visibility); `expiresInHours` default 24.
- The rider receives the `shareToken` + `expiresAt`; the token is sent to recipients via the platform's own channel (in-app share sheet or OS SMS — never a hardcoded gateway), and the token expires server-side (`TRIP_SHARE_EXPIRED` when stale). Recipients see a live view of the trip (position + route only when `includeRoute`), never the rider's ledger, phone, or order details (SECURITY.md).
- `trip.shared` in-app notification confirms; errors: `TRIP_SHARE_NOT_ALLOWED` (no active trip/order state) → button hidden per status; `TRIP_SHARE_EXPIRED` → generate a fresh share.

## Batch trips — completing a trip

- When the rider's orders belong to an active batch trip (DISPATCH-FLOW.md), DeliveryDetail renders the trip context: stop sequence, per-stop status (`pending` → `arrived` → `done` / `failed`), and the batch `earningsTZS` from `GET /riders/me/trips/{tripId}`.
- Stops advance with the normal order actions (arrive at pickup/drop-off, POD, `advanceOrder` status calls); each per-order `delivered` marks its trip stops `done` server-side — there is no separate trip action.
- The final stop `done` completes the trip (`status: completed`, `completedAt` set) and emits `trip.completed` — an in-app batch summary with `earningsTZS` (EARNINGS.md). After completion, reorder → `REORDER_NOT_ALLOWED` (409) and the reorder action is hidden.
- Priority handling: VIP/express orders (`Order.priority`) are sequenced first by dispatch; their stops stay ahead in the trip unless the rider manually reorders (`POST /riders/me/trips/{tripId}/reorder`). VIP/express stops render their priority badge throughout the flow.

## Tips after delivery (customer gratuity)

- After `delivered` → `completed`, the customer may tip via `POST /orders/{orderId}/tip` `{amountTZS, method?, note?}` — customer-callable; the rider app has no tip action and never collects tips.
- The rider sees the result, never a prompt to collect: `tip.received` (push, in-app) → order detail refreshes (`Order.tipTZS`), and a `tip` ledger entry credits Earnings (EARNINGS.md). `TIP_NOT_ALLOWED` (before completion) and `TIP_EXCEEDS_LIMIT` are server rules; a stale screen refetch just shows the current order state.

## Cancellation mid-flow (order `cancelled`)

| Trigger | Rider app behavior |
| --- | --- |
| Customer cancels (`order.cancelled` push, parties notified) | Active card removed on refetch; toast explains cancellation; no penalty shown |
| Merchant cancels | same handling; if rider already picked up, an ops/`support` path is offered (ticket with `orderId`) |
| Rider abandonment | never a client action; ops reassigns — rider sees removal + notification |

- The rider never cancels an order from the app; there is no rider cancel button (contract has `cancelOrder` but rider use is server/ops-governed — do not call it). Cancellation after acceptance counts against reliability score (server-side); after `delivered`, customer cancellation becomes a refund flow (`refund.processed` notification) and the rider keeps the fee (already in ledger).

## Crash and fatigue escalation (Phase 3)

### Crash detection

1. Impact detected (accelerometer/gyroscope/GPS) → app posts `POST /riders/me/safety-events` (`type: crash_detected`, `source: accelerometer|gyroscope|gps`, `severity: critical`, last known location); `safety.crash_detected` pushes the rider + dispatch (critical).
2. Full-screen "Are you OK?" countdown (10 s): tapping "I'm OK" dismisses it and the event is marked `acknowledged`.
3. No response → auto-SOS to dispatch with live location, emergency contacts notified (trip share), active orders cancelled and re-assigned server-side; the alert screen shows the event id for the support ticket.
4. `safety.crash_acknowledged` (critical) notifies dispatch + emergency contacts once the rider confirms safe. Rate-limited: `SAFETY_EVENT_RATE_LIMITED` → back off, never spam.

### Fatigue detection

1. On-device front-camera model (consent-based, SECURITY.md) detects drooping eyelids/yawning → `safety.fatigue_detected` (critical) + audio/vibration alerts → "Take a Break" prompt.
2. The rider starts a shift break (`POST /riders/me/shifts/{shiftId}/break {action: start}`); repeated detection escalates to dispatch.
3. Escalation or max-hours sweepers set `RiderShift.forcedRestUntil` — new offers blocked (`REST_ENFORCED`, "Mandatory rest until {local time}"), `safety.rest_enforced` push, rest countdown card; offers resume when the window passes (DISPATCH-FLOW.md).

## Failed delivery / RTO flow

- Failed delivery (customer unreachable, wrong address, refused, damaged, other): from `delivering`, tap "Delivery failed" → `POST /orders/{orderId}/failed-delivery` with `reason` ∈ `customer_unavailable | wrong_address | refused | damaged | other` (reason sheet from the contract enum, never free text), `note` (max 500), `photoUrl` (optional photo evidence, e.g. closed gate), `returnToMerchant` (defaults `true`).
- Order transitions: `delivering` → `failed_delivery` → `returning` (rider returns items to the merchant; card shows "Returning to merchant") → `delivered` (returned to merchant, logged as a returned delivery) or `cancelled` (server/ops decision, e.g. refund path). The rider never sets `cancelled` directly.
- Errors: `FAILED_DELIVERY_NOT_ALLOWED` (409, status gate — refetch order, show real status). Unsafe conditions: prefer SOS (SECURITY.md) before/alongside a failed-delivery report; the ticket priority `high`/`critical` path remains for safety incidents.

## Rescheduled deliveries

- Customer/ops reschedule an attempt: `POST /orders/{orderId}/reschedule` requires `{scheduledAt, reason}`; `RESCHEDULE_IN_PAST` (409) → inline error, pick a future slot. Who triggers: customer or ops arrange a new time; the rider app offers the reschedule action only where ops instructs (the endpoint is rider-callable per contract — the rider confirms a requested new slot, never inventing one). Result: order status `rescheduled`; the active card is replaced by a "Rescheduled — {local date/time}" state, and `order.rescheduled` notifies the parties; if the rider is no longer on the order, the card is removed on refetch.

## State checklist (delivery screens)

| State | Behavior |
| --- | --- |
| Loading | detail skeleton; nav button disabled |
| Empty | 404 order → "Delivery no longer available", return Home |
| Error | network/5xx → retry banner; `409` → refetch + status explainer |
| Retry | refetch `OrderDetail`; resume countdown |
| Success | status transitions reflected from server `Order`; success summary on `delivered` |

## Masked calls (number privacy)

- "Call Customer" opens the masked dialer: `POST /orders/{orderId}/masked-call` → 201 `MaskedCallSession` `{sessionId, orderId, maskedNumber, direction: rider_to_customer | customer_to_rider, expiresAt}`. The app dials `maskedNumber` only — real numbers are never exchanged, and the customer's raw phone is not in the rider payload.
- Session expiry: `MASKED_CALL_EXPIRED` → "Call link expired" banner → re-create via a fresh POST and retry; `MASKED_CALL_NOT_ALLOWED` (409 — order not assigned to this rider) → hide the action per status. `customer_to_rider` sessions render as inbound-call context (customer initiated); the same session resource backs both legs.

## Restaurant wait timer (paid waiting)

- When the merchant is not ready at pickup, the rider starts a wait timer from PickupConfirm ("Order not ready — start wait"). The elapsed time is tracked as `Order.waitSeconds` (integer seconds, default 0) and is reported in the pickup status `note`; the same measurement feeds the merchant prep-time model (`backend/AI-LAYER.md`), so `DispatchOffer.predictedPrepMinutes` reflects real waits on future offers (DISPATCH-FLOW.md).
- Waiting now pays: the completed order carries `FareBreakdown.waitPayTZS` — restaurant wait-time compensation (TZS integer, `TZS x,xxx` rendering), shown as its own line in the fare breakdown and as a separate row in the Earnings summary for that order (EARNINGS.md). The rider never asserts the amount — the server computes `waitPayTZS` from `waitSeconds`; the app renders rows only.
- States: timer running on DeliveryDetail (running countdown) → stop on `picked_up` (timer value snapshots to the pickup status `note`) → discard on cancel/failed delivery → success: wait-pay line appears on the fare after `delivered`.

## Item-wise verification flag

- `Order.itemsChecked` (boolean, default false) marks that item-wise verification was completed on the order: after the rider confirms each item in the POD screen (item-wise confirmation, `itemIds` above), the server sets `itemsChecked: true` on the order — the detail screen refetches and shows the "Items verified" badge on the pickup summary. The flag is read-only context (server-set); a partially confirmed order keeps `itemsChecked: false` and the checklist resumes from the confirmed subset.

## Smart replies (chat)

- The order conversation offers quick-reply chips ("I'm at the gate", "Delivered — thank you") that send a `ChatMessage` as `rider`; AI/NLP smart replies are planned (ENTERPRISE-READINESS.md, ROADMAP.md) and ship only when the backend model lands. States: chips loading (context) → tap sends → sent state from the server thread; failed send → retry, draft kept.
