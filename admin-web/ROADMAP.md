# HUDumika Admin Web — Roadmap

Aligned with `functionalities/ROADMAP.md` and `backend/ROADMAP.md`. The admin web is mock-first (MSW against the contract) and wires to the real API when each backend milestone lands.

## P0 — Foundations

- Scaffold (Vite + React + TS, design system tokens).
- Staff login: OTP → MFA → role-scoped session.
- App shell: sidebar navigation, module routing with role guards.
- MSW handlers for auth + admin surface.

**Exit:** staff can log in with MFA against mocks; role determines visible modules.

## P1 — Marketplace administration

- Overview dashboard (metrics + queues).
- Merchants: queue, verification states, documents, approve/reject/request changes, commercial terms.
- Providers: verification, qualifications, approve flow.
- Riders: verification, documents, approve flow.
- Cities and service areas; service catalogue management.

**Exit:** approve merchant/provider/rider end-to-end on mocks; real API wiring when backend M2 ships.

## P2 — Order and booking oversight

- Orders: search, detail timeline, refunds, cancellations.
- Bookings: search, detail, no-show handling.
- Dispute resolution workflow with payout hold awareness.

**Exit:** resolve a dispute end-to-end; refund rules and audit entries verified.

## P3 — Dispatch monitor

- Stuck-order view, acceptance-timeout surfacing, re-queue/reassign actions, rider pool depth.

**Exit:** monitor data live on staging with backend M5.

## P4 — Money

- Payments: intents, refund thresholds.
- Payouts: batches, exceptions, reconciliation workflow, finance sign-off.

**Exit:** reconcile a payout batch against a gateway report; exception resolution audited.

## P5 — Engagement and moderation

- Reviews: moderation queue, reports, publish/hide/delete, author velocity flags.
- Support: ticket queue, SLAs, assignment, escalation.
- Notifications to parties on decisions.

**Exit:** moderation and support workflows green on staging.

## P6 — Content, promotions, audit, launch

### P6a — Content and SEO

- Content and SEO module (marketing copy, banners, service content, site metadata).

### P6b — Promotions oversight

- Promotions module: campaign-type overview (discount, spend_based, instant_discount, bargain, coupon, traffic), moderation queue, decisions (approved/rejected/paused + reason), coupon campaign oversight (quantity vs claimed), budget anomaly views.

**Exit:** approve a promotion end-to-end on mocks; decision trail verified; wired to the real API when backend M7c lands.

### P6c — Commerce ops moderation

- Group buy operations: deal queue, moderation decisions (approved/rejected/delisted + reason), sold voucher views, extension requests, expiry/refund edge cases.
- Voucher operations: staff verification (`/admin/vouchers/verify`) for disputes, verification history, refund handling.

**Exit:** group buy moderated and voucher dispute verified end-to-end. **Dependency: backend M7c** (group buy + promotions engine, weeks 16–18).

### P6d — Loyalty oversight

- Merchant loyalty config oversight: review tiers (`discountBps`, `thresholdTZS`, perks) and top-up rewards (`thresholdTZS`/`bonusTZS`) for compliance.
- Analytics exports for finance (permissioned, logged downloads).

**Exit:** loyalty config review workflow green. **Dependency: backend M7d** (loyalty + staff + wallet, weeks 18–19) and M7e analytics exports.

### P6e — Audit and launch

- Audit logs module (query, filters, export, unmask).
- Hardening: full permission matrix tests, E2E suite, security review.
- Production launch (separate hostname, network policy, MFA enforced).

**Exit:** production launch checklist complete; all modules live.

## P8 — Enterprise oversight

### P8a — Enterprise chains (backend M9a, weeks 23–24)

- Enterprise chains module: chain list (`GET /admin/chain`), tier/SLA/account manager view, `monthlyVolumeTZS` visibility, suspension (reason + audit).

**Exit:** chain onboarded with tier assignment end-to-end on mocks; wired to the real API when backend M9a lands.

### P8b — Integrations and webhooks health (backend M9b, weeks 25–26)

- Failing webhook monitor (`GET /admin/webhooks?failingOnly=true`), integration disconnect oversight, retry backoff view (`attempts`, `nextRetryAt`).

**Exit:** a `failed` delivery surfaces in the monitor and the runbook clears it (retrying → success); wired to the real API when backend M9b lands.

### P8c — Data export queue (backend M9c, weeks 27–28)

- Data export queue (`GET /admin/data-exports`), approval decisions (reason + audit, dual control for enterprise scope), re-run, audited downloads.

**Exit:** export job approved, run, and audited end-to-end; wired to the real API when backend M9c lands.

## Control-plane milestones

The admin web's control-plane expansion: the platform-level command center
(control tower, global search, universal entity view, live map, dispatch
console, two-person authorization, risk cases, hub dashboards, integration
health, command palette, IAM, configuration center). All endpoints are live in
`backend/API-CONTRACT.yaml` (`/admin/search`, `/admin/two-person-approvals`,
`/admin/hubs/{hubId}/dashboard`, `/admin/control-tower`, `/admin/risk/cases`,
`/admin/integrations`); the admin web is mock-first (MSW against the contract)
and wires to the real API as each backend milestone lands.

### CP-P0 — Control-plane foundation

- **Operations control tower** (`GET /admin/control-tower`): totals (8 stat
  cards), network health (delivery + service splits), critical actions (6
  deep-linked counts); workflow 33 response drills.
- **Global search** (`GET /admin/search`): top-bar search + overview
  quick-search; entity prefixes (`ORD-`, `SHP-`, `CUS-`, `PRV-`, `RDR-`,
  `MRC-`, `JOB-`); entity-type filters (11 types); universal-entity-view
  drill-in; `ADMIN_SEARCH_INVALID` handling; ABAC scoping.
- **Universal entity view**: the standard detail template (status, parties,
  origin/destination, location, timeline, actions, audit, events, scans,
  actors, locations, devices) applied to orders, shipments, providers,
  merchants, customers, riders.
- **Live map core layers**: riders, vehicles, hubs, merchants, providers,
  active deliveries, service jobs (traffic/geofences/incidents land with the
  map milestone); vehicle click → trip/shipments/ETA; rider click → current
  job/status.
- **Dispatch console**: unassigned list + map, assign, reassign, bulk assign,
  schedule, reschedule, cancel, escalate
  (`/admin/orders/{id}/assign-rider`,
  `/admin/bookings/{id}/assign-provider`,
  `/admin/shipments/{id}/reassign`).

**Exit:** control tower renders live totals with working deep links; global
search finds any entity by prefix and opens the universal view; dispatch
console assigns and reassigns end-to-end on mocks.

### CP-P1 — Control-plane scale

- **Two-person authorization**: approval queue (`GET /admin/two-person-
  approvals`), initiate composer, second-admin decision (approve/reject),
  same-actor block (`APPROVAL_SAME_ACTOR`), execution-on-approval,
  `two_person_approval.*` audit pair.
- **Risk & trust cases**: risk dashboard (severity × status), case detail
  (signals, related entities, ipHistory/device context), review actions
  (dismiss/block_user/block_provider/escalate/hold), `risk_case.*` audit.
- **Hub dashboards** (`GET /admin/hubs/{hubId}/dashboard`): load cards,
  sortation queues, staff, vehicles, exceptions, capacity warnings →
  control-tower interplay.
- **Integration health** (`GET /admin/integrations`): 9-category registry,
  healthy/degraded/down, technical operations module, alert wiring.
- **Fleet management** module (vehicle fleet by type/status, vehicle detail
  with driver/capacity/compartments/current trip/maintenance/insurance/
  registration).
- **Hub operations** module (hub list + dashboard + performance).
- **Trust & risk cases** module; **integration health** module.
- **Analytics scope extensions**: `gmv`, `take_rate`, `quality`.
- **Feature flag targeting**: countries/regions/cities/segments/userPct.

**Exit:** a dangerous action completes only through the two-person flow with
the audit pair; a risk case blocks a user end-to-end; hub dashboards and the
integration registry render live; feature flags roll out to one region.

### CP-P2 — Control-plane depth

- **Command palette** (Ctrl/Cmd+K): global search + screen navigation (15
  groups) + actions + saved views.
- **IAM teams/policies**: admin teams, ABAC policies, organizations,
  regions-as-scope, access-log analytics beyond the base surface.
- **CMS editorial**: draft → review → publish with scheduling and rollback.
- **Configuration center full**: the complete domain set (regions, cities,
  zones, fees, commissions, tax, cancellation, SLA, matching, risk, feature
  flags, notification rules) with change review and audit surfacing.
- **Navigation blueprint** (15 groups) final polish; keyboard-shortcut cheat
  sheet; saved views sharing.

**Exit:** full control-plane feature set live; E2E suite green; production
launch checklist complete.

---

## Implementation status (admin-web build, current)

| Milestone | Status | Notes |
| --- | --- | --- |
| M1 — Test foundation | DONE | typecheck + 608 vitest tests + build gate green; no inline money/locale debt |
| M2 — CRUD modules | DONE | all 35 modules real; every list uses the shared DataTable (sort, pagination, CSV export, J/K/Enter/E keys) |
| M3 — Towers / dispatch / search / approvals | DONE | deep links, dispatch monitor + reassign, global search + universal entity view, two-person approvals, Ctrl+K palette |
| M4 — COD reconciliation | DONE (read-only) | shifts/totals/signed variance/date range; decision endpoints pending backend (see `docs/PENDING-ENDPOINTS.md`) |
| M5 — Fleet & logistics towers | DONE | fleet + logistics towers, waybill & custody audit, hub dashboards, coverage map |
| M6 — Hardening | DONE | staff OTP/MFA session (20-min timeout, logout), RBAC gating on 19 mutation pages, 20-role registry, permissioned unmask, long-poll freshness, self-hosted fonts, security meta |
| Release gate | DONE | E2E 30 specs (incl. super-admin smoke) green on mocks; parity 57 cases (47 happy + 10 error paths) in CI; staging workflow wired (`admin-web-staging.yml`) |

**Pending backend (documented for Team 6 in `docs/PENDING-ENDPOINTS.md`):** rider/provider approval, dispute decisions, payout reconcile, COD decisions, chain onboard/suspend, export approve/re-run, loyalty config, crash response, rest override, seal-broken resolution, anomaly decisions, order cancel, consignment missing-order resolution. Each surface renders full UI and resolves to a `PENDING_ENDPOINT` notice until the contract lands.
