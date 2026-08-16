# Contract additions — Phase B (deferred endpoints)

Tracking doc for the merchant app's ~50 mock-only endpoints that are not yet on
`backend/API-CONTRACT.yaml` (or not yet adopted from it). This is the content of
the Phase B "contract-additions" PR to Team 6, prepared under the contract-first
rule (`CONTRIBUTING.md`): **never invent paths, never call a URL not in the
contract.** Mock handlers may exist for off-contract paths only while this PR is
tracked; they stay mock-only until adopted.

Process per phase: propose here → Team 6 gates the contract change → bump
`@hudumika/contract` (patch, `CHANGELOG.md` entry) → regenerate → the app flips
the path from mock-only to live (see `ROADMAP.md` "Phase gate process" and
"Contract gaps to propose").

Status legend:

- `proposed` — contract addition needed; path below is the proposal.
- `mock-only-until-adopted` — the contract path already exists; the app stays on
  the mock handler until the endpoint is adopted (payload alignment may be needed).

## Known inconsistencies (recorded, per app README "Origin & status")

1. **`GET /auth/me` (merchant-specific payload).** The app's `/auth/me` returns a
   merchant session bundle `{merchant, store, staff, permissions}` — consumer-
   shaped `/users/me` does not exist and the contract already has
   `GET /merchants/me` (operationId `getMyMerchant`, schema `MerchantPrivate`,
   "Own merchant profile and commercial terms"). **Proposal:** align to
   `GET /merchants/me`; the app composes its session bundle from
   `GET /merchants/me` + `GET /merchants/me/settings` + `GET /merchants/me/staff`.
   The `/auth/me` mock path is kept mock-only until adoption.
2. **Merchant order list.** `GET /orders/me` is the consumer's own order list.
   The contract has no merchant-scoped order list (checked the YAML under
   `/orders*`: `/orders` is create-only, `/orders/search` exists for filtered
   queries). **Proposal:** add `GET /merchants/me/orders` (cursor pagination,
   status/store filters) — matches the app's `GET /orders` merchant list.
3. **"ready"/"complete" transitions.** The app's `POST /orders/{id}/ready` and
   `POST /orders/{id}/complete` map onto the contract's status-advance endpoint
   `POST /orders/{orderId}/status` (operationId `advanceOrder`, body
   `{status: OrderStatus, note?}`). Status mapping: app `preparing` (accept) →
   contract `merchant_accepted`; app `ready` → contract `preparing`; app
   `completed` → contract `completed`. The two mock paths stay mock-only until
   adoption (kept because they carry dispatch/settle side effects).
4. **Batch accept request shape.** `POST /orders/batch/accept` is on contract
   (Phase A) but the app sends `{ids: [...]}` where the contract body is
   `{orderIds: [...]}` (`AcceptOrdersBatchBody`). **Proposal:** switch the app to
   `{orderIds}` as part of this PR.

## Deferred endpoint groups

| App module | Current mock path(s) (`src/mock/handlers/`) | Proposed contract path | Needed for | Status |
| --- | --- | --- | --- | --- |
| Auth | `GET /auth/me` | `GET /merchants/me` | session restore, profile | `mock-only-until-adopted` (payload composition, see inconsistency 1) |
| Orders — merchant list | `GET /orders` (merchant session) | `GET /merchants/me/orders` (addition; `/orders/search` exists for filtered queries) | orders tab | `proposed` (see inconsistency 2) |
| Orders — transitions | `POST /orders/:id/ready`, `POST /orders/:id/complete` | `POST /orders/{orderId}/status` | order state machine | `mock-only-until-adopted` (see inconsistency 3) |
| Orders — batch accept | `POST /orders/batch/accept` (`{ids}`) | `POST /orders/batch/accept` (`{orderIds}`) | accept-all | `mock-only-until-adopted` (payload swap, see inconsistency 4) |
| Analytics — dashboard summary | `GET /analytics/overview` | `GET /analytics/dashboard` | dashboard | `mock-only-until-adopted` |
| Analytics — live strip | `GET /analytics/overview` (live section) | `GET /analytics/dashboard` (`AnalyticsDashboard`/`AnalyticsDashboardLive`) | dashboard live strip | `mock-only-until-adopted` |
| Analytics — peak hours | `GET /analytics/trend` | `GET /analytics/hourly-trends` | dashboard trend | `mock-only-until-adopted` |
| Analytics — funnel | `GET /analytics/funnel` | `GET /analytics/funnel` | analytics funnel | `mock-only-until-adopted` |
| Analytics — benchmark | `GET /analytics/benchmark` | `GET /analytics/benchmarks` | benchmarks screen | `mock-only-until-adopted` |
| Analytics — market | `GET /analytics/market` | `GET /analytics/market` | market analysis | `mock-only-until-adopted` |
| Analytics — diagnostics | `GET /analytics/diagnostics` | `GET /analytics/diagnostics` | diagnostics | `mock-only-until-adopted` |
| Analytics — report bundle | `GET /analytics/report` | `POST /analytics/reports/export` | report export | `mock-only-until-adopted` |
| Analytics — order-level | `GET /analytics/orders` | `GET /analytics/order-analytics` | order analytics | `mock-only-until-adopted` |
| Analytics — reviews | `GET /reviews/analytics` | `GET /analytics/reviews` | reviews analytics | `mock-only-until-adopted` |
| Analytics — multi-store | `GET /analytics/multi-store` | `GET /chain/analytics` | multi-store inspection | `mock-only-until-adopted` |
| Analytics — revenue composition | `GET /analytics/revenue-composition`, `GET /finance/revenue-composition` | `GET /analytics/revenue` | revenue screen | `mock-only-until-adopted` |
| Analytics — product | `GET /analytics/products` | `GET /analytics/products` | product analytics | `mock-only-until-adopted` |
| Analytics — top dishes | `GET /analytics/top-dishes` | `GET /analytics/top-dishes` | product analytics | `mock-only-until-adopted` |
| Analytics — traffic | `GET /analytics/traffic` | `GET /analytics/traffic` | traffic screen | `mock-only-until-adopted` |
| Analytics — forecast | `GET /analytics/forecast` | `GET /analytics/forecast` | demand forecast | `mock-only-until-adopted` |
| Analytics — campaign performance | `GET /campaigns/:id/performance`, `GET /analytics/promotions` | `GET /analytics/promotions` (per-campaign performance) | campaign ROI | `mock-only-until-adopted` |
| Analytics — flash sale | (no mock path — UI planned) | `GET /marketing/flash-sales` | flash sale visibility | `proposed` (screen to be built; adopt `/marketing/flash-sales` first) |
| Closure | `POST /closure/apply`, `POST /closure/cancel`, `GET /closure/status` | `POST /merchants/me/closure-protection` (apply/cancel exists); `GET /merchants/me/closure-protection` (status read — addition) | closure protection | `mock-only-until-adopted` (status read: `proposed`) |
| Onboarding | `POST /onboarding/profile`, `POST /onboarding/docs`, `POST /onboarding/submit`, `GET /onboarding/status`, `POST /onboarding/demo-approve` | `POST /onboarding/profile`, `POST /onboarding/docs`, `POST /onboarding/submit`, `GET /onboarding/status`, `POST /onboarding/demo-approve` (all exist) | onboarding wizard | `mock-only-until-adopted` (payload shape: app returns `{status, plan}`; contract `OnboardingStatus` has `steps/currentStep` — align in PR) |
| Printers | `GET /printers`, `POST /printers`, `PATCH /printers/:id`, `DELETE /printers/:id`, `POST /printers/:id/connect`, `POST /printers/:id/test` | `GET /devices`, `POST /devices`, `PATCH /devices/{deviceId}`, `DELETE /devices/{deviceId}`, `POST /devices/{deviceId}/pair`, `POST /devices/{deviceId}/test` | devices & printing | `mock-only-until-adopted` |
| Print jobs | `GET /orders/print-jobs` | `GET /print-jobs`, `GET /print-jobs/{printJobId}` | print history | `mock-only-until-adopted` |
| Tables (dine-in) | `GET /tables`, `POST /tables`, `GET /tables/:id`, `PATCH /tables/:id`, `DELETE /tables/:id`, `POST /tables/:id/qr` | `GET /dine-in/tables`, `POST /dine-in/tables`, `GET /dine-in/tables/{tableId}`, `PATCH /dine-in/tables/{tableId}`, `DELETE /dine-in/tables/{tableId}`, `GET /dine-in/tables/{tableId}/qr` | dine-in | `mock-only-until-adopted` |
| Dual-screen | `GET /stores/:id/dual-screen`, `PATCH /stores/:id/dual-screen`, `POST /dual-screen/pair` | dual-screen settings as fields on `StoreSettings` (addition); pairing via `POST /devices/{deviceId}/pair` | kitchen display / cashier | `proposed` |
| Settlements | `GET /settlements`, `POST /settlements/run`, `POST /settlements/:id/payout` | `GET /finance/settlements/daily`, `POST /finance/settlements/run`, `POST /finance/settlements/{settlementId}/payout` | finance | `mock-only-until-adopted` |
| Ledger | `GET /ledger`, `POST /ledger/withdraw`, `GET /finance/reconciliation` | `GET /payouts/me/statement` (ledger lines), `POST /wallet/withdrawals`, `GET /finance/reconciliation` | finance ledger | `mock-only-until-adopted` (statement/withdrawal shapes to align) |
| AI assistant | `GET /products/assistant/suggestions`, `POST /products/assistant/apply`, `POST /products/assistant/describe` | `GET /products/assistant/suggestions`, `POST /products/assistant/apply`, `POST /products/assistant/describe` (all exist) | product assistant | `mock-only-until-adopted` |
| Redemptions | `GET /redemptions`, `POST /redemptions`, `POST /redemptions/validate` | `GET /vouchers/me`, `POST /vouchers/{voucherCode}/verify` (redemption rows map to vouchers); member top-ups via `POST /loyalty-transactions` if needed | loyalty redemptions | `mock-only-until-adopted` (shape alignment in PR) |
| Chat/messaging | `GET /chat/threads`, `POST /chat/threads/:id/messages`, `POST /chat/threads/:id/customer-messages`, `POST /chat/threads/:id/read` | `GET /conversations`, `GET /conversations/{conversationId}/messages`, `POST /conversations/{conversationId}/messages`, `POST /conversations/{conversationId}/read` | messaging | `mock-only-until-adopted` |
| Notifications | `GET /notifications`, `POST /notifications/read` | `GET /notifications/me`, `POST /notifications/read-all` | notification center | `mock-only-until-adopted` |
| Support tickets | `GET /support/tickets`, `POST /support/tickets` | `GET /support/tickets/me`, `POST /support/tickets` | support | `mock-only-until-adopted` |
| Risk review | `GET /risk/events`, `POST /risk/:id/review` | `GET /risk/events`, `POST /risk/{riskEventId}/review` (both exist) | risk review | `mock-only-until-adopted` |
| Sessions | `GET /sessions`, `POST /sessions/:token/revoke` | `GET /sessions`, `POST /sessions/{token}/revoke` (both exist) | staff sessions | `mock-only-until-adopted` |
| Staff | `GET /staff`, `POST /staff`, `PATCH /staff/:id` | `GET /merchants/me/staff`, `POST /merchants/me/staff`, `PATCH /merchants/me/staff/{staffId}` (all exist) | team & roles | `mock-only-until-adopted` |
| Templates | `GET /templates`, `POST /templates`, `DELETE /templates/:id`, `POST /templates/:id/apply` | `GET /product-templates`, `POST /product-templates`, `DELETE /product-templates/{templateId}`, `POST /product-templates/{templateId}/apply` (all exist) | product templates | `mock-only-until-adopted` |
| Payment accounts | `GET /payment-accounts`, `POST /payment-accounts`, `POST /payment-accounts/:id/verify`, `PATCH /payment-accounts/:id`, `DELETE /payment-accounts/:id` | `GET /store/payment-accounts`, `POST /store/payment-accounts`, `POST /store/payment-accounts/{accountId}/verify`, `PATCH /store/payment-accounts/{accountId}`, `DELETE /store/payment-accounts/{accountId}` (all exist) | payout accounts | `mock-only-until-adopted` |

## Additional off-contract mock paths (outside the tracked ~50)

Handlers that already map 1:1 to existing contract paths and are not part of the
deferred groups above — adopt opportunistically, no contract change needed:
campaigns (`/coupon-campaigns`, `/marketing/platform-events`), customer segments
(`/segments`), announcements (`/announcements`), audit (`/audit/me`), events
(`/events`), riders (`/riders`), invoices (`/finance/invoices`), receipt
templates (`/store/receipt-templates`), QR ordering (`/store/qr-codes`),
compliance (`/store/compliance/recheck`), tasks (`/tasks`), privacy
(`/privacy/export`, `/privacy/delete`), experiments (`/experiments`),
monitoring (`/monitoring/errors`), store settings/menu
(`/merchants/me/settings`, `/catalogues/me`), staff logs (`/store/logs`).

## Landing the PR

1. Send this table to Team 6 as the contract-additions PR content (one PR per
   group or a single batched PR — Team 6 decides batching).
2. Team 6 adds the `proposed` paths, bumps `@hudumika/contract` (patch +
   `CHANGELOG.md`), regenerates, and the app upgrades the exact pin.
3. Per group, the app flips the mock handler to the contract path (path +
   payload-shape alignment) and moves the row's status to `adopted` in
   `merchant/app/README.md` "Phase B — deferred endpoints (tracked)".
4. Mock handlers are never deleted; they remain the dev fallback behind the
   `EXPO_PUBLIC_MOCK_*` switches.

## Resolution status — Drift-D (marketing/analytics/messaging/CRM/ops)

Contract paths the merchant app now calls directly; the mock serves the SAME
behavior at both the contract path and the legacy alias (aliases stay for
compat). Enforced by `merchant/app/tests/drift-marketing.test.ts`
(success-shape parity, error-code parity, auth-required).

| Contract path | Legacy app path (still served) | Status |
| --- | --- | --- |
| `GET /coupon-campaigns` | `GET /campaigns` | `resolved` — mock alias + app re-point (`src/store/campaigns.ts`) |
| `POST /coupon-campaigns` | `POST /campaigns` | `resolved` — mock alias + app re-point (same payload; note: yaml only documents the GET) |
| `GET /marketing/platform-events` | `GET /campaigns/platform` | `resolved` — mock alias + app re-point |
| `POST /marketing/platform-events/{eventId}/enroll` | `POST /campaigns/platform/:id/signup` | `resolved` — mock alias + app re-point |
| `GET /segments` | `GET /customers/segments` | `resolved` — mock alias + app re-point (`src/store/customers.ts`, marketing precision screen) |
| `POST /segments` | `POST /customers/segments/:id/coupons` | `resolved` — mock alias (segment addressed via `segmentId`/`segment` in body, since the contract path has no route id); yaml POST is "create segment" — payload alignment stays a live-adoption note |
| `GET /analytics/dashboard` | `GET /analytics/overview` | `resolved` — dual dispatch in `src/mock/handlers/bi.ts`: no params = contract `AnalyticsDashboard` (p6e-analytics test), `?storeId=` = legacy overview payload the app's dashboard consumes; app re-pointed (`src/store/analytics.ts`) |
| `GET /analytics/hourly-trends` | `GET /analytics/trend` | `resolved` — dual dispatch: `?date=` = contract `[{hour, revenueTZS, orderCount}]`, no `date` = legacy `{days}` payload; app re-pointed |
| `GET /analytics/reviews` | `GET /reviews/analytics` | `resolved` — mock alias (`src/mock/handlers/ops2.ts`) + app re-point (reviews screen analytics section) |
| `GET /analytics/benchmarks` | `GET /analytics/benchmark` | `verified` — already on the contract path (earlier wave); both shapes still served |
| `GET /analytics/order-analytics` | `GET /analytics/orders` | `verified` — already on the contract path (earlier wave); both shapes still served |
| `GET /conversations` | `GET /chat/threads` | `resolved` — mock alias (`src/mock/handlers/messaging.ts`) + app re-point (`src/store/chat.ts`) |
| `POST /conversations/{conversationId}/messages` | `POST /chat/threads/:id/messages` (+ `customer-messages` via `x-internal-key`) | `resolved` — mock alias serving both legacy behaviors + app re-point |
| `POST /conversations/{conversationId}/read` | `POST /chat/threads/:id/read` | `resolved` — mock alias + app re-point |
| `GET /notifications/me` | `GET /notifications` | `resolved` — mock alias + app re-point (`src/store/messages.ts`) |
| `POST /notifications/read-all` | `POST /notifications/read` | `resolved` — mock alias + app re-point |
| `POST /notifications/{notificationId}/read` | (per-item mark previously unmocked) | `resolved` — contract-path handler added (204); app's per-item mark now hits it |
| `GET /reviews/me` | `GET /reviews` | `resolved` — mock alias (`src/mock/handlers/ops2.ts`) + app re-point (`src/store/reviews.ts`) |
| `GET /support/tickets/me` | `GET /support/tickets` | `resolved` — mock alias (registered before `:ticketId` for MSW first-match) + app re-point (`src/store/support.ts`) |
| `GET /audit/me` | `GET /audit` | `resolved` — mock alias (`src/mock/handlers/ops.ts`) + app re-point (audit screen) |
| `GET /print-jobs` | `GET /orders/print-jobs` (mock-only) | `verified` — earlier wave already moved the app to `GET /print-jobs`; contract-path handler exists (`src/mock/handlers/print-jobs.ts`); no action needed |

Legacy paths stay live as aliases (`tests/contract.test.ts` keeps pinning
them); nothing was removed or restructured.

## Resolution status

Contract paths resolved in the Phase B drift wave (module: finance/orders). The
app now calls the contract path; the mock serves the contract path with the
same behavior the legacy path serves. Legacy handlers stay registered (they are
still asserted by the immutable `tests/contract.test.ts`); the aliases live in
`src/mock/handlers/finance.ts` and are covered by `tests/drift-orders.test.ts`.

| Contract path | App call (no `/api` prefix) | Mock handler (with `/api` prefix) | Legacy path kept (same behavior) | Status |
| --- | --- | --- | --- | --- |
| `POST /orders/{orderId}/status` | `src/store/orders.ts` (already re-pointed in an earlier wave) | `POST /api/orders/:id/status` | `POST /api/orders/:id/ready`, `POST /api/orders/:id/complete` | `resolved` (verified by drift test) |
| `GET /payouts/me/statement` | `src/store/finance.ts` `hydrate()` (`?size=100`) | `GET /api/payouts/me/statement` | `GET /api/ledger` | `resolved` |
| `GET /finance/settlements/daily` | `src/store/finance.ts` `hydrate()` | `GET /api/finance/settlements/daily` | `GET /api/settlements` | `resolved` |
| `POST /finance/settlements/run` | `src/store/finance.ts` `runSettlement()` (sends `periodStart`; handler also accepts contract `date`/`reason`) | `POST /api/finance/settlements/run` | `POST /api/settlements/run` | `resolved` |
| `POST /finance/settlements/{settlementId}/payout` | `src/store/finance.ts` `payout()` | `POST /api/finance/settlements/:settlementId/payout` (param renamed internally) | `POST /api/settlements/:id/payout` | `resolved` |
| `GET /finance/invoices` | `src/store/finance.ts` `hydrateInvoices()` (already at contract path from w5b) | `GET /api/finance/invoices` | — (contract path serves the requested e-invoice list) | `resolved` (verified) |
| `POST /finance/invoices/{invoiceId}/issue` | `src/store/finance.ts` `issueInvoice()` | `POST /api/finance/invoices/:invoiceId/issue` (dual-table lookup: requested e-invoices + legacy settlement invoices) | `POST /api/invoices/:id/issue` | `resolved` |
| `GET /payments/methods` | no app call today (test-only) | `GET /api/payments/methods` (contract shape `{method, available}`, all 8 methods, static optimistic availability per backend `ListPaymentMethods`) | — | `resolved` (test-only) |

Notes:

- `GET /api/invoices` (settlement e-invoice list, `{invoices}`) stays mock-only:
  the contract path `GET /finance/invoices` already serves the requested
  e-invoice domain (w5b, contract `Invoice` schema), so the settlement list has
  no free contract path. The issue action for both domains is covered by the
  dual-table `POST /finance/invoices/{invoiceId}/issue`.
- Contract-path settlement/invoice/statement aliases return the legacy shapes
  (`{settlements}`, `{settlement, invoice}`, `{payout, settlement}`,
  `{invoice}`, `{entries, total, page, size, balance}`) — the app consumes
  those envelopes. Payload-shape alignment to the contract schemas
  (`DailySettlement`, `LedgerStatement`) is tracked for the adoption PR.
- `GET /api/finance/methods` (ops2.ts, settlement payment-method breakdown) is
  unrelated to `GET /payments/methods` and stays mock-only.


## Resolution status

Contract paths resolved in the Drift-C wave (`merchant/app`). For each row the
app now calls the contract path and the mock serves the contract path with the
same behavior as the legacy alias (same success shape, same error codes) —
`tests/drift-store.test.ts` pins the equivalence; the legacy handlers stay
registered for the legacy tests.

| Contract path (now called by the app) | Legacy alias (kept) | Behavior parity |
| --- | --- | --- |
| `GET /store/payment-accounts` | `GET /payment-accounts` | `{accounts}` masked list, same rows |
| `POST /store/payment-accounts` | `POST /payment-accounts` | create → `{account}` pending; 400/404 parity |
| `POST /store/payment-accounts/{accountId}/verify` | `POST /payment-accounts/:id/verify` | idempotent activation → `{account}` |
| `DELETE /store/payment-accounts/{accountId}` | `DELETE /payment-accounts/:id` | `{deleted, newDefault}`; default promotion parity |
| `GET /store/receipt-templates` | `GET /receipt-templates` | contract array shape (fields/isActive) — screen maps to app rows |
| `POST /store/receipt-templates` | `POST /receipt-templates` | 201 contract row; name+headerText required (422) |
| `PUT /store/receipt-templates/{templateId}` | `PATCH /receipt-templates/:id` | update never flips active flag |
| `POST /store/receipt-templates/{templateId}/activate` | (legacy default flow) | flips default + clears others |
| `DELETE /store/receipt-templates/{templateId}` | `DELETE /receipt-templates/:id` | `{deleted}`; 409 when template is the assigned default |
| `GET /store/qr-codes` | `GET /stores/:id/qr` (store-QR card) | QR screen now derives the store-QR card from the contract list (ordering kind); list/create/delete already contract from P6b |
| `POST /store/qr-codes` | `POST /store/qr-codes` (P6b) | create 201; kind enum 422 |
| `DELETE /store/qr-codes/{qrCodeId}` | `DELETE /store/qr-codes/{qrCodeId}` (P6b) | 204; unknown 404 |
| `POST /store/compliance/recheck` | `POST /stores/:id/compliance/recheck` | same computed compliance payload (`?storeId=` scoping) |
| `GET /store/logs` | `GET /stores/:id/logs` | `{logs}` rows, same ordering/filtering |
| `GET /dine-in/tables` | `GET /tables` | `{tables}` same rows |
| `POST /dine-in/tables` | `POST /tables` | `{table}`; 400 INVALID_TABLE parity |
| `PATCH /dine-in/tables/{tableId}` | `PATCH /tables/:id` | `{table}`; 400/404 parity |
| `DELETE /dine-in/tables/{tableId}` | `DELETE /tables/:id` | `{deleted}` (was added in the alias wave) |
| `POST /devices/{deviceId}/pair` | `POST /printers/:id/connect` | idempotent connect → `{printer}`; 404 parity |
| `POST /devices/{deviceId}/test` | `POST /printers/:id/test` | 200 `{printed, jobId}`; 409 PRINTER_OFFLINE parity |
| `POST /merchants/me/closure-protection` (`active: true`) | `POST /closure/apply` | same validation (400 reason/period), 409 overlap/quota, closes store, `{protection}` |
| `POST /merchants/me/closure-protection` (`active: false`) | `POST /closure/cancel` | `{cancelled}`; 404 when none active |
| `PATCH /merchants/me` (store-settings update) | `PATCH /store` | partial-patch merge incl. nested objects → `{store}` |

Deliberately NOT re-pointed (no contract path exists — checked
`API-CONTRACT.yaml`):
`GET/PATCH /stores/{storeId}/qr-ordering` (QR ordering config has no contract
endpoint; the merchant-settings payload carries no `qrOrdering` field),
`GET /closure/status` (status read is the `proposed` addition — see the
deferred table above), `POST /tables/{tableId}/qr` (no contract mutation for
regenerating a table QR), `PATCH /payment-accounts/{accountId}` (contract
`/store/payment-accounts/{accountId}` is DELETE-only) and
`GET /receipt-templates/active`. Out-of-scope callers still on legacy paths
(kept working; follow-ups): `(tabs)/dashboard/finance.tsx`
(`GET /payment-accounts`), `(tabs)/profile/index.tsx`
(`POST /printers/:id/connect|test`), `(auth)/register.tsx` (`PATCH /store`).

## Resolution status — catalogue module (drift-a)

Resolved by the drift-elimination pass: the contract paths below are registered
with identical behavior to the legacy paths (same handler function where
possible) and are now what the app calls. Legacy paths remain as aliases
(`tests/contract.test.ts` keeps asserting them). Verified by
`merchant/app/tests/drift-catalogues.test.ts` (contract path ≡ legacy path for
success shape, 4xx/5xx codes, and auth-required).

| Contract path | Status | Notes |
| --- | --- | --- |
| `GET /merchants/me` | resolved | Alias of `GET /auth/me` (same session bundle) in `src/mock/handlers/auth.ts`; session boot + refresh re-pointed (`src/store/session.ts`). `/auth/me` kept as alias. |
| `GET /catalogues/me` | resolved | Serves the own-catalogue payload (`merchantId`/`items`/`publishedAt`) from the session merchant's store menu (`src/mock/handlers/catalogues.ts`); parity with `GET /stores/{storeId}/menu` asserted by the drift tests. |
| `POST /catalogue-items` | resolved | Thin alias of `POST /api/products` (same handler core, `src/mock/handlers/products.ts`); app create re-pointed (`src/store/catalog.ts`). |
| `PATCH /catalogue-items/{itemId}` | resolved | Thin alias of `PATCH /api/products/:id` (param rename `itemId`→`id`); app update re-pointed (`src/store/catalog.ts`). |
| `GET /catalogue-items/{itemId}/logs` | resolved | Thin alias of `GET /api/products/logs` scoped to the item; item-scoped log view re-pointed (`src/app/(tabs)/products/logs.tsx`). The unfiltered "all products" log view stays on the legacy path (no contract equivalent for a merchant-wide log list). |
| `GET /product-templates` | resolved | Thin alias of `GET /api/templates` (same handler core); templates list re-pointed (`src/app/(tabs)/products/templates.tsx`). |
| `POST /product-templates` | resolved | Thin alias of `POST /api/templates` (same handler core); template create re-pointed. |
| `POST /product-templates/{templateId}/apply` | resolved | Thin alias of `POST /api/templates/:id/apply` (param rename `templateId`→`id`); template apply re-pointed. |
| `POST /inventory/items/{itemId}/adjust` | resolved (pre-existing) | The contract path was already registered by the supply-chain module (`src/mock/handlers/supply-chain.ts`); no alias added in this pass to avoid shadowing it. Parity with the mock-only `POST /api/products/stock-adjust` asserted by the drift tests (401/404, delta math). Known divergence kept intentionally: legacy clamps below-zero deltas, contract rejects with `409 INVENTORY_NEGATIVE_STOCK` (contract-specified). |
| `GET /merchants/me/stores` | resolved | Thin alias of `GET /api/stores` (same handler core, `src/mock/handlers/products.ts`); store list re-pointed (`src/app/(tabs)/products/stores.tsx`, `src/app/(tabs)/products/templates.tsx`). |

Remaining mock-only paths in this module (unchanged, not part of this pass):
`GET /products` (merchant product list — `ProductRow` carries `stock`/`sold`/
variants beyond the contract `CatalogueItem`), `GET /categories` +
`/categories/sort` (category CRUD), `POST /api/products/stock-adjust` (batch
adjust — see the inventory row above), and the `/stores/{storeId}/menu`
read/patch pair (chain-store menu editing).

## Resolution status — P7: Arabic locale + RTL (shipped)

P7 (docs/LOCALIZATION.md: `ar` capable) shipped in the merchant app:

- `src/i18n/index.ts` — `Locale` extended to `'en' | 'sw' | 'ar'`; full Arabic bundle added (2,553 keys, one-to-one with `en`/`sw`, identical `{param}` placeholders). Dictionary exported as `dict` (used by `tests/i18n.test.ts`). Locale persistence (`merchant.locale`) now accepts `ar`; `setLocale` flips the web `dir` attribute for RTL and re-renders through the existing `onLocaleChange` subscription.
- `src/i18n/rtl.ts` — native RTL wiring: `I18nManager.allowRTL(true)` + `forceRTL(locale === 'ar')`, called from the locale switcher.
- `src/app/(tabs)/profile/settings.tsx` — language switcher extended with العربية (`set.arabic` added to all three bundles).
- `app.json` / `package.json` — `expo-localization` installed; config plugin sets `supportsRTL: true` and registers `en`/`sw`/`ar` locales (iOS `CFBundleLocalizations`, Android `localeConfig`; `allowDynamicLocaleChangesAndroid` defaults to true so the runtime flip is not blocked by activity restarts).
- `tests/i18n.test.ts` — asserts key-set parity across en/sw/ar and per-key placeholder parity; registered in `tests/run.mjs` (`DEFAULT_TESTS`).
- Known pre-existing sw quirk (intentionally left, en/sw content untouched): `offline.banner` / `offline.syncing` in `sw` skip the `{noun}` placeholder — whitelisted in the test.

## Status summary

- **Contract coverage:** all 217 merchant-scope operations in
  `backend/API-CONTRACT.yaml` are implemented (handlers + tests + screens) —
  217/217. The YAML carries 580 operations; the unserved remainder belongs to
  other app surfaces (admin/riders/providers/customer).
- **Drift:** 48 drift operations resolved across all `Resolution status`
  tables above (drift-a, Drift-C, finance/orders, Drift-D) — the app calls the
  contract path; legacy paths remain registered mock aliases with behavior
  parity pinned by `merchant/app/tests/drift-*.test.ts` +
  `contract-aliases.test.ts`.
- **Out of scope:** remaining unserved paths belong to other apps; nothing
  further is proposed for the merchant app here *beyond the open items tracked
  in "Open contract additions (needs backend PR)" below*.
- **P7 shipped:** Arabic locale + RTL (see the P7 section above).

## Open contract additions (needs backend PR)

Re-verified against `backend/API-CONTRACT.yaml` on 2026-08-15. The items below are
still absent from (or in conflict with) the contract and need a backend PR before
the app can adopt them; each maps to a `proposed` row in the deferred tables above.

| # | Addition | Contract status (verified against yaml) | App status |
| --- | --- | --- | --- |
| 1 | `GET /merchants/me/orders` — merchant order list | absent (consumer `/orders/me` is customer-scoped; `/orders/search` exists) | `src/store/orders.ts:107` still on mock-only `GET /orders` (inconsistency 2) |
| 2 | `GET /merchants/me/closure-protection` — status read | `POST` only (`setClosureProtection`, yaml:2608) | app calls only the POST; status derived client-side |
| 3 | Dine-in split-bill | no `split` path anywhere in the yaml | no split UI in `src/store/dine-in.ts` / `store/bill/[id].tsx` |
| 4 | Merchant-side reservation management (list/confirm/seat/no-show) | `/reservations*` (yaml:2948-2990) are customer-only | `store/reservations.tsx` uses the consumer own-list endpoint |
| 5 | `POST /feedback` | absent (only a `feedback` QR kind enum) | no feedback screen |
| 6 | Dual-screen settings as `StoreSettings` fields | no `dualScreen` fields in the schema | settings mock-only (`/stores/:id/dual-screen`); pairing via `POST /devices/{deviceId}/pair` |
| 7 | `GET /members/{memberId}/transactions` + phone lookup | absent (`/members`, `/members/{memberId}/top-up` only) | redemptions mock-only (`/vouchers/verify-history`) |
| 8 | `barcode` field on `CatalogueItem` | absent (separate `/barcodes/*` resources exist; item schema has no field) | barcode screens on legacy mock paths (`products/barcodes.tsx`) |
| 9 | `GET /orders/me/advance?date=` GET vs app POST | GET **exists** with required `date` (yaml:3898, `listAdvanceOrders`); the app's `POST /orders/me/advance` handoff is off-contract and collides | decide: adopt the contract GET for the pre-orders tab and re-map the handoff onto `POST /orders/{orderId}/status`, or get the POST documented |
| 10 | Batch accept `{ids}` → `{orderIds}` | path **exists** with body `{orderIds}` (`AcceptOrdersBatchBody`, yaml:5771) | app sends `{ids}` (`src/store/orders.ts:143`) — app-side swap, no yaml change needed |
