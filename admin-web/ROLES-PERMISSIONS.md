# HUDumika Admin — Roles and Permissions

Enforced **server-side** on every admin route. The admin web only renders what the API returns; it never gates permissions itself.

## The 20-role model

The control-plane blueprint defines twenty built-in admin roles. Every role is a
bundle of **action permissions** (the permission catalog below), layered with
**ABAC + resource/context rules** (regional ops manage only their region, finance
sees financial data but cannot edit job execution, support sees masked PII until
granted) and **tenant isolation** (chain/fleet scopes never cross).

| # | Role | Domain | Summary |
| --- | --- | --- | --- |
| 1 | Platform Owner | Governance | Full platform control: everything the Platform Administrator holds plus role management, audit access, and change-owner decisions (the legacy "super admin"). Owns the platform, holds every permission including `iam.manage` and `audit.read`. |
| 2 | Platform Administrator | Governance | Day-to-day deputy of the Owner: all operational and configuration permissions (`configuration.edit`, `iam.manage`) minus the owner-only change-owner decision. Second approver for two-person authorizations. |
| 3 | Operations Manager | Operations | Runs the platform day-to-day: order/dispatch escalation, ticket reassignment, logistics network, exceptions, hubs, warehouses, carriers, facilities, fleet. First-line escalation target for the control tower and dispatch failures. |
| 4 | Dispatch Manager | Operations | Owns the dispatch console: unassigned queues, assignment, reassignment, bulk assignment, scheduling, rescheduling, cancellation, escalation. Holds `dispatch.*` and `order.override`/`shipment.reassign`. |
| 5 | Regional Operations Manager | Operations | Operations for a bounded set of regions/cities (ABAC-scoped): regional dispatch, hubs, warehouses, carriers, facilities, delivery exceptions, regional dashboards. Never crosses region scope. |
| 6 | Merchant Operations | Commerce | Merchant onboarding, verification, catalogue review, commercial terms, suspensions. Holds `merchant.read`/`merchant.approve`/`merchant.suspend`. |
| 7 | Provider Operations | Commerce | Provider onboarding, verification, qualifications, reliability, suspensions. Holds `provider.read`/`provider.verify`/`provider.suspend`. |
| 8 | Rider Operations | Logistics | Rider onboarding, verification, vehicles, reliability, rest/safety enforcement, fleet sub-accounts. Holds `provider`-adjacent rider permissions (rider.read/verify/suspend modeled under the provider group) plus `dispatch.read`. |
| 9 | Customer Support | Support | Customers, tickets, conversations, review reports, in-threshold refunds with a linked ticket. No financial actions above threshold. |
| 10 | Finance | Finance | Payments, refunds, payouts, reconciliation, settlements, ledger, taxes, chargebacks, promotions budgets. Holds `finance.read`/`finance.refund`/`finance.payout_adjust`. |
| 11 | Payments | Finance | Payment operations specialist: intents, capture/refund execution, payment-provider health, gateway configuration oversight, chargebacks. Holds `finance.read` + payment-specific surfaces. |
| 12 | Risk & Fraud | Trust & Safety | Risk cases, signals, investigations, blocks. Holds `risk.investigate`/`risk.block`; the second decision surface for the risk domain. |
| 13 | Trust & Safety | Trust & Safety | Rider/provider/customer safety, review moderation, abuse reports, conversation blocks, SOS/fatigue escalation oversight, logistics anomaly actors. Shares `risk.investigate`; holds review/moderation permissions. |
| 14 | Compliance | Governance | Review moderation, disputes, audit logs, sensitive unmask, compliance expirations (`admin.compliance_expiring`), data-export approvals, regulated decisions. Holds `audit.read` + moderation permissions. |
| 15 | Marketing | Growth | Promotions, campaigns, coupons, flash sales, group buys, notification broadcasts, customer segments. Holds promotion/campaign moderation permissions. |
| 16 | Analytics | Growth | Analytics scopes (revenue/orders/growth/retention/fleet/operations/gmv/take_rate/quality), custom reports, data exports, retention analysis. Read-only on operational data; no mutations. |
| 17 | Content Manager | Growth | Service catalogue, cities/areas, content and SEO, banners, templates, help articles, promotion campaign building. Holds `configuration.edit` scoped to content/catalogue config. |
| 18 | Technical Operations | Platform | Infrastructure and integrations: integration health, webhooks, feature flags, technical configuration, monitoring, deployment surfaces. Holds `configuration.edit` scoped to technical config. |
| 19 | Security Administrator | Governance | IAM operations: admin users, teams, roles, permissions, policies, sessions, devices, MFA, access logs. Holds `iam.manage` + `audit.read`; the second approver for `change_iam_policy`. |
| 20 | Read-only Auditor | Governance | `audit.read` only. No mutations anywhere. Used for external audits, compliance reviews, and observer sessions. |

### Legacy naming map

| Legacy role name | New canonical role |
| --- | --- |
| Super admin | Platform Owner (alias retained in docs) |
| Operations manager | Operations Manager |
| Customer support agent | Customer Support |
| Merchant operations | Merchant Operations |
| Provider operations | Provider Operations |
| Rider operations | Rider Operations |
| Finance | Finance |
| Content manager | Content Manager |
| Compliance reviewer | Compliance |
| Logistics operations | Functional role held by Operations Manager, Dispatch Manager, and Regional Operations Manager (capability set documented below) |
| Warehouse manager | Functional role held by Regional Operations Manager (registry + stock domain) |
| Carrier manager | Functional role held by Regional Operations Manager (carrier registry domain) |
| Facility manager | Functional role held by Regional Operations Manager (facilities domain) |
| Fleet account manager | Functional role held by Rider Operations + Technical Operations (fleet accounts domain) |

Legacy tables below use the old names where they were written; the mapping
applies everywhere.

## Role responsibilities and permission sets

### 1. Platform Owner

- Owns the platform: every permission in the catalog including `iam.manage`,
  `audit.read`, `configuration.edit`, and owner-only change decisions.
- Approves the final decision on two-person authorizations when acting as the
  second admin; can also initiate.
- Manages admin users, teams, roles, permissions, policies, regions,
  organizations, sessions, devices, MFA, and access logs (IAM module).
- Owns audit access: full audit log queries, unmask of sensitive entries,
  audited exports.
- Suspends staff; suspension revokes all sessions immediately.
- **Permission set**: all permissions (full catalog).

### 2. Platform Administrator

- Same operational surface as the Owner: orders, bookings, dispatch escalation,
  logistics, money decisions, risk, configuration, IAM day-to-day.
- Cannot transfer platform ownership (owner-only decision).
- Acts as the second admin in two-person authorizations for
  `change_iam_policy`, `change_payment_settings`, `delete_critical_data`.
- **Permission set**: full catalog minus owner-only change-owner decision;
  `iam.manage` (non-owner scope).

### 3. Operations Manager

- All operational modules: overview, orders, bookings, dispatch monitor,
  logistics control tower, hubs, warehouses, carriers, facilities, fleet,
  delivery exceptions (18 kinds), support ticket reassignment, chain oversight.
- First-line escalation target: control-tower critical actions, dispatch
  failures, SLA breaches, shipment exceptions, hub capacity warnings.
- Holds reassignment, escalation, freeze/release, and exception escalation
  decisions (ops-manager-and-above gates).
- **Permission set**: `order.read`/`order.cancel`/`order.override`,
  `shipment.read`/`shipment.reassign`/`shipment.hold`/`shipment.release`,
  `dispatch.read`/`dispatch.assign`/`dispatch.reassign`,
  `provider.read`, `merchant.read`, `finance.read`, `audit.read`,
  `configuration.edit` (operations scopes).

### 4. Dispatch Manager

- Owns the dispatch console (module: Dispatch monitor): unassigned lists,
  assignment, reassignment, bulk assignment, schedule, reschedule, cancel,
  escalate.
- Uses `POST /admin/orders/{orderId}/assign-rider`,
  `POST /admin/bookings/{bookingId}/assign-provider`,
  `POST /admin/shipments/{shipmentId}/reassign`.
- Watches acceptance timeouts, rider pool depth, stuck orders; escalates to
  Operations Manager for incidents.
- **Permission set**: `dispatch.read`/`dispatch.assign`/`dispatch.reassign`,
  `order.read`/`order.override`, `shipment.read`/`shipment.reassign`,
  `provider.read`, `merchant.read`.

### 5. Regional Operations Manager

- ABAC-scoped: every operation is bound to the admin's region/city list
  (`regions` on the staff record; server-enforced).
- Regional dispatch, hubs, warehouses, carriers, facilities, delivery
  exceptions, regional dashboards, regional SLA monitoring.
- **Permission set**: Operations Manager's set scoped by region ABAC rules.

### 6. Merchant Operations

- Merchant applications, verification states, documents, commercial terms
  (`commissionRateBps`, `payoutCycleDays`), suspensions.
- Catalogue review; loyalty config oversight; chain tier/SLA reviews.
- **Permission set**: `merchant.read`/`merchant.approve`/`merchant.suspend`,
  `finance.read` (commission visibility), `order.read`.

### 7. Provider Operations

- Provider applications, verification, qualifications, trade/service areas,
  certifications, insurance, reliability scores, suspensions.
- **Permission set**: `provider.read`/`provider.verify`/`provider.suspend`,
  `order.read`, `booking.read`.

### 8. Rider Operations

- Rider applications, verification, documents, vehicles, reliability, online
  history, COD reconciliation, rest enforcement, crash response, fleet
  sub-account linkage (`serviceModel: fleet` + `fleetAccountId`).
- **Permission set**: `rider.read`/`rider.verify`/`rider.suspend` (rider group),
  `dispatch.read`, `shipment.read`, `fleet.*` registry surfaces.

### 9. Customer Support

- Customers, tickets (assign/reply/escalate/close), conversations (read-only
  oversight), review reports, voucher dispute verification, feedback.
- Refunds ≤ threshold with a linked ticket only.
- **Permission set**: `order.read`/`order.cancel` (with reason), `finance.refund`
  (≤ threshold, ticket-linked), `dispatch.read` (limited), `audit.read` (masked).

### 10. Finance

- Payments, refunds (all thresholds), payouts, settlements, reconciliation,
  ledger, taxes, chargebacks, wallet adjustment, commissions.
- Approves large exports (finance sign-off), views analytics exports read-only.
- **Permission set**: `finance.read`/`finance.refund`/`finance.payout_adjust`,
  `order.read`, `merchant.read`, `audit.read`.

### 11. Payments

- Payment specialist: intents, capture/refund execution, provider health
  (integration health — payment category), gateway configuration, chargeback
  handling.
- **Permission set**: `finance.read`/`finance.refund`, payment-specific surfaces,
  `integration.read` (payment category).

### 12. Risk & Fraud

- Risk cases (`GET /admin/risk/cases`), signals, related entities, review
  actions (dismiss/block_user/block_provider/escalate/hold).
- Fraud spike response on the control tower; payment-failure triage.
- **Permission set**: `risk.investigate`/`risk.block`, `order.read`,
  `finance.read` (fraud context), `provider.read`, `rider.read`.

### 13. Trust & Safety

- Safety: crash response, fatigue/rest enforcement, SOS escalation, abusive
  conversation blocks, review reports, logistics anomaly actor review.
- Shares risk-case investigation with Risk & Fraud.
- **Permission set**: `risk.investigate`, `review.moderate`, `conversation.*`
  blocks, `provider.read`/`rider.read`, `safety.*` surfaces.

### 14. Compliance

- Review moderation, disputes, audit logs (full detail), sensitive unmask,
  compliance expirations (`admin.compliance_expiring`), data-export approvals,
  blocked-conversation history, damage/loss claims review.
- **Permission set**: `audit.read` (unmask), `review.moderate`,
  `export.*` approvals, `merchant.read`/`provider.read`/`rider.read`.

### 15. Marketing

- Promotions, campaigns, coupons, flash sales, group buys, notification
  broadcasts (`admin.broadcast`), customer segments, campaign builder.
- **Permission set**: promotion/group-buy/coupon moderation permissions,
  `configuration.edit` (promotion scopes), `finance.read` (budgets read-only).

### 16. Analytics

- Analytics scopes (`revenue`, `orders`, `growth`, `retention`, `fleet`,
  `operations`, `gmv`, `take_rate`, `quality`), custom reports, data exports,
  retention/cohort analysis.
- Read-only: no operational mutations.
- **Permission set**: `analytics.read` (all scopes), `export.*` (request),
  `audit.read` (masked).

### 17. Content Manager

- Service catalogue, categories, cities/areas, content and SEO, banners,
  templates, help articles, promotions campaign building.
- **Permission set**: `configuration.edit` (content scopes),
  promotion/group-buy moderation permissions.

### 18. Technical Operations

- Integration health (`GET /admin/integrations`), webhook health, feature
  flags (with targeting), technical configuration, monitoring.
- **Permission set**: `configuration.edit` (technical scopes),
  `integration.read`, `feature.*`, `audit.read`.

### 19. Security Administrator

- IAM: admin users, teams, roles, permissions, policies, regions,
  organizations, sessions, devices, MFA, access logs.
- Second approver for `change_iam_policy` two-person authorizations.
- **Permission set**: `iam.manage`, `audit.read`, `configuration.edit`
  (security scopes).

### 20. Read-only Auditor

- `audit.read` only. No mutations. All read surfaces render masked; unmask is
  never granted.
- Used for external audits, compliance reviews, and observer sessions.
- The UI renders this role with every mutation action hidden; the API rejects
  any mutation attempt with 403 `FORBIDDEN`.

## Action permission catalog (complete)

Every permission is a `resource.action` string, server-enforced. The catalog:

| Permission | Resource scope | Description | Dangerous (two-person) |
| --- | --- | --- | --- |
| `order.read` | Orders | Read any order, timeline, parties, items, payment | — |
| `order.cancel` | Orders | Cancel an order (reason required) | — |
| `order.refund` | Orders | Decide a refund on an order (threshold rules; ticket link for support) | Above-threshold `large_refund` requests |
| `order.override` | Orders | Manual assignment override (`POST /admin/orders/{id}/assign-rider`, reason max 500) | — |
| `shipment.read` | Logistics | Read shipments, custody chains, waybill trails | — |
| `shipment.reassign` | Logistics | Active reassignment (`POST /admin/shipments/{id}/reassign`, reason required) | — |
| `shipment.hold` | Logistics | Freeze a shipment (`POST /admin/shipments/{id}/freeze`, reason required) | — |
| `shipment.release` | Logistics | Unfreeze a shipment (`POST /admin/shipments/{id}/unfreeze`, reason required) | — |
| `dispatch.read` | Dispatch | Read dispatch surfaces (monitor, pools, queues, unassigned) | — |
| `dispatch.assign` | Dispatch | Assign work (manual assignment, scheduling) | — |
| `dispatch.reassign` | Dispatch | Move work between actors (assign-rider, assign-provider, shipment reassign) | — |
| `provider.read` | Providers | Read providers, verification state, qualifications | — |
| `provider.verify` | Providers | Approve/reject provider verification and document reviews | — |
| `provider.suspend` | Providers | Suspend a provider (reason required) | — |
| `merchant.read` | Merchants | Read merchants, applications, commercial terms | — |
| `merchant.approve` | Merchants | Approve/reject merchant applications, set commercial terms | — |
| `merchant.suspend` | Merchants | Suspend a merchant (reason required) | `suspend_major_merchant` |
| `finance.read` | Finance | Read payments, refunds, payouts, settlements, ledger | — |
| `finance.refund` | Finance | Issue refunds (threshold rules) | Above-threshold `large_refund` |
| `finance.payout_adjust` | Finance | Payout adjustments, wallet adjustment (`POST /admin/wallets/{userId}/adjust`) | `modify_ledger` |
| `risk.investigate` | Risk | Open/advance risk cases, review signals, related entities | — |
| `risk.block` | Risk | Block users/providers from risk-case review actions | — |
| `configuration.edit` | Configuration | Configuration center: regions, cities, zones, fees, commissions, tax, cancellation, SLA, matching, risk, feature flags, notification rules — every change audited | `change_payment_settings`, `delete_critical_data` |
| `iam.manage` | IAM | Admin users, teams, roles, permissions, policies, regions, organizations, sessions, devices, MFA, access logs | `change_iam_policy` |
| `audit.read` | Audit | Read audit logs (compliance-gated detail), audited exports | — |

### Extended/legacy catalog (existing actions)

The pre-existing action surface remains in force and is bundled per role:

| Action | Description |
| --- | --- |
| `orders.view` | View order list/detail (alias of `order.read`) |
| `refund.approve` | Approve refunds (finance role; above threshold) |
| `review.moderate` | Reviews: publish/hide/delete + reason |
| `group_buy.moderate` | Group buy decisions: approved/rejected/delisted + reason |
| `promotion.moderate` | Promotion decisions: approved/rejected/paused + reason |
| `voucher.verify` | Staff voucher verification in disputes |
| `conversation.block` | Block abusive conversations (reason max 500, audit `conversation.*`) |
| `chain.*` | Enterprise chain tier/SLA/account manager changes, suspensions |
| `webhook.*` | Webhook health views and delivery-failure responses |
| `export.*` | Data export approvals (dual control for enterprise scope), audited downloads |
| `cod.*` | Rider COD reconciliation decisions |
| `safety.*` | Crash/fatigue escalation handling, rest enforcement |
| `fleet.*` | Fleet control tower views, fleet account registry |
| `hub.*` / `consignment.*` / `handoff.*` / `waybill.*` | Intercity and line-haul oversight |
| `shipment.*` / `trip.*` / `reconciliation.*` / `anomaly.*` | Logistics OS audit surface |
| `warehouse.*` / `carrier.*` / `facility.*` / `exception.*` | Deep-logistics registries and delivery exceptions |

## Two-person authorization rule

Certain dangerous actions must be authorized by **two different admins** (4-eyes
principle). The rule applies to the eight action types below. Flow:

1. An admin with the underlying permission **initiates** via
   `POST /admin/two-person-approvals` with `{actionType, targetType, targetId,
   reason (max 1000), payload?}` → 201 pending approval.
2. A **different** admin (never the requester) decides via
   `POST /admin/two-person-approvals/{approvalId}/decision`
   `{decision: approve|reject, comment (max 1000)}`.
   - The requester attempting to decide → 409 `APPROVAL_SAME_ACTOR` (blocked).
   - A missing required second admin at the underlying action's execution point
     → 409 `TWO_PERSON_REQUIRED`.
   - An unknown approval → 404 `APPROVAL_NOT_FOUND`; a decided approval →
     409 `APPROVAL_ALREADY_DECIDED`.
3. **On approval the action executes** (the platform runs the requested
   operation with the recorded payload); on rejection nothing executes.
4. Every initiate and every decision writes an audit entry
   (`two_person_approval.*` — initiate, approve, reject with actor pairs,
   before/after approval state).

| actionType | Underlying permission | Example target |
| --- | --- | --- |
| `large_refund` | `finance.refund` (above threshold) | payment intent / order |
| `change_commission` | `configuration.edit` / `merchant.approve` | merchant |
| `suspend_major_merchant` | `merchant.suspend` | merchant (enterprise chain) |
| `change_payment_settings` | `configuration.edit` | gateway config |
| `modify_ledger` | `finance.payout_adjust` | ledger entry / payout |
| `change_iam_policy` | `iam.manage` | IAM policy |
| `delete_critical_data` | `configuration.edit` | export/retention/archive |
| `release_hold` | `shipment.release` / finance | shipment / payout hold |

Approval state machine: `pending → approved | rejected` (terminal; no reopen —
`APPROVAL_ALREADY_DECIDED`). The approval queue is `GET /admin/two-person-approvals?status=`
over `AdminTwoPersonApproval`: `{id, actionType, targetType, targetId, reason,
payload?, status, requestedBy, decidedBy?, decisionComment?, createdAt,
decidedAt?}`.

## Read-only Auditor role

- Single permission: `audit.read`. No mutations; the API rejects every mutation
  attempt with 403 `FORBIDDEN`.
- Can query `GET /admin/audit-logs`, view entity timelines (masked by default),
  and export audit views (itself audited).
- Never granted unmask; sensitive details stay masked (`audit.read` reads
  without `unmask` scope).
- Used for external audits, compliance reviews, and observer sessions; role
  changes are owner-only and audited.

## Permission matrix (20 roles)

Columns: **PO** Platform Owner · **PA** Platform Administrator · **OM**
Operations Manager · **DM** Dispatch Manager · **ROM** Regional Operations
Manager · **MO** Merchant Operations · **PVO** Provider Operations · **RO**
Rider Operations · **CS** Customer Support · **FI** Finance · **PY** Payments ·
**RF** Risk & Fraud · **TS** Trust & Safety · **CO** Compliance · **MK**
Marketing · **AN** Analytics · **CM** Content Manager · **TO** Technical
Operations · **SA** Security Administrator · **RA** Read-only Auditor.

| Action | PO | PA | OM | DM | ROM | MO | PVO | RO | CS | FI | PY | RF | TS | CO | MK | AN | CM | TO | SA | RA |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `order.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ | | | | |
| `order.cancel` | ✓ | ✓ | ✓ | ✓ | ✓ | | | | ✓ | ✓ | | | | | | | | | | |
| `order.refund` | ✓ | ✓ | ✓ | | ✓ | | | | ✓* | ✓ | ✓ | | | | | | | | | |
| `order.override` | ✓ | ✓ | ✓ | ✓ | ✓ | | | ✓ | | | | | | | | | | | | |
| `shipment.read` | ✓ | ✓ | ✓ | ✓ | ✓ | | | ✓ | | | | | | ✓ | | | | | | |
| `shipment.reassign` | ✓ | ✓ | ✓ | ✓ | ✓ | | | | | | | | | | | | | | | |
| `shipment.hold` | ✓ | ✓ | ✓ | | ✓ | | | | | | | | | ✓ | | | | | | |
| `shipment.release` | ✓ | ✓ | ✓ | | ✓ | | | | | | | | | ✓ | | | | | | |
| `dispatch.read` | ✓ | ✓ | ✓ | ✓ | ✓ | | | ✓ | ✓ | | | ✓ | ✓ | | | | | | | |
| `dispatch.assign` | ✓ | ✓ | ✓ | ✓ | ✓ | | | | | | | | | | | | | | | |
| `dispatch.reassign` | ✓ | ✓ | ✓ | ✓ | ✓ | | | | | | | | | | | | | | | |
| `provider.read` | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ | | ✓ | | ✓ | ✓ | ✓ | | | | | | |
| `provider.verify` | ✓ | ✓ | | | ✓ | | ✓ | | | | | | | | | | | | | |
| `provider.suspend` | ✓ | ✓ | ✓ | | ✓ | | ✓ | | | | | ✓ | | | | | | | | |
| `merchant.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | ✓ | ✓ | | ✓ | | ✓ | | ✓ | ✓ | | | |
| `merchant.approve` | ✓ | | | | | ✓ | | | | | | | | | | | | | | |
| `merchant.suspend` | ✓ | ✓ | ✓ | | ✓ | ✓ | | | | | | | | | | | | | | |
| `finance.read` | ✓ | ✓ | ✓ | | ✓ | ✓ | | | | ✓ | ✓ | ✓ | | ✓ | ✓ | ✓ | | | | |
| `finance.refund` | ✓ | | ✓ | | ✓ | | | | ✓* | ✓ | ✓ | | | | | | | | | |
| `finance.payout_adjust` | ✓ | | | | | | | | | ✓ | | | | | | | | | | |
| `risk.investigate` | ✓ | ✓ | ✓ | | ✓ | | | | | | | ✓ | ✓ | ✓ | | | | | | |
| `risk.block` | ✓ | ✓ | ✓ | | ✓ | | | | | | | ✓ | | | | | | | | |
| `configuration.edit` | ✓ | ✓ | ✓ | | ✓ | | | | | | | | | | | | ✓ | ✓ | | |
| `iam.manage` | ✓ | ✓ | | | | | | | | | | | | | | | | | ✓ | |
| `audit.read` | ✓ | ✓ | ✓ | | | | | | | ✓ | | | | ✓ | | ✓ | | | ✓ | ✓ |
| View overview | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Search customers | ✓ | ✓ | ✓ | ✓ | ✓ | | | | ✓ | ✓ | | ✓ | | ✓ | | ✓ | | | | |
| View merchant applications | ✓ | ✓ | ✓ | | ✓ | ✓ | | | | ✓ | | | | ✓ | | | | | | |
| Approve/reject merchant | ✓ | | | | | ✓ | | | | | | | | | | | | | | |
| Set commercial terms | ✓ | | | | | ✓ | | | | ✓ | | | | | | | | | | |
| Suspend merchant/provider/rider | ✓ | ✓ | ✓ | | ✓ | ✓ | ✓ | ✓ | | | | | | | | | | | | |
| View provider applications | ✓ | ✓ | ✓ | | ✓ | | ✓ | | | | | | | ✓ | | | | | | |
| View rider applications | ✓ | ✓ | ✓ | | ✓ | | | ✓ | | | | | | ✓ | | | | | | |
| View rider COD reconciliation | ✓ | | | | | | | ✓ | | ✓ | | | | | | | | | | |
| View orders/bookings | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ | | | | |
| Issue refund > threshold | ✓ | | | | | | | | | ✓ | | | | | | | | | | |
| Issue refund ≤ threshold | ✓ | ✓ | ✓ | | ✓ | | | | ✓* | ✓ | ✓ | | | | | | | | | |
| View payout batches | ✓ | | | | | | | | | ✓ | | | | ✓ | | | | | | |
| Resolve payout exception | ✓ | | | | | | | | | ✓ | | | | | | | | | | |
| Run reconciliation | ✓ | | | | | | | | | ✓ | | | | | | | | | | |
| Moderate reviews (hide) | ✓ | ✓ | ✓ | | ✓ | | | | ✓ | | | | ✓ | ✓ | | | | | | |
| Delete review | ✓ | | | | | | | | | | | | | ✓ | | | | | | |
| Assign/reassign tickets | ✓ | ✓ | ✓ | | ✓ | | | | ✓ | | | | | | | | | | | |
| View conversations | ✓ | ✓ | ✓ | | ✓ | | | | ✓ | | | | ✓ | ✓ | | | | | | |
| Block conversation | ✓ | | | | | | | | ✓ | | | | ✓ | | | | | | | |
| View blocked-conversation history | ✓ | | | | | | | | | | | | | ✓ | | | | | | |
| Export data | ✓ | ✓ | ✓ | | ✓ | | | | | ✓ | | | | ✓ | | ✓ | | | | |
| View audit logs | ✓ | ✓ | ✓ | | | | | | | | | | | ✓ | | | | | ✓ | ✓ |
| Unmask sensitive fields | ✓ | | | | | | | | | ✓ | | | | ✓ | | | | | | |
| Edit cities/catalogue/content | ✓ | | | | | | | | | | | | | | | | ✓ | | | |
| Approve/reject promotion | ✓ | ✓ | ✓ | | | | | | | | | | | | ✓ | | ✓ | | | |
| Pause promotion | ✓ | ✓ | ✓ | | | | | | | | | | | | ✓ | | | | | |
| Moderate group buy | ✓ | ✓ | ✓ | | | | | | | | | | | | ✓ | | ✓ | | | |
| Verify voucher in dispute | ✓ | | | | | | | | ✓ | | | | | | | | | | | |
| View analytics exports | ✓ | | | | | | | | | ✓ | | | | | | ✓ | | | | |
| Oversee merchant loyalty config | ✓ | ✓ | ✓ | | | ✓ | | | | | | | | | | | | | | |
| View enterprise chains | ✓ | ✓ | ✓ | | ✓ | ✓ | | | | ✓ | | | | | | | | | | |
| View fleet control tower | ✓ | ✓ | ✓ | ✓ | ✓ | | | ✓ | | | | | | | | | | | | |
| Suspend chain (reason + audit) | ✓ | ✓ | ✓ | | ✓ | | | | | | | | | | | | | | | |
| View webhook health | ✓ | ✓ | ✓ | | | | | | | | | | | | | | | ✓ | | |
| View data export queue | ✓ | | | | | | | | | | | | | ✓ | | | | | | |
| Approve large exports | ✓ | | | | | | | | | ✓ | | | | ✓ | | | | | | |
| Manage staff roles | ✓ | ✓ | | | | | | | | | | | | | | | | | ✓ | |
| Global search (`order.read`-level) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | ✓ | | | | |
| Two-person approval — initiate | ✓ | ✓ | ✓ | | ✓ | | | | | ✓ | ✓ | | | | | | | | ✓ | |
| Two-person approval — decide | ✓ | ✓ | ✓ | | ✓ | | | | | | | ✓ | | ✓ | | | | | ✓ | |
| Risk case review actions | ✓ | ✓ | ✓ | | ✓ | | | | | | | ✓ | ✓ | | | | | | | |
| Integration health view | ✓ | ✓ | ✓ | | | | | | | | ✓ | | | | | | | ✓ | | |
| Hub dashboard view | ✓ | ✓ | ✓ | ✓ | ✓ | | | | | | | | | | | | | | | |
| Control tower view | ✓ | ✓ | ✓ | ✓ | ✓ | | | | | | | ✓ | ✓ | | | | | | | |

\* Support may refund ≤ threshold only with a linked ticket.

## Moderation and oversight rules

- Promotion approvals/rejections/pauses and group buy approvals/rejections/delistings require a `reason` and always produce an audit entry (contract: reason max 1000).
- Voucher dispute verification by support agents is logged with the acting user; support never issues refunds without a linked ticket.
- Conversation blocks (`conversation.*`) require a `reason` (max 500) and always produce an audit entry; blocked-conversation history is compliance-gated. Staff never send messages inside customer-merchant conversations — support replies only via tickets.
- Finance sees promotion budgets and analytics exports read-only; only content manager, marketing, and ops make promotion decisions.
- Chain suspensions (`chain.*`) and data export approvals (`export.*`) require a `reason` and always produce an audit entry; enterprise-scope export approvals follow dual control (compliance sign-off, finance approval for large exports).
- Manual overrides (`assignment.*`) require a `reason` (max 500) and always produce an order event + audit entry; COD reconciliation decisions (`cod.*`) record the shift status change (`reconciled` / `pending` / `mismatch`) and the acting staff user.
- Fleet control tower (`fleet.*`) is view-only for ops manager + rider ops + super admin; crash-response actions (workflow 19) and early rest-enforcement overrides (workflow 20) are ops-manager-and-above with a required reason and audit entry.
- Deep-logistics registries: warehouse/carrier/facility/fleet mutations (modules 28–31) always require a `reason` and produce `warehouse.*` / `carrier.*` / `facility.*` / `fleet.*` audit entries; `NOT_WHITELISTED` incidents and delivery-exception resolutions (`exception.*`) follow the same rule. `POST /warehouses/{id}/fulfill` is order-tagged and server-driven — no staff role calls it from admin-web.
- **Two-person authorizations** (`two_person_approval.*`): initiate and decision both audited; same-actor decisions blocked (`APPROVAL_SAME_ACTOR`); the action executes only on second-admin approval; a dangerous action attempted without the two-person flow fails with 409 `TWO_PERSON_REQUIRED`.
- **Risk cases** (`risk_case.*`): review actions (dismiss/block_user/block_provider/escalate/hold) require a `reason` (max 1000) and produce audit entries; `block_user`/`block_provider` require the `risk.block` permission; already-decided cases reject new decisions (`RISK_CASE_ALREADY_DECIDED`).
- **Configuration center**: every `configuration.edit` change (regions, cities, zones, fees, commissions, tax, cancellation, SLA, matching, risk, feature flags, notification rules) requires a reason where the domain demands it and always produces an audit entry.
- **IAM**: `iam.manage` mutations (admin users, teams, roles, permissions, policies, regions, organizations, sessions, devices, MFA) are audited; `change_iam_policy` requires two-person authorization; role changes require Platform Owner or Platform Administrator and every change is an audit log entry.

## Deep logistics roles — capability matrix (modules 28–31)

| Action | Warehouse manager | Carrier manager | Facility manager | Fleet account manager | Audit |
| --- | :-: | :-: | :-: | :-: | --- |
| View warehouse registry (`GET /warehouses`) | ✓ | | | | View-only (`warehouse.*` reads) |
| Create/update warehouse (name, city, address, coords, `servingCities`, `status`) | ✓ | | | | Yes (`warehouse.*`), reason required |
| View/adjust warehouse stock (`GET /warehouses/{id}`, `PUT /{id}/stock`) | ✓ | | | | Yes on mutations (`warehouse.*`), reason required |
| View fulfillment routing state (`fulfillmentSource: warehouse`, fallback records) | ✓ | | | ✓ | View-only |
| Register/update carriers (`GET/POST /carriers`, `PATCH /{id}`) | | ✓ | | | Yes (`carrier.*`), reason required |
| Monitor carrier handoffs (`carrier.handoff_required`, custody entries `actorType: carrier`) | | ✓ | | | View-only |
| Register/update facilities (`GET/POST /facilities`) | | | ✓ | | Yes (`facility.*`), reason required |
| Manage facility whitelists (`PUT /facilities/{id}/whitelist`) | | | ✓ | | Yes (`facility.*`), reason required |
| Review entry logs + `NOT_WHITELISTED` incidents | | | ✓ | | View-only (`facility.*` reads) |
| Create/update/suspend fleet accounts (`GET/POST /fleet/accounts`, `PATCH /{id}`) | | | | ✓ | Yes (`fleet.*`), reason required |
| Link driver sub-accounts (`serviceModel: fleet` + `fleetAccountId` on the rider record) | | | | ✓ | Yes (`rider.*` / `fleet.*`), reason required |
| View fleet consolidated billing | ✓ | | | ✓ | View-only (`fleet.*` reads); finance sign-off for settlements |
| Resolve delivery exceptions (workflow 25) | ✓ | ✓ | ✓ | ✓ | Yes (`exception.*`), reason required |
| Escalate delivery exceptions (`status: escalated`) | | | | | Ops manager + logistics operations + super admin only; Yes (`exception.*`), reason required |
| Active reassignment (`POST /admin/shipments/{id}/reassign`) | | | | | Ops manager + logistics operations + super admin only; Yes (`shipment.*`), reason required |
| Shipment escalation (`POST /admin/shipments/{id}/escalate`) | | | | | Ops manager + super admin only; Yes (`shipment.*`), reason required |

Every deep-logistics mutation requires a `reason` (missing → `ADMIN_REASON_REQUIRED`)
and writes an audit entry; the four managers see their registry read/write while
reassignment, escalation, and exception escalation remain ops-manager-level.

## Intercity and line-haul permissions

| Action | Roles | Audit |
| --- | --- | --- |
| Manage hubs (create/update/active) | Ops manager, logistics operations | Yes (`hub.*`), reason required |
| View consignments | Ops manager, logistics operations, rider operations | — |
| Resolve consignment exception (missing order / mismatch) | Ops manager, logistics operations | Yes (`consignment.*`), reason required |
| View route / waybill audit trails | Ops manager, logistics operations, compliance reviewer | View-only (`waybill.*`, `handoff.*` read access) |
| View hub dashboard (`GET /admin/hubs/{hubId}/dashboard`) | Ops manager, dispatch manager, regional ops manager, logistics operations | View-only (`hub.*` reads); `HUB_DASHBOARD_UNAVAILABLE` → empty state + retry |

- Hub and consignment mutations require a `reason` and always produce an audit entry; consignment-exception resolutions (workflow 21) and seal-broken handoff decisions (workflow 22) are ops-manager-and-logistics, reason required, audited (`consignment.*` / `handoff.*`).

## Logistics OS permissions — full capability matrix

| Action | Ops manager | Logistics operations | Rider operations | Finance | Compliance reviewer | Super admin | Audit |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | --- |
| View logistics control tower (`GET /admin/logistics/control-tower`) | ✓ | ✓ | | | | ✓ | View-only |
| View shipments list/detail (`GET /shipments`, `GET /shipments/{id}`) | ✓ | ✓ | | | | ✓ | View-only (`shipment.*` reads) |
| Query custody chains (`GET /shipments/{id}/custody`) | ✓ | ✓ | | | ✓ | ✓ | View-only (`shipment.*` reads) |
| View trips (`GET /trips`, `GET /trips/{tripId}`) | ✓ | ✓ | | | | ✓ | View-only (`trip.*` reads) |
| View vehicles/routes (`GET /vehicles`, `GET /routes`) | ✓ | ✓ | | | | ✓ | View-only |
| View consignments + manifests | ✓ | ✓ | ✓ | | | ✓ | View-only |
| Inspect logistics anomalies (`logistics_anomalies`) | ✓ | ✓ | | | ✓ | ✓ | View-only (`anomaly.*` reads) |
| Run reconciliation (`POST /linehaul/consignments/{id}/reconcile`) | ✓ | ✓ | | | | ✓ | Yes (`reconciliation.*`) |
| Resolve reconciliation failure (workflow 23) | ✓ | ✓ | | | | ✓ | Yes (`reconciliation.*`), reason required |
| Approve replan — alternate trip/vehicle (workflow 23) | ✓ | ✓ | | | | ✓ | Yes (`trip.*`), reason required |
| Declare package lost → damage-claim path (workflow 23) | ✓ | ✓ | | | ✓ (claims review) | ✓ | Yes (`reconciliation.*`), reason required |
| Respond to logistics anomaly (workflow 24) | ✓ | ✓ | | | | ✓ | Yes (`anomaly.*`), reason required |
| Freeze/block a shipment (workflow 24) | ✓ | ✓ | | | | ✓ | Yes (`anomaly.*`), reason required |
| Dismiss anomaly as false positive (workflow 24) | ✓ | ✓ | | | | ✓ | Yes (`anomaly.*`), reason required |
| Handle seal-broken handoff (workflow 22) | ✓ | ✓ | | | | ✓ | Yes (`handoff.*`), reason required |
| Manage hubs (create/update/active) | ✓ | ✓ | | | | ✓ | Yes (`hub.*`), reason required |
| Resolve consignment exception (workflow 21) | ✓ | ✓ | | | | ✓ | Yes (`consignment.*`), reason required |
| View route/waybill audit trails | ✓ | ✓ | | | ✓ | ✓ | View-only (`waybill.*`, `handoff.*` reads) |
| View delivery-exceptions queue (18 kinds) | ✓ | ✓ | | | ✓ | ✓ | View-only (`exception.*` reads) |
| Resolve delivery exception (workflow 25) | ✓ | ✓ | | | | ✓ | Yes (`exception.*`), reason required |
| Escalate delivery exception (`status: escalated`) | ✓ | ✓ | | | | ✓ | Yes (`exception.*`), reason required |
| Active shipment reassignment (`POST /admin/shipments/{id}/reassign`) | ✓ | ✓ | | | | ✓ | Yes (`shipment.*`), reason required |
| Shipment escalation (`POST /admin/shipments/{id}/escalate`) | ✓ | ✓ | | | | ✓ | Yes (`shipment.*`), reason required |
| View warehouse registry + stock | ✓ | ✓ | | | | ✓ | View-only (`warehouse.*` reads) |
| Create/update warehouse + stock deltas (module 28) | ✓ | ✓ | | | | ✓ | Yes (`warehouse.*`), reason required |
| Register/update carriers + handoff monitor (module 29) | ✓ | ✓ | | | | ✓ | Yes (`carrier.*`), reason required |
| Facilities CRUD + whitelist management (module 30) | ✓ | ✓ | | | | ✓ | Yes (`facility.*`), reason required |
| Fleet account CRUD + sub-account linkage (module 31) | ✓ | ✓ | | | | ✓ | Yes (`fleet.*`), reason required |
| View platform control tower (`GET /admin/control-tower`) | ✓ | ✓ | | | | ✓ | View-only |
| View hub dashboard (`GET /admin/hubs/{hubId}/dashboard`) | ✓ | ✓ | | | | ✓ | View-only (`hub.*` reads) |

Rules:

- Reconciliation resolutions, replan approvals, and anomaly decisions
  (freeze/block/dismiss) require a `reason` and always produce an audit entry;
  anomalies are never resolved by rider apps — only ops owns the decision.
- Replan is an **approval** in admin-web: the decision is recorded in audit with
  the reason; the physical `POST /linehaul/consignments/{id}/replan` call is
  executed by dispatch on the rider side.
- All logistics views require a staff session with an `mfa_verified` claim;
  role checks are UI rendering only — the API is the enforcement point.
- Deep-logistics rules: exception resolutions, escalations, warehouse/carrier/
  facility/fleet mutations, reassignments, and shipment escalations all require
  a `reason` (max 500–1000 per contract) and produce audit entries
  (`exception.*`, `warehouse.*`, `carrier.*`, `facility.*`, `fleet.*`,
  `shipment.*`); escalation and reassignment are ops-manager-and-above even
  though the four deep-logistics managers hold registry read/write.
- `POST /warehouses/{id}/fulfill` is order-tagged and server-driven; no staff
  role calls it from admin-web — the module renders routing state only.

## Control-plane permissions (global search, universal entity view, dispatch)

| Action | Roles | Audit |
| --- | --- | --- |
| Global search (`GET /admin/search`) | Any staff role with `order.read`-level visibility of the searched entity type | View-only; per-entity-type ABAC scoping; `ADMIN_SEARCH_INVALID` (422) on bad queries |
| Universal entity view (orders, shipments, providers, merchants, customers, riders) | The roles that can `read` that entity type | View-only; read surfaces audited per prefix |
| Live map layers (riders, vehicles, hubs, merchants, providers, deliveries, service jobs, traffic, geofences, incidents) | Ops manager, dispatch manager, regional ops manager, rider operations, logistics operations, platform owner/administrator | View-only |
| Dispatch console actions (assign/reassign/bulk/schedule/reschedule/cancel/escalate) | Dispatch manager, ops manager, regional ops manager | Yes (`assignment.*`, `shipment.*`, `booking.*`), reason required |
| Two-person approval — initiate | Any role holding the underlying permission | Yes (`two_person_approval.*`) |
| Two-person approval — decide | Second admin (never the requester) | Yes (`two_person_approval.*`) |

## Rules

- Role changes require Platform Owner (or Platform Administrator for non-owner
  changes); every change is an audit log entry.
- A user can hold one staff role at a time; staff roles are separate from customer/merchant/provider/rider roles.
- All admin API calls require a staff session with an `mfa_verified` claim.
- Frontend role checks are for UI rendering only; the API is the enforcement point.
- The Read-only Auditor holds `audit.read` only and is rejected on every
  mutation (403 `FORBIDDEN`).
