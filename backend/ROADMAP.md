# HUDumika Backend Roadmap

Milestones were contract-first: `API-CONTRACT.yaml` defines each slice before it ships; clients use MSW mocks against the same contract until the API is live. All milestones below are **delivered** — the full inventory lives in `app/README.md` and `ARCHITECTURE.md` → "Delivered state". Every contract operation is implemented (580/580; the only remaining 501 is the dependency state of `GET /events` without Redis/PostgreSQL configured).

## Delivered

- **M1 — Foundation**: repo scaffold, request IDs, structured logging, error catalog, health endpoints, OTP auth (request/verify), sessions, refresh, logout, role switching, users profile/roles.
- **M2 — Marketplaces + catalogue**: cities/service areas, service catalogue, merchant/provider/rider applications with admin approval workflows, merchant catalogue CRUD.
- **M3 — Orders + payments**: order state machine + events, server-side pricing, payment intents + M-Pesa/Tigo/Airtel/card signed webhooks, refunds, idempotency, order tracking.
- **M4 — Bookings**: state machine + events, provider availability, acceptance windows, completion confirmation, no-show handling.
- **M5 — Dispatch**: rider online pools, assignment (manual admin + auto-assign sweeper), acceptance timeouts, escalation paths.
- **M6 — Payouts + ledger**: immutable ledger, batches, statements, reconciliation, dispute holds.
- **M7 — Reviews, support, notifications**: review lifecycle + moderation, support tickets, in-app/push/SMS/email notifications via outbox.
- **M7b — Dine-in**: tables, QR ordering, dine-in order lifecycle, bill confirm/close, reservations.
- **M7c — Group buy + promotions**: deals with moderation, vouchers with verify/redeem, promotion engine (discount/spend/instant/bargain/coupon/traffic campaigns), coupon wallet, performance tracking.
- **M7d — Loyalty + staff + wallet**: merchant loyalty (members, tiers, top-ups), platform memberships, merchant staff roles + devices, wallet projection + withdrawals.
- **M7e — Analytics**: dashboard, traffic, product, revenue, benchmark endpoints, permissioned exports.
- **M8 — Admin API + hardening**: full `/admin/*` surface, audit wiring, rate limiting, observability dashboards + alerts, runbooks, load tests, security review (staff MFA, masking, IP allow-list).
- **M9 — Enterprise layer (phased)**: chain + bulk operations, inventory + procurement, staff ops + approvals + integrations/webhooks, reporting + CRM + data export, merchant ops suite (order ops, barcodes/combos/menus, tasks/risk, finance, marketing, store ops, analytics extras).
- **Final wave**: logistics OS (shipments, warehouses, consignments, trips, handoffs, waybills), rider-ops extras, provider self-service, home BFF, event stream (`/events`) + `/ws` WebSocket, masked calls, password change, image-search placeholder (contract-declared), PostgreSQL event-log fallback, sweeper jobs (auto-cancel, voucher expiry, settlements, export-queued), entity linkage (real merchant/provider row ids, legacy-compatible).

Cross-cutting delivered: RBAC + MFA, PII masking, audit, idempotency, rate limits, immutable ledger, outbox + retrying worker, sweeper jobs, OTel + Prometheus + dashboards + alerts, public-path exemptions, admin IP allow-list.

## Next slices (current, in Team 6 order)

Per `backend/app/README.md`:

1. Real provider adapters: SMS gateway, M-Pesa/Tigo/Airtel webhook signing keys per provider. (TODO: partially delivered — env-driven HTTP SMS/email gateways and per-provider webhook secrets already exist in code; confirm what remains.)
2. Merchant/provider entity linkage refactor (orders/catalogues/bookings reference real merchant rows). (TODO: delivered via migration 00058 — resolve ordering with item 1.)
3. Dispatch matching from Redis online sets + auto-accept; settlement cycles and export workers on the sweeper.
4. Chat real-time (WebSocket), offline queue replay, customer simulator for E2E.
5. M8 ops drills re-run on staging; dashboards 1–2 green 24 h as the release gate.

## Standing commitments

- Every milestone keeps MSW contract parity.
- Every money/status/moderator mutation writes an audit entry (tested).
- No client ever trusts client-supplied prices, roles, or statuses.
