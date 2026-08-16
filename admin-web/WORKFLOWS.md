# HUDumika Admin — Critical Workflows

## 1. Approve a merchant

1. Open merchant record (queue filtered by `verification=pending|documents_review`).
2. Review documents (business registration, IDs) — status per document: missing/pending/approved/rejected.
3. Verify business details (name, category, city, service areas).
4. Inspect catalogue draft (items, prices, availability).
5. Configure commercial terms: `commissionRateBps`, `payoutCycleDays`, payout account.
6. Decision: `approved` / `rejected` / `changes_requested` — reason required.
7. Notification sent to merchant (`lead.reviewed`); audit log entry created.

## 2. Approve a provider

1. Review identity documents and qualifications for the trade (plumbing, electrical, etc.).
2. Review trade, service areas, base rate (`baseRateTZS`), bio.
3. Decision: approve (profile published) or request changes with specific items.
4. Notification + audit log entry.

## 3. Approve a rider

1. Review identity documents, license, vehicle documents.
2. Review city/delivery zone.
3. Decision: approve (eligible to go online) or request changes.
4. Notification + audit log entry.

## 4. Resolve a dispute

1. Open the order/booking from the dispute queue; payout is held.
2. Inspect status events (`order_events`/`booking_events`) and attached evidence.
3. Contact parties through the linked support ticket.
4. Decide: release payout, refund (partial/full), or adjust — reason required, threshold rules apply.
5. Create audit entries and notify both parties.
6. Dispute resolved events clear the hold; payout proceeds or refund ledger entries are created.

## 5. Reconcile payouts

1. Open the payout batch for the cycle (`payout_batches`).
2. Compare provider gateway settlement report with platform ledger totals per day.
3. Match entries: mark `paid`, or flag mismatches as `exception` with reason; resolve exceptions with manual settlement or re-processing.
4. Batch settles; finance sign-off recorded; every action is audited.

## 6. Moderate reviews

1. Review queue: pending reviews, open reports, flagged author velocity (> 5 reviews/hour).
2. Decide per report: dismiss, hide, or delete — reason required.
3. Hidden/deleted reviews never count toward rating averages.
4. Audit log entry per decision; author notified (`review.moderated`).

## 7. Handle a stuck order (dispatch)

1. Dispatch monitor surfaces orders past acceptance timeouts.
2. Options: re-queue dispatch, reassign manually (permissioned), cancel with refund (rules apply), or escalate to ops manager.
3. Every action appends an order event and audit entry.

## 8. Issue a refund

1. Open payment intent from the order/booking.
2. Verify eligibility per cancellation rules (`SHARED-FLOWS.md`).
3. Enter amount + reason; amount may not exceed paid amount minus prior refunds.
4. Above-threshold refunds require finance role; support refunds require a linked ticket. Webhook-driven refund status; audit entry with before/after amounts.

## 9. Moderate a promotion

1. Open the promotion queue (`GET /admin/promotions?state=pending_review`).
2. Inspect the campaign: `type` (discount / spend_based / instant_discount / bargain / coupon / traffic), `rules`, `budgetTZS`, `startsAt`/`endsAt`, and redemption/spend so far (`redeemCount`, `spendTZS`).
3. Check rule validity (`PROMOTION_RULE_INVALID`), budget sanity (`PROMOTION_BUDGET_EXCEEDED`), and overlap with active campaigns (`PROMOTION_CONFLICT_ACTIVE`).
4. Decision via `POST /admin/promotions/{promotionId}/decision`: `approved` / `rejected` / `paused` — reason required (max 1000). `paused` also applies to live campaigns (ops only).
5. Merchant notified (`promotion.moderated`); audit entry records actor, decision, reason, and before/after status.

## 10. Moderate a group buy deal

1. Open the deal queue (`GET /admin/group-buys?state=pending_review`).
2. Inspect pricing (`priceTZS` vs `originalPriceTZS`), `quantity`, `validityDays`, and the `salesStartAt`/`salesEndAt` window.
3. Check for abusive discounts or unrealistic quantity; verify merchant eligibility.
4. Decision via `POST /admin/group-buys/{groupId}/decision`: `approved` / `rejected` / `delisted` — reason required (max 1000). Delist applies to live deals.
5. Merchant notified (`group_buy.moderated`); audit entry per decision. Extension requests (`/extend` with `newEndsAt`) and relist applications are reviewed through the same queue.

## 11. Verify a voucher in dispute

1. Open the linked support ticket (customer vs merchant disagreement about a voucher).
2. Staff verifies the voucher via `POST /admin/vouchers/verify` with `voucherCode`.
3. Outcome: valid and unused → decide between redeem at merchant or refund; otherwise surface the stable code (`VOUCHER_INVALID_CODE`, `VOUCHER_ALREADY_USED`, `VOUCHER_EXPIRED`, `VOUCHER_NOT_REDEEMABLE_AT_MERCHANT`).
4. Refund path: voucher moves to `refunded`; payment refund rules and finance thresholds apply, support refunds need the linked ticket. Verification is logged (acting staff user + `result`); audit entry; both parties notified.

## 12. Oversee merchant loyalty config

1. Review the merchant's tier configuration (`name`, `discountBps`, `thresholdTZS`, `perks`).
2. Review top-up rewards (`thresholdTZS`/`bonusTZS` pairs) against policy limits.
3. Flag anomalies: excessive `discountBps`, bonus rates that exceed spend, tier thresholds trivially met or unreachable; request merchant changes through the merchant record, or escalate to ops manager; every review action is audited.

## 13. Moderate an abusive conversation

1. Search conversations (`GET /admin/conversations`) filtered by `merchantId` and `status` (`open` / `archived` / `blocked`); review the message history (`GET /conversations/{conversationId}/messages`) — customer and merchant data masked by default, unmask only what the review needs.
2. Check whether an abuse report or linked support ticket already exists; route new reports to a ticket.
3. Block via `POST /conversations/{conversationId}/block` with a `reason` (max 500) — required, never client-composed; both parties are notified (`conversation.blocked`) and receive `CONVERSATION_BLOCKED` on further sends.
4. Audit entry (`conversation.*`) records actor, reason, and before/after status; blocked-conversation history is compliance-gated; staff never reply inside the customer-merchant chat — follow-up goes through the ticket channel.

## 14. Onboard an enterprise chain

1. Review the chain application: `name`, `storesCount`, expected `monthlyVolumeTZS`, requested `tier` (`standard` / `enterprise`).
2. Set `tier` and `slaLevel`, assign an `accountManager`, and confirm `storesCount` against the merchant group; activate the chain (`status` → `active`) — suspension (`suspended`) is the only downgrade path.
3. Every decision requires a `reason` and writes an audit entry (`chain.*`); the merchant owner is notified.
4. Post-activation, monitor `monthlyVolumeTZS` against tier expectations in the chain list.

## 15. Respond to webhook failures

1. Open the failing webhook monitor (`GET /admin/webhooks?failingOnly=true`); focus on `failed` / `retrying` deliveries.
2. Inspect delivery detail: `attempts`, `statusCode`, `nextRetryAt`, `deliveredAt`, and the subscribed event.
3. Notify the merchant owner (`webhook.delivery_failed`) and guide the fix: endpoint reachability, signature/secret handling, event filtering.
4. Re-test after the merchant confirms the fix; verify the next delivery moves `retrying` → `success`; escalate to ops manager if `attempts` keep climbing — every action is audited (`webhook.*`).

## 16. Approve an enterprise data export

1. Compliance reviews the request: `scope` (`all` / `orders` / `customers` / `catalogue` / `financial`), `format` (`csv` / `xlsx` / `json`), and requester.
2. Decide: approve (job runs `queued` → `processing` → `ready`) or reject with a `reason`; large exports additionally require finance sign-off; the requester is notified (`data_export.ready`) with the `downloadUrl` and `expiresInSeconds`.
3. Downloads are permissioned and audited (`export.*`); `failed` jobs can be re-run through the queue.

## 17. Manual override assignment

1. Open the order (search or dispatch monitor — stuck/stale dispatch, or a VIP/complex case needing a named rider).
2. Choose the target rider from the eligible pool (online, in zone); the picker shows rating/vehicle/reliability context.
3. Enter a `reason` (max 500) — required; submit `POST /admin/orders/{orderId}/assign-rider` `{riderId, reason}`; offline/out-of-zone target → `ASSIGN_RIDER_UNAVAILABLE` → pick another rider.
4. The order gets a new assignment event; audit entry (`assignment.*`) records actor, rider, reason, and the before/after rider; the rider is notified and the order continues its normal status flow.

## 18. Reconcile rider COD

1. Open the rider's shift list (`GET /admin/riders/{riderId}/cod?from=&to=`).
2. Compare each shift's `expectedTZS` (COD owed from orders) vs `collectedTZS` (cash declared at clock-out); review the rider's clock-out reconciliation state.
3. Mark `reconciled` when they match, or flag `mismatch` with a `note` for the variance; `pending` stays until reviewed; `totals.varianceTZS` tracks the gap for the range (money `TZS x,xxx`, integer with separators).
4. Mismatches route to finance follow-up; every status change is audited (`cod.*`) and the shift state updates on the rider side.

## 19. Respond to a crash alert

1. A `crash_detected` safety event (critical) surfaces in the fleet control tower (module 23) with the rider's last location; `safety.crash_detected` pushes dispatch (critical).
2. If the 10 s "Are you OK?" countdown lapsed, the app already auto-fired SOS and cancelled/re-assigned the rider's orders; locate the rider and call them per the escalation runbook (rider DELIVERY-FLOW.md).
3. Rider confirms safe → `safety.crash_acknowledged` (critical) notifies dispatch + emergency contacts; record the outcome in the linked support ticket.
4. Reassign any uncovered orders via manual override (`POST /admin/orders/{orderId}/assign-rider` with reason).
5. Every action writes an audit entry (`safety.*` / `fleet.*`).

## 20. Enforce or relieve mandatory rest

1. Fatigue events or max-hours sweepers set `RiderShift.forcedRestUntil`; the rider gets `safety.rest_enforced` and new offers are blocked (`REST_ENFORCED`).
2. Open the rider record (Riders module or control tower drill-in): see `forcedRestUntil` and `continuousDrivingMinutes`.
3. Leave the enforcement in place until the window passes (system clears it automatically) or confirm the rider has rested and override early — ops manager + rider ops only, reason required, audited (`fleet.*`).

## 21. Resolve a consignment exception

1. A `CONSIGNMENT_MISSING_ORDERS` or `CONSIGNMENT_ORDER_MISMATCH` arrival surfaces in module 24's missing-order queue; `consignment.exception` (critical push) notifies ops and the carrier.
2. Open the consignment: compare `verifiedOrderIds` against the manifest (per-order `waybillNumber` + `section`); identify the missing order(s) and the last waybill event for each.
3. Locate: dispatch/scan history (`waybill_events`), carrier contact, origin-hub scan records; escalate to the carrier per SLA when not found.
4. Decide: locate and deliver on the next corridor (re-route), or declare loss → damage-claim path; every decision requires a `reason`.
5. Re-route: the order is placed on the next available corridor; the customer is notified with a new ETA (`intercity.eta_updated`) and the waybill gains an `exception` event (`waybill.updated`) — never a silent stall.
6. Audit: `consignment.*` entry records actor, reason, and before/after state; resolution clears the queue row.

## 22. Handle a seal-broken handoff

1. A `HANDOFF_SEAL_BROKEN` handoff blocks the leg advance and flags ops; the handoff record shows `sealIntact: false` with the custody record (`from`/`to`/`at`) and `conditionPhotoUrl`.
2. Inspect the custody chain and waybill trail to find the last handoff where the seal was verified intact — the reference point for responsibility.
3. Decide: re-seal and continue (condition photo + note) or open a damage/loss claim — reason required; the leg then advances normally.
4. If the order is delayed, the customer receives `waybill.updated` (exception event) and a new ETA via `intercity.eta_updated`.
5. Audit: `handoff.*` entry records actor, decision, and before/after seal state; the incident clears from module 24.

## 23. Resolve a reconciliation failure (full runbook)

Trigger: `RECONCILIATION_FAILED` on a consignment arrival surfaces in module 27
with `missingOrderIds[]`; `reconciliation.failed` (critical push) notifies ops
and the driver; the trip stays open (`TRIP_CANNOT_CLOSE`).

Roles: ops manager, logistics operations, super admin. Every decision requires a
`reason` and writes a `reconciliation.*` audit entry.

| Step | Action | Screen / data | Notes |
| --- | --- | --- | --- |
| 1. Identify | Open the mismatch row: `expected` vs `scanned`, `missingOrderIds[]` | module 27 reconcile-outcomes table | `missingOrderIds` maps to shipment ids; the manifest rows show the last `scannedIn`/`scannedOut` state |
| 2. Locate via custody chain | For each missing id open `GET /shipments/{id}/custody` — the **last custody entry is the last known holder and location** (actor, `deviceId`, GPS, time) | module 27 custody-chain drawer | Trace forward from the last entry: loaded on which trip, unloaded where, sorted to which bin; use `evidence` (photos/seal refs) and scan-device binding |
| 3. Physical search | Dispatch/scan history, hub scan records, driver/carrier contact | module 24 + module 25 waybill view | Escalate to the carrier per SLA when not found; the driver is already engaged (`reconciliation.failed` push) |
| 4. Decide | Found → re-scan; not found → reroute or declare lost | decision modal with `reason` (required) | **Reroute**: approve replan to an alternate trip/vehicle (`alternateTripId`/`alternateVehicleId`) — recorded as a `trip.*` approval entry; the physical `/replan` call executes on the dispatch/rider side; `PLAN_NOT_MUTABLE` if the trip already departed — then the package must be located or declared lost. **Declare lost** → damage-claim path (compliance review, claims follow the custody chain: the last-intact-seal handoff is the responsibility reference) |
| 5. Close trip | Re-run `POST /linehaul/consignments/{id}/reconcile` after the found package is re-scanned | module 27 run action | 200 `{status: matched, tripClosed: true}` → trip `completed`; closing before this is blocked (`TRIP_CANNOT_CLOSE`) |
| 6. Notify | Customer receives the new ETA / window when delayed | `intercity.eta_updated` (push + in-app) + `waybill.updated` exception row | Never a silent stall; the order's active phase `eta` re-renders |
| 7. Audit | `reconciliation.*` entry: actor, reason, before/after counts (`expected`/`scanned`), missing ids, decision | AUDIT.md display mapping | The queue row clears when the mismatch is resolved or the loss is declared |

UI requirements: stepper modal with the custody drawer embedded; each mutation
shows confirmation with the reason input first, then loading → success →
dismiss, with error/retry states; `PLAN_NOT_MUTABLE` renders inline.

## 24. Respond to a logistics anomaly (full runbook)

Trigger: `logistics.anomaly` (critical push) surfaces in module 26's critical
exceptions queue; types `wrong_hub_scan`, `vehicle_delayed`, `package_missing`,
`rider_no_show`, `seal_broken`, `reconciliation_failed`; scans also raise
`SCAN_GPS_MISMATCH` / `SCAN_VEHICLE_STATIC` (stored in `logistics_anomalies`).

Roles: ops manager, logistics operations, super admin. Every decision requires a
`reason` and writes an `anomaly.*` audit entry.

| Step | Action | Screen / data | Notes |
| --- | --- | --- | --- |
| 1. Verify device/actor | Open the exception row → custody entry: `deviceId` + GPS + `actorId` vs the claimed scan location | module 26 exception queue → module 27 custody drawer | Compare: is the device's location consistent with the scanned hub/vehicle? Is the actor's GPS history consistent (70 km away at scan time = genuine mismatch)? |
| 2. Decide | Dismiss as false positive (GPS drift, clock skew — with a `note`) OR block/freeze the shipment | decision modal with `reason` (required) | **Dismiss**: `anomaly.resolved = true` + note; the scan stays rejected, the custody chain is unchanged. **Block/freeze**: shipment → `status: exception`, excluded from dispatch and loading |
| 3. Block/freeze | Freeze the shipment and flag the actor for trust & safety review | module 26 freeze action | Hubs notified (`logistics.anomaly`); rider scan attempts return the block with `requestId`; dispatch excludes it from new assignments |
| 4. Audit | `anomaly.*` entry: actor, decision, evidence summary (device/GPS comparison), before/after state | AUDIT.md display mapping | Resolved anomalies clear from the queue; frozen shipments keep the `exception` status until ops releases them (a later decision, also reason + audit) |

UI requirements: evidence panel (device/GPS side by side with the claimed scan),
stepper modal, reason required, loading → success → dismiss with error/retry;
role without permission sees the action hidden, API 403 `FORBIDDEN`.

## 25. Resolve a delivery exception (18-kind decision table)

Trigger: an exception row enters the queue (module 26 live queue / module 27
audit view) via rider report or system detection; `exception.created`
(push + in-app) notifies ops and affected parties.

Roles: ops manager, logistics operations, super admin; the four deep-logistics
managers (warehouse/carrier/facility/fleet) may resolve rows in their domain per
ROLES-PERMISSIONS.md. Every status change requires a `reason`-carrying outcome
where the runbook demands it and writes an `exception.*` audit entry.

### The 18-kind decision table — who resolves what

| # | Kind | Who resolves | Locate → reroute → outcome → audit |
| --- | --- | --- | --- |
| 1 | `missing_package` | Ops manager / logistics operations | Locate via custody chain (`GET /shipments/{id}/custody` — last entry = last holder/device/GPS); find or declare lost → re-route or damage claim; outcome "Located and re-scanned" / "Declared lost"; `autoReplanned` when the manifest moved |
| 2 | `wrong_package` | Ops manager / logistics operations | Verify barcode vs manifest (`waybill`); swap/return; outcome "Swapped — correct package dispatched" |
| 3 | `wrong_hub` | Logistics operations | Compare expected vs scanned hub; re-route to the correct hub; outcome with both hubs; `autoReplanned` |
| 4 | `wrong_vehicle` | Logistics operations | Unload → reload on the planned vehicle (`HANDOFF_VERIFICATION_FAILED` context); outcome with both vehicles; `autoReplanned` |
| 5 | `scan_failure` | Logistics operations / the reporting rider (their scoped fix) | Manual verification → re-label → re-scan; outcome "Re-scanned successfully" |
| 6 | `damaged_package` | Logistics operations + compliance (claims) | Inspect condition photo; re-seal or open damage claim (last-intact-seal handoff = reference); outcome with claim reference |
| 7 | `late_vehicle` | Ops manager / logistics operations | ETA update (`intercity.eta_updated`) or replan; outcome with the new window; `autoReplanned` |
| 8 | `vehicle_breakdown` | System auto-replan + ops confirmation | Auto-replan: detect → alternate trip → move manifest → notify hubs → update ETA → update customer; outcome "Replanned to {trip} — new ETA {window}"; `autoReplanned: true` |
| 9 | `rider_unavailable` | Ops manager / logistics operations | Active reassignment (`POST /admin/shipments/{id}/reassign` `{riderId, reason}`) or re-dispatch; outcome with the replacement rider; `SHIPMENT_NOT_REASSIGNABLE` when the status forbids |
| 10 | `bus_cancellation` | Logistics operations | Replan to the next departure; outcome with the alternate trip; `autoReplanned` |
| 11 | `hub_congestion` | Logistics operations / warehouse manager | Prioritize critical shipments, defer non-critical; ETA updates; outcome with volumes |
| 12 | `weather_disruption` | Ops manager | Hold at hub or replan; ETA updates; outcome with the window |
| 13 | `road_closure` | Logistics operations | Re-route or replan; outcome with the diversion; `autoReplanned` |
| 14 | `customer_unavailable` | Ops / support (with the order) | Reschedule or RTO per the failed-delivery flow; outcome with the new attempt |
| 15 | `package_refused` | Ops / support | Return to origin; refund rules; outcome with the RTO reference |
| 16 | `route_deviation` | Logistics operations (anomaly-adjacent) | Verify telemetry; correct course or investigate (anomaly workflow 24); outcome with the evidence summary |
| 17 | `security_incident` | Ops manager + super admin (**escalate**) | Safety first: `status: escalated` → `exception.escalated` (critical) to ops manager; law-enforcement path; freeze shipment (`status: exception`); outcome with the incident reference |
| 18 | `reconciliation_failure` | Ops manager / logistics operations | Reconciliation runbook (workflow 23): locate → re-scan → reroute or declare lost → close trip; outcome with `expected`/`scanned` counts; `autoReplanned` |

### The step-by-step

1. **Open** the exception row (`GET /delivery-exceptions/{exceptionId}`): kind,
   context (`shipmentId`/`orderId`/`tripId`), description, `reportedBy`, status,
   `autoReplanned`, `createdAt`.
2. **Locate** (kinds 1–4, 6, 18): open the shipment custody chain — the last
   entry is the last known holder and location (actor, `deviceId`, GPS, time);
   compare the manifest (`waybill`) and the scan records.
3. **Reroute or replan** (kinds 1, 3, 4, 7, 8, 10, 13): approve the alternate
   trip/vehicle (audit `trip.*`); the physical `/replan` executes on the
   dispatch side; `PLAN_NOT_MUTABLE` if the trip departed — then locate or
   declare lost.
4. **Outcome**: `PATCH /delivery-exceptions/{exceptionId}` `{status: resolved,
   outcome}` — the outcome text (max 1000) records the decision; `resolvedAt`
   set; `exception.resolved` notifies affected parties.
5. **Escalate** (kind 17 and unresolvable-in-window cases): `{status:
   escalated, outcome}` → `exception.escalated` (critical) to ops manager; the
   row is terminal (`EXCEPTION_ALREADY_RESOLVED` blocks re-open).
6. **Notify**: customer-facing ETA changes go only through `intercity.eta_updated`
   + `waybill.updated` (exception row) — exception internals never render
   customer-side; `warehouse.fulfilled`/`carrier.handoff_required` fire where
   relevant.
7. **Audit**: `exception.*` entry records actor, before/after status, outcome,
   and `requestId`; the queue row clears or moves to the audit view (module 27).

UI requirements: queue table with kind/status filters; detail drawer with the
custody-chain embed; status stepper (`open → resolving → resolved | escalated`);
every mutation shows the reason/outcome input first, then loading → success →
dismiss, with error/retry states; `EXCEPTION_ALREADY_RESOLVED` (409) renders the
terminal state.

## 26. Warehouse replenishment & fulfillment routing

Trigger: a warehouse item falls below its serving threshold → `warehouse.stock_low`
(in-app, merchant + ops); or a merchant bulk-ships inventory to a target-city
warehouse (module 28).

Roles: warehouse manager, ops manager, logistics operations, super admin.
Every mutation requires a `reason` and writes a `warehouse.*` audit entry.

| Step | Action | Screen / data | Notes |
| --- | --- | --- | --- |
| 1. Detect | Stock-low rows surface from `warehouse.stock_low`; check the warehouse detail Stock tab | module 28 stock-low monitor | Row: warehouse, item, quantity, threshold state |
| 2. Coordinate | Notify the merchant owner (the alert already fires to them); confirm the bulk inbound quantity | merchant console / warehouse detail | The merchant runs `PUT /warehouses/{id}/stock` themselves or admin runs it on their behalf |
| 3. Receive | Bulk inbound: `PUT /warehouses/{warehouseId}/stock` `{items: [{catalogueItemId, delta}]}` (positive deltas) | module 28 stock action | `INVENTORY_NEGATIVE_STOCK` (409) blocks below-zero outcomes; idempotency-keyed (retry never double-counts) |
| 4. Verify | `GET /warehouses/{warehouseId}` reflects the new `stock[]`; low pills clear | warehouse detail | Server-computed quantities; the client never sums |
| 5. Route | When a customer orders in a serving city, the server selects the nearest active serving warehouse and fulfills (`POST /warehouses/{id}/fulfill` — order tag, never called from admin-web); stock deducts; `warehouse.fulfilled` notifies the customer | order routing state (module 28 / order search) | Fallbacks: `WAREHOUSE_STOCK_UNAVAILABLE` / `WAREHOUSE_OUT_OF_SERVICE` → merchant-store fulfillment (never a partial order) |
| 6. Monitor | Serving-city coverage per warehouse: which cities get the next-day/day-after promise from which warehouse; last-fulfillment log | module 28 routing view | `status: maintenance` excludes a warehouse from fulfillment; `full` warns on inbound |
| 7. Audit | `warehouse.*` entry per create/update/stock-delta: actor, reason, before/after quantities | AUDIT.md display mapping | Routing itself is server-driven and logged with the order |

## 27. Carrier handoff

Trigger: a line-haul consignment is assigned to a third-party carrier
(`Consignment.carrierId`); `carrier.handoff_required` (push + in-app) fires when
the platform-side leg is ready for pickup (module 29 handoff monitor).

Roles: carrier manager, ops manager, logistics operations, super admin.
Carrier registry mutations require a `reason` and write `carrier.*` audit
entries.

| Step | Action | Screen / data | Notes |
| --- | --- | --- | --- |
| 1. Assign | Line-haul leg to carrier: `Consignment.carrierId` set (dispatch); verify the carrier serves the corridor (`regions` × `modes` — `CARRIER_UNAVAILABLE` when the pairing is missing) | module 29 coverage matrix | Carrier `status` must be `active`; `paused` stops new handoffs, `suspended` blocks all |
| 2. Hand over | Platform rider scans the consignment at the origin hub (standard multi-factor handoff); custody entry `actorType: carrier` on pickup | consignment detail / handoff monitor | `carrier.handoff_required` fired; manual scans or webhook integration record pickup |
| 3. Monitor | Line-haul in transit: track pickup/drop-off scans vs SLA | module 29 handoff monitor | Missing scans past SLA → `consignment.exception`-style escalation |
| 4. Receive | Carrier drop-off scan at the destination hub; platform last-mile takes over | custody chain (module 27) | Drop-off recorded via manual scan or webhook; `consignment.arrived` |
| 5. Escalate | Delayed/missing carrier leg → delivery exception (`late_vehicle` / `missing_package` kind) → workflow 25 | module 26 queue | Carrier contact per SLA; `CARRIER_NOT_FOUND` / `CARRIER_UNAVAILABLE` handled inline |
| 6. Audit | `carrier.*` entries for registry/config changes; custody entries are the handoff trail | AUDIT.md display mapping | Customer timeline never shows carrier internals — logical phases only |

## 28. Facility whitelist management

Trigger: a gated facility needs fixed-rider credential access, or a rider
reports `NOT_WHITELISTED` at entry (with a "Request access" ticket), or the
facility changes its `accessPolicy`.

Roles: facility manager, ops manager, logistics operations, super admin.
Every whitelist mutation requires a `reason` and writes a `facility.*` audit
entry.

| Step | Action | Screen / data | Notes |
| --- | --- | --- | --- |
| 1. Register | `POST /facilities` (name, address, `geofence[]`, `accessPolicy` default `whitelist_only`) | module 30 create drawer | Empty geofence renders a warning (entry scans cannot be geofence-verified) |
| 2. Review requests | `NOT_WHITELISTED` incidents + linked "Request access" tickets | module 30 incidents queue | Verify the rider's assignment context (deliveries into the facility) and reliability |
| 3. Grant | `PUT /facilities/{facilityId}/whitelist` `{riderIds}` (full replacement list) | module 30 whitelist editor | `facility.whitelist_granted` (in-app) fires to each added rider; `facility.whitelist_revoked` to removed riders |
| 4. Enforce | Entry scans geofence-verified server-side: whitelisted → granted; not → `NOT_WHITELISTED` (403) | entry log | `whitelist_or_otp` facilities accept a validated one-time code; `open` allows all |
| 5. Audit | `facility.*` entries: actor, reason, rider list before/after | AUDIT.md display mapping | Revocations are audited the same as grants; entry-log reads are view-only |
| 6. Review | Periodically review policy (`whitelist_only` → `whitelist_or_otp`) and prune stale entries | module 30 list | Geofence updates are facility mutations (reason + audit) |

## 29. Fleet account provisioning

Trigger: a delivery company signs up for a fleet master account with driver
sub-accounts.

Roles: fleet account manager, rider ops, ops manager, super admin. Every
mutation requires a `reason` and writes a `fleet.*` audit entry; driver-record
linkage writes `rider.*` entries too.

| Step | Action | Screen / data | Notes |
| --- | --- | --- | --- |
| 1. Create master | `POST /fleet/accounts` `{name, ownerUserId, vehicles[], regions[], permissions}` → 201 | module 31 create drawer | `permissions` is the master RBAC map; vehicles/regions are company-owned |
| 2. Link drivers | Set each driver's `serviceModel: fleet` + `fleetAccountId` (rider-record mutation, rider ops) | module 31 sub-account drill-in / module 5 | Each driver still passes individual identity + licence verification before going online |
| 3. Scope permissions | `PATCH /fleet/accounts/{id}` — per-sub-account permission map, vehicles, regions | module 31 detail | Server-enforced; the app renders only granted surfaces (`CAPABILITY_FORBIDDEN` otherwise) |
| 4. Operate | Company assignments flow to drivers; platform dispatch remains available; master-dependent operations enforce `FLEET_ACCOUNT_SUSPENDED` when suspended | rider side / module 31 | Driver app never exposes master data (rider SECURITY.md fleet boundaries) |
| 5. Bill | Consolidated billing per master for the cycle (server-computed across sub-accounts; money `TZS x,xxx`) | module 31 billing view | Per-driver ledger rows link to the rider's payout view; finance sign-off for settlements |
| 6. Suspend | `status: suspended` with a reason (ops manager + fleet account manager + super admin) | module 31 | Disables master-dependent operations; individual drivers remain subject to rider rules |
| 7. Audit | `fleet.*` entries: actor, reason, before/after status/permissions; `rider.*` entries for linkage changes | AUDIT.md display mapping | Suspension is never client-composed |

## UI requirements

Each workflow runs as a guided modal or drawer with a stepper; every step that mutates shows confirmation with the reason input first, then loading → success → dismiss, with error/retry states.

## Workflow 30 — Freeze and recover a shipment

1. **Trigger**: incident, security concern, legal hold, or damage investigation on a shipment (distinct from the anomaly freeze in workflow 24 — this is the deliberate ops hold).
2. **Freeze**: ops manager (or compliance) calls `POST /admin/shipments/{id}/freeze` with a reason. Shipment status → `frozen`; every movement endpoint returns `SHIPMENT_FROZEN`; custody is locked in place; `shipment.frozen` notifies carrier/hub/affected parties (critical).
3. **Investigate**: run against the custody ledger (`/shipments/{id}/custody`) and waybill trail; damage claims reference the frozen window.
4. **Recover**: `POST /admin/shipments/{id}/unfreeze` with reason + optional `resumePlan`; movement resumes with the plan; `shipment.unfrozen` notifies all parties.
5. **Audit**: both actions write `shipment.freeze` / `shipment.unfreeze` audit entries with actor, reason, and timestamp.

## Workflow 31 — Two-person authorization (4-eyes approval)

**Trigger**: an admin attempts a dangerous action — one of the eight action
types: `large_refund`, `change_commission`, `suspend_major_merchant`,
`change_payment_settings`, `modify_ledger`, `change_iam_policy`,
`delete_critical_data`, `release_hold`. The underlying API fails with 409
`TWO_PERSON_REQUIRED` unless the flow below completes first.

Roles: the initiating admin must hold the underlying permission (e.g.
`finance.refund` for `large_refund`, `iam.manage` for `change_iam_policy`).
The deciding admin must be a **different** admin (never the requester).

| Step | Action | Screen / data | Notes |
| --- | --- | --- | --- |
| 1. Initiate | From the entity view (order, merchant, ledger, policy, shipment), open the approval composer: `POST /admin/two-person-approvals` `{actionType, targetType, targetId, reason (max 1000), payload?}` → 201 `pending` | approval modal on the entity | The composer pre-fills `actionType` from the attempted action and `targetType`/`targetId` from the entity; `payload` carries the proposed operation (amount, rate, policy diff, hold id) |
| 2. Queue | The approval appears in the two-person approval queue (`GET /admin/two-person-approvals?status=pending`) and on the entity's audit timeline | Audit group → Two-person approvals | Requested-by column shows the initiator; the queue sorts oldest-first |
| 3. Decide | A second admin opens the approval and posts `POST /admin/two-person-approvals/{approvalId}/decision` `{decision: approve|reject, comment (max 1000)}` | approval detail drawer | Decision reasons render in the drawer; the comment is required |
| 4. Same-actor block | The initiator (or anyone acting as them) attempts to decide → 409 `APPROVAL_SAME_ACTOR`; the UI hides the decision buttons for the requester | inline block | Never bypassable client-side |
| 5. Execute | On `approve` the platform executes the action with the recorded `payload`; on `reject` nothing executes; status becomes `approved`/`rejected` (terminal — `APPROVAL_ALREADY_DECIDED` blocks re-decision) | entity view reflects the result | Execution is server-driven; the UI only renders the outcome (e.g. refund posted, commission updated, policy applied) |
| 6. Notify | The initiator is notified of the decision; rejections carry the comment | notification center | `approval.decided` pattern for admin staff |
| 7. Audit | `two_person_approval.*` entries: initiate (actor, actionType, target, reason, payload summary) and decision (deciding actor, approve/reject, comment, before/after status) | AUDIT.md display mapping | Both entries render on the entity timeline; the audit pair reconstructs the full 4-eyes record |

UI requirements: approval composer modal with action-type selector + reason
prompt; queue table with status filters (`pending`/`approved`/`rejected`);
detail drawer with both actors, payload, comment; decision stepper shows
loading → success → dismiss with error/retry; `APPROVAL_SAME_ACTOR` (409)
renders inline; role without permission sees actions hidden, API 403.

## Workflow 32 — Investigate a risk case

**Trigger**: a risk case is created by the risk engine (signals fire:
`refund_ratio`, `refund_velocity`, `large_refund`, `withdrawal_anomaly`,
`login_risk`, `unusual_order_pattern`, `order_delay`, `rider_inactivity`,
`suspicious_cancellation`, `gps_spoof`, `rapid_decline`, `impossible_speed`,
`multi_device`, `payment_abuse`, `multiple_accounts`, …) and appears in the
risk dashboard (module 34); `critical` cases push the "fraud spike"-class
alert to risk & fraud.

Roles: risk & fraud, trust & safety, ops manager, super admin. Every review
action requires a `reason` (max 1000) and writes a `risk_case.*` audit entry.

| Step | Action | Screen / data | Notes |
| --- | --- | --- | --- |
| 1. Triage | Open the case: severity, `signals[]`, status, `createdAt` | module 34 queue (filter by severity/status) | `critical` + `open` sorts first |
| 2. Anchor | Open the related entities: `customerUserId`, `providerId`, `riderId`, `orderIds[]`, `deviceIds[]`, `ipHistory[]` — each links to the universal entity view | case detail related panel | Check the entity history: order velocity, refund history, device count, IP spread |
| 3. Investigate | Walk the signals against the entity evidence: order timeline, payment intents, refunds, devices, IPs, review/rating velocity | linked universal views + audit timelines | Set status → `investigating` (the UI offers the status transition with a note) |
| 4. Decide | `POST /admin/risk/cases/{caseId}/review` `{action, reason}`: `dismiss` / `block_user` / `block_provider` / `escalate` / `hold` | review stepper modal | `block_user`/`block_provider` require `risk.block`; `dismiss` requires a reason explaining the false positive; `escalate` routes to the ops manager / risk lead; `hold` keeps the case open for more signals |
| 5. Execute | The block paths suspend the linked customer/provider; escalation notifies ops; the case flips to its terminal state (`resolved`/`dismissed`) | case status pill | Blocks follow the suspension rules (reason + audit on the user record too) |
| 6. Audit | `risk_case.*` entry: actor, action, reason, before/after status, decidedAction | AUDIT.md display mapping | Already-decided cases reject new decisions (`RISK_CASE_ALREADY_DECIDED`); unknown ids → `RISK_CASE_NOT_FOUND` |

UI requirements: dashboard matrix (severity × status), queue with filter
chips, case drawer with the related-entity panel, review stepper with reason
input first; `block_user` shows the target customer's masked profile before
confirming; every decision shows loading → success → dismiss with
error/retry.

## Workflow 33 — Respond to control-tower critical alerts

**Trigger**: `GET /admin/control-tower` (or the live WS stream) shows
critical actions. Per alert type:

### 33.1 Shipment exceptions (`shipmentExceptions`)

1. Open the count → logistics control tower / delivery-exceptions queue
   (module 26/27).
2. Triage by kind: `missing_package`, `wrong_hub`, `rider_unavailable`,
   `reconciliation_failure`, `security_incident`, …
3. For physical exceptions run the locate flow (workflow 23) or the 18-kind
   decision table (workflow 25): locate via custody chain → reroute/replan or
   declare lost → outcome → notify.
4. Escalate `security_incident`-class rows immediately (`exception.escalated`
   critical to ops manager); freeze the shipment (`shipment.hold`).
5. Audit every decision (`exception.*` / `reconciliation.*` / `shipment.*`).

### 33.2 Provider incidents (`providerIncidents`)

1. Open the incident list (provider incidents surface).
2. Assess impact: active bookings, affected customers, SLA exposure.
3. Act: suspend the provider (`provider.suspend`, reason), reassign jobs
   (`POST /admin/bookings/{id}/assign-provider`), or escalate to regional
   ops.
4. Notify affected customers via the booking channel; every decision is
   audited (`provider.*`, `booking.*`).

### 33.3 Payment failures (`paymentFailures`)

1. Open the payment failure queue (payments module).
2. Triage by provider/category (integration health `payment` rows).
3. If the payment provider is `down`: fire the "payment provider down"
   alert; consider fallback methods; escalate to technical operations.
4. If failures are per-intent: retry or refund path per payment rules;
   `PAYMENT_PROVIDER_ERROR` context; every action audited (`refund.*`,
   `payment.*`).

### 33.4 Fraud spike (`fraudCases`)

1. Open the risk dashboard (module 34); review new `critical`/`high` cases.
2. Run the risk-case investigation (workflow 32): signals → related
   entities → dismiss/block/escalate/hold.
3. Consider risk-rule tuning in the configuration center (risk thresholds) —
   configuration change is audited; aggressive tuning changes follow the
   change-review rule.
4. Audit every case decision (`risk_case.*`).

### 33.5 SLA breach (`slaBreaches`)

1. Open the SLA breach queue (`admin.sla_breach` rows).
2. Triage by scope (`support_ticket` / `delivery` / `service_booking` /
   `refund` / `verification`).
3. Respond: reassign tickets, expedite deliveries, escalate to regional
   ops; verify SLA rules (`GET/PUT /admin/sla-rules`) are current.
4. Track response time against `alertBeforeMinutes`; every action audited
   (`ticket.*`, `shipment.*`).

### 33.6 Hub capacity warnings (`hubCapacityWarnings`)

1. Open the hub list (module 33); warnings link to the hub dashboard
   (`capacityPct` > 100).
2. Relieve: reroute inbound to a sibling hub, defer non-critical
   outbound, expedite sortation (staff/vehicle allocation).
3. Update the customer ETA where routed
   (`intercity.eta_updated` / booking channels).
4. Audit decisions (`hub.*`, `consignment.*`); the warning clears when the
   dashboard load normalizes.

### General

- The tower polls (React Query refetch interval); each `criticalActions`
  count is a deep link, never a static number.
- Level-1 alerts notify Operations Manager; unresolved alerts escalate to
  Platform Administrator, then Platform Owner per the escalation window.
- Every response step is audited under the owning prefix; the tower itself
  is read-only.

## UI requirements

Each workflow runs as a guided modal or drawer with a stepper; every step that mutates shows confirmation with the reason input first, then loading → success → dismiss, with error/retry states.
