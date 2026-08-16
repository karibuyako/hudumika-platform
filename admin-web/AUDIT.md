# HUDumika Admin Web — Audit Integration

The admin web is the primary producer and consumer of audit data. See `backend/AUDIT.md` for the server-side contract.

## What the UI must show

- **Audit logs module**: queryable table (filters: actor user, entity type/id, date range), masked details by default, export (permissioned, capped, itself audited).
- **Entity timelines**: orders, bookings, merchants, providers, riders, payouts, reviews, tickets, promotions, group buys, vouchers, conversations, chains, webhooks, data exports, and fleet/safety events show their relevant audit trail inline (actions + actor + time).
- **Unmask**: sensitive entries require compliance reviewer or super admin; unmask action is logged.

## What the UI must do

| Rule | Detail |
| --- | --- |
| Reason on mutations | Money, status, and moderation mutations always prompt for a reason before submit |
| Logged exports | Export button always records actor, filter set, row count, and timestamp |
| No delete paths | The UI never offers delete for audit data |
| System actor clarity | `actorRole=system` entries (webhook-driven changes) render as "System" |

## Display mapping

| Audit `action` prefix | UI label | Module |
| --- | --- | --- |
| `merchant.*` | Approval / suspension / terms changes | Merchants |
| `provider.*` / `rider.*` | Verification / reliability changes | Providers / Riders |
| `order.*` / `booking.*` | Status transitions, cancellations | Orders / Bookings |
| `refund.*` / `payout.*` | Money movements | Payments |
| `review.*` | Moderation decisions | Reviews |
| `promotion.*` | Moderation decisions (approve/reject/pause) | Promotions |
| `group_buy.*` | Moderation, extension, delist decisions | Group buy |
| `voucher.*` | Staff verification and refund handling | Vouchers |
| `conversation.*` | Blocks and read-only oversight access | Messages |
| `chain.*` | Tier/SLA/account manager changes, suspensions | Enterprise chains |
| `webhook.*` | Delivery failures, retry state, subscription status | Integrations |
| `export.*` | Export approvals, job runs, downloads | Data export |
| `ticket.*` | Assignment / status changes | Support |
| `assignment.*` | Manual order → rider overrides (actor, rider, reason) | Orders |
| `cod.*` | COD reconciliation decisions (shift status, variance) | Riders |
| `safety.*` | Safety-event handling (crash/fatigue escalation, acknowledgements) | Fleet control tower |
| `fleet.*` | Fleet actions (rest enforcement/override, control-tower decisions) | Fleet control tower |
| `hub.*` | Hub create/update/active changes (actor, reason) | Hubs & line-haul oversight |
| `consignment.*` | Consignment exception resolutions (missing order / mismatch, reason, before/after state) | Hubs & line-haul oversight |
| `handoff.*` | Seal-broken handoff decisions (actor, decision, before/after seal state) | Waybill & custody audit |
| `waybill.*` | Waybill audit-trail reads (per-order scan/custody views) | Waybill & custody audit |
| `shipment.*` | Shipment lifecycle (create, scans, status transitions, freeze/block) | Logistics control tower / Reconciliation & custody audit |
| `trip.*` | Trip state advances and replan approvals (action, vehicle, reason) | Logistics control tower |
| `reconciliation.*` | Reconciliation outcomes and resolutions (expected/scanned counts, missing ids, reason) | Reconciliation & custody audit |
| `anomaly.*` | Logistics anomaly decisions (scan/GPS mismatch, wrong hub, freeze/block, actor) | Reconciliation & custody audit |
| `warehouse.*` | Warehouse create/update, status changes (`active`/`full`/`maintenance`), stock deltas (bulk inbound / write-off), serving-city changes | Regional warehouses |
| `carrier.*` | Carrier registration/config, status changes (`active`/`paused`/`suspended`), regions/modes coverage changes | Carrier management |
| `facility.*` | Facility create/update (geofence, `accessPolicy`), whitelist grants/revocations, `NOT_WHITELISTED` incident handling | Facilities & whitelists |
| `fleet.*` | Fleet account create/update/suspend, sub-account permissions, vehicle/region ownership, consolidated-billing visibility | Fleet accounts / Fleet control tower |
| `exception.*` | Delivery-exception lifecycle: create, status changes (`open`→`resolving`→`resolved`/`escalated`), outcomes, escalations | Logistics control tower / Reconciliation & custody audit |
| `admin.*` | Staff role changes, exports, unmask | Audit |
| `two_person_approval.*` | Two-person authorization lifecycle: initiate, approve, reject (both actors, decision comment, before/after status) | Two-person approvals / Audit |
| `risk_case.*` | Risk case lifecycle: create, review decisions (`dismiss`/`block_user`/`block_provider`/`escalate`/`hold`), before/after status, decidedAction, reason | Trust & risk cases |
| `integration_health.*` | Integration health registry reads and health-state transitions (`healthy`/`degraded`/`down` per provider/category) | Integration health |
| `configuration.*` | Configuration center changes: regions, cities, zones, fees, commissions, tax, cancellation, SLA, matching, risk thresholds, notification rules — every change audited | Configuration center |
| `feature.*` | Feature flag changes (enabled, `rolloutPct`, `betaOnly`, targeting diff) | Configuration center |
| `iam.*` | IAM mutations: admin users, teams, roles, permissions, policies, sessions, devices, MFA, access-log policy changes | IAM |

## Logistics action prefixes — full catalog (Logistics OS)

All logistics mutations and permissioned reads are audited. Entry schema per
`backend/AUDIT.md` (`action`, `entityType`, `entityId`, `details {before, after,
reason}`, `actorUserId`, `requestId`). The admin web renders these on the
relevant entity timelines and in the audit logs module.

| Prefix | What is logged | Key fields in `details` | Source module |
| --- | --- | --- | --- |
| `shipment.*` | Shipment lifecycle: create (`shipment.created`), scans (`picked_up`, `hub_in`, `hub_out`, `vehicle_load`, `vehicle_unload`, `delivery`), status transitions, freeze/block (`status: exception`) | `shipmentNumber`, `scanType`, `before`/`after` status, `actorId`, `deviceId`, `reason` (freeze) | Logistics control tower / Reconciliation & custody audit |
| `package.*` | Package-level events: attribute changes, compatibility decisions, seal state on container load | `packageId`, `containerId`, `attributes`, `before`/`after` state | Reconciliation & custody audit |
| `container.*` | Container create, load, seal (`sealCode`, `sealedAt`), trip assignment | `containerId`, `kind`, `section`, `packageIds` count, `sealCode` | Reconciliation & custody audit |
| `vehicle.*` | Vehicle registration, status change (`active`/`on_trip`/`maintenance`/`retired`), capacity/permitted-route updates | `registration`, `vehicleType`, `before`/`after` status, `reason` | Logistics control tower |
| `route.*` | Route create/update/active changes | `name`, corridor hubs, `permittedVehicles`, `reason` | Logistics control tower |
| `trip.*` | Trip create and state advances (`start_loading`, `depart`, `arrive`, `start_unloading`, `complete`), replan approvals, `TRIP_CANNOT_CLOSE` events | `tripNumber`, `action`, `before`/`after` status, `vehicleId`, `driverId`, `reason` (replan approval) | Logistics control tower |
| `custody.*` | Permissioned custody-chain reads (compliance/reconciliation queries) | `shipmentId`, query time window, `entryCount` | Reconciliation & custody audit |
| `reconciliation.*` | Reconciliation runs and resolutions: `expected`/`scanned` counts, `missingOrderIds`, `status` (`matched`/`mismatch`), declare-lost decisions | `consignmentId`, `expected`, `scanned`, `missingOrderIds`, `before`/`after` status, `reason` | Reconciliation & custody audit |
| `anomaly.*` | Anomaly decisions: verify (dismiss with note / block/freeze with reason), release, evidence summary | `shipmentId`, `anomalyType` (`scan_gps_mismatch`/`scan_vehicle_static`/`wrong_hub_scan`/`scan_before_pickup`), `deviceId`, GPS comparison, `before`/`after` state, `reason` | Reconciliation & custody audit |
| `handoff.*` | Seal-broken handoff decisions: re-seal (condition photo + note) or damage-claim opening | `orderId`/`shipmentId`, `from`/`to`, `sealIntact: false`, `before`/`after` seal state, `reason` | Waybill & custody audit |
| `waybill.*` | Waybill audit-trail reads (per-order scan/custody views) | `orderId`, `waybillNumber`, `eventCount` | Waybill & custody audit |
| `consignment.*` | Consignment exception resolutions: missing order / mismatch, re-route decisions, loss declarations | `consignmentNumber`, corridor, `verifiedOrderIds` vs manifest difference, `reason`, `before`/`after` state | Hubs & line-haul oversight |
| `warehouse.*` | Warehouse lifecycle: create/update (`name`, `cityId`, `address`, `lat`/`lon`, `servingCities`, `status`), stock deltas (`PUT /warehouses/{id}/stock` — `catalogueItemId`, signed `delta`, before/after quantity), fulfill routing state | `warehouseId`, `before`/`after` status, `stockDeltas`, `reason` | Regional warehouses |
| `carrier.*` | Carrier lifecycle: registration, mode/region coverage changes, status transitions (`active`/`paused`/`suspended`), handoff-monitor config | `carrierId`, `modes[]`, `regions[]`, `before`/`after` status, `reason` | Carrier management |
| `facility.*` | Facility lifecycle: create/update (`geofence`, `accessPolicy`), whitelist mutations (`PUT /facilities/{id}/whitelist` — rider list before/after), `NOT_WHITELISTED` incident decisions (grant/dismiss) | `facilityId`, `accessPolicy`, `whitelistAdded`/`whitelistRemoved`, `before`/`after` state, `reason` | Facilities & whitelists |
| `fleet.*` | Fleet-account lifecycle: create/update/suspend (`status`), sub-account permissions, vehicle/region ownership, consolidated-billing views | `fleetAccountId`, `driverSubAccountIds`, `permissions` diff, `before`/`after` status, `reason` | Fleet accounts / Fleet control tower |
| `exception.*` | Delivery-exception lifecycle: create (report), status changes (`open` → `resolving` → `resolved`/`escalated`), outcomes, escalations (`exception.escalated`), `autoReplanned` confirmations | `exceptionId`, `kind` (18 values), `shipmentId`/`orderId`/`tripId`, `before`/`after` status, `outcome`, `autoReplanned`, `reason` | Logistics control tower / Reconciliation & custody audit |

### Rendering rules for deep-logistics entries

- Warehouse entries render the signed stock deltas and before/after quantities;
  status changes render `before`/`after` (`active`/`full`/`maintenance`).
- Carrier entries render modes/regions coverage diff and the status transition.
- Facility entries render whitelist before/after (added/removed rider counts)
  and `accessPolicy` changes; incident decisions link to the entry log.
- Fleet entries render the permissions diff, sub-account list changes, and the
  suspension decision with `reason`.
- Exception entries render `kind`, the status path (`open → resolving →
  resolved/escalated`), `outcome`, and the `autoReplanned` flag; escalations
  link to the `exception.escalated` notification.
- Every deep-logistics mutation screen ships with a test asserting the audit
  entry appears on the entity timeline after the mutation succeeds.

## Control-plane action prefixes — full catalog

The control-plane capabilities add their own audit surface. Entry schema per
`backend/AUDIT.md`; the admin web renders these on the relevant entity
timelines and in the audit logs module.

| Prefix | What is logged | Key fields in `details` | Source module |
| --- | --- | --- | --- |
| `two_person_approval.*` | Two-person authorization lifecycle: initiate (`two_person_approval.initiated`), approve (`two_person_approval.approved` — action executed), reject (`two_person_approval.rejected` — nothing executed) | `actionType` (the 8 dangerous types), `targetType`/`targetId`, `requestedBy`/`decidedBy` actor pair, `decisionComment`, `payload` summary, `before`/`after` status (`pending` → `approved`/`rejected`) | Two-person approvals |
| `risk_case.*` | Risk case lifecycle: created (engine or staff), review decisions — `dismiss`, `block_user`, `block_provider`, `escalate`, `hold` | `caseId`, `severity`, `signals[]` summary, `related` entity ids, `action`, `reason`, `before`/`after` status (`open`/`investigating`/`resolved`/`dismissed`), `decidedAction` | Trust & risk cases |
| `integration_health.*` | Integration health registry: permissioned reads (view-only) and health-state transitions logged by the monitor | `provider`, `category` (9 values), `before`/`after` health (`healthy`/`degraded`/`down`), `error` summary, `lastCheckedAt` | Integration health |
| `configuration.*` | Configuration center changes: regions, cities, zones, fees, commissions, tax, cancellation, SLA rules, matching, risk thresholds, notification rules | `configKey`, `before`/`after` values, `reason` where required, acting staff user | Configuration center |
| `feature.*` | Feature flag changes: `enabled`, `rolloutPct`, `betaOnly`, targeting diff | `key`, `before`/`after` targeting (`countries[]`/`regions[]`/`cities[]`/`segments[]`/`userPct`), `updatedBy` | Configuration center |
| `iam.*` | IAM mutations: admin user create/update/suspend, team changes, role definition changes (`GET/POST /admin/staff-roles`), permission/policy changes, session revocation, device/MFA policy changes | `iamEntity`, `before`/`after` role/permission/policy diff, `reason` where required | IAM |
| `search.*` | Global search usage (permissioned reads; query + result counts) | `query` (hashed/truncated in detail view), `entityTypes`, `resultCount` | Global search |

### Rendering rules for control-plane entries

- Two-person entries render both actors (requester and decider), the
  `actionType` (e.g. `large_refund`), the target entity link, the decision
  comment, and the before/after approval status; the approve/reject pair
  reconstructs the full 4-eyes record on the entity timeline.
- Risk-case entries render the severity, signal summary, related entity links
  (`customerUserId`/`providerId`/`riderId`/`orderIds`/`deviceIds`/
  `ipHistory`), the decision action and reason, and the before/after status;
  `block_user`/`block_provider` decisions also surface on the target user's
  timeline.
- Integration-health entries render the provider, category chip, and the
  health transition (`healthy → degraded → down`) with the error summary.
- Configuration entries render the changed key with before/after values and
  the acting staff user; feature-flag entries render the targeting diff
  (country/region/city/segment/percentage).
- IAM entries render the diff (role/permission/policy) and link to the IAM
  record; `change_iam_policy` decisions link to their two-person approval
  pair.
- Every control-plane mutation screen ships with a test asserting the audit
  entry appears on the entity timeline after the mutation succeeds.

## Moderation decision details

- Trip advances render `action` + `before`/`after` status + `vehicleId`; replan
  approvals render the alternate trip/vehicle + `reason`.
- Reconciliation entries render `expected`/`scanned` counts and the
  `missingOrderIds` list; declare-lost entries link to the damage-claim path.
- Anomaly entries render the evidence summary (device/GPS side by side) and the
  decision (dismiss vs freeze); frozen shipments show `status: exception` until
  released.
- Every logistics mutation screen ships with a test asserting the audit entry
  appears on the entity timeline after the mutation succeeds.
- Deep-logistics entries follow the same rule (see the deep-logistics catalog
  below).

### Moderation decision details (promotions, vouchers, conversations)

- Promotion (`promotion.*`) and group buy (`group_buy.*`) decision entries must render the decision, the reason, and the before/after moderation state from `details`; the reason is required by the API (`ADMIN_REASON_REQUIRED`) and is never client-composed.
- Voucher (`voucher.*`) verification entries render the `result` (`redeemed` / `invalid` / `expired` / `already_used`) and the acting staff user; refund decisions link to the payment intent entry.
- Conversation (`conversation.*`) block entries render the reason, the acting staff user, and the before/after status (`open` / `archived` / `blocked`); the reason is required by the API and never client-composed.

## Testing requirement

Every mutation screen ships with a test asserting the audit entry appears on the entity timeline after the mutation succeeds.
