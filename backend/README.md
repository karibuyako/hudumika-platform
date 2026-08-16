# HUDumika Backend

**Team 6 folder — copy this folder to hand off.** The Go service lives in `app/` (module `github.com/hudumika/api-backend`, runnable today: `make -C app run` with `DATABASE_URL`/`REDIS_URL`, tests `make -C app test`, full stack `docker compose -f app/docker-compose.yml up`). The contract `API-CONTRACT.yaml` below is the single source of truth — changes here flow to `packages/contract` (TS client + MSW) and to `app/` Go stubs (`make -C app gen`).

Go service behind all HUDumika applications: customer app, merchant web/mobile, provider web/mobile, rider app, and the private admin web. The public web is a marketing layer only and never talks to these APIs directly beyond lead submission.

**Stack:** Go 1.25+, chi router, PostgreSQL 16, Redis 7. Details in `ARCHITECTURE.md`.

**Status:** M1–M8 + all contract domains delivered — 580/580 contract operations implemented (464 paths routed via the generated chi interface, shapes pinned by `TestAllContractPathsReturnDefinedShape`; the only remaining 501 is the dependency state of `GET /events` without Redis/PostgreSQL configured). Delivered: auth, users, riders, orders, bookings, payments, payouts/ledger, wallet, catalogues, merchants/providers, reviews, support, dine-in, group-buys, promotions, loyalty, chain, inventory, staff-ops, chat, integrations/webhooks, analytics, logistics (incl. warehouses/consignments), approvals/tasks/risk/onboarding, finance, marketing, reports, media, rider-ops, provider self-service, home BFF, event stream (`/events`) + `/ws` WebSocket. Cross-cutting live: RBAC + MFA, PII masking, audit, idempotency, rate limits, immutable ledger, outbox + worker, sweeper jobs, OTel + Prometheus `/metrics` + dashboards + alerts, public-path exemptions, admin IP allow-list. Roadmap and run instructions in `app/README.md`.

## Documents

| Doc | Purpose |
| --- | --- |
| `API-CONTRACT.yaml` | OpenAPI 3.1 spec — the single source of truth for every client app and MSW mocks |
| `ARCHITECTURE.md` | Repository layout, layering rules, cross-cutting concerns |
| `DATA-MODEL.md` | PostgreSQL schema, indexes, immutability rules |
| `AUTH.md` | OTP, sessions, RBAC, staff MFA, role switching |
| `PAYMENTS.md` | Provider integrations, idempotency, refunds, webhooks |
| `PAYOUTS-LEDGER.md` | Immutable ledger, payout batches, reconciliation |
| `DISPATCH.md` | Rider assignment and provider matching |
| `NOTIFICATIONS.md` | Event catalog, channels, preferences |
| `REVIEWS-MODERATION.md` | Review lifecycle, rating computation, abuse handling |
| `SUPPORT.md` | Ticket tracks, SLAs, escalation |
| `AUDIT.md` | Audit log schema and rules |
| `ERROR-CODES.md` | Stable error code catalog |
| `TESTING.md` | Test pyramid, contract testing with MSW |
| `DEPLOYMENT.md` | Environments, delivery, observability, runbooks |
| `ROADMAP.md` | Delivered milestones (M1–M8 + final wave) and next slices |

## Resource groups

```text
/auth /users /cities /services /merchants /providers /riders /catalogues
/orders /bookings /payments /payouts /reviews /notifications /support /admin
/dine-in /reservations /group-buys /vouchers /promotions /coupons
/members /membership-tiers /memberships /wallet /analytics /favorites /devices
/conversations
/chain /bulk-operations /inventory /suppliers /purchase-orders /supplier-returns
/approvals /staff/shifts /staff/attendance /staff/performance /staff/commissions
/integrations /webhooks /reports /segments /journeys /data/exports
/print-jobs /categories /payments/qr
/orders/search /orders/enterprise /orders/rush /orders/batch /refunds
/barcodes /combos /menus /videos /products/assistant
/tasks /risk /audit/me /sessions /privacy /onboarding /announcements
/finance/bank-cards /finance/invoices /finance/settlements /finance/reconciliation
/marketing/platform-events /marketing/flash-sales /marketing/precision
/marketing/dianjin /marketing/brand-display /marketing/self-service
/store/kitchen-camera /store/qualifications /store/qr-codes
/store/receipt-templates /store/payment-accounts /store/self-pickup
/store/compliance/recheck /store/logs /analytics/hourly-trends
/analytics/funnel /analytics/store-score /analytics/order-analytics
/analytics/customers /analytics/customer-distribution /analytics/forecast
/analytics/top-dishes /payments/methods /payments/history /riders/assigned
/riders/reject-reasons /riders/me/location /riders/me/missions /orders/{id}/proof-of-delivery
/orders/{id}/failed-delivery /orders/{id}/reschedule /orders/{id}/transfer /sos
/orders/{id}/tip /orders/issue-reasons /riders/me/shifts (+ clock-in/clock-out)
/dispatch/available-orders /dispatch/heatmap /orders/{id}/fare
/orders/{id}/hold /orders/{id}/unhold /orders/{id}/add-items
/riders/me/trips/{orderId}/share /riders/me/performance /riders/me/leaderboard
/riders/me/shifts/{shiftId}/swap-request /riders/me/shifts/{shiftId}/break
/riders/me/trips /riders/me/trips/{tripId} /riders/me/trips/{tripId}/reorder
/admin/orders/{orderId}/assign-rider /admin/riders/{riderId}/cod /admin/fleet/control-tower /admin/users /admin/customers /admin/refunds/{id}/decision
/admin/bookings/{id}/assign-provider /admin/banners /admin/notifications/send /admin/templates
/admin/help/articles /admin/commission-rules /admin/wallets/{userId}/adjust /admin/features
/admin/staff-roles /admin/sla-rules /admin/analytics/{scope} /admin/reports
/admin/search /admin/two-person-approvals /admin/hubs/{id}/dashboard /admin/control-tower
/admin/risk/cases /admin/integrations
/dispatch/forecast /riders/me/safety-events /riders/me/sync/batch /riders/me/sync/status
/riders/me/destination-filter /orders/{orderId}/masked-call
/riders/me/vehicle/maintenance /riders/me/goals /riders/me/security /riders/me/expenses
/providers/me/services /providers/me/technicians /providers/me/certifications
/bookings/estimate /bookings/{id}/quote /bookings/{id}/proof-of-service
/bookings/{id}/parts /bookings/{id}/invoice /bookings/{id}/warranty
/dispatch/provider-jobs /dispatch/provider-jobs/{bookingId}/accept
/providers/me/staff /providers/me/capabilities /providers/me/dispatch /providers/me/trust
/providers/me/inventory /providers/me/service-plans /providers/me/contracts /providers/me/documents
/providers/me/copilot /service-categories /bookings/{id}/check-in /bookings/{id}/pause
/hubs /orders/{id}/route /orders/{id}/waybill /orders/{id}/legs/{legId}/advance
/orders/{id}/handoff /linehaul/consignments (+ depart/arrive/reconcile/replan)
/shipments /shipments/{id}/custody /shipments/{id}/scan /containers /vehicles
/warehouses (+ /{id}/stock /{id}/fulfill) /carriers /facilities (+ /{id}/whitelist)
/fleet/accounts /delivery-exceptions /admin/shipments/{id}/reassign /admin/shipments/{id}/escalate
/admin/shipments/{id}/freeze /admin/shipments/{id}/unfreeze
/routes /trips /orders/{id}/tracking-phases /admin/logistics/control-tower
/bookings/{id}/assign-technician
/riders/me/contacts /riders/me/exports /riders/me/training /help/articles /riders/me/preferences
```

Newer groups cover the Meituan-inspired enterprise suite: chain management and
bulk operations, inventory and procurement, approval workflows, staff
operations, integrations and webhooks, scheduled reporting, CRM, and data export.

Newer groups cover the Meituan-inspired merchant suite: dine-in + QR ordering,
group buy + voucher verification, promotions and coupons, loyalty, merchant
staff and devices, wallet/withdrawals, and analytics.

## API rules (non-negotiable)

- Version endpoints from the beginning: `/api/v1/...`.
- Validate all request bodies server-side; return stable error codes, not only messages.
- Idempotency keys for order creation, booking creation, payments, and refunds.
- Cursor pagination for feeds and history; timestamps UTC, rendered local in clients.
- Never trust price, role, commission, payout, or status values from clients.
- Immutable ledger entries for all money movement.
- Request IDs in logs and error responses.

## MSW parity

Client apps run MSW mocks matching `API-CONTRACT.yaml`. The replacement plan:

1. Keep the same request and response contracts.
2. Replace MSW handlers with real API routes.
3. Keep contract tests against both MSW and staging.
4. Remove the browser worker from production builds.
5. Preserve loading, error, retry, and empty states in clients.

## Environment variables

The public web and apps must not hardcode future URLs. Configure through:

```text
VITE_CUSTOMER_IOS_URL / VITE_CUSTOMER_ANDROID_URL
VITE_MERCHANT_IOS_URL / VITE_MERCHANT_ANDROID_URL
VITE_PROVIDER_IOS_URL / VITE_PROVIDER_ANDROID_URL
VITE_RIDER_IOS_URL / VITE_RIDER_ANDROID_URL
```

Production API base URL is environment-driven per app (`EXPO_PUBLIC_API_URL` for mobile, `VITE_API_URL` for web) once the real backend is introduced.
