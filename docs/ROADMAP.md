# HUDumika Cross-Team Roadmap

Coordinate lanes across teams. Backend milestones gate client work; clients use MSW against the same contract (`backend/API-CONTRACT.yaml`) until APIs ship.

## Milestones

| Phase | Backend | Customer app | Merchant web/app | Provider web/app | Rider app | Admin web |
| --- | --- | --- | --- | --- | --- | --- |
| **P0 — Foundations** | M1 auth + users | App scaffold, OTP login, city picker | Scaffold, OTP login | Scaffold, OTP login | Scaffold, OTP login | Scaffold, staff login + MFA |
| **P1 — Marketplace** | M2 cities/services/leads/approvals | Browse catalogue, merchant/provider discovery | Apply → catalogue CRUD, verification status | Apply, profile + availability | Apply, onboarding docs | Approve merchants/providers/riders, city + service areas |
| **P2 — Transactions** | M3 orders + payments | Order + pay (sandbox), order history, tracking | Accept orders, order status updates | — | — | Order oversight, refunds |
| **P3 — Bookings** | M4 bookings | Book + pay, booking management | — | Accept/decline, schedule, job lifecycle | — | Booking oversight |
| **P4 — Dispatch** | M5 dispatch | Live tracking | — | On-demand jobs | Online/offline, accept assignments, delivery flow | Dispatch monitor |
| **P5 — Money** | M6 payouts + ledger | Refund status | Wallet + withdrawals, settlement view | Earnings + payout statements | Earnings + payout statements | Finance: reconciliation, exceptions |
| **P6 — Engagement** | M7 reviews/support/notifications | Reviews, tickets, notifications | Reviews, tickets | Reviews, tickets, reliability view | Ratings, tickets | Moderation queue, support queue, SLAs |
| **P6b — Dine-in** | M7b dine-in + reservations | Dine-in QR ordering, reservations | Tables, QR menus, bill confirm/close | — | — | Dine-in oversight |
| **P6c — Commerce ops** | M7c group buy + promotions | Group buy discovery + wallet, coupon wallet | Group buy deals, vouchers, promotions, coupons | — | — | Group buy + promotion moderation, voucher ops |
| **P6d — Growth tools** | M7d loyalty + staff + wallet | Customer membership (points) | Loyalty members/tiers/top-ups, staff roles, devices | — | — | Merchant config oversight |
| **P6e — Intelligence** | M7e analytics | — | Dashboard, traffic, products, benchmarks, diagnostics, exports | — | — | Platform metrics |
| **P7 — Admin + launch** | M8 admin API + hardening | Release readiness | Release readiness | Release readiness | Release readiness | Full admin modules, audit logs, launch |
| **P8 — Enterprise** | M9a chain/inventory/procurement | — | Chain dashboard + bulk ops, inventory + PO workflow, low-stock alerts | — | — | Chain + webhook oversight |
| **P8b — Enterprise ops** | M9b staff ops/approvals/integrations | — | Shifts + attendance + commissions, approval workflows, webhooks + integrations | — | — | Integration health + approval oversight |
| **P8c — Enterprise scale** | M9c reporting/CRM/export + verticals | — | Scheduled reports, CRM segments/journeys, data export; vertical configs | Vertical trades (beauty, fitness, auto…) | — | Export + report oversight |

## Dependencies (who waits on whom)

- Client teams wait on **contract only** — MSW mocks keep them unblocked. They never wait for a deployed backend.
- Backend waits on design decisions that affect schemas (payment methods, price model) — frozen in P0.
- Admin web waits on backend M1 (staff auth) for real integration; mock-first until then.
- Merchant/provider web apps share the Expo design tokens via `DESIGN-SYSTEM.md`.

## Standing rules for every team

1. Follow `backend/API-CONTRACT.yaml`; never invent endpoints or fields — propose contract changes first.
2. Every screen has loading, empty, error, retry, and success states.
3. Every mutation is idempotent-safe from the client (send idempotency key).
4. All money is TZS; format with thousands separators.
5. English first release; i18n keys Swahili-ready (`sw`) and Arabic-capable (`ar`).
6. No hardcoded URLs, phones, emails, or ratings anywhere — environment-driven config only.
7. Staff routes never appear in public apps or the public web.

## Launch definition

- All apps in store/web production on their own domains.
- Backend live with payments sandbox → real provider certification done.
- Audit logging and observability dashboards green.
- Contract test suites green against staging from every client.
