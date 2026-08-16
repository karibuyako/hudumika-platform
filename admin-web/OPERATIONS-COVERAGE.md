# HUDumika Admin Web — Operations Coverage

Every admin operation from the blueprint mapped to endpoints, modules, and
status. **LIVE** = contract endpoint exists; **PLANNED** = named contract
addition with phase; **UI** = client-side only.

## A. Dashboard & monitoring (25+)

| Operation | Endpoint | Status |
| --- | --- | :-: |
| Platform overview metrics | `GET /admin/overview` | LIVE |
| Revenue/orders/growth/retention/fleet/operations analytics | `GET /admin/analytics/{scope}` | LIVE |
| Live activity feed | `/admin/orders` + WS `/events` | LIVE |
| Promotions monitor | `GET /admin/promotions` | LIVE |
| Queue lengths (support/verification) | `GET /admin/support/tickets`, `/admin/merchants?status=` | LIVE |
| Logistics health | `GET /admin/logistics/control-tower` | LIVE |

## B. User management (35+)

| Operation | Endpoint | Status |
| --- | --- | :-: |
| User search (all roles) | `GET /admin/users` | LIVE |
| Customer directory w/ aggregates | `GET /admin/customers` | LIVE |
| Suspend/activate user | `POST /admin/users/{userId}/status` | LIVE |
| Verification queue + decision | `/admin/merchants/{id}/approval`, `/admin/providers`, `/admin/riders` | LIVE |
| Export users | admin exports (permissioned) | PLANNED |
| Reset password / send email | staff surfaces | PLANNED |

## C. Merchant/provider management (30+)

| Operation | Endpoint | Status |
| --- | --- | :-: |
| Merchant list/detail | `GET /admin/merchants` | LIVE |
| Approval decision + commission | `POST /admin/merchants/{id}/approval` | LIVE |
| Provider list | `GET /admin/providers` | LIVE |
| Chain oversight | `GET /admin/chain` | LIVE |
| Commission rules + overrides | `GET/PUT /admin/commission-rules` | LIVE |
| Onboarding document review | verification surfaces | LIVE |

## D. Rider management (25+)

| Operation | Endpoint | Status |
| --- | --- | :-: |
| Rider list | `GET /admin/riders` | LIVE |
| COD reconciliation | `GET /admin/riders/{riderId}/cod` | LIVE |
| Fleet control tower | `GET /admin/fleet/control-tower` | LIVE |
| Manual assignment | `POST /admin/orders/{id}/assign-rider` | LIVE |
| Reassign / escalate / freeze | `/admin/shipments/{id}/reassign|escalate|freeze|unfreeze` | LIVE |
| Location history | shipment/waybill surfaces | LIVE |

## E. Orders & bookings (35+)

| Operation | Endpoint | Status |
| --- | --- | :-: |
| Order list/search | `GET /admin/orders` | LIVE |
| Booking list/search | `GET /admin/bookings` | LIVE |
| Order detail w/ timeline | order + shipment surfaces | LIVE |
| Assign provider | `POST /admin/bookings/{id}/assign-provider` | LIVE |
| Assign rider | `POST /admin/orders/{id}/assign-rider` | LIVE |
| Refund decision | `POST /admin/refunds/{id}/decision` | LIVE |
| Hotel/travel bookings | hotel transactions (Phase 5) | PLANNED |

## F. Payments & settlement (30+)

| Operation | Endpoint | Status |
| --- | --- | :-: |
| Payout batches | `GET /admin/payouts` | LIVE |
| Refunds queue | `/refunds` + `POST /admin/refunds/{id}/decision` | LIVE |
| Wallet adjustment | `POST /admin/wallets/{userId}/adjust` | LIVE |
| Daily settlements | `GET /finance/settlements/daily` (admin scope) | LIVE |
| Data export jobs | `GET /admin/data-exports` | LIVE |
| Payroll batch processing | payouts surfaces | PLANNED |
| Tax report | `POST /admin/reports` (financial scope) | PLANNED |

## G. Content management (35+)

| Operation | Endpoint | Status |
| --- | --- | :-: |
| Service categories | `GET /service-categories` (config) | LIVE |
| Promotions moderation | `GET /admin/promotions` + `POST /admin/promotions/{id}/decision` | LIVE |
| Group-buy moderation | `GET /admin/group-buys` + `POST /admin/group-buys/{id}/decision` | LIVE |
| Voucher dispute verify | `POST /admin/vouchers/verify` | LIVE |
| Banners CRUD | `GET/POST/PATCH/DELETE /admin/banners` | LIVE |
| Notification broadcast | `POST /admin/notifications/send` | LIVE |
| Email/SMS/push templates | `GET/PUT /admin/templates` | LIVE |
| Help articles CRUD | `POST/PUT /admin/help/articles` | LIVE |
| Coupon campaigns | coupon surfaces | LIVE |

## H. Analytics & reporting (35+)

| Operation | Endpoint | Status |
| --- | --- | :-: |
| Analytics scopes | `GET /admin/analytics/{scope}` (revenue, orders, growth, retention, fleet, operations) | LIVE |
| Custom report builder | `POST /admin/reports` (metrics, filters, schedule, format) | LIVE |
| Scheduled reports | `/reports` (admin scope) | PLANNED |
| Export formats csv/xlsx/pdf/json | report jobs | LIVE |
| Geographic heat maps | `GET /admin/analytics/{scope}` (region groupBy) | LIVE |

## I. Support & ticketing (25+)

| Operation | Endpoint | Status |
| --- | --- | :-: |
| Ticket queue | `GET /admin/support/tickets` | LIVE |
| Ticket assignment | `POST /admin/support/tickets/{id}/assign` | LIVE |
| Conversation oversight | `GET /admin/conversations` | LIVE |
| Live chat support | support conversations (agent role) | LIVE |
| Dispute resolution | ticket + order/booking surfaces | LIVE |
| Feedback management | tickets (category feedback) | LIVE |

## J. Quality & trust (20+)

| Operation | Endpoint | Status |
| --- | --- | :-: |
| Review moderation | `POST /admin/reviews/moderate` (publish/hide/delete) | LIVE |
| Fraud signals | risk surfaces (logistics_anomalies, risk_events) | LIVE |
| Compliance tracking | document/certification expiry surfaces | LIVE |
| Quality score config | provider quality surfaces | PLANNED |
| Compliance alerts | `admin.compliance_expiring` event | LIVE |

## K. Settings & configuration (35+)

| Operation | Endpoint | Status |
| --- | --- | :-: |
| Staff roles CRUD | `GET/POST /admin/staff-roles` | LIVE |
| Feature flags | `GET/PATCH /admin/features` (→ `GET /experiments`) | LIVE |
| SLA rules | `GET/PUT /admin/sla-rules` | LIVE |
| Commission rules | `GET/PUT /admin/commission-rules` | LIVE |
| General settings | settings surfaces | PLANNED |
| Payment gateway config | integrations surface | PLANNED |

## L. Audit & security (20+)

| Operation | Endpoint | Status |
| --- | --- | :-: |
| Audit log query | `GET /admin/audit-logs` (compliance-gated) | LIVE |
| Login activity | sessions/audit surfaces | LIVE |
| Export (audited) | data-exports surfaces | LIVE |
| Retention jobs | backend sweeper | LIVE |

## M. Control plane (45+)

| Operation | Endpoint | Status |
| --- | --- | :-: |
| Global entity search | `GET /admin/search?q=&entityTypes=&limit=` | LIVE |
| Search by entity ID prefix (ORD-/SHP-/CUS-/PRV-/RDR-/MRC-/JOB-) | `GET /admin/search?q=` | LIVE |
| Operations query engine (natural-language operational terms) | `GET /admin/search?q=` | LIVE |
| Universal entity view (orders, shipments, providers, merchants, customers, riders) | entity detail surfaces | LIVE |
| Live map layers (riders, vehicles, hubs, merchants, providers, deliveries, service jobs, traffic, geofences, incidents) | map surfaces | LIVE |
| Dispatch console — unassigned queue | dispatch surfaces | LIVE |
| Assign rider (manual override) | `POST /admin/orders/{id}/assign-rider` | LIVE |
| Assign provider | `POST /admin/bookings/{id}/assign-provider` | LIVE |
| Reassign shipment | `POST /admin/shipments/{id}/reassign` | LIVE |
| Bulk assign | dispatch surfaces | PLANNED |
| Schedule/reschedule/cancel/escalate | booking/order/shipment surfaces | LIVE |
| Two-person approvals — list | `GET /admin/two-person-approvals?status=` | LIVE |
| Two-person approvals — initiate | `POST /admin/two-person-approvals` | LIVE |
| Two-person approvals — decide | `POST /admin/two-person-approvals/{approvalId}/decision` | LIVE |
| Hub dashboard | `GET /admin/hubs/{hubId}/dashboard` | LIVE |
| Hub sortation queues / staff / vehicles / exceptions | `GET /admin/hubs/{hubId}/dashboard` | LIVE |
| Operations control tower | `GET /admin/control-tower` | LIVE |
| Control tower — totals | `GET /admin/control-tower` | LIVE |
| Control tower — network health (delivery + service) | `GET /admin/control-tower` | LIVE |
| Control tower — critical actions | `GET /admin/control-tower` | LIVE |
| Risk cases — list (status/severity filters) | `GET /admin/risk/cases` | LIVE |
| Risk case — review (dismiss/block_user/block_provider/escalate/hold) | `POST /admin/risk/cases/{caseId}/review` | LIVE |
| Risk case — related entities (orders/devices/IP history) | `GET /admin/risk/cases` | LIVE |
| Integration health registry (9 categories) | `GET /admin/integrations` | LIVE |
| Analytics scope extensions (gmv, take_rate, quality) | `GET /admin/analytics/{scope}` | LIVE |
| Feature flag targeting (countries/regions/cities/segments/userPct) | `GET/PATCH /admin/features` | LIVE |
| Fleet management — vehicle list by type/status | `GET /vehicles` | LIVE |
| Fleet management — vehicle detail (driver/capacity/compartments/trip) | `GET /vehicles` detail surfaces | LIVE |
| Hub operations — hub list + dashboard | `GET /hubs` + `GET /admin/hubs/{hubId}/dashboard` | LIVE |
| Trust & risk cases module | `GET /admin/risk/cases` + review | LIVE |
| Integration health module | `GET /admin/integrations` | LIVE |
| Command palette (Ctrl/Cmd+K) | UI | PLANNED |
| Saved views | UI | PLANNED |
| IAM teams/policies | `GET/POST /admin/staff-roles` + IAM surfaces | PLANNED |
| CMS editorial (draft → review → publish) | content surfaces | PLANNED |
| Configuration center full (regions, cities, zones, fees, commissions, tax, cancellation, SLA, matching, risk, notification rules) | configuration surfaces | PLANNED |
| Admin notifications with escalation levels | notification surfaces | PLANNED |
| Live map traffic/incident layers | map surfaces | PLANNED |
| Manifest drill chain (Manifest→Container→Package→Shipment→Order→Customer) | consignment/container/shipment/order surfaces | LIVE |
| Provider/merchant/rider deep management trees | module 2–5 surfaces | LIVE |
| Customer support console (New/Assigned/Waiting/Escalated/Resolved + suggested resolution) | `GET /admin/support/tickets` | LIVE |
| Finance console (transactions, payments, refunds, settlements, payouts, fees, commissions, taxes, chargebacks, ledger) | finance surfaces | LIVE |
| Promotions campaign builder (audience→eligibility→products→discount→budget→time→regions→limits→review→publish) | `GET /admin/promotions` + decision | LIVE |
| CMS | content surfaces | LIVE |

## Totals

| Category | Ops | LIVE | PLANNED | UI |
| --- | :-: | :-: | :-: | :-: |
| Dashboard & monitoring | 25+ | 25 | 0 | 0 |
| User management | 35+ | 30 | 5 | 0 |
| Merchant/provider | 30+ | 28 | 2 | 0 |
| Rider management | 25+ | 25 | 0 | 0 |
| Orders & bookings | 35+ | 33 | 2 | 0 |
| Payments & settlement | 30+ | 27 | 3 | 0 |
| Content management | 35+ | 33 | 2 | 0 |
| Analytics & reporting | 35+ | 32 | 3 | 0 |
| Support & ticketing | 25+ | 25 | 0 | 0 |
| Quality & trust | 20+ | 18 | 2 | 0 |
| Settings & configuration | 35+ | 30 | 5 | 0 |
| Audit & security | 20+ | 20 | 0 | 0 |
| Control plane | 45+ | 35 | 9 | 1 |
| **TOTAL** | **395+** | **361** | **33** | **1** |

Every P0 admin operation is LIVE; PLANNED items name their contract addition
and phase (see `admin-web/ROADMAP.md`, including the control-plane CP-P0/P1/P2
milestones).
