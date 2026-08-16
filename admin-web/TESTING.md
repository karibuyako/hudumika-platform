# HUDumika Admin Web — Testing

## Pyramid

| Layer | Tooling | Scope |
| --- | --- | --- |
| Unit | Vitest | Permission matrix logic, TZS formatting, filters, workflow state transitions |
| Component | React Testing Library | Tables, drawers, steppers, reason prompts, masking, toasts |
| Contract | MSW against `backend/API-CONTRACT.yaml` | Every admin endpoint + error path |
| E2E | Playwright | Staff login + MFA, approve merchant, resolve dispute, reconcile payout, moderate review, promotion/group buy moderation, voucher verification, conversation search and block, chain onboarding, webhook failure runbook, export approval, permission denial, fleet control tower, crash response, rest enforcement, consignment exception, seal-broken escalation, logistics control tower, reconciliation runbook, anomaly response, global search, two-person approval (same-actor 409), risk case block_user, hub dashboard, operations control tower alerts, integration health degraded, feature flag region rollout |

## Contract tests (MSW parity)

- MSW handlers mirror `/admin/*` endpoints from the contract with identical shapes and error codes.
- A CI job re-validates the generated client types against `API-CONTRACT.yaml` on every backend change.
- Same request suites run against MSW (admin-web CI) and staging (backend CI).

## Checklist per module

1. List: loading skeleton → data → empty state → error + retry.
2. Filters: each server filter round-trips; pagination to last page shows empty state.
3. Detail drawer: timeline renders events in order; masked fields masked.
4. Mutation: reason validation → loading → success toast → audit entry visible on timeline.
5. Error paths: `FORBIDDEN` (role without permission sees action hidden and API 403 handled), `CONFLICT` (stale status), network failure.
6. Permissions: render-only checks — UI hides actions the role cannot perform, and the API is still mocked to reject them in tests.

## E2E scenarios (Playwright)

| Scenario | Flow |
| --- | --- |
| Staff login | OTP → MFA → dashboard renders role-scoped modules |
| Approve merchant | Queue → documents → terms → approve → notification state + audit entry |
| Resolve dispute | Dispute queue → evidence → refund decision (reason) → payout hold cleared |
| Reconcile payout | Batch → gateway report compare → exception → resolve → settled |
| Moderate review | Queue → hide → rating average recalculated |
| Approve promotion | Queue → inspect rules/budget → approve (reason) → live state + merchant notified + audit entry |
| Reject group buy | Queue → reject with reason → merchant notified, deal never listed |
| Voucher dispute verification | Ticket → `POST /admin/vouchers/verify` → refund decision → voucher `refunded` + audit entry |
| Search conversation | Filter by merchant → open conversation → masked participant data, message history renders in order |
| Block conversation | Conversation → `POST /conversations/{conversationId}/block` with reason → status `blocked` → both parties notified (`conversation.blocked`) + audit entry |
| Permission denial | Finance sees no block action on conversations; API returns 403 `FORBIDDEN` |
| Permission denial | Support agent sees no promotion approval actions; API returns 403 `ADMIN_ACTION_FORBIDDEN` |
| Export audit | Filters → export → export log entry present |
| Onboard enterprise chain | Chain application → review stores/volume → set tier + SLA + account manager → activate → audit entry (`chain.*`) |
| Webhook failure runbook | `failingOnly` filter → inspect deliveries (`attempts`, `nextRetryAt`) → notify merchant (`webhook.delivery_failed`) → guide fix → re-test → delivery `success` + audit entry (`webhook.*`) |
| Approve enterprise export | Compliance reviews scope/format → approve (reason) → job `ready` → requester notified (`data_export.ready`) → audited download (`export.*`) |
| Export approval denial | Finance attempt on enterprise scope denied (403 `ADMIN_ACTION_FORBIDDEN`); approval without reason rejected (`ADMIN_REASON_REQUIRED`); action hidden for roles without permission |
| Manual override assignment | Open order → pick online/in-zone rider → reason → `POST /admin/orders/{orderId}/assign-rider` → assignment event + audit entry (`assignment.*`) → rider notified |
| Offline rider override | Target offline/out of zone → `ASSIGN_RIDER_UNAVAILABLE` → picker reopens; role without permission sees the action hidden, API 403 `FORBIDDEN` |
| COD reconciliation | `GET /admin/riders/{riderId}/cod` → shift with `mismatch` flagged + note → finance marks `reconciled` → `varianceTZS` updates + audit entry (`cod.*`) |
| Control tower renders multi-hub fleet | `GET /admin/fleet/control-tower` → totals (`activeRiders`, `onlineRiders`, `activeOrders`, `inTransit`, `anomalies`, `openSos`) + `byFleetType[]` + `hubs[]` render; `hubId`/`fleetType` filters round-trip; `CONTROL_TOWER_UNAVAILABLE` → empty state + retry; hub drill-in opens the rider; role without permission sees the module hidden, API 403 `FORBIDDEN` |
| Crash response runbook | `crash_detected` safety event surfaces in the control tower → locate rider → call → confirm safe (`safety.crash_acknowledged`) → reassign uncovered orders via manual override → support ticket + audit entries (`safety.*` / `fleet.*`) |
| REST_ENFORCED override | Rider in forced rest (`forcedRestUntil`): control tower shows the rest state and new offers are blocked (`REST_ENFORCED`); ops manager relieves early with a reason → enforcement clears + audit entry (`fleet.*`); unauthorized role → action hidden, API 403 |
| Hub CRUD | Hubs module → `GET /hubs` renders (`name`, `cityId`, `address`, `capacity`, `active`) → create hub (`POST /hubs`) with name/city/address/capacity → row appears → deactivate → `hub.*` audit entry with actor + reason; `HUB_NOT_FOUND`/`HUB_FULL` inline; role without permission sees actions hidden, API 403 |
| Consignment exception runbook | Missing-order arrival (`CONSIGNMENT_MISSING_ORDERS`) → module 24 exception queue → inspect manifest vs `verifiedOrderIds` → locate → re-route decision (reason) → customer notified (`intercity.eta_updated` + `waybill.updated` exception event) → queue row clears + `consignment.*` audit entry; mismatch variant (`CONSIGNMENT_ORDER_MISMATCH`) shows the manifest difference |
| Seal-broken escalation | `HANDOFF_SEAL_BROKEN` incident → custody record + condition photo + last-intact-seal handoff → re-seal decision (reason) → leg advances → `handoff.*` audit entry; unauthorized role sees the action hidden, API 403 |
| Control tower renders network totals | `GET /admin/logistics/control-tower` → `totals {activeShipments, delayed, exceptions, atRisk, activeTrips}` + `tripsByHub[]` + `criticalExceptions[]` render; exception row links to the shipment custody chain; `CONTROL_TOWER_UNAVAILABLE` → empty state + retry; role without permission sees the module hidden, API 403 `FORBIDDEN` |
| Reconciliation runbook | `RECONCILIATION_FAILED` with `missingOrderIds[]` → module 27 → custody chain per missing id → locate → re-scan/re-route decision (reason) → reconcile `matched` + `tripClosed: true` → audit entry (`reconciliation.*`); `PLAN_NOT_MUTABLE` variant after departure |
| Anomaly response | `logistics.anomaly` (`SCAN_GPS_MISMATCH` evidence) → verify device/GPS binding → freeze shipment (reason) → status `exception`, dispatch excludes it → audit entry (`anomaly.*`); queue clears on resolution |
| Delivery exception queue | 18-kind catalog renders with kind/status filters → open detail (context, `reportedBy`, `autoReplanned`) → `PATCH` `resolving` → resolve with `outcome` (reason) → `exception.resolved` asserted → queue row clears + audit entry (`exception.*`); duplicate resolve → `EXCEPTION_ALREADY_RESOLVED`; escalate variant → `exception.escalated` critical (D1 full flow) |
| Warehouse module | `GET /warehouses` renders (name, city, address, `servingCities`, `stock[]`, status) → create (`POST /warehouses` with name/city) → update status `maintenance` (reason) → stock delta via `PUT /{id}/stock` (positive inbound + negative write-off; `INVENTORY_NEGATIVE_STOCK` conflict) → stock-low monitor rows → routing state view (`fulfillmentSource: warehouse`, fallback records) → `warehouse.*` audit entries; `WAREHOUSE_NOT_FOUND` inline (D2 full flow) |
| Carrier module | `GET /carriers` renders (name, `modes[]`, `regions[]`, `apiIntegration`, status) → register (`POST /carriers`) → pause/suspend (`PATCH /{id}`, reason) → coverage matrix (`CARRIER_UNAVAILABLE` pairing) → handoff monitor (`carrier.handoff_required` + `actorType: carrier` custody entries) → `carrier.*` audit entries (D3 full flow) |
| Facility module | `GET /facilities` renders (name, address, `geofence[]`, `whitelistRiderIds[]`, `accessPolicy`) → register facility → whitelist edit (`PUT /{id}/whitelist`, rider add/remove) → `facility.whitelist_granted`/`revoked` asserted → entry log + `NOT_WHITELISTED` incident queue → resolve by granting access (reason) → `facility.*` audit entries; `FACILITY_WHITELIST_EXISTS` inline (D4 full flow) |
| Fleet account module | `GET /fleet/accounts` renders (name, `driverSubAccountIds[]`, `vehicles[]`, `regions[]`, `permissions`, status) → create master → link a driver sub-account (`serviceModel: fleet` + `fleetAccountId` on the rider record) → update permissions → consolidated billing view (`TZS x,xxx`) → suspend (reason) → `FLEET_ACCOUNT_SUSPENDED` on dependent ops → `fleet.*` audit entries (D5 full flow) |
| Active reassignment / escalation | `POST /admin/shipments/{id}/reassign` `{riderId, reason}` → shipment re-assigned + assignment event + audit `shipment.*`; status-gate variant → `SHIPMENT_NOT_REASSIGNABLE`; `POST /admin/shipments/{id}/escalate` `{reason}` → `exception.escalated` critical; status-gate variant → `SHIPMENT_NOT_ESCALATABLE`; unauthorized role → 403 `FORBIDDEN` (D6 full flow) |
| Global search finds an order by ID prefix | Command palette / top-bar search → `GET /admin/search?q=ORD-…` → result row renders (`entityType: order`, `id`, `label`, `status`, `region`) → click opens the universal entity view; entity-type filter chips (`order`/`shipment`/`customer`/`provider`/`rider`/`merchant`/`booking`/`hub`/`vehicle`/`ticket`/`conversation`) round-trip; natural-language query variant; `ADMIN_SEARCH_INVALID` (422) inline; unauthorized role sees search hidden, API 403 `FORBIDDEN` (C1 full flow) |
| Two-person approval executes only after second admin | Finance initiates `large_refund` approval (`POST /admin/two-person-approvals` with reason + payload) → queue shows `pending` with `requestedBy`; the **same** actor attempts `POST /admin/two-person-approvals/{id}/decision` → 409 `APPROVAL_SAME_ACTOR` inline, decision buttons hidden for the requester; a second admin approves (`{decision: approve, comment}`) → status `approved`, the refund executes server-side, `two_person_approval.*` audit pair visible on the entity timeline; rejection variant → nothing executes; already-decided re-decision → 409 `APPROVAL_ALREADY_DECIDED`; dangerous action attempted without the flow → 409 `TWO_PERSON_REQUIRED` (C2 full flow) |
| Risk case block_user | Risk dashboard renders severity × status matrix → open a `high`/`critical` case (`GET /admin/risk/cases`) → signals + `related` entities render (`customerUserId`, `providerId`, `riderId`, `orderIds[]`, `deviceIds[]`, `ipHistory[]`) → review stepper `POST /admin/risk/cases/{id}/review` `{action: block_user, reason}` → customer suspended, case `resolved` + `decidedAction`, `risk_case.*` audit entry; `dismiss` variant with reason → `dismissed`; already-decided → 409 `RISK_CASE_ALREADY_DECIDED`; role without `risk.block` sees block actions hidden, API 403 (C3 full flow) |
| Hub dashboard load | Hubs module → hub row → `GET /admin/hubs/{hubId}/dashboard` → `load {incoming, outgoing, awaitingSort, exceptions, capacityPct}` cards + `sortationQueues[]` per-zone table + `staffOnDuty` + `vehiclesPresent` render; `capacityPct` > 100 renders the capacity warning and links to the control tower `hubCapacityWarnings`; `HUB_NOT_FOUND` (404) → empty variant; `HUB_DASHBOARD_UNAVAILABLE` → empty state + retry; unauthorized role → module hidden, API 403 `FORBIDDEN` (C4 full flow) |
| Operations control tower alerts | `GET /admin/control-tower` → `totals` (8 stat cards) + `networkHealth` (delivery/service stacked bars with `normalPct`/`delayedPct`/`criticalPct`, `capacityIssuePct`) + `criticalActions` (6 counts: `shipmentExceptions`, `providerIncidents`, `paymentFailures`, `fraudCases`, `slaBreaches`, `hubCapacityWarnings`); each count deep-links to its queue (risk cases for `fraudCases`, hub list for `hubCapacityWarnings`); `generatedAt` shown; 5xx → empty state + retry; unauthorized role → module hidden, API 403 `FORBIDDEN` (C5 full flow) |
| Integration health degraded | `GET /admin/integrations` → registry rows (provider, `category` chip among the 9, `health` pill, `lastCheckedAt`, `error`) → a `degraded` payment row renders amber with error hint; `down` variant fires the integration-failure alert (push critical) + payment-category `down` routes follow-up to technical operations; `INTEGRATION_HEALTH_UNAVAILABLE` → empty state + retry; unauthorized role → module hidden, API 403 `FORBIDDEN` (C6 full flow) |
| Feature flag rollout to a region only | Configuration center → feature flags (`GET /admin/features`) → edit flag: `enabled: true`, `rolloutPct: 1`, `targeting {regions: ["Dar es Salaam"]}` via `PATCH /admin/features` → client resolution mock asserts `GET /experiments` returns enabled only for the targeted region, disabled elsewhere; targeting diff renders in the audit entry (`feature.*`); `FEATURE_KEY_EXISTS` inline (C7 full flow) |

## Logistics E2E scenarios — full step-by-step (modules 26–27, workflows 23–24)

### L1 — Control tower renders network totals + trips-by-hub + exception queue

1. Staff login (OTP + MFA) → Logistics control tower module visible for ops
   manager / logistics operations / super admin.
2. `GET /admin/logistics/control-tower` → `totals {activeShipments, delayed,
   exceptions, atRisk, activeTrips}` render as stat cards; `generatedAt` shown.
3. `tripsByHub[]` renders the map nodes (hubName + trips badge) and the table
   view; corridor lines for `in_transit` trips.
4. `criticalExceptions[]` renders all six types
   (`wrong_hub_scan`/`vehicle_delayed`/`package_missing`/`rider_no_show`/
   `seal_broken`/`reconciliation_failed`) with `shipmentId` + `detail`; each row
   links to the shipment custody chain (module 27) and the runbook (workflow
   23/24).
5. `CONTROL_TOWER_UNAVAILABLE` → empty state + retry; unauthorized role → module
   hidden, API 403 `FORBIDDEN`.

### L2 — Reconciliation runbook end-to-end (workflow 23)

1. `RECONCILIATION_FAILED` with `missingOrderIds[]` surfaces in module 27 →
   `reconciliation.failed` critical push asserted.
2. Identify: table shows expected vs scanned, missing list; manifest rows show
   the last scanned state.
3. Locate: for each missing id open the custody chain → last entry shows the
   last holder (`actorId`, `deviceId`, GPS, time) → search/dispatch history
   consulted; carrier escalation path when not found.
4. Decide (reason required, `ADMIN_REASON_REQUIRED` when missing):
   - Found → re-scan (driver side) → re-run `POST
     /linehaul/consignments/{id}/reconcile` from the module → 200 `matched` +
     `tripClosed: true` → trip `completed`.
   - Reroute → replan approval modal (`alternateTripId`) → audit `trip.*`
     approval recorded; `PLAN_NOT_MUTABLE` variant after departure renders
     inline.
   - Declare lost → damage-claim path opened with `reason`; compliance review
     linked.
5. Notify: `intercity.eta_updated` + `waybill.updated` exception row asserted
   (customer side mock).
6. Audit: `reconciliation.*` entry with expected/scanned counts, missing ids,
   reason; queue row clears.

### L3 — Anomaly response runbook end-to-end (workflow 24)

1. `logistics.anomaly` (`SCAN_GPS_MISMATCH` evidence) surfaces in module 26's
   exception queue with the custody entry (deviceId, GPS, actorId).
2. Verify: evidence panel shows the scan GPS vs actor GPS side by side (70 km
   apart) → genuine mismatch confirmed.
3. Decide: freeze the shipment with `reason` → shipment `status: exception`,
   excluded from dispatch and loading; hubs notified (`logistics.anomaly`);
   rider scan attempts return the block with `requestId`.
4. Variant: GPS drift (5 m) → dismiss with `note` → anomaly `resolved: true`,
   queue row clears; no shipment state change.
5. Audit: `anomaly.*` entry records actor, decision, evidence summary, before/
   after state; unauthorized role → action hidden, API 403.

### L4 — Module permission denials

- Finance sees no logistics control tower / reconciliation / anomaly actions;
  API 403 `FORBIDDEN`.
- Compliance reviewer can read custody chains and anomalies but never resolves
  them (no decision actions rendered).
- Every mutation without a reason rejected (`ADMIN_REASON_REQUIRED`).

## Deep logistics E2E scenarios — full step-by-step (modules 28–31, workflows 25–29)

### D1 — Delivery-exceptions queue (workflow 25)

1. A `vehicle_breakdown` exception (rider/system-reported, `autoReplanned: true`)
   surfaces in module 26's queue; `exception.created` push asserted.
2. Row renders kind pill, context links (`shipmentId`/`orderId`/`tripId`),
   `reportedBy`, status `open`; filters `kind` (18 chips) and `status` (4 pills)
   round-trip; `escalated` sorts first.
3. Open detail (`GET /delivery-exceptions/{exceptionId}`) → custody-chain embed
   for `missing_package`-type rows → locate the package (last custody entry:
   actor, `deviceId`, GPS, time).
4. `PATCH` `{status: resolving}` → pill flips; ops works the case.
5. Resolve: `{status: resolved, outcome: "Replanned to TRP-9913 — new ETA Day 2
   09:00–14:00"}` → `exception.resolved` asserted; `autoReplanned: true` badge +
   replan record link; queue row clears.
6. Duplicate resolve on the resolved row → 409 `EXCEPTION_ALREADY_RESOLVED` →
   terminal state shown, no reopen.
7. Escalation variant (kind 17 `security_incident`): `{status: escalated,
   outcome}` → `exception.escalated` (critical) to ops manager; row pinned;
   customer-side mock asserts no exception internals render.
8. Audit: `exception.*` entry with kind, before/after status, outcome, reason.

### D2 — Warehouse replenishment & fulfillment routing (module 28, workflow 26)

1. `warehouse.stock_low` (in-app) fires for an item below threshold → stock-low
   monitor shows the row (warehouse, item, quantity).
2. Merchant confirmed inbound → `PUT /warehouses/{id}/stock`
   `{items: [{catalogueItemId, delta: 200}]}` → 200 `Warehouse`, `stock[]`
   updates, low pill clears; negative delta write-off variant (reason) →
   `INVENTORY_NEGATIVE_STOCK` conflict when below zero.
3. Create warehouse (`POST /warehouses` name + city) → 201; set
   `status: maintenance` (`PATCH`, reason) → excluded from fulfillment; `full`
   warns on inbound.
4. Routing state: an order fulfills `fulfillmentSource: warehouse` (order tag —
   assert admin-web never calls `/fulfill`); fallback record
   (`WAREHOUSE_STOCK_UNAVAILABLE`) renders the merchant-store fulfillment.
5. Audit: `warehouse.*` entries per create/update/stock-delta with before/after
   quantities; unauthorized role sees actions hidden, API 403.

### D3 — Carrier handoff (module 29, workflow 27)

1. Register carrier (`POST /carriers` `{name, modes: [linehaul_bus],
   regions: ["Dar es Salaam"]}`) → 201; coverage matrix shows the region × mode
   cell; a corridor outside the pairing → `CARRIER_UNAVAILABLE` inline.
2. `PATCH /carriers/{id}` `paused` (reason) → no new handoffs; `suspended`
   blocks all; `carrier.handoff_required` asserted for an active carrier
   consignment (`Consignment.carrierId` set).
3. Handoff monitor: pickup custody entry (`actorType: carrier`) + drop-off scan
   (manual/webhook) render on the consignment detail; a missed-SLA leg surfaces
   as a delivery exception → workflow 25.
4. Audit: `carrier.*` entries with modes/regions diff and status transitions;
   unauthorized role 403.

### D4 — Facility whitelist management (module 30, workflow 28)

1. Register facility (`POST /facilities` name + address, `accessPolicy:
   whitelist_only`) → 201; empty-geofence warning renders.
2. Whitelist edit: `PUT /facilities/{id}/whitelist` `{riderIds: [riderA,
   riderB]}` (reason) → `facility.whitelist_granted` asserted for A and B;
   remove riderB → `facility.whitelist_revoked` asserted.
3. Entry logs: geofenced entry scans (granted/blocked) render with GPS vs
   geofence; a `NOT_WHITELISTED` (403) incident + "Request access" ticket
   resolves by granting access (reason) → grant notification; dismiss variant
   with `reason`.
4. Policy switch: `whitelist_or_otp` → one-time code issue/use records (masked)
   render.
5. Audit: `facility.*` entries with whitelist before/after; `FACILITY_WHITELIST_EXISTS`
   (409) inline; unauthorized role 403.

### D5 — Fleet account provisioning (module 31, workflow 29)

1. Create master (`POST /fleet/accounts` `{name, ownerUserId, vehicles[],
   regions[], permissions}`) → 201; list renders drivers/vehicles/regions
   counts.
2. Link a driver: rider record set to `serviceModel: fleet` + `fleetAccountId`
   (rider ops action) → sub-account drill-in shows the linkage + verification
   + ratings (module 5 link).
3. Update permissions (`PATCH /fleet/accounts/{id}`, reason) → server-enforced
   scopes reflected; consolidated billing view renders `TZS x,xxx` totals
   (server-computed across sub-accounts) with per-driver ledger links.
4. Suspend (reason) → `FLEET_ACCOUNT_SUSPENDED` on master-dependent operations;
   individual driver records remain readable.
5. Audit: `fleet.*` entries (permissions diff, sub-account list, suspension
   decision); unauthorized role 403.

### D6 — Active reassignment and escalation

1. Open a shipment mid-flight → `POST /admin/shipments/{id}/reassign`
   `{riderId, reason}` → 200 `Shipment` re-assigned; the rider-side mock
   receives a new assignment event; audit `shipment.*`.
2. Status-gate variant (e.g. already delivered) → 409 `SHIPMENT_NOT_REASSIGNABLE`
   → inline block; the action is hidden per status.
3. `POST /admin/shipments/{id}/escalate` `{reason}` → 200; `exception.escalated`
   (critical) asserted to ops manager; status-gate variant →
   `SHIPMENT_NOT_ESCALATABLE`.
4. Unauthorized role (e.g. support) → action hidden, API 403 `FORBIDDEN`;
   missing reason → `ADMIN_REASON_REQUIRED`.

## Control-plane E2E scenarios — full step-by-step

### C1 — Global search finds an order by ID prefix

1. Staff login (OTP + MFA) → search is available from the top bar and the
   command palette (Ctrl/Cmd+K) for roles with `order.read`-level visibility.
2. Type the order prefix `ORD-` + the order id → `GET /admin/search?q=ORD-…`
   → result row renders `entityType: order`, `id`, `label`, `status`, `region`.
3. Entity-type filter chips (`order`/`shipment`/`customer`/`provider`/
   `rider`/`merchant`/`booking`/`hub`/`vehicle`/`ticket`/`conversation`)
   round-trip via `entityTypes`; `limit` default 20 respected.
4. Natural-language variant: `q=stuck orders Dar` returns the operational
   queue interpretation (operations query engine) with matching rows.
5. Click the row → the universal entity view opens (status, parties,
   origin/destination, location, timeline, actions, audit, events, scans,
   actors, locations, devices).
6. Malformed query → `ADMIN_SEARCH_INVALID` (422) renders inline; a role
   without search permission sees the search hidden and the API returns 403
   `FORBIDDEN`; results are ABAC-scoped (regional ops never see outside-region
   entities).

### C2 — Two-person approval executes only after second admin

1. Finance opens an order → the refund composer exceeds the threshold → the
   UI routes through two-person authorization: initiate
   `POST /admin/two-person-approvals` `{actionType: large_refund, targetType,
   targetId, reason, payload}` → 201 `pending`; queue row shows `requestedBy`.
2. The **same** actor opens the approval → decision buttons are hidden; a
   forged `POST /admin/two-person-approvals/{id}/decision` returns 409
   `APPROVAL_SAME_ACTOR` inline.
3. A second admin (Platform Administrator) opens the approval → `{decision:
   approve, comment}` → 200 `approved` → the refund executes server-side
   (webhook-driven status); `two_person_approval.*` audit pair (initiate +
   decide with both actors, comment, before/after status) renders on the
   entity timeline.
4. Rejection variant: second admin `{decision: reject, comment}` → status
   `rejected`, nothing executes, initiator notified.
5. Re-decision on a decided approval → 409 `APPROVAL_ALREADY_DECIDED`; unknown
   approval → 404 `APPROVAL_NOT_FOUND`.
6. Dangerous action attempted without the flow → 409 `TWO_PERSON_REQUIRED`
   (e.g. a second `change_commission` attempt without a pending approval);
   missing reason on initiate → `ADMIN_REASON_REQUIRED`; role without the
   underlying permission → 403 `FORBIDDEN`.

### C3 — Risk case block_user

1. Risk dashboard (module 34) renders the severity × status matrix; a
   `critical`/`open` case sorts first.
2. Open the case (`GET /admin/risk/cases`) → `signals[]` chips, `severity`
   pill, `related` panel (`customerUserId`, `providerId`, `riderId`,
   `orderIds[]`, `deviceIds[]`, `ipHistory[]`) — each link opens the universal
   entity view.
3. Investigate: walk the linked orders/payments/devices; set status →
   `investigating` with a note.
4. Decide: `POST /admin/risk/cases/{id}/review` `{action: block_user, reason}`
   (reason required, `ADMIN_REASON_REQUIRED` when missing) → customer
   suspended, case `resolved` + `decidedAction: block_user`,
   `risk_case.*` audit entry with actor/action/reason/before-after status; the
   block also surfaces on the customer's timeline.
5. Variants: `dismiss` with reason → `dismissed` (no entity changes);
   `escalate` → routed to ops manager; `hold` → case stays open with a hold
   note.
6. Already-decided case → 409 `RISK_CASE_ALREADY_DECIDED`; unknown → 404
   `RISK_CASE_NOT_FOUND`; role without `risk.block` sees block actions hidden,
   API 403 `FORBIDDEN`.

### C4 — Hub dashboard load

1. Hubs module (33) lists hubs (`GET /hubs`); a hub row opens the dashboard.
2. `GET /admin/hubs/{hubId}/dashboard` → `load` cards render: `incoming`,
   `outgoing`, `awaitingSort`, `exceptions` (links to module 26/27),
   `capacityPct` gauge.
3. `sortationQueues[]` per-zone table renders (`zone`, `count`); `staffOnDuty`
   and `vehiclesPresent` cards render; `updatedAt` snapshot shown.
4. `capacityPct` > 100 → capacity warning + control-tower
   `hubCapacityWarnings` link asserted (C5 interplay).
5. `HUB_NOT_FOUND` (404) → empty variant; `HUB_DASHBOARD_UNAVAILABLE` → empty
   state + retry; unauthorized role → module hidden, API 403 `FORBIDDEN`.

### C5 — Operations control tower alerts

1. `GET /admin/control-tower` → `totals` renders the 8 stat cards
   (`ordersToday`, `activeDeliveries`, `activeServiceJobs`, `providersOnline`,
   `ridersOnline`, `openIncidents`, `delayedShipments`, `pendingDisputes`).
2. `networkHealth` renders the two stacked bars: `deliveryNetwork`
   (`normalPct`/`delayedPct`/`criticalPct`) and `serviceNetwork`
   (`normalPct`/`capacityIssuePct`/`criticalPct`) with legend; `generatedAt`
   shown.
3. `criticalActions` renders the six counts (`shipmentExceptions`,
   `providerIncidents`, `paymentFailures`, `fraudCases`, `slaBreaches`,
   `hubCapacityWarnings`); each count deep-links: `fraudCases` → risk
   dashboard, `hubCapacityWarnings` → hub list, `slaBreaches` → SLA queue.
4. 5xx response → empty state + retry; unauthorized role (e.g. content
   manager) → module hidden, API 403 `FORBIDDEN`.
5. Alert-response drill: one count (e.g. `shipmentExceptions`) is worked via
   workflow 33.1 and the queue clears.

### C6 — Integration health degraded

1. `GET /admin/integrations` → registry table renders provider, `category`
   chip (9 values: `payment`/`maps`/`sms`/`email`/`pos`/`logistics`/`erp`/
   `crm`/`webhooks`), `health` pill (`healthy`/`degraded`/`down`),
   `lastCheckedAt`, `error`.
2. A `degraded` payment row renders amber with the error hint; category filter
   chips round-trip.
3. `down` variant fires the integration-failure alert (push critical) and the
   payment-category `down` routes follow-up to technical operations;
   `INTEGRATION_HEALTH_UNAVAILABLE` → empty state + retry.
4. Unauthorized role → module hidden, API 403 `FORBIDDEN`.

### C7 — Feature flag rollout to a region only

1. Configuration center → feature flags (`GET /admin/features`) → flag rows
   render `key`, `enabled`, `rolloutPct`, `betaOnly`, `targeting` summary.
2. Edit a flag: `enabled: true`, `rolloutPct: 1`, `targeting {regions:
   ["Dar es Salaam"]}` via `PATCH /admin/features` → 200 `AdminFeatureFlag`.
3. Client-resolution mock: `GET /experiments` returns the flag enabled only
   for the targeted region and disabled elsewhere; city/segment/userPct
   targeting variants assert the same (cities filter by uuid).
4. The audit entry (`feature.*`) renders the targeting diff (before/after
   countries/regions/cities/segments/userPct) and `updatedBy`;
   `FEATURE_KEY_EXISTS` inline; unauthorized role → API 403.

## CI gate

```text
vitest run   ->   msW parity suite   ->   playwright (staging)
```

Secrets only in CI environment; never in repo.
