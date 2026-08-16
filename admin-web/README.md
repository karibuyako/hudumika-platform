# Private HUDumika Admin Web Specification

**Team 5 folder — copy this folder to hand off.** The running app is in `app/` (`@hudumika/admin-web`: Vite + React + generated client + MSW mocks; `npm run dev:admin` from the platform root). This file set is the spec that app is built against.

The admin web is the internal HUDumika operations console: React + Vite + TypeScript, built by the admin team, never linked from any public surface.

## Visibility

The admin web is private and must never be linked from the public website, public sitemap, footer, navigation, or marketing content. It must require:

- Staff authentication.
- MFA.
- Role-based permissions.
- Session timeout.
- Audit logging.
- IP/device policy where required.

## Team documents

| Doc | Purpose |
| `MASTER-BLUEPRINT.md` | The complete admin frontend build specification — every module, screen, workflow, access-control level, and priority, including the control-plane blueprint (control tower, global search, universal entity view, live map, dispatch console, two-person authorization, risk cases, hub dashboards, integration health, IAM, configuration center) |
| `OPERATIONS-COVERAGE.md` | All 395+ admin operations mapped to endpoints, modules, and status |
| --- | --- |
| `README.md` | This overview |
| `MODULES.md` | The 35 modules with owners and cross-module behaviors |
| `ROLES-PERMISSIONS.md` | 20 staff roles, permission matrix, rules |
| `WORKFLOWS.md` | 33 critical workflows (1 approve merchant, 2 approve provider, 3 approve rider, 4 resolve dispute, 5 reconcile payouts, 6 moderate reviews, 7 handle stuck order, 8 issue refund, 9 moderate promotion, 10 moderate group buy, 11 verify voucher in dispute, 12 oversee loyalty config, 13 moderate conversation, 14 onboard enterprise chain, 15 respond to webhook failures, 16 approve enterprise export, 17 manual override assignment, 18 reconcile rider COD, 19 respond to crash alert, 20 enforce/relieve mandatory rest, 21 resolve consignment exception, 22 handle seal-broken handoff, 23 resolve reconciliation failure, 24 respond to logistics anomaly, 25 resolve a delivery exception, 26 warehouse replenishment & fulfillment routing, 27 carrier handoff, 28 facility whitelist management, 29 fleet account provisioning, 30 freeze and recover a shipment, 31 two-person authorization, 32 investigate a risk case, 33 respond to control-tower critical alerts) |
| `SECURITY.md` | Hosting, auth, masking, session and device policy |
| `ARCHITECTURE.md` | Stack, repository layout, conventions |
| `API.md` | `/admin/*` endpoints and staff auth flow |
| `AUDIT.md` | Audit data consumption and rules |
| `TESTING.md` | Test pyramid, MSW parity, E2E scenarios |
| `DEPLOYMENT.md` | Environments, headers, release checklist |
| `ROADMAP.md` | P0–P8 milestones + control-plane CP-P0/P1/P2, aligned with the backend |

## Admin roles

- Platform Owner.
- Platform Administrator.
- Operations Manager.
- Dispatch Manager.
- Regional Operations Manager.
- Merchant Operations.
- Provider Operations.
- Rider Operations.
- Customer Support.
- Finance.
- Payments.
- Risk & Fraud.
- Trust & Safety.
- Compliance.
- Marketing.
- Analytics.
- Content Manager.
- Technical Operations.
- Security Administrator.
- Read-only Auditor.

## Modules

- Operations overview.
- Customers.
- Merchants.
- Providers.
- Riders.
- Cities and service areas.
- Service catalogue.
- Orders.
- Bookings.
- Dispatch monitor.
- Payments, refunds, and payouts.
- Reviews and moderation.
- Support tickets.
- Promotions.
- Content and SEO.
- Audit logs.
- Group buy operations.
- Voucher operations.
- Messages and chat oversight.
- Enterprise chains.
- Integrations and webhooks health.
- Data export queue.
- Fleet control tower.
- Hubs and line-haul oversight.
- Waybill and custody audit.
- Logistics control tower.
- Reconciliation and custody audit.
- Regional warehouses.
- Carrier management.
- Facilities and whitelists.
- Fleet accounts.
- Fleet management.
- Hub operations.
- Trust & risk cases.
- Integration health.

## Critical admin workflows

- **Approve a merchant**: Review documents → verify business → inspect catalogue → configure commercial terms → approve → notify merchant.
- **Approve a provider**: Review identity → review qualifications → review trade and service area → approve or request changes → publish profile.
- **Approve a rider**: Review identity/licence/vehicle documents → review city/zone → approve (eligible to go online) or request changes → notify → audit.
- **Resolve a dispute**: Open order/booking → inspect status events and evidence → contact parties → decide refund/payout action → create audit entry → notify parties.
- **Reconcile payouts**: Compare provider gateway settlement → platform ledger → merchant/provider payout records → mark paid, failed, or exception.
- **Moderate reviews**: Pending queue + reports + author velocity flags → dismiss/hide/delete with reason → rating recalculated → audit.
- **Handle a stuck order**: Dispatch monitor → re-queue, manual reassign, cancel with refund, or escalate → order event + audit.
- **Issue a refund**: Verify eligibility → amount + reason → threshold/role rules → webhook-driven status → audit with before/after amounts.
- **Moderate a promotion**: Queue → inspect rules/budget → approve/reject/pause with reason → notify merchant → audit.
- **Moderate a group buy deal**: Queue → inspect pricing/validity → approve/reject/delist → notify → audit.
- **Verify a voucher in dispute**: Customer/merchant disagreement → staff verify via `/admin/vouchers/verify` → decide refund or redeem → audit.
- **Oversee merchant loyalty config**: Review tiers/top-up rewards for compliance.
- **Moderate an abusive conversation**: Search conversations → review masked history → block with reason → notify both parties → audit → optional linked ticket.
- **Onboard an enterprise chain**: Review chain application → set tier/SLA/account manager → activate → audit.
- **Respond to webhook failures**: Monitor failing deliveries → inspect → notify merchant owner → guide fix → re-test → audit.
- **Approve an enterprise data export**: Compliance reviews scope/format → approve → job runs → audited download.
- **Manual override assignment**: Stuck/VIP order → pick online/in-zone rider → reason → assign → order event + audit.
- **Reconcile rider COD**: Shift expected vs collected cash → mark reconciled or flag mismatch with note → finance follow-up → audit.
- **Respond to a crash alert**: Safety event → locate rider → call → confirm safe → reassign orders → audit.
- **Enforce or relieve mandatory rest**: Fatigue/max-hours → `forcedRestUntil` → confirm break → early override with reason → audit.
- **Resolve a consignment exception**: Missing-order/mismatch arrival → compare `verifiedOrderIds` vs manifest → locate → re-route or loss claim → new ETA to customer → audit.
- **Handle a seal-broken handoff**: `HANDOFF_SEAL_BROKEN` → block leg → inspect custody chain → re-seal or damage claim → audit.
- **Resolve a reconciliation failure**: Manifest vs scanned mismatch → locate missing packages via the custody chain → re-route or declare lost → close the trip → notify → audit.
- **Respond to a logistics anomaly**: Scan/GPS mismatch → verify device/actor binding → block or freeze the shipment → audit.
- **Resolve a delivery exception**: 18-kind catalog → locate (custody chain) → reroute/replan → outcome → notify → audit; escalate incidents (`exception.escalated`) to ops manager.
- **Warehouse replenishment & fulfillment routing**: Stock-low alert → merchant bulk inbound (`PUT /warehouses/{id}/stock`) → verify stock → nearest-warehouse fulfillment routing → audit.
- **Carrier handoff**: Assign line-haul to a third-party carrier → handoff scans (pickup/drop-off) → SLA monitor → escalate via the exception queue → audit.
- **Facility whitelist management**: Register facility (geofence + `accessPolicy`) → review `NOT_WHITELISTED` incidents → grant/revoke (`PUT /facilities/{id}/whitelist`) → entry logs → audit.
- **Fleet account provisioning**: Create master account → link driver sub-accounts (`serviceModel: fleet` + `fleetAccountId`) → permissions/vehicles/regions → consolidated billing → suspend with reason → audit.
- **Freeze and recover a shipment**: Incident/security/legal hold → `POST /admin/shipments/{id}/freeze` with reason → investigate against the custody ledger → `POST /admin/shipments/{id}/unfreeze` with `resumePlan` → audit.
- **Two-person authorization**: Dangerous action (large_refund, change_commission, suspend_major_merchant, change_payment_settings, modify_ledger, change_iam_policy, delete_critical_data, release_hold) → initiate approval → second admin approves/rejects (same-actor blocked) → executes on approval → audit pair.
- **Investigate a risk case**: Case → signals + related entities (customer/provider/rider/orders/devices/IP history) → dismiss / block_user / block_provider / escalate / hold with reason → audit.
- **Respond to control-tower critical alerts**: Per alert type (shipment exception, provider incident, payment failure, fraud spike, SLA breach, hub capacity) — open the deep link, triage, act, escalate, audit.

Full details in `WORKFLOWS.md`.

## Admin security rules

- Never allow frontend-only authorization.
- Every mutation requires server permission checks.
- Sensitive fields are masked by default.
- Financial changes require reason and audit record.
- Export actions are permissioned and logged.
- Admin routes use a separate deployment or protected hostname.
