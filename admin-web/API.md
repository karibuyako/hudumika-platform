# HUDumika Admin Web — API Surface

All endpoints come from `backend/API-CONTRACT.yaml`. The admin web only calls `/admin/*` endpoints; public endpoints are never used by staff tools.

| Feature | Endpoint | Notes |
| --- | --- | --- |
| Overview | `GET /admin/overview` | Metrics + queues for the dashboard |
| Merchants | `GET /admin/merchants?status=&cursor=` | Verification-state filter |
| Merchant decision | `POST /admin/merchants/{merchantId}/approval` | approved/rejected/changes_requested + reason + commission |
| Providers | `GET /admin/providers` | Verification-state filter |
| Riders | `GET /admin/riders` | Onboarding-state filter |
| Orders | `GET /admin/orders` | Search across customers |
| Bookings | `GET /admin/bookings` | Search across customers |
| Payouts | `GET /admin/payouts` | Batches + exceptions |
| Review moderation | `POST /admin/reviews/moderate` | publish/hide/delete + reason |
| Support queue | `GET /admin/support/tickets` | Track/status/priority filters |
| Ticket assignment | `POST /admin/support/tickets/{ticketId}/assign` | Assign agent |
| Audit logs | `GET /admin/audit-logs` | Filters: actor, entity, range; compliance-gated |
| Cities | `POST /admin/cities` | Upsert city + service areas |
| Promotion queue | `GET /admin/promotions?state=` | `state`: pending_review/live/paused/rejected/ended |
| Promotion decision | `POST /admin/promotions/{promotionId}/decision` | approved/rejected/paused + reason (max 1000); audit entry |
| Group buy queue | `GET /admin/group-buys?state=` | `GroupBuyStatus` filter |
| Group buy decision | `POST /admin/group-buys/{groupId}/decision` | approved/rejected/delisted + reason (max 1000); audit entry |
| Voucher verification | `POST /admin/vouchers/verify` | Body `{voucherCode}`; staff dispute verification; returns `Voucher` |
| Conversation search | `GET /admin/conversations?merchantId=&status=&cursor=` | Read-only oversight; `status` `open`/`archived`/`blocked`; rows are `ConversationDetail` |
| Block conversation | `POST /conversations/{conversationId}/block` | Staff-only moderation; body `{reason}` required (max 500); notify `conversation.blocked`; audit entry; 403 `FORBIDDEN` without permission |
| Enterprise chains | `GET /admin/chain` | `ChainAccountAdmin` list: tier `standard`/`enterprise`, status `active`/`suspended`, `storesCount`, `monthlyVolumeTZS` |
| Webhook health | `GET /admin/webhooks?failingOnly=` | `WebhookDelivery` list; `failingOnly` boolean, default `false` |
| Data export queue | `GET /admin/data-exports` | `DataExportJob` list: scope/format/status queue |
| Manual rider assignment | `POST /admin/orders/{orderId}/assign-rider` | Body `{riderId, reason}` (reason max 500); override for VIP/complex cases; `ASSIGN_RIDER_UNAVAILABLE` when target offline/out of zone; staff-only (ops manager + rider ops) |
| Rider COD reconciliation | `GET /admin/riders/{riderId}/cod?from=&to=` | `RiderCodReconciliation`: per-shift `expectedTZS` vs `collectedTZS`, status `reconciled`/`pending`/`mismatch`, totals `varianceTZS`; rider ops + finance |
| Fleet control tower | `GET /admin/fleet/control-tower?hubId=&fleetType=` | `FleetOverview`: `totals {activeRiders, onlineRiders, activeOrders, inTransit, anomalies, openSos}`, `byFleetType[]` (`captive`/`contracted`/`outsourced`/`hybrid` × count), `hubs[]` (`hubId`, `name`, `region`, `activeRiders`, `activeOrders`, `anomalies`); filters `hubId`/`fleetType`; `CONTROL_TOWER_UNAVAILABLE` → empty state + retry; ops manager + rider ops + super admin |
| Hubs | `GET /hubs` · `POST /hubs` | Hub list (authenticated staff) / create-update (admin); `Hub` `{id, name, cityId, address, capacity?, active}`; `HUB_NOT_FOUND` (404), `HUB_FULL` (409); mutations require a reason and write `hub.*` audit entries |
| Consignments | `GET /linehaul/consignments?status=` | `Consignment[]` — corridor (`fromHubId`/`toHubId`), `transportMode` (`van`/`linehaul_bus`/`linehaul_truck`), `carrierId`, `orderCount`, manifest (per-order `waybillNumber` + `section`), status `manifesting`/`in_transit`/`at_hub`/`delivered`/`cancelled`; `CONSIGNMENT_NOT_FOUND` (404) |
| Logistics control tower | `GET /admin/logistics/control-tower` | `ControlTower` — `totals {activeShipments, delayed, exceptions, atRisk, activeTrips}`, `tripsByHub[]` (`hubName`, `trips`), `criticalExceptions[]` (`wrong_hub_scan`/`vehicle_delayed`/`package_missing`/`rider_no_show`/`seal_broken`/`reconciliation_failed` with `shipmentId` + `detail`); `CONTROL_TOWER_UNAVAILABLE` → empty state + retry; ops manager + logistics operations + super admin |
| Delivery exceptions | `GET /delivery-exceptions?kind=&status=` | `DeliveryException[]` — 18-kind catalog, status `open`/`resolving`/`resolved`/`escalated`, `autoReplanned` badge, `outcome`, `resolvedAt`; drives modules 26/27 queue |
| Delivery exception detail/update | `GET /delivery-exceptions/{exceptionId}` · `PATCH /delivery-exceptions/{exceptionId}` | Detail; PATCH `{status, outcome?}` (status required) — `EXCEPTION_NOT_FOUND` (404), `EXCEPTION_ALREADY_RESOLVED` (409); resolution runbook (workflow 25), audit `exception.*` |
| Warehouses | `GET /warehouses` · `POST /warehouses` | `Warehouse[]` / 201 `Warehouse` — registry for pre-positioned inventory; filters `cityId`/`status` (`active`/`full`/`maintenance`); `WAREHOUSE_NOT_FOUND` (404) |
| Warehouse detail/update | `GET /warehouses/{warehouseId}` · `PATCH /warehouses/{warehouseId}` | detail incl. `stock[]` `{catalogueItemId, quantity}`; PATCH any field incl. `servingCities`/`status`, reason required, audit `warehouse.*` |
| Warehouse stock | `PUT /warehouses/{warehouseId}/stock` | `{items: [{catalogueItemId, delta}]}` signed deltas (bulk inbound / write-off); `INVENTORY_NEGATIVE_STOCK` guard; audit `warehouse.*` |
| Warehouse fulfill | `POST /warehouses/{warehouseId}/fulfill` | `{orderId}` — server-driven nearest-warehouse fulfillment (order tag); admin-web renders routing state, never calls on behalf of customer orders; `WAREHOUSE_STOCK_UNAVAILABLE` / `WAREHOUSE_OUT_OF_SERVICE` (409) |
| Carriers | `GET /carriers` · `POST /carriers` | `Carrier[]` / 201 — registry; `modes[]` (`van`/`linehaul_bus`/`linehaul_truck`/`refrigerated_truck`/`train`/`air`), `regions[]`, `apiIntegration`; `CARRIER_NOT_FOUND` (404) |
| Carrier update | `PATCH /carriers/{carrierId}` | status/config changes (`active`/`paused`/`suspended`), reason required, audit `carrier.*`; `CARRIER_UNAVAILABLE` (409 — region/mode not served) |
| Facilities | `GET /facilities` · `POST /facilities` | `Facility[]` / 201 — gated communities/business parks; `geofence[]` (`"lon,lat"`), `accessPolicy` (`whitelist_only`/`whitelist_or_otp`/`open`); `FACILITY_NOT_FOUND` (404) |
| Facility whitelist | `PUT /facilities/{facilityId}/whitelist` | `{riderIds: uuid[]}` full replacement; grant/revoke notifications (`facility.whitelist_granted`/`facility.whitelist_revoked`); reason required, audit `facility.*`; `FACILITY_WHITELIST_EXISTS` (409) |
| Fleet accounts | `GET /fleet/accounts` · `POST /fleet/accounts` | `FleetAccount[]` / 201 — master accounts; `driverSubAccountIds[]`, `vehicles[]`, `regions[]`, `permissions`; `FLEET_ACCOUNT_NOT_FOUND` (404) |
| Fleet account update | `PATCH /fleet/accounts/{fleetAccountId}` | sub-account permissions, vehicles, regions, status (`active`/`suspended`); reason required, audit `fleet.*`; `FLEET_ACCOUNT_SUSPENDED` (409) |
| Active reassignment | `POST /admin/shipments/{shipmentId}/reassign` | `{reason (required, max 500), riderId?, tripId?}` — dispatcher moves a shipment mid-flight; `SHIPMENT_NOT_REASSIGNABLE` (status gate, 409); 403 `FORBIDDEN`; audit `shipment.*`; rider receives a new assignment event |
| Escalation | `POST /admin/shipments/{shipmentId}/escalate` | `{reason (required, max 500)}` — incident/safety escalation; `SHIPMENT_NOT_ESCALATABLE` (status gate, 409); 403 `FORBIDDEN`; `exception.escalated` critical push to ops manager |
| Global entity search | `GET /admin/search?q=&entityTypes=&limit=` | Global search across `order`/`shipment`/`customer`/`provider`/`rider`/`merchant`/`booking`/`hub`/`vehicle`/`ticket`/`conversation`; `q` max 200; entity ID prefixes (`ORD-`, `SHP-`, `CUS-`, `PRV-`, `RDR-`, `MRC-`, `JOB-`); rows `{entityType, id, label, status?, region?, updatedAt?}`; `ADMIN_SEARCH_INVALID` (422) on malformed queries; ABAC-scoped |
| Two-person approvals — list | `GET /admin/two-person-approvals?status=` | `AdminTwoPersonApproval[]`; `status` filter `pending`/`approved`/`rejected` |
| Two-person approvals — initiate | `POST /admin/two-person-approvals` | `{actionType, targetType, targetId, reason (max 1000), payload?}` — `actionType` enum `large_refund`/`change_commission`/`suspend_major_merchant`/`change_payment_settings`/`modify_ledger`/`change_iam_policy`/`delete_critical_data`/`release_hold`; 201 `AdminTwoPersonApproval` |
| Two-person approvals — decision | `POST /admin/two-person-approvals/{approvalId}/decision` | `{decision: approve|reject, comment (max 1000)}` — second admin decides; executes on approval; `APPROVAL_NOT_FOUND` (404), `APPROVAL_ALREADY_DECIDED` (409), `APPROVAL_SAME_ACTOR` (409 — requester cannot decide); `TWO_PERSON_REQUIRED` (409 — dangerous action without the flow); audit `two_person_approval.*` |
| Hub dashboard | `GET /admin/hubs/{hubId}/dashboard` | `HubDashboard` — `load {incoming, outgoing, awaitingSort, exceptions, capacityPct}`, `sortationQueues[]` (`zone`, `count`), `staffOnDuty`, `vehiclesPresent`, `updatedAt`; `HUB_NOT_FOUND` (404), `HUB_DASHBOARD_UNAVAILABLE` → empty state + retry |
| Operations control tower | `GET /admin/control-tower` | `OperationsControlTower` — `totals {ordersToday, activeDeliveries, activeServiceJobs, providersOnline, ridersOnline, openIncidents, delayedShipments, pendingDisputes}`, `networkHealth {deliveryNetwork {normalPct, delayedPct, criticalPct}, serviceNetwork {normalPct, capacityIssuePct, criticalPct}}`, `criticalActions {shipmentExceptions, providerIncidents, paymentFailures, fraudCases, slaBreaches, hubCapacityWarnings}`; `generatedAt`; 403 `FORBIDDEN` |
| Risk cases — list | `GET /admin/risk/cases?status=&severity=` | `RiskCase[]`; `status` `open`/`investigating`/`resolved`/`dismissed`; `severity` `low`/`medium`/`high`/`critical` |
| Risk cases — review | `POST /admin/risk/cases/{caseId}/review` | `{action, reason (max 1000)}` — `action` `dismiss`/`block_user`/`block_provider`/`escalate`/`hold`; `RISK_CASE_NOT_FOUND` (404), `RISK_CASE_ALREADY_DECIDED` (409), 403 `FORBIDDEN`; audit `risk_case.*` |
| Integration health | `GET /admin/integrations` | Registry rows `{provider, category, health, lastCheckedAt, error?}`; `category` `payment`/`maps`/`sms`/`email`/`pos`/`logistics`/`erp`/`crm`/`webhooks`; `health` `healthy`/`degraded`/`down`; `INTEGRATION_HEALTH_UNAVAILABLE` → empty state + retry |
| Analytics scopes (extended) | `GET /admin/analytics/{scope}` | scope enum extended: `revenue`, `orders`, `growth`, `retention`, `fleet`, `operations`, `gmv`, `take_rate`, `quality`; `from`/`to`/`groupBy` (`day`/`week`/`month`/`category`/`region`) |
| Feature flags | `GET /admin/features` · `PATCH /admin/features` | `AdminFeatureFlag {key (max 80), enabled, rolloutPct (0–1), betaOnly, targeting?}` — **targeting**: `countries[]`, `regions[]`, `cities[]` (uuid), `segments[]` (uuid), `userPct` (0–1) — country/region/city/segment/percentage rollout; clients read `GET /experiments`; `FEATURE_KEY_EXISTS`; changes audited |

### `GET /admin/logistics/control-tower` — full reference

- Purpose: logistics control tower — network health, exceptions, at-risk.
- Security: staff session with `mfa_verified`; roles ops manager, logistics operations, super admin; 403 `FORBIDDEN` without permission.
- Response 200 `ControlTower`:

```json
{
  "generatedAt": "2026-08-13T09:00:00Z",
  "totals": {
    "activeShipments": 1240,
    "delayed": 23,
    "exceptions": 6,
    "atRisk": 41,
    "activeTrips": 18
  },
  "tripsByHub": [
    { "hubName": "Dar es Salaam Hub", "trips": 7 },
    { "hubName": "Mwanza Hub", "trips": 5 }
  ],
  "criticalExceptions": [
    { "shipmentId": "SH-2026-000091829", "type": "package_missing",
      "detail": "Expected 2, scanned 1" }
  ]
}
```

- `criticalExceptions[].type` enum (exact): `wrong_hub_scan`, `vehicle_delayed`,
  `package_missing`, `rider_no_show`, `seal_broken`, `reconciliation_failed`.
- Error: 403 `FORBIDDEN`; 5xx/`CONTROL_TOWER_UNAVAILABLE` → empty state + retry.
- Module: 26; workflow links 23–24; every view audited (`shipment.*`, `trip.*`).

### Delivery exceptions — full reference

- Purpose: the 18-kind delivery-exceptions catalog with lifecycle
  (`open → resolving → resolved | escalated`) and `autoReplanned` flag.
  Rider-callable too; admin sees the full queue (modules 26/27).
- `GET /delivery-exceptions?kind=&status=` → `DeliveryException[]`; filters:
  `kind` (18 values), `status` (`open`/`resolving`/`resolved`/`escalated`).
- `POST /delivery-exceptions` — report (body: `DeliveryException` shape; `kind`
  + `description` max 1000 required) → 201.
- `GET /delivery-exceptions/{exceptionId}` → detail; `EXCEPTION_NOT_FOUND`
  (404).
- `PATCH /delivery-exceptions/{exceptionId}` `{status, outcome?}` — status
  required; `outcome` max 1000; `EXCEPTION_ALREADY_RESOLVED` (409) on
  resolved/escalated re-opens; resolution requires a reason-carrying outcome per
  workflow 25; audit `exception.*`.
- `DeliveryExceptionKind` (exact): `missing_package`, `wrong_package`,
  `wrong_hub`, `wrong_vehicle`, `scan_failure`, `damaged_package`,
  `late_vehicle`, `vehicle_breakdown`, `rider_unavailable`, `bus_cancellation`,
  `hub_congestion`, `weather_disruption`, `road_closure`,
  `customer_unavailable`, `package_refused`, `route_deviation`,
  `security_incident`, `reconciliation_failure`.
- Notifications: `exception.created` / `exception.resolved` (ops + affected
  parties), `exception.escalated` (critical, ops manager).

### Warehouses — full reference

- Purpose: regional/shared warehouses for pre-positioned inventory
  (next-day/day-after fulfillment).
- `GET /warehouses` → `Warehouse[]` — `{id, name, cityId, address, lat?, lon?,
  servingCities[], stock[] ({catalogueItemId, quantity}), status
  (active|full|maintenance), createdAt}`.
- `POST /warehouses` — create (name + cityId required) → 201; reason required,
  audit `warehouse.*`.
- `GET /warehouses/{warehouseId}` → detail incl. `stock[]`; `WAREHOUSE_NOT_FOUND`
  (404).
- `PATCH /warehouses/{warehouseId}` — update (serving cities, status, address,
  coords); reason required, audit `warehouse.*`.
- `PUT /warehouses/{warehouseId}/stock` `{items: [{catalogueItemId, delta}]}` —
  signed deltas (bulk inbound / write-off); `INVENTORY_NEGATIVE_STOCK` (409)
  when below zero; audit `warehouse.*`.
- `POST /warehouses/{warehouseId}/fulfill` `{orderId}` — nearest-warehouse
  fulfillment (order tag; server-driven); `WAREHOUSE_STOCK_UNAVAILABLE` (409),
  `WAREHOUSE_OUT_OF_SERVICE` (409, `maintenance`/`full`), `WAREHOUSE_NOT_FOUND`
  (404). Admin-web renders routing state only.
- Notifications: `warehouse.fulfilled` (customer), `warehouse.stock_low`
  (merchant + ops).

### Carriers — full reference

- Purpose: third-party line-haul registry (SF-style integrations).
- `GET /carriers` → `Carrier[]` — `{id, name, modes[] (van|linehaul_bus|
  linehaul_truck|refrigerated_truck|train|air), regions[], apiIntegration?,
  status (active|paused|suspended), createdAt}`.
- `POST /carriers` — register (name + modes required) → 201; reason required,
  audit `carrier.*`.
- `PATCH /carriers/{carrierId}` — status/config; `paused` stops new handoffs,
  `suspended` blocks all operations; `CARRIER_UNAVAILABLE` (409 — region/mode
  not served); `CARRIER_NOT_FOUND` (404); audit `carrier.*`.
- Handoff surface: consignments with `Consignment.carrierId` set; `carrier.handoff_required`
  (push + in-app); carrier custody entries (`actorType: carrier`).

### Facilities — full reference

- Purpose: gated communities/business parks with fixed-rider credential access.
- `GET /facilities` → `Facility[]` — `{id, name, address, geofence[]
  ("lon,lat"), whitelistRiderIds[], accessPolicy (whitelist_only|
  whitelist_or_otp|open), createdAt}`.
- `POST /facilities` — register (name + address required) → 201; audit
  `facility.*`.
- `PUT /facilities/{facilityId}/whitelist` `{riderIds: uuid[]}` — full
  replacement list; grant/revoke notifications fire; reason required, audit
  `facility.*`; `FACILITY_WHITELIST_EXISTS` (409); `FACILITY_NOT_FOUND` (404).
- Entry enforcement: geofenced scans; `NOT_WHITELISTED` (403) blocks
  non-whitelisted riders at the gate.

### Fleet accounts — full reference

- Purpose: fleet master accounts with driver sub-accounts (one master, many
  drivers via `RiderPrivate.fleetAccountId`).
- `GET /fleet/accounts` → `FleetAccount[]` — `{id, name, ownerUserId,
  driverSubAccountIds[], vehicles[], regions[], permissions (map), status
  (active|suspended), createdAt}`.
- `POST /fleet/accounts` — create (name required) → 201; reason required, audit
  `fleet.*`.
- `PATCH /fleet/accounts/{fleetAccountId}` — permissions/vehicles/regions/
  status; `FLEET_ACCOUNT_SUSPENDED` (409) on suspended-master operations;
  `FLEET_ACCOUNT_NOT_FOUND` (404); audit `fleet.*`.
- Driver linkage: `serviceModel: fleet` + `fleetAccountId` are rider-record
  mutations (rider ops, audited `rider.*` / `fleet.*`).

### Active reassignment and escalation — full reference

- `POST /admin/shipments/{shipmentId}/reassign` `{reason (required, max 500),
  riderId?, tripId?}` → 200 `Shipment` — dispatcher moves a shipment to another
  rider or trip mid-flight; `SHIPMENT_NOT_REASSIGNABLE` (409 — status gate);
  403 `FORBIDDEN`; audit `shipment.*`; the rider receives a new assignment event
  (workflow 24).
- `POST /admin/shipments/{shipmentId}/escalate` `{reason (required, max 500)}`
  → 200 `Shipment` — incident/safety escalation; `SHIPMENT_NOT_ESCALATABLE`
  (409 — status gate); 403 `FORBIDDEN`; `exception.escalated` critical push to
  ops manager (workflow 25).

### Global search — full reference

- `GET /admin/search?q=&entityTypes=&limit=` → array of search rows.
- `q` (required, max 200): free text, natural-language operational terms, or
  entity ID prefixes — `ORD-` (orders), `SHP-` (shipments), `CUS-`
  (customers), `PRV-` (providers), `RDR-` (riders), `MRC-` (merchants),
  `JOB-` (service jobs/bookings).
- `entityTypes` (repeatable): `order` / `shipment` / `customer` / `provider` /
  `rider` / `merchant` / `booking` / `hub` / `vehicle` / `ticket` /
  `conversation`.
- `limit` (default 20).
- Row shape: `{entityType, id, label, status?, region?, updatedAt?}`; click
  through to the universal entity view.
- ABAC-scoped: an admin only sees entity types they can `read`; results never
  leak entities outside the session's region/tenant scope.
- Errors: `ADMIN_SEARCH_INVALID` (422 — malformed query), 403 `FORBIDDEN`
  without search permission.
- Entry points: top-bar search, command palette (Ctrl/Cmd+K), overview
  quick-search.

### Two-person approvals — full reference

- `GET /admin/two-person-approvals?status=` → `AdminTwoPersonApproval[]`;
  `status` filter `pending`/`approved`/`rejected`.
- `POST /admin/two-person-approvals` — initiate: `{actionType, targetType,
  targetId, reason (max 1000), payload?}` → 201.
  - `actionType` enum (exact): `large_refund`, `change_commission`,
    `suspend_major_merchant`, `change_payment_settings`, `modify_ledger`,
    `change_iam_policy`, `delete_critical_data`, `release_hold`.
- `POST /admin/two-person-approvals/{approvalId}/decision` — decide:
  `{decision: approve|reject, comment (max 1000)}` → 200; the action executes
  on approval, nothing on rejection.
- `AdminTwoPersonApproval` schema: `{id, actionType, targetType, targetId,
  reason, payload?, status (pending|approved|rejected), requestedBy,
  decidedBy?, decisionComment?, createdAt, decidedAt?}`.
- Errors: `APPROVAL_NOT_FOUND` (404), `APPROVAL_ALREADY_DECIDED` (409 —
  terminal states), `APPROVAL_SAME_ACTOR` (409 — requester cannot decide),
  `TWO_PERSON_REQUIRED` (409 — dangerous action attempted without the flow),
  403 `FORBIDDEN`.
- Audit: `two_person_approval.*` (initiate, approve, reject with actor pair,
  before/after status).
- Module: two-person approvals; workflow 31.

### Hub dashboard — full reference

- `GET /admin/hubs/{hubId}/dashboard` → `HubDashboard`:
  `{hubId, name, load {incoming, outgoing, awaitingSort, exceptions,
  capacityPct}, sortationQueues[] {zone, count}, staffOnDuty,
  vehiclesPresent, updatedAt}`.
- `capacityPct` > 100 feeds the control tower's `hubCapacityWarnings`.
- Errors: `HUB_NOT_FOUND` (404), `HUB_DASHBOARD_UNAVAILABLE` → empty state +
  retry, 403 `FORBIDDEN`.
- Module: 33; roles: ops manager, dispatch manager, regional ops manager,
  logistics operations (view-only).

### Operations control tower — full reference

- `GET /admin/control-tower` → `OperationsControlTower`:
  `{generatedAt, totals {ordersToday, activeDeliveries, activeServiceJobs,
  providersOnline, ridersOnline, openIncidents, delayedShipments,
  pendingDisputes}, networkHealth {deliveryNetwork {normalPct, delayedPct,
  criticalPct}, serviceNetwork {normalPct, capacityIssuePct, criticalPct}},
  criticalActions {shipmentExceptions, providerIncidents, paymentFailures,
  fraudCases, slaBreaches, hubCapacityWarnings}}`.
- Each `criticalActions` count is a deep link to the owning queue.
- Errors: 403 `FORBIDDEN`; 5xx degrades to empty state + retry.
- Module: 26 (platform control tower); workflow 33; roles: ops manager,
  dispatch manager, regional ops manager, risk & fraud, trust & safety,
  super admin (view-only).

### Risk cases — full reference

- `GET /admin/risk/cases?status=&severity=` → `RiskCase[]`; `status`
  `open`/`investigating`/`resolved`/`dismissed`; `severity`
  `low`/`medium`/`high`/`critical`.
- `RiskCase` schema: `{id, severity, signals[], related {customerUserId?,
  providerId?, riderId?, orderIds[], deviceIds[], ipHistory[]}, status,
  decidedAction?, reason?, createdBy, createdAt}`.
- `signals[]` examples: `multiple_accounts`, `refund_ratio`,
  `refund_velocity`, `large_refund`, `withdrawal_anomaly`, `login_risk`,
  `unusual_order_pattern`, `order_delay`, `rider_inactivity`,
  `suspicious_cancellation`, `gps_spoof`, `rapid_decline`,
  `impossible_speed`, `multi_device`, `payment_abuse`.
- `POST /admin/risk/cases/{caseId}/review` — `{action, reason (max 1000)}`;
  `action` enum (exact): `dismiss`, `block_user`, `block_provider`,
  `escalate`, `hold`. `block_user`/`block_provider` require `risk.block`.
- Errors: `RISK_CASE_NOT_FOUND` (404), `RISK_CASE_ALREADY_DECIDED` (409),
  403 `FORBIDDEN`; missing reason → `ADMIN_REASON_REQUIRED`.
- Audit: `risk_case.*` per decision (actor, action, reason, before/after
  status, decidedAction).
- Module: 34; workflow 32.

### Integration health — full reference

- `GET /admin/integrations` → registry rows `{provider, category, health,
  lastCheckedAt, error?}`.
- `category` enum (exact): `payment`, `maps`, `sms`, `email`, `pos`,
  `logistics`, `erp`, `crm`, `webhooks`.
- `health` enum (exact): `healthy`, `degraded`, `down`.
- Errors: `INTEGRATION_HEALTH_UNAVAILABLE` → empty state + retry, 403
  `FORBIDDEN`.
- Module: 35; roles: technical operations, ops manager, super admin
  (view-only); payments role sees the `payment` category in detail.

### Analytics scopes and feature flag targeting — full reference

- `GET /admin/analytics/{scope}` scope enum (exact): `revenue`, `orders`,
  `growth`, `retention`, `fleet`, `operations`, `gmv`, `take_rate`,
  `quality`; `from`/`to` (date) and `groupBy`
  (`day`/`week`/`month`/`category`/`region`); 403 `FORBIDDEN`;
  `ADMIN_ANALYTICS_UNAVAILABLE` on failure.
- `GET /admin/features` → `AdminFeatureFlag[]`; `PATCH /admin/features` —
  `{key (max 80), enabled, rolloutPct (0–1, default 1), betaOnly (default
  false), targeting?}`.
- `targeting` (nullable): `countries[]`, `regions[]`, `cities[]` (uuid),
  `segments[]` (uuid), `userPct` (0–1) — country/region/city/segment/
  percentage rollout; clients read the resolved state via `GET /experiments`.
- Errors: `FEATURE_KEY_EXISTS`, 403 `FORBIDDEN`; changes audited
  (`configuration.*` / `feature.*`).

## Logistics network oversight (staff-scoped, read-only in admin-web)

Non-`/admin` but staff-scoped endpoints admin-web may call (all read-only in this
console; write actions stay rider/hub-scoped):

| Endpoint | Purpose | Admin usage |
| --- | --- | --- |
| `GET /shipments?status=` | shipments list (all statuses) | module 26 drill-in; status filter |
| `GET /shipments/{shipmentId}` | shipment detail + packages | module 27 shipment context |
| `GET /shipments/{shipmentId}/custody` | custody chain | module 27 "where at 15:00?" queries, damage/loss attribution |
| `GET /trips?status=` / `GET /trips/{tripId}` | trips + manifest summary | module 26 trip drill-in; **advance actions remain driver-scoped** (`PATCH /trips/{tripId}` is never called by admin-web) |
| `GET /vehicles` | vehicle registry + compartment capacity | module 26 fleet context; `PATCH /vehicles/{vehicleId}` is admin/fleet-owner only, never from admin-web |
| `GET /routes` | route corridors | corridor context for replan decisions |
| `POST /linehaul/consignments/{consignmentId}/reconcile` | reconciliation runbook execution | workflow 23 re-run after locating missing packages |
| `GET /orders/{orderId}/route` / `GET /orders/{orderId}/waybill` | per-order legs + waybill trail | module 25, via existing order access (module 8) |

Write actions (`POST /shipments`, `POST /containers`, `POST /vehicles`,
`POST /routes`, `POST /trips`, `PATCH /trips`, `/replan`) are rider/hub/
dispatch-scoped and **never called by admin-web**; replan decisions are approved
via workflow 23 in the reconciliation module (the approval is an ops decision
recorded in audit; the physical replan call is executed by dispatch on the rider
side).

Waybill and route views: staff can read any order's `GET /orders/{orderId}/route` and `GET /orders/{orderId}/waybill` through the existing order access (module 8) — there is no separate admin endpoint; module 25 (Waybill & custody audit) renders those views read-only.

## Auth flow for staff

1. `POST /auth/request-otp` (phone/email) — purpose `login`.
2. `POST /auth/verify-otp` → session **without** MFA claim.
3. Staff MFA step (TOTP/SMS) → `mfa_verified` claim on the session.
4. All subsequent calls use the bearer token; refresh via `POST /auth/refresh`.

Staff sessions carry the `mfa_verified` claim (contract `staffSession` security scheme); admin endpoints reject sessions without it (`FORBIDDEN` / `ADMIN_ACTION_FORBIDDEN`). Roles are enforced server-side on every route; the UI only hides actions the role cannot perform.

## Conventions

- Every list: cursor pagination (`limit`, `cursor`), server filters.
- Every mutation on the matrix (money/status/moderation) requires a `reason`.
- Error handling switches on stable codes from `backend/ERROR-CODES.md` (`FORBIDDEN`, `ADMIN_ACTION_FORBIDDEN`, `ADMIN_REASON_REQUIRED`, `PROMOTION_STATUS_CONFLICT`, `GROUP_BUY_STATUS_CONFLICT`, `VOUCHER_INVALID_CODE`, `CONVERSATION_NOT_FOUND`, `CONVERSATION_BLOCKED`, `ASSIGN_RIDER_UNAVAILABLE`, `COD_RECONCILIATION_UNAVAILABLE`, `CONTROL_TOWER_UNAVAILABLE`, `REST_ENFORCED`, `WAREHOUSE_NOT_FOUND`, `WAREHOUSE_STOCK_UNAVAILABLE`, `WAREHOUSE_OUT_OF_SERVICE`, `CARRIER_NOT_FOUND`, `CARRIER_UNAVAILABLE`, `FACILITY_NOT_FOUND`, `NOT_WHITELISTED`, `FACILITY_WHITELIST_EXISTS`, `FLEET_ACCOUNT_NOT_FOUND`, `FLEET_ACCOUNT_SUSPENDED`, `EXCEPTION_NOT_FOUND`, `EXCEPTION_ALREADY_RESOLVED`, `CAPACITY_WEIGHT_EXCEEDED`, `CAPACITY_VOLUME_EXCEEDED`, `DISPATCH_STRATEGY_INVALID`, `SERVICE_MODEL_INVALID`, `SHIPMENT_NOT_REASSIGNABLE`, `SHIPMENT_NOT_ESCALATABLE`, `ADMIN_SEARCH_INVALID`, `APPROVAL_NOT_FOUND`, `APPROVAL_ALREADY_DECIDED`, `TWO_PERSON_REQUIRED`, `APPROVAL_SAME_ACTOR`, `HUB_DASHBOARD_UNAVAILABLE`, `RISK_CASE_NOT_FOUND`, `RISK_CASE_ALREADY_DECIDED`, `INTEGRATION_HEALTH_UNAVAILABLE`, etc.).
- Response shapes match the contract schemas (`MerchantAdmin`, `ProviderAdmin`, `RiderAdmin`, `PayoutBatch`, `AuditLog`, `TicketDetail`, `AdminOverview`, `Promotion`, `GroupBuyDeal`, `Voucher`, `ConversationDetail`, `ChatMessage`, `ChainAccountAdmin`, `WebhookDelivery`, `DataExportJob`, `RiderCodReconciliation`, `FleetOverview`, `Warehouse`, `Carrier`, `Facility`, `FleetAccount`, `DeliveryException`, `AdminTwoPersonApproval`, `HubDashboard`, `OperationsControlTower`, `RiskCase`, `AdminFeatureFlag`).
- Deep-logistics registries (`/warehouses`, `/carriers`, `/facilities`,
  `/fleet/accounts`, `/delivery-exceptions`, `/admin/shipments/{id}/reassign` +
  `/escalate`) are admin-tagged in the contract and callable from admin-web with
  the role gates in ROLES-PERMISSIONS.md; `POST /warehouses/{id}/fulfill` is
  order-tagged and server-driven — admin-web renders routing state but never
  calls fulfill on behalf of customer orders.
