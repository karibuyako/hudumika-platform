# HUDumika Admin Web — Master Blueprint

The central command center for the platform. The complete build specification:
every module, screen, feature, workflow, access-control level, API dependency,
and priority. Built from `admin-web/MODULES.md`, `ROLES-PERMISSIONS.md`,
`WORKFLOWS.md`, `API.md`, `AUDIT.md`, `SECURITY.md` + this blueprint; endpoints
are live in `backend/API-CONTRACT.yaml`.

## 0. Purpose, users, and design principles

**Purpose**: one control center for merchants, providers, riders, customers,
orders, bookings, payments, logistics, content, quality, and the entire
ecosystem — built as the **central control plane** for the platform: a
completely separate product from the consumer, merchant, provider, and rider
applications, not a back-office afterthought. It is effectively several
applications (Control Tower, Back Office, Management) inside one shared shell.

**Users (20 roles)**: Platform Owner · Platform Administrator · Operations
Manager · Dispatch Manager · Regional Operations Manager · Merchant Operations ·
Provider Operations · Rider Operations · Customer Support · Finance · Payments ·
Risk & Fraud · Trust & Safety · Compliance · Marketing · Analytics · Content
Manager · Technical Operations · Security Administrator · Read-only Auditor.
(Full catalog: `ROLES-PERMISSIONS.md`.)

**Design principles**:
- Role-based access: every admin sees only what their role requires
  (server-enforced; UI renders per session capabilities).
- Real-time data: live order/delivery/metrics via WS `/events` +
  `/admin/control-tower`, `/admin/logistics/control-tower`,
  `/admin/fleet/control-tower`.
- Actionable insights: dashboards highlight problems + suggest actions.
- Efficient workflows: minimize clicks; keyboard shortcuts; saved views;
  bulk operations; command palette.
- Audit trails: every action logged (`/admin/audit-logs`).
- Responsive: desktop + tablet; optional mobile monitoring app (planned).
- **Every screen answers three questions**: *What is happening?* (live state),
  *What needs intervention?* (exceptions, queues, alerts), *What can I
  configure?* (the configuration surface for that domain).

**Access control (all levels)**:
1. **Authentication**: staff OTP → **MFA (TOTP/SMS)** mandatory; session
   timeout 20 min; refresh rotation; logout revokes server-side.
2. **RBAC**: 20 built-in roles + custom roles (`/admin/staff-roles`) — each a
   bundle of action permissions (`order.read`, `refund.approve`,
   `configuration.edit`, `iam.manage`, `audit.read`…).
3. **ABAC + resource/context rules**: e.g. regional ops manage only their
   region; finance views financial data but cannot edit job execution; support
   sees masked PII until granted.
4. **Tenant isolation**: chain/fleet scopes never cross.
5. **IP/device policy**: allow-list where required; new device re-verifies.
6. **Audit**: every mutation → audit entry (actor, role, action, entity,
   before/after, requestId, IP).
7. **Sensitive fields masked by default**; unmask permissioned + audited.
8. **Two-person authorization**: dangerous actions (the 8 dangerous action
   types) require a second admin; same-actor blocked; executes on approval.

---

## 1. Control-plane architecture

The admin web is split into three functional planes under one shared shell:

| Plane | Live operations | Back office | Management |
| --- | --- | --- | --- |
| Covers | Control tower, dispatch, live map, hub dashboards, fleet, exceptions, risk triage | Finance, support, compliance, risk cases, exports, audit | Providers, merchants, customers, riders, catalogue, content, chains |
| Signature screens | Operations control tower, dispatch console, universal entity view, live map layers | Finance console, customer support console, risk cases, compliance console | Provider/merchant/rider deep management trees, CMS, configuration center |
| Primary roles | Operations Manager, Dispatch Manager, Regional Operations Manager, Rider Operations | Finance, Payments, Customer Support, Compliance, Analytics | Merchant Operations, Provider Operations, Rider Operations, Content Manager, Marketing |

All three planes share the same foundation:

- **Shared auth**: OTP + MFA, `mfa_verified` claim on every admin session.
- **Shared design system**: design tokens, dense UI components, enterprise
  tables, side drawers, command palette.
- **Shared permissions**: the single action catalog in `ROLES-PERMISSIONS.md`,
  enforced server-side; the UI renders per-session capabilities.
- **Shared navigation**: the 15-group navigation blueprint (§Navigation).
- **Shared global search**: `GET /admin/search` (§Global search) from any
  screen via the search bar and command palette.
- **Shared notifications**: admin notification center with escalation levels
  (§Admin notifications).
- **Shared audit**: every mutation in every plane lands in the audit log and
  renders on entity timelines.
- **Shared API gateway**: all data flows through `/admin/*` endpoints from
  `backend/API-CONTRACT.yaml`; MSW parity in dev.

---

## 2. Global search

`GET /admin/search?q=&entityTypes=&limit=` — platform-wide entity search across
`order`, `shipment`, `customer`, `provider`, `rider`, `merchant`, `booking`,
`hub`, `vehicle`, `ticket`, `conversation` entity types.

- **Query** (`q`, max 200 chars): free text, natural-language terms
  ("orders stuck in Dar", "rider John", "merchant Amani"), and **entity ID
  prefixes**:
  - `ORD-` orders, `SHP-` shipments, `CUS-` customers, `PRV-` providers,
    `RDR-` riders, `MRC-` merchants, `JOB-` service jobs (bookings).
- **Scope**: `entityTypes` filter (repeatable); `limit` default 20; results are
  ABAC-scoped — an admin only sees entity types they can `read`.
- **Result rows**: `{entityType, id, label, status?, region?, updatedAt?}` —
  click through to the universal entity view of that entity.
- **Entry points**: the top-bar search box, the command palette (Ctrl/Cmd+K),
  and the Operations Overview quick-search.
- **Errors**: `ADMIN_SEARCH_INVALID` (422) on malformed queries; 403
  `FORBIDDEN` without permission.
- **Operations query engine (concept)**: the search layer interprets
  operational terms ("unassigned", "stuck", "escalated", "open SOS",
  "overdue") and returns the matching operational queues with live counts —
  one query box answers both "find the entity" and "find the work".
  (Engine scoring planned; prefix + exact-ID matching live first.)

---

## 3. Universal entity view

A single standard detail layout applied to orders, shipments, providers,
merchants, customers, and riders. Every entity view answers "what is
happening / what needs intervention / what can I configure" with these
sections:

| Section | Content |
| --- | --- |
| **Status** | Current status + status pill; status history count; SLA/age context if applicable |
| **Parties** | The actors on the entity: customer, merchant, provider, rider, carrier, hub (masked by default; unmask permissioned) |
| **Origin / destination** | Route legs, pickup/drop-off, from-hub/to-hub, address context |
| **Current location** | Live position (rider/vehicle/hub) with map pin when available |
| **Timeline** | The entity's event trail (order events, shipment custody, booking events, verification history) |
| **Actions panel** | The actions the session's role may take (server-gated); dangerous actions route through two-person authorization |
| **Audit history** | The relevant `*.` audit prefix entries (WHO/WHAT/WHEN/WHERE/WHY/BEFORE/AFTER + reason) |
| **Events** | The realtime WS event stream relevant to the entity |
| **Scans** | Scan trail for physical entities (waybill/custody scans, device binding) |
| **Actors** | Who touched it and when (rider, hub worker, carrier, admin, system) |
| **Locations** | GPS/timeline points, geofence context, zone/region |
| **Devices** | Device IDs that scanned/accessed the entity (scan-device binding evidence) |

Entity → module mapping: order → Modules 8/9, shipment → Modules 25–27,
provider/merchant/customer/rider → Modules 2–5, plus the deep-logistics
registries. The universal view is the shared template underneath them all.

---

## 4. Live map

`/admin/map` — the live operational map of the platform, layered and
toggleable:

| Layer | Data source | Interaction |
| --- | --- | --- |
| Riders | fleet control tower / rider locations | click rider → current job, status, shift, SOS state |
| Vehicles | `/vehicles` + trip state | click vehicle → **trip / shipments / ETA**, capacity used, compartments, driver |
| Hubs | `/hubs` | click hub → hub dashboard (`GET /admin/hubs/{hubId}/dashboard`) |
| Merchants | merchant registry | click merchant → store state, live orders, inventory |
| Providers | provider registry | click provider → current jobs, availability, reliability |
| Active deliveries | orders/shipments in flight | click → order/shipment universal view |
| Service jobs | bookings in flight | click → booking view |
| Traffic | traffic provider layer | contextual overlay |
| Geofences | cities, zones, facilities, warehouses | boundary overlay with entry/exit state |
| Incidents | exceptions, anomalies, SOS, risk cases | click → exception/case queue |

The map is one screen with a layer panel; every marker opens the universal
entity view. Layers are read-only for the listed roles; markers never carry
mutations.

---

## 5. Dispatch console

`/admin/dispatch` — the live assignment surface:

- **Unassigned list + map**: orders/bookings without an actor, shown as a
  queue and as map markers with wait time.
- **Assignment context**: unassigned orders + **available riders** (online,
  in zone, capacity), vehicles, capacity, and routes shown side by side in
  the dispatch workspace.
- **Assign**: `POST /admin/orders/{orderId}/assign-rider`
  (`{riderId, reason}`, `ASSIGN_RIDER_UNAVAILABLE` when offline/out of zone);
  `POST /admin/bookings/{bookingId}/assign-provider`.
- **Reassign**: `POST /admin/shipments/{shipmentId}/reassign`
  (`{reason, riderId?, tripId?}`).
- **Bulk assign**: multi-select queue rows → assign/reassign in one pass
  (server-gated, per-row outcome report).
- **Schedule / reschedule**: scheduled orders/bookings — change the slot with
  reason; `RESCHEDULE_IN_PAST` guard.
- **Cancel**: cancel with reason; refund rules apply per cancellation policy.
- **Escalate**: push to Operations Manager via `exception.escalated`-style
  escalation or the dispatch-failure notification.
- Every action appends an order/booking/shipment event + audit entry
  (`assignment.*`, `booking.*`, `shipment.*`).

---

## 6. Hub management & hub dashboard

The hub is its own management surface, not a card on another screen:

```
Hubs
├── Hub Overview
├── Incoming
├── Outgoing
├── Sorting
├── Containers
├── Capacity
├── Staff
├── Vehicles
├── Exceptions
└── Performance
```

`GET /admin/hubs/{hubId}/dashboard` → `HubDashboard`:

- `load`: `incoming`, `outgoing`, `awaitingSort`, `exceptions`, `capacityPct`
  — headline cards (**Current load**: incoming / outgoing / **awaiting sort**
  / exceptions / capacity %); `capacityPct` over 100 renders a capacity
  warning and feeds the control tower's `hubCapacityWarnings`.
- `sortationQueues[]`: per-zone sortation queue depth (`zone`, `count`).
- `staffOnDuty`: staffing level per shift.
- `vehiclesPresent`: vehicles at the hub.
- `updatedAt` timestamps the snapshot.
- Errors: 404 `HUB_NOT_FOUND`, `HUB_DASHBOARD_UNAVAILABLE` → empty state +
  retry; 403 `FORBIDDEN` without permission.
- Roles: ops manager, dispatch manager, regional ops manager, logistics
  operations (view-only).

---

## 7. Manifest drill chain

Manifest → Container → Package → Shipment → Order → Customer traceability:

```
Manifest (linehaul_manifest, per-consignment)
  → Container (BAG-CN-…, SSCC-style, sealed)
    → Package (PKG-…, attributes)
      → Shipment (SH-…, physical object)
        → Order (ORD-…, commercial object)
          → Customer (CUS-…, the party)
```

- **Entry points**: a consignment manifest row, a container barcode, a
  package/shipment scan, an order search hit, a damage claim, a delivery
  exception.
- **Navigation**: each level opens the next — the chain drills down one
  direction and traces responsibility up the other (the custody ledger at each
  level answers "who handled it and when").
- **Evidence**: scan records, seal states, condition photos, GPS, devices,
  custody entries at every level.
- **Use cases**: reconciliation failures (workflow 23), damage/loss claims,
  delivery exceptions (workflow 25), compliance audits.
- Data: `/linehaul/consignments`, `/containers`, `/shipments/{id}/custody`,
  `/orders/{id}/waybill`, `GET /admin/search` at each hop.

---

## 8. Two-person authorization

Dangerous actions require **two different admins** (4-eyes). Eight action types:

`large_refund` · `change_commission` · `suspend_major_merchant` ·
`change_payment_settings` · `modify_ledger` · `change_iam_policy` ·
`delete_critical_data` · `release_hold`

Human-readable examples of dangerous operations that trigger the flow:
**large refund** · **change commission** · **suspend major merchant** ·
**change payment settings** · **modify the financial ledger** ·
**change IAM policy** · **delete critical data** · **release a hold**.

**Flow** (module: Two-person approvals; workflow 31):

1. **Initiate**: an admin holding the underlying permission posts
   `POST /admin/two-person-approvals` `{actionType, targetType, targetId,
   reason (max 1000), payload?}` → 201 `pending`.
2. **Notify**: the approval queue updates; the second admin is notified.
3. **Approve/reject**: a *different* admin posts
   `POST /admin/two-person-approvals/{approvalId}/decision`
   `{decision: approve|reject, comment (max 1000)}`:
   - requester deciding → 409 `APPROVAL_SAME_ACTOR` (blocked);
   - unknown → 404 `APPROVAL_NOT_FOUND`;
   - already decided → 409 `APPROVAL_ALREADY_DECIDED`.
4. **Execute**: on approval the platform executes the action with the recorded
   payload; on rejection nothing executes.
5. **Audit**: `two_person_approval.*` entries for initiate/approve/reject with
   both actors, decision comment, before/after status.

A dangerous action attempted without the flow fails with 409
`TWO_PERSON_REQUIRED`. Queue: `GET /admin/two-person-approvals?status=`
(`pending` / `approved` / `rejected`).

---

## 9. Risk & trust cases

`GET /admin/risk/cases?status=&severity=` → `RiskCase[]`:

- `severity`: `low` / `medium` / `high` / `critical`.
- `signals[]`: signal names (e.g. `multiple_accounts`, `refund_ratio`,
  `refund_velocity`, `large_refund`, `withdrawal_anomaly`, `login_risk`,
  `unusual_order_pattern`, `order_delay`, `rider_inactivity`,
  `suspicious_cancellation`, `gps_spoof`, `rapid_decline`, `impossible_speed`,
  `multi_device`, `payment_abuse`).
- `related`: `customerUserId`, `providerId`, `riderId`, `orderIds[]`,
  `deviceIds[]`, `ipHistory[]` — the case is always anchored to its entities.
- `status`: `open` / `investigating` / `resolved` / `dismissed`;
  `decidedAction` + `reason` record the outcome; `createdBy`/`createdAt`.

**Review actions** (`POST /admin/risk/cases/{caseId}/review`
`{action, reason}`):
`dismiss` · `block_user` · `block_provider` · `escalate` · `hold`.

- `block_user` / `block_provider` require `risk.block`; every action requires a
  `reason` (max 1000) and writes a `risk_case.*` audit entry.
- Already-decided cases reject new decisions (`RISK_CASE_ALREADY_DECIDED`,
  409); unknown cases → `RISK_CASE_NOT_FOUND` (404).
- Roles: risk & fraud, trust & safety, ops manager, platform owner/admin
  (workflow 32).

---

## 10. Integration health

`GET /admin/integrations` → health registry rows
`{provider, category, health, lastCheckedAt, error?}` across nine categories:
`payment` · `maps` · `sms` · `email` · `pos` · `logistics` · `erp` · `crm` ·
`webhooks`.

- `health`: `healthy` / `degraded` / `down` — rendered as traffic-light pills
  with the provider name, category chip, `lastCheckedAt`, and `error` detail.
- Example provider surfaces per category: **payment providers** (gateways,
  PSPs), **maps**, **SMS**, **email**, **POS**, **partner logistics**,
  **ERP**, **CRM**, **webhooks** — each with a registered provider name.
- The registry feeds the Technical Operations module and the admin
  notification "integration failure" alert (push critical at `down`).
- `INTEGRATION_HEALTH_UNAVAILABLE` → empty state + retry; 403 `FORBIDDEN`.
- Roles: technical operations, platform owner/administrator, ops manager
  (view-only); payments role sees the payment category in detail.

---

## 11. Control tower

`GET /admin/control-tower` → `OperationsControlTower` — the live platform
health screen (Overview group):

- `generatedAt`: snapshot timestamp.
- `totals`: `ordersToday`, `activeDeliveries`, `activeServiceJobs`,
  `providersOnline`, `ridersOnline`, `openIncidents`, `delayedShipments`,
  `pendingDisputes`.
- `networkHealth`:
  - `deliveryNetwork`: `normalPct` / `delayedPct` / `criticalPct`.
  - `serviceNetwork`: `normalPct` / `capacityIssuePct` / `criticalPct`.
- `criticalActions` — the intervention queue:
  `shipmentExceptions` · `providerIncidents` · `paymentFailures` ·
  `fraudCases` · `slaBreaches` · `hubCapacityWarnings` — each a count that
  links to the matching queue (logistics exceptions, provider incidents,
  payment failures, risk cases, SLA breaches, hub dashboards).
- **Live alert banner** (the tower is an operational dashboard, not BI):
  e.g. "17 orders delayed > 30 min", "4 hubs above 90% capacity", "31
  providers unavailable", "9 vehicles offline", "3 missing package
  reconciliations", "22 SLA violations approaching" — each alert deep-links
  to the queue it came from. This is what makes the tower distinct from
  normal BI dashboards: it shows what needs intervention right now.
- 403 `FORBIDDEN` without permission; no availability error code (the tower
  degrades to empty-state on 5xx).
- Roles: ops manager, dispatch manager, regional ops manager, risk & fraud,
  trust & safety, platform owner/admin (view-only; workflow 33).

---

## 12. Configuration center

The configuration surface, split by domain — **every change is audited**
(`configuration.*` / domain prefix), sensitive config requires a reason, and
the dangerous items route through two-person authorization:

| Domain | Contents | Notes |
| --- | --- | --- |
| Regions | Region list, boundaries | `configuration.edit` |
| Cities | `POST /admin/cities` upsert + service areas | ABAC scope basis |
| Service/delivery zones | **Service zones** / **delivery zones**: zone polygons, service areas, geofences | feeds dispatch + map |
| Fees | Delivery fees, min order, surcharge rules | audited |
| Commissions | `GET/PUT /admin/commission-rules` (rateBps by category/merchant/provider) | `change_commission` is two-person |
| Tax rules | Tax rates, reporting | audited |
| Cancellation rules | Cancellation/refund policy rules | audited |
| SLA rules | `GET/PUT /admin/sla-rules` (`support_ticket`/`delivery`/`service_booking`/`refund`/`verification` + `alertBeforeMinutes`) | feeds `admin.sla_breach` |
| Matching rules | Dispatch/matching parameters | audited |
| Risk rules | Risk thresholds, signal weights | audited |
| Feature flags | `GET/PATCH /admin/features` → `AdminFeatureFlag {key, enabled, rolloutPct, betaOnly, targeting}` | **targeting**: `countries[]`, `regions[]`, `cities[]` (uuid), `segments[]` (uuid), `userPct` (0–1) — country/region/city/segment/percentage rollout; clients read `GET /experiments` |
| Notification rules | Per-event channel rules, admin notification rules | audited |

Example flags an admin configures: `food_delivery_v2`, `intercity_delivery`,
`provider_quotes`, `multi_leg_tracking`, `new_checkout`, `new_homepage` —
each with country/region/city/segment/percentage rollout.

---

## 13. IAM

`/admin/iam` — the identity and access surface:

- **Admin users**: staff accounts, suspension (revokes sessions), MFA
  enrollment/rotation, session list/revoke, devices.
- **Teams**: staff groupings for ownership and notification routing.
- **Roles**: the 20 built-in roles + custom roles (`GET/POST /admin/staff-roles`;
  `AdminRoleDefinition {name, permissions[], system}`; `ROLE_IN_USE` blocks
  deletion of assigned roles).
- **Permissions**: the action catalog (ROLES-PERMISSIONS.md).
- **Policies**: ABAC/resource policies (region scoping, tenant isolation,
  masking policy).
- **Regions / organizations**: scope boundaries for roles and policies.
- **Sessions / devices / MFA**: staff session management, device registry,
  mandatory MFA, suspicious-device re-verification.
- **Access logs**: login/MFA/role-change/denied-attempt stream (audit).
- `iam.manage` mutations are audited; `change_iam_policy` requires two-person
  authorization; role changes require Platform Owner or Platform
  Administrator.

---

## 14. Admin notifications

The admin notification center (top-bar bell + center) with escalation levels:

| Level | Examples | Channels |
| --- | --- | --- |
| High-severity incident | `sos.created`, `safety.crash_detected`, `safety.crash_acknowledged`, `plan.disruption_detected`, `exception.escalated` | push (critical) + in-app |
| Payment provider down | integration health `payment` → `down` | push (critical) + in-app |
| Hub capacity exceeded | `hubCapacityWarnings` / hub dashboard `capacityPct` > 100 | push + in-app |
| Fraud spike | control tower `fraudCases` jump; risk case `critical` created | push + in-app |
| Dispatch failure | `order.transfer_requested`, stuck dispatch, `DISPATCH_NO_RIDER` | push + in-app |
| SLA breach | `admin.sla_breach` (ops manager, critical) | push (critical) + in-app |
| Database issue | technical operations alert (backend sweeper) | in-app + pager |
| Integration failure | `INTEGRATION_HEALTH_UNAVAILABLE`, webhook delivery failures, `integration.disconnected` | push + in-app |
| Compliance expiring | `admin.compliance_expiring` (licenses/insurance/certificates → compliance) | in-app |
| Broadcast | `admin.broadcast` (targeted platform push campaign) | push + in-app |

Escalation rules: level-1 alerts route to Operations Manager; unresolved
level-1 alerts escalate to Platform Administrator, then Platform Owner after
the configured window. Every notification renders a deep link into the
relevant screen (order, shipment, hub dashboard, risk case, ticket).

---

## 15. UX: dense interface

- **Dense UI**: `data-dense` tables, compact stat cards, high information
  density, minimal chrome; keyboard-first. The admin web is deliberately the
  opposite of the consumer app: **dense, fast, searchable, filterable,
  keyboard-friendly, information-rich** — an admin processes 50 cases in the
  time a customer processes one order.
- **Enterprise tables**: search, multi-filter, sort, column selection, saved
  views, pagination (cursor), bulk selection, export (permissioned + audited),
  import (where supported), row expansion, keyboard navigation.
- **Side drawers**: detail panels without losing list context; drawers host
  timelines, audit, and action panels.
- **Command palette (Ctrl/Cmd+K)**: global search, screen navigation (all 15
  navigation groups), actions (approve, reassign, block…), and saved views —
  one keystroke away from any screen.
- **Keyboard shortcuts**: documented cheat sheet (e.g. `/` focus search,
  `K`/`J` row navigation, `Shift+A` open actions, `Ctrl/Cmd+K` palette,
  `E` export view, `S` save view); all shortcuts disabled in the palette.
- **Saved views**: per-table saved filter/sort/column combinations, personal
  and shared (role-scoped).
- **Bulk operations**: multi-row assign, export, status changes with reason +
  per-row outcome report.
- **Accessibility**: WCAG 2.1 AA; keyboard navigable throughout.

---

## 16. Navigation blueprint (15 groups)

```
┌──────────────────────────────────────────────────────────────┐
│  HUDumika Ops          [Ctrl+K search] [Alerts] [Admin] [⏻]  │
├──────────────────────────────────────────────────────────────┤
│  OVERVIEW       Operations control tower · overview · map     │
│  OPERATIONS     Dispatch · fleet · hubs · line-haul ·         │
│                 warehouses · carriers · facilities ·          │
│                 delivery exceptions                           │
│  COMMERCE       Orders · bookings · dine-in · reservations    │
│  SERVICES       Provider directory · service catalogue ·     │
│                 territories                                   │
│  LOGISTICS      Logistics control tower · shipments ·         │
│                 reconciliation · waybill & custody            │
│  CUSTOMERS      Customer directory · global search ·          │
│                 universal entity views                        │
│  FINANCE        Finance console · payments · refunds ·        │
│                 settlements · payouts · ledger · taxes        │
│  GROWTH         Promotions · campaigns · coupons · group      │
│                 buys · CMS · loyalty · chains                 │
│  SUPPORT        Support console · tickets · conversations ·   │
│                 disputes · vouchers                           │
│  TRUST & SAFETY Risk cases · review moderation · safety ·     │
│                 fleet control tower (safety)                  │
│  COMPLIANCE     Compliance console · audit · expirations ·    │
│                 data exports                                  │
│  ANALYTICS      Deep analytics · reports · exports            │
│  CONFIGURATION  Configuration center · feature flags ·        │
│                 integrations & webhooks · staff roles         │
│  IAM            Admin users · teams · roles · policies ·      │
│                 sessions · devices · MFA · access logs        │
│  AUDIT          Audit logs · two-person approvals ·           │
│                 access logs                                   │
└──────────────────────────────────────────────────────────────┘
```

Every screen in every group answers: what is happening / what needs
intervention / what can I configure.

---

## 17. Sections (detailed)

### 17.1 Dashboard
Metric cards (top row): Total Revenue (today/week/month + trend) · Total
Orders (count + value) · Total Bookings · Active Users
(customers/providers/riders) · New Signups · Active Orders · Active Riders ·
Avg Response Time · SLA Compliance Rate · Revenue Breakdown by category.
Real-time activity feed (live stream of new orders/bookings via
`/admin/orders`, `/admin/bookings` + WS `/events`; quick view/intervene
actions; filter by type/status/region). Performance charts (revenue trend,
order volume, category breakdown, geographic distribution, peak hours).
Alerts & notifications (system alerts, operational alerts, queue lengths,
active flash sales). Quick actions (create flash sale, manage urgent orders,
respond to alerts, reconcile payouts, approve pending verifications, open
two-person approval queue).
**Data**: `GET /admin/overview`, `GET /admin/analytics/{scope}`,
`GET /admin/promotions?state=`, `GET /admin/support/tickets`,
`GET /admin/control-tower`.

### 17.2 Users (customers + all roles)
User list: search (name/phone/email/ID via `GET /admin/search` and
`GET /admin/users`), filters (role, status, region, date), bulk actions
(suspend/activate/email), export CSV/Excel. Customer detail: basic profile,
**verification status**, order history, payment history, addresses,
**support cases**, reviews, activity log, devices, risk, **membership**
status, actions (suspend, activate, email, reset password, view KYC).
Sensitive information is **masked by default** unless the role has a
legitimate need to unmask (unmask is permissioned + audited). Provider
detail: profile + verification, service offerings, service area,
certifications, insurance, booking history, reviews, performance, actions
(verify, suspend, approve service changes). Merchant detail: profile +
verification, catalogue, order history, reviews, performance, financials,
actions (approve, suspend, change commission — `change_commission` is
two-person, message). Verification management: queue, document review,
decision (approve/reject/request changes + reason), note/action history.

### 17.3 Merchant & provider management
**Providers** — the deep management tree:

```
Providers
├── All Providers
├── Pending Approval
├── Verified
├── Suspended
├── Restricted
├── Expiring Documents
├── Performance
└── Incidents
```

Provider detail sections: identity, business, users, **branches**, skills,
certifications, services, service areas, availability, vehicles, inventory,
jobs, reviews, earnings, documents, compliance, risk, audit. Provider
actions: approve, reject, suspend, restrict, **verify document**, **change
service area**, **change category**, **assign manager**.

**Merchants** — the equivalent tree: applications, active, suspended,
**stores**, **menus**, orders, promotions, finance, reviews, compliance.
List (search/filter/quick actions/export) · detail (business info,
category/services, service area map, availability, performance, financials,
reviews + moderation, certifications & documents, actions incl. commission
change via `/admin/commission-rules` and `/admin/merchants/{id}/approval`) ·
onboarding workflow (application list → document review → KYC → training
completion → approve/reject with comments). Chain oversight:
`/admin/chain`. Provider and merchant data are never merged into a generic
profile — they are distinct supply-side domains with their own registries,
trees, and actions.

### 17.4 Rider management
Rider list (search, filters by type/vehicle/status/region, live online
status) · rider tree: **applicants**, verified, online, offline, suspended,
incidents, performance · rider detail (profile, documents, **transport
type**, **current assignment**, current location, completed jobs,
performance: deliveries, **acceptance rate**, **cancellation rate**,
on-time, rating, earnings; delivery history; location history; reviews;
safety incidents; actions: approve, suspend, view location, message) ·
onboarding workflow (application → documents → background check → training →
approval) · real-time fleet map with dispatch control:
`/admin/fleet/control-tower`, `/admin/orders/{id}/assign-rider`,
`/admin/riders/{id}/cod` (COD reconciliation), shipment freeze/reassign/
escalate, `/admin/logistics/control-tower`.

### 17.5 Orders & bookings
Order list (food/grocery): status pipeline **All / New / Preparing / Ready /
Picked Up / Delivering / Completed / Cancelled / Disputed**; search
(ID/customer/restaurant/rider), filters (status, date, restaurant, region,
payment), real-time updates, bulk actions (print, complete), export. Order
detail: summary, customer, merchant, rider + live location, items, payment,
timeline, actions (view, update status, reassign rider, **contact
merchant**, **contact rider**, cancel, refund, escalate, **add internal
note**). Sensitive actions (cancel/refund/override) require elevated
permission and route through two-person authorization where applicable.
Booking list/detail: search/filter by status/date/provider/region · summary,
customer, provider + live location, service details, payment, timeline ·
actions (update, reschedule, cancel, reassign provider via
`/admin/bookings/{id}/assign-provider`, refund). Service job lifecycle:
requests → matching → unassigned → assigned → **en route** → **in
progress** → quote pending → completed → warranty → disputed. Hotel & travel
bookings (Phase 5; `HotelBooking`/`TicketBooking` transactions). Assignment
& dispatch: manual assignment, reassignment, emergency dispatch override,
capacity management (workload view).

### 17.6 Operations center & logistics (multi-leg, from LOGISTICS-OS)
The **operations center** is the broadest admin module:

```
Operations
├── Orders
├── Service Jobs
├── Deliveries
├── Shipments
├── Exceptions
├── Incidents
├── SLA Monitoring
└── Control Tower
```

Every queue has the same filter bar — **filter by city**, region, service,
merchant, provider, rider, vehicle, hub, status, priority, time, SLA — one
filter surface across all eight queues.

Logistics oversight (multi-city, multi-hub): hubs & line-haul oversight
(`/hubs`, `/linehaul/consignments`), consignment monitor + exceptions,
waybill & custody audit, logistics control tower (`/admin/logistics/
control-tower`), hub dashboards (`/admin/hubs/{hubId}/dashboard`), shipment
freeze/unfreeze, reassign, escalate, reconciliation outcomes. The logistics
tower drills into any live leg: **vehicle, trip, manifest, leg, container,
package, handoff, current location, ETA, exceptions**. Manifest drill chain
(§Manifest drill chain). Operations control tower role covers these.

### 17.7 Payments & settlement
Transactions: list (search/filter/export) · detail (amount, status, order
ref, method, refund status, actions: refund/complete/flag). Settlements:
list pending/completed (`/finance/settlements/daily` admin scope,
`/admin/payouts`) · detail (amount, period, commission, net) ·
approve/hold/release · bank transfer integration. Refunds: queue (`/refunds`
admin scope) · decision with reason + amount via
`/admin/refunds/{id}/decision` · audit. Commissions: rules by
category/merchant/provider + overrides (`/admin/commission-rules`) ·
commission reports (`/admin/analytics/{scope=revenue}`). Payouts
(riders/merchants/providers): earnings lists, batch payroll processing,
payroll reports. Wallets: user wallet overview, transactions, manual
adjustment (finance, audited): `/admin/wallets/{userId}/adjust` —
`modify_ledger`-class changes route through two-person authorization.

### 17.8 Content management
Categories & sub-categories (dynamic via `ServiceCategoryConfig`) · category
images/order/SEO · promotions & campaigns (`/admin/promotions` +
`/admin/promotions/{id}/decision`) · group-buy moderation
(`/admin/group-buys/{id}/decision`) · flash sales · coupons · referral
program settings · banners (`/admin/banners` CRUD with
placement/schedule/metrics) · **home sections** · **campaign pages** ·
**editorial content** · **help articles + FAQ** (`/admin/help/articles`
CRUD) · **promotional content** · notification broadcast
(`/admin/notifications/send` — targeted audience, scheduled, deep links) ·
email/SMS/push templates (`/admin/templates`) · email + SMS template
management (variables).

### 17.9 Analytics & reporting
BI dashboard (executive KPIs) · revenue analytics · order analytics · user
growth · retention/churn · merchant/provider analytics (top, compare,
retention) · rider analytics (performance, fleet efficiency, retention) ·
customer analytics (segments, cohorts, LTV, churn) · operations analytics
(SLA compliance, completion, response, dispatch efficiency) · financial
reports (revenue, commission, settlement, refund, tax) · custom reports
(`/admin/reports` builder + scheduling + csv/xlsx/pdf/json) · geographic
analytics (heat maps, region performance, coverage gaps). The **platform
analytics** group covers: GMV, orders, **completed transactions**, customers,
merchants, providers, riders, **delivery performance**, **service
performance**, revenue, **take rate**, **conversion**, retention,
cancellation, refunds, SLA, quality — one dashboard set for the whole
platform, deeper than merchant analytics.
**API**: `GET /admin/analytics/{scope}` with scope enum `revenue`, `orders`,
`growth`, `retention`, `fleet`, `operations`, `gmv`, `take_rate`, `quality`
and `from/to/groupBy` (`day`/`week`/`month`/`category`/`region`).

### 17.10 Support & ticketing
Ticket dashboard (open vs closed, response time, agent performance) · ticket
management (list, detail with conversation + order/booking ref, assign via
`/admin/support/tickets/{id}/assign`, reply, escalate, close, transfer) ·
live chat support (queue, agent chat, history, predefined responses) ·
dispute resolution (list, detail with evidence, mediate, rule, escalate) ·
customer feedback management (list, detail with context,
resolve/escalate/forward). **Customer support console**: inbox with
New / Assigned to me / Waiting / Escalated / Resolved buckets + suggested
resolution (ticket context, refund eligibility, order state, conversation
history).

### 17.11 Quality & trust
Review moderation (`/admin/reviews/moderate` — publish/hide/delete + reason,
bulk) · fraud detection (alerts, review/order analysis, actions:
investigate/block/file report) · risk cases (§Risk & trust cases) · quality
score configuration + recalculation · compliance tracking
(certificate/insurance/license expirations + alerts via `/admin/compliance`
surfaces + `admin.compliance_expiring`) · audit & security (system audit
log, login activity, suspicious logins).

### 17.12 Settings & configuration
General (name/logo/contact/timezone/currency/language) · order settings
(min order, delivery fees, cancellation/refund policy) · booking settings
(rules, time slots, lead time) · pricing (dynamic, surge, commissions) ·
notification settings (push/SMS/email keys) · payment gateway configuration
(`change_payment_settings` is two-person) · SLA rules (`/admin/sla-rules` +
`admin.sla_breach` alerts) · user role management (`/admin/staff-roles`
custom roles) · audit configuration (logging prefs, retention) · feature
flags (`/admin/features` → `GET /experiments` for clients; enable/disable,
rollout %, beta, targeting by country/region/city/segment/userPct). See
§Configuration center.

### 17.13 Audit
System audit log query (`/admin/audit-logs` — filters actor/entity/range;
compliance-gated) · login activity · export (permissioned + audited) ·
immutable retention (7y money/identity, 2y other) · two-person approval
queue (view + decide) · risk case decisions · access logs.

### 17.14 Customer support console
Inbox buckets: New / Assigned to me / Waiting / Escalated / Resolved; agent
flow per ticket: **customer → current transaction → timeline → relevant
entities → suggested resolution**; ticket detail with the linked
order/booking/shipment universal view; suggested resolution panel (refund
eligibility, cancellation policy match, voucher verification state,
conversation history summary); actions (reply, assign, escalate, close,
transfer, refund, cancel, reschedule, contact merchant/provider/rider,
create incident) all audited (`ticket.*`).

### 17.15 Finance console
Transactions, payments, refunds, settlements, **provider payouts**,
**merchant settlements**, fees, commissions, taxes, chargebacks, ledger —
one console with a consolidated money overview: pending settlements, refund
queue depth, payout exceptions, chargeback queue, ledger balances; finance
operates on an **immutable ledger** — balances are never edited manually;
every action reason-gated and audited (`refund.*`, `payout.*`,
`settlement.*`); `modify_ledger` two-person.

### 17.16 Trust & risk domain
A dedicated navigation domain, not a sub-item:

```
Trust & Risk
├── Risk dashboard
├── Fraud alerts
├── Account investigations
├── Payment risk
├── Provider risk
├── Rider risk
├── Customer abuse
├── Promotion abuse
├── Location anomalies
├── Device risk
└── Cases
```

Risk case dashboard (severity × status matrix), case detail (risk level,
signals like **multiple accounts** / unusual refunds / device reuse,
related: customer, orders, payments, devices, **IP history**; timeline),
review actions (dismiss/block_user/block_provider/escalate/hold), risk rule
configuration (risk thresholds in the configuration center), fraud-spike
monitoring on the control tower.

### 17.17 Compliance console
Compliance tree: **provider verification**, **merchant verification**,
documents, **expiring documents**, **licensing**, **regional
requirements**, audit, **regulatory reports**. Compliance expirations
(`admin.compliance_expiring`), document/certification expiry calendar, audit
queries, data-export approvals (dual control), blocked-conversation history,
damage/loss claim review, regulated decision records. Read-only surfaces
plus decision queues; all gated and audited.

### 17.18 Promotions administration
Promotions tree: **campaigns**, **coupons**, **merchant promotions**,
**platform promotions**, **loyalty**, **referral**, **eligibility rules**,
**budgets**, **performance**. Campaign builder:
Audience → eligibility → products → discount → budget → time → regions →
limits → review → publish. The builder is a guided flow that ends in the
moderation queue (`GET /admin/promotions?state=pending_review`); decisions
via `POST /admin/promotions/{id}/decision` (approved/rejected/paused +
reason). Audience targeting uses the same segment model as feature flags
(countries/regions/cities/segments/userPct).

### 17.19 CMS
Content and SEO module: banners, **home sections**, categories, **campaign
pages**, **editorial content**, help articles, **FAQ**, **promotional
content**, notification templates; all content changes audited
(`content.*`). **CMS editorial workflow** (P2): draft → review → publish
with scheduled publication and rollback.

### 17.20 Deep analytics
`GET /admin/analytics/{scope}` for `gmv`, `take_rate`, `quality` beyond the
base scopes: GMV trends, take-rate analysis by category/merchant, quality
metrics (completion, refund, cancellation, SLA, ratings). Reports builder
(`POST /admin/reports`) + scheduling + exports (csv/xlsx/pdf/json).

### 17.21 Catalog / service configuration
One of the most powerful modules: admins define a service type from a form,
no developer involvement. A service definition has: **category, service,
questions, pricing, rules, required skills, required certifications, SLA,
commission, cancellation policy, warranty, availability, service area**.
Example: adding "**air-conditioner repair**" — name, category, pricing model,
skills (HVAC), certifications (refrigerant handling), SLA, commission,
warranty window, availability, service area — is a configuration change, not
a code change. Changes write `configuration.*` audit entries and publish to
clients via the catalogue endpoints (`/services`, `/catalogues/me`).

---

## 18. Access control matrix (all levels)

| Level | Mechanism | Contract |
| --- | --- | --- |
| Auth | OTP + mandatory MFA, 20-min timeout, refresh rotation | `AUTH.md`, `admin-web/SECURITY.md` |
| RBAC | 20 roles + custom (`/admin/staff-roles`) | `admin-web/ROLES-PERMISSIONS.md` |
| ABAC | resource/region/tenant conditions on each action | `backend/AUTH.md` |
| Permissions | action catalog (`order.read`, `configuration.edit`, `iam.manage`, `audit.read`…) | `ROLES-PERMISSIONS.md` |
| Masking | sensitive fields masked; unmask permissioned + audited | `SECURITY.md`, `AUDIT.md` |
| Audit | every mutation logged; WHO/WHAT/WHEN/WHERE/WHY/BEFORE/AFTER + reason | `AUDIT.md` |
| Isolation | chain/fleet/region scopes | `backend/AUTH.md` |
| Two-person | dangerous actions need a second admin; same-actor blocked; executes on approval | `API.md` (workflow 31) |
| Read-only auditor | `audit.read` only; all mutations rejected | `ROLES-PERMISSIONS.md` |

---

## 19. Technical architecture

- **Stack**: React + Vite + TypeScript; Tailwind 4 (design tokens from
  `DESIGN-SYSTEM.md`); React Query (server state), Zustand (UI state);
  react-router with role guards; Recharts/ECharts (charts); Leaflet/Mapbox
  (maps — live map layers); AG Grid (tables — enterprise tables, saved
  views, bulk ops); WS `/events` (realtime); command palette (Ctrl/Cmd+K)
  with global search + actions.
- **Layout**: sidebar (15 navigation groups) + topbar (search, alerts, admin
  switcher, logout); module folders in `src/modules/*` mirroring this
  blueprint.
- **Recommended folder structure** (the admin web is several applications in
  one shell, so the tree separates shell, platform, and domains):

```
admin-web/
├── app/                  routing, layouts, providers, bootstrap
├── core/                 api client, auth, permissions, feature-flags,
│                         realtime, audit, telemetry
├── design-system/        tables, forms, filters, maps, timelines, drawers,
│                         modals, command-palette, charts
├── domains/              operations, orders, logistics, dispatch, hubs,
│                         providers, merchants, riders, customers, services,
│                         finance, support, risk, compliance, marketing,
│                         analytics, configuration, iam, audit
└── shared/               hooks, utils, types, constants
```
- **Data**: all via `/admin/*` endpoints; MSW parity in dev.
- **UX**: dense UI (`data-dense`), keyboard shortcuts, side drawers, saved
  views, bulk ops, undo/redo (planned), responsive desktop/tablet.
- **i18n**: en/sw/ar ready. **Accessibility**: WCAG 2.1 AA.
- **Integrations (planned)**: QuickBooks/Xero, CRM, Zendesk/Freshdesk, Slack/
  Teams alerts (integration health registry monitors their connectivity).

## 20. Priorities

- **P0 (launch + control plane)**: Control tower, global search, universal
  entity view, Dashboard, Users (search/verify/suspend), Merchant/Provider
  onboarding + management, Rider management, Orders/Bookings detail +
  dispatch console, Payments (transactions/settlements/refunds/commissions),
  Reviews moderation, Support tickets, Audit logs, Staff roles, Feature
  flags (with targeting), SLA rules, two-person authorization, integration
  health, live map core layers.
- **P1**: Logistics control tower + custody audit, hub dashboards, risk
  cases, Banners/templates/broadcast, Custom reports, Commission overrides,
  Wallet adjustment, Fraud analysis, Compliance tracking, Live chat support,
  Dispute resolution, Analytics scopes (incl. `gmv`/`take_rate`/`quality`),
  command palette.
- **P2**: Custom report scheduling, Mobile admin app, ERP/CRM/chat
  integrations, IAM teams/policies, CMS editorial, config center full,
  Undo/redo, geographic coverage gap analysis.

### Priority classification of the new capabilities

| Capability | Class | Milestone |
| --- | --- | --- |
| Operations control tower (`GET /admin/control-tower`) | P0 | Control-plane P0 |
| Global search (`GET /admin/search`) | P0 | Control-plane P0 |
| Universal entity view | P0 | Control-plane P0 |
| Live map layers | P0 | Control-plane P0 |
| Dispatch console | P0 | Control-plane P0 |
| Two-person authorization | P1 | Control-plane P1 |
| Risk cases (`GET /admin/risk/cases`) | P1 | Control-plane P1 |
| Hub dashboards (`GET /admin/hubs/{id}/dashboard`) | P1 | Control-plane P1 |
| Integration health (`GET /admin/integrations`) | P1 | Control-plane P1 |
| Fleet management module | P1 | Control-plane P1 |
| Hub operations module | P1 | Control-plane P1 |
| Trust & risk cases module | P1 | Control-plane P1 |
| Integration health module | P1 | Control-plane P1 |
| Command palette (Ctrl/Cmd+K) | P2 | Control-plane P2 |
| IAM teams/policies | P2 | Control-plane P2 |
| CMS editorial | P2 | Control-plane P2 |
| Configuration center full | P2 | Control-plane P2 |

## 21. Build phases

P0 foundation (auth/MFA, shell, roles, audit) → P0 operations (users,
merchants, providers, riders, orders, bookings, payments, support, quality) →
P0 control plane (control tower, global search, universal entity view, live
map, dispatch console) → P1 scale (logistics, hub dashboards, risk cases,
two-person authorization, integrations, content ops, reports, analytics,
compliance) → P2 ecosystem (command palette, IAM teams/policies, CMS
editorial, config center full, integrations, mobile, automation).
See `admin-web/ROADMAP.md` for gates.
