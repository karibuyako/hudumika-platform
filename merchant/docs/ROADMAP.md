# HUDumika Merchant — Roadmap

Phased plan (P0–P7, P8–P8c), aligned with the root `docs/` blueprint. Clients work against MSW mocks matching `backend/API-CONTRACT.yaml` and never wait on a deployed backend.

Status column verified 2026-08-16 against routes, stores, mock handlers and tests. "DONE" = implemented at mock level (in-app MSW backend, the roadmap's stated model); "PARTIAL" = in place with listed gaps.

## Phases

| Phase | Scope (both surfaces) | Depends on | Exit criteria | Status |
| --- | --- | --- | --- | --- |
| P0 — Foundations | Scaffold: Expo app (single codebase, web = static export), shared `api`/`store`/`i18n`/`components` kit, MSW dev parity, OTP login (`request-otp`, `verify-otp`, `refresh`, `logout`), `users/me`, `users/me/roles`, role-scoped session | backend M1 (auth + users) | Login E2E on both surfaces; contract tests for auth green | **DONE** — single Expo app (no Vite/`api-client` package — see ARCHITECTURE.md superseded note); OTP + refresh + role-scoped session (`src/store/session.ts`, `src/mock/handlers/auth.ts`); contract suites run in CI (`tests/run.mjs`) |
| P1 — Marketplace | Onboarding: `POST /merchants`, `GET/PATCH /merchants/me`, verification status screen (all `VerificationState` values), document upload checklist, commercial terms card on approval; catalogue CRUD (`GET/PUT /catalogues/me`, `POST /catalogue-items`, `PATCH/DELETE /catalogue-items/{itemId}`), availability toggles, publish workflow | backend M2 (leads/approvals) | Apply → approved → published catalogue E2E; onboarding gate blocks tabs when not approved | **PARTIAL** — wizard + verification screen ship (`(auth)/register.tsx`, `(tabs)/profile/verification.tsx`: all six `VerificationState` values, documents with retake, re-submission, commercial-terms card; mock `/onboarding/*`, `tests/onboarding-flow.test.ts`). Gate is soft only: dashboard under-review banner + post-submit redirect; the hard tab-lock is not enforced. Catalogue E2E is mock-level |
| P2 — Transactions | Orders: queue (`GET /orders/me`), detail (`GET /orders/{orderId}` with masked `contactPhone`), accept with 409 handling (`POST /orders/{orderId}/accept`), advance (`POST /orders/{orderId}/status`), cancel with fee awareness (`POST /orders/{orderId}/cancel`), tracking view (`GET /orders/{orderId}/track`), dispute badge | backend M3 (orders + payments) | Catalogue publish → order accept happy path E2E (TESTING.md); 409/422 states tested | **DONE (mock-level)** — queue/detail/accept/status-advance/cancel/track/dispute/refunds (`src/store/orders.ts`, `orders/[id].tsx`); caveat: merchant list reads mock-only `GET /orders` (tracked contract-additions gap) |
| P3 — Bookings | None (provider service bookings are provider/customer; merchant dine-in and reservations land in P6b) | — | parity check: merchant surfaces remain order-only until P6b | **DONE** — nothing to build by design |
| P4 — Dispatch | Read-only rider visibility (`rider_assigned` onward), live track refresh, rider-owned action hiding | backend M5 (dispatch) | Track view E2E; state machine tests for advance rejection | **DONE (mock-level)** — waybill/route/track (`src/store/orders.ts`); sweeper drives rider events (`src/mock/sweeper.ts`) |
| P5 — Money | Earnings: `GET /payouts/me`, `GET /payouts/me/statement`, commission explanation (`commissionRateBps`), payout cycle (`payoutCycleDays`), status pills (pending/processing/paid/failed/exception), dispute holds card, payout account masked display | backend M6 (payouts + ledger) | Statement E2E with `order_earning` + `commission` entries; hold/exception states tested | **DONE (mock-level)** — statement/payouts on contract paths (`src/store/finance.ts`); commission/cycle surface via `/merchants/me` commercial terms; per-screen display not exhaustively verified |
| P6 — Engagement | Reviews (received list via `GET /reviews/me`, reply via `POST /reviews/{reviewId}/reply`, report via `POST /reviews/{reviewId}/report`), support tickets (create/list/get/reply), notification center (`GET /notifications/me`, mark read), preferences (`GET/PUT /notifications/me/preferences`), push setup (mobile, expo-notifications), event-to-UI mapping per backend/NOTIFICATIONS.md | backend M7 (reviews/support/notifications) | Notification preference E2E; deep-link routing tested | **PARTIAL** — reviews/support/notification center/preferences on contract paths (`src/store/reviews.ts`, `support.ts`, `messages.ts`, `notifications-settings.ts`); push setup shipped (expo-notifications, `src/lib/push.ts` — explain-before-ask, token registration in `notifications-settings.tsx`). Deep-link routing is not wired yet: tap APIs (`subscribePushTaps`/`currentPushTap`) exist with no consumers, no `Linking` routing — tracked with P6 |
| P6b — Dine-in | Tables CRUD + QR (`/dine-in/tables*`, `GET /dine-in/tables/{id}/qr`), bill lifecycle (open→billing→paid→closed via `confirm-payment`/`close`), reservations visibility, dual-screen POS (kitchen display + cashier terminal), store settings + closure protection (`/merchants/me/settings`, `/merchants/me/closure-protection`) | backend M7b (dine-in + reservations) | E2E 1: QR → dine-in pay → close; table conflict codes tested | **DONE** — bills on `/dine-in/orders/me` + confirm-payment/close, closure on contract path, dual-screen, reservations via consumer `/reservations/me` (store-scoped endpoints still proposed — see gap table) |
| P6c — Commerce ops | Group buy deals (create/update/extend/delist/relist, moderation statuses), vouchers (list, manual code + QR verify with 409 codes, verify history), promotions (types, lifecycle, budget, pause/resume, performance), coupon campaigns (create, claimed counts), group buy cards + voucher cards per DESIGN-SYSTEM | backend M7c (group buy + promotions) | E2E 2 and 3: deal → voucher verify; coupon redemption on order; traffic (advertising) campaigns remain hidden (phased, not built) | **DONE** — group-buy/promotions/coupons/flash-sales on contract paths (`src/store/group-buy.ts`, `promotions.ts`, `marketing.ts`); note: advertising screens (dianjin/precision/self-service) exist under `(tabs)/marketing/` — the "remain hidden (phased)" note is not enforced in the UI |
| P6d — Growth tools | Loyalty members (register/update/top-up, thresholds + bonuses), tiers (`GET/PUT /membership-tiers`), staff accounts (invite/update/remove/suspend, roles, permissions, cashier scope), device registry (printer/pos/kitchen_display/cashier_terminal), print settings + print queue, merchant wallet + withdrawals, chain stores + product templates | backend M7d (loyalty + staff + wallet) | E2E 4 and 5: withdrawal request; staff permission enforcement; top-up rewards credited | **DONE** — loyalty/devices/print-jobs/wallet (`src/store/loyalty.ts`, `devices.ts`, `print-jobs.ts`, `finance.ts`), staff on `/merchants/me/staff`; member transactions + phone lookup still proposed (gap table) |
| P6e — Intelligence | Analytics dashboard (today's real-time + live strip), traffic/products/revenue screens, benchmarks (store score, percentile), permissioned report exports; AI diagnostics screen held behind an honest "coming soon" gate until shipped | backend M7e (analytics) | E2E 6: dashboard totals match ledger; exports audited | **DONE** — analytics store + dashboard screens (`src/store/analytics.ts`, `dashboard/analytics.tsx`, `revenue-detail.tsx`, `exports.tsx`); diagnostics gated "coming soon" per plan |
| P7 — Admin + launch | Release readiness: i18n `en`/`sw`/`ar` pass, security review (secure-store/sessionStorage, masking, logout revocation), performance, contract test suites green against staging, store releases (EAS submit) + web production deploy, rollback drills | backend M8 (admin + hardening) | Launch definition per root `docs/ROADMAP.md` | **PARTIAL** — DONE: i18n en/sw/ar + RTL (`src/i18n/index.ts`, `rtl.ts`), secure-store/sessionStorage, masking, logout revocation, bundle budget in CI (`ci.yml`). NOT met (operations TODOs, see DEPLOYMENT.md): staging contract-test run (CI runs MSW-only), store releases (EAS profiles exist, no `eas submit`), web production deploy (CI exports + artifact; no host/deploy step), rollback drills |
| P8 — Chain + supply chain | Chain dashboard (`GET /chain/dashboard`), cross-store analytics (`GET /chain/analytics`), chain report export (`POST /chain/reports`), bulk operations (`POST /bulk-operations` with approval gating + per-store results), master inventory (`/inventory/items`, adjust, adjustments, alerts, sync-config), suppliers, purchase orders (draft→sent→receive→close/cancel), supplier returns; bulk catalogue ops (`POST /catalogue-items/bulk`, `/catalogues/import`, `/catalogues/export`) | backend M9a (chain + inventory + procurement) | E2E 7 and 8: bulk price update with approval + partial/failed; PO receive updates stock + COGS | **DONE** — `src/store/chain.ts`, `catalogue-ext.ts`, `supply-chain.ts` + `store/bulk.tsx`, `chain.tsx`, `suppliers.tsx`, `purchase-orders.tsx`, `warehouses.tsx` |
| P8b — Staff ops + approvals + integrations | Shifts (`/staff/shifts`, `SHIFT_OVERLAP`), attendance clock-in/out, performance metrics, commission rules, approval engine (`/approvals`, decision with comment, `APPROVAL_ALREADY_DECIDED`), integration registry + disconnect, webhook subscriptions + deliveries (backoff, `failing` status), admin webhook health view | backend M9b (staff ops + approvals + integrations) | E2E 9 and 10: webhook retry → failing; clock-in/out → attendance record; approval-gated refund flow | **DONE** — `src/store/staff-ops.ts`, `webhooks.ts`, `tasks.ts` + `ops/*` screens; `tests/staff-ops.test.ts`, `webhooks-tasks.test.ts` |
| P8c — Reporting + CRM + data export | Scheduled reports (`/reports` CRUD, email delivery), segments (`/segments` with `memberCount`), journeys (`/journeys` trigger → delayed actions), enterprise data exports (`/data/exports`, permissioned + audited), vertical readiness surfacing per VERTICALS.md | backend M9c (reporting + CRM + data export) | E2E 11: segment creation → member count; scheduled report lands; export job audited | **DONE** — `src/store/reports.ts`, `analytics-ext.ts`, `dashboard/reports.tsx`, `journeys.tsx`, `exports.tsx` |

## Contract gaps to propose (before their phase)

| Gap | Needed for | Proposal |
| --- | --- | --- |
| Merchant-side reservation management (list, confirm/seat/no-show transitions) | P6b reservations manager | store-scoped reservation endpoints (contract addition) |
| Barcode scanning on catalogue items | P8 retail depth | `barcode` field + scan-at-POS flow (contract addition; resolved items: stock counts/low-stock alerts are live in P8 via `/inventory`, VERTICALS.md; `/barcodes/*` resource endpoints exist — `CatalogueItem.barcode` field still pending) |
| Product video field | menu depth | resolved — `CatalogueItem.videoUrl` + `/videos*` are in the contract |
| Receipt template customization (header/footer) | P6c printing | resolved — `/store/receipt-templates` (`headerText`/`footerText`) is in the contract |
| Loyalty member transactions list + server-side phone lookup | P6d member detail | `GET /members/{memberId}/transactions` and lookup query param |
| Dedicated feedback endpoint | P6d feedback | `POST /feedback` or a `feedback` subject convention on tickets |
| Categories endpoints | catalogue category manager | resolved — `/categories`, `/categories/{categoryId}` are in the contract |

Until these are in `backend/API-CONTRACT.yaml`, the affected screens render from existing fields and no UI fabricates the missing endpoints.

## Phase gate process

1. Contract diff review: any new endpoint/field used by the phase is already in `backend/API-CONTRACT.yaml`; otherwise it lands in the gap list first.
2. MSW handlers updated and contract tests extended before UI work starts.
3. Per-screen state matrix (TESTING.md) signed off for every screen in the phase.
4. E2E scenario for the phase passes on both surfaces.
5. Staging deploy of the phase build, then release to the channel/static host.

## Cross-phase workstreams

| Workstream | Runs from | Notes |
| --- | --- | --- |
| i18n bundles (`en`/`sw`/`ar`) | P0 | keys added per phase; `sw` copy reviewed, `ar` fallback verified |
| Design-system components | P0 | one `ui` package; both surfaces render the same tokens |
| MSW parity suite | P0 | extended each phase; drift fails CI |
| Security review | P1, P5, P7 | token storage, masking, role-switch isolation, logout revocation |
| Performance/accessibility pass | P7 | contrast, touch targets, focus, reduced motion |

## Standing commitments

- Every phase ships loading/empty/error/retry/success states per screen (TESTING.md matrix).
- MSW parity with the contract is maintained in every phase; contract drift fails CI.
- Money stays integer TZS with thousands separators; no floats.
- English first, Swahili-ready, Arabic-capable keys from P0.
- No hardcoded URLs, phones, emails, or ratings — environment-driven only.
