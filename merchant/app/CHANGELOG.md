# Changelog

All notable changes to the Hudumika Merchant app (Expo) are recorded here.
Format: Keep a Changelog. Versioning: calendar-ish per release (see M7).

## [Unreleased]

### Added

- Per-module mock switches (`EXPO_PUBLIC_MOCK_AUTH/_ORDERS/_CATALOG/_FINANCE/_BI/_MARKETING/_MESSAGING/_OPS/_STORE/_ALL`),
  default ON in dev, gated in `src/mock/switches.ts`; mocks never load in
  production builds (`EXPO_PUBLIC_ENVIRONMENT=production` or all switches off).
  Registered in `docs/ENV-VARS.md` + `.env.example`; CI asserts the production
  export carries no mock runtime marker. (M2)
- `@hudumika/contract` adopted as a file: workspace dependency; `src/api/types.ts`
  typed against generated contract types where shapes match (auth, orders,
  payments, payout accounts, accepted-payment-methods), app extensions explicit.
  Payment method keys re-keyed to the contract enum (`wechat→mpesa`,
  `alipay→airtel_money`, `cash→cod`). (M3)
- `merchant/docs/CONTRACT-ADDITIONS.md`: Phase B contract-additions proposals for
  the ~50 deferred endpoints (mock paths, proposed contract paths, needed-for,
  status), incl. the three known inconsistencies (`GET /auth/me` → `GET /merchants/me`,
  merchant order list → `GET /merchants/me/orders` proposal, ready/complete →
  `POST /orders/{orderId}/status` advance). (M3)
- Store-level tests (`tests/store.test.ts`, 21 tests) covering 11 zustand stores
  against the in-app mock API; offline-queue + idempotency tests
  (`tests/queue.test.ts`, 23 tests); bundle-budget check
  (`tests/bundle-budget.mjs`, 3.75 MB budget, wired into CI). (M6, M8)
- Testing-stack decision recorded in `merchant/docs/TESTING.md`:
  `node:test` + esbuild is the standardized stack (no Jest/RNTL). (M6)
- Full i18n coverage: all user-facing strings routed through `t()`; dictionary
  extended to 1218 keys × 2 locales (`en` + `sw`). (M4)
- Accessibility pass: roles/labels/states on `ui.tsx` primitives and
  icon-only/ambiguous controls across screens; reduce-motion respected in
  toast + splash animations; loading/empty/error/retry gaps fixed on
  dashboard, orders list, marketing ROI and profile staff cards. (M5)
- Auth tokens persisted via `expo-secure-store` on native (web keeps
  sessionStorage), with an in-memory cache so the synchronous transport path
  is unchanged. (M5)
- Full P6b–P6e feature waves: dine-in (tables CRUD + QR, bill lifecycle,
  dual-screen POS, store settings + closure protection), commerce ops
  (group-buy deals + vouchers, promotions + brand-display, coupon campaigns),
  growth tools (loyalty members/tiers/top-ups, staff accounts, device
  registry + print jobs, merchant wallet, chain stores + product templates),
  intelligence (analytics dashboard + live strip, traffic/products/revenue
  screens, benchmarks, report exports). (P6b–P6e)
- Full P8/P8b/P8c feature waves: chain dashboard + cross-store analytics +
  bulk operations, catalogue bulk import/export + product templates, master
  inventory + suppliers + purchase orders + supplier returns + warehouses,
  staff ops (shifts/attendance/performance/commissions) + approval engine,
  integration registry + webhook subscriptions with delivery health,
  scheduled reports + CRM segments/journeys + enterprise data exports +
  privacy export, analytics-ext (store score, customers,
  customer-distribution, marketing). (P8/P8b/P8c)
- All 217 merchant-scope contract operations implemented (handlers + tests +
  screens) — 217/217; `backend/API-CONTRACT.yaml` carries 580 operations and
  the unserved remainder belongs to other app surfaces (admin/riders/
  providers/customer). (P6–P8)
- Drift alignment: the app calls the contract path for finance/orders, store,
  catalogues and marketing/analytics/messaging/CRM/ops; legacy paths stay
  registered as mock aliases with behavior parity pinned by
  `tests/drift-*.test.ts` + `tests/contract-aliases.test.ts`. (drift waves)
- Per-module mock switches extended to 26 modules + `_ALL` master
  (`EXPO_PUBLIC_MOCK_CATALOGUES/_MERCHANTS/_PROMOTIONS/_GROUP_BUY/_LOYALTY/
  _DEVICES/_CATALOGUE_EXT/_CHAIN/_SUPPLY_CHAIN/_WEBHOOKS/_TASKS/_STAFF_OPS/
  _REPORTS/_ANALYTICS_EXT/_PRINT_JOBS`); registered in `docs/ENV-VARS.md` +
  `.env.example`. (P6b–P8c)
- Arabic locale + RTL: `Locale` extended to `en | sw | ar` with a full Arabic
  bundle (2,553 keys per locale, key + placeholder parity asserted by
  `tests/i18n.test.ts`); `I18nManager` RTL wiring and `expo-localization`
  config plugin (`supportsRTL`, locale registration). (P7)
- Test suite growth 144 → 497 across 26 suites (per-wave additions: dine-in,
  group-buy, loyalty, p6d-gaps, p6e-analytics, w0a, promotions, orders-gaps,
  catalogue-ext, supply-chain, webhooks-tasks, staff-ops, engagement,
  reports-crm, finance-ext, store-settings, catalogues-merchants,
  contract-aliases, drift-catalogues, drift-orders, drift-store,
  drift-marketing, i18n). (M8 → now)

### Changed

- `tests/run.mjs` default suite: contract + store + queue (existence-filtered).
- `tests/run.mjs` default suite extended to the 26 per-phase, drift, alias and
  i18n suites (existence-filtered). (M8 → now)
- CI: web export runs with `EXPO_PUBLIC_ENVIRONMENT=production`; mock-gate
  assertion step; bundle-budget step after export.
- Bundle budget stays at 3.75 MB with ~25% headroom over the measured 2.97 MB
  web export; the CI check keeps running after web export. (M8 → now)
- `src/store/orders.ts`: `acceptAllOrders` no longer clobbers state rows with
  `{id, order}` wrappers (was mapped as `Order[]`).

### Removed

- Source-app leftovers: `AGENTS.md`, `CLAUDE.md`, `.qwen/`, `.vscode/`,
  `.claude/`, `scripts/reset-project.js` (+ its package.json script) and unused
  Expo template assets. Provenance noted in README. (M1)

## [1.0.0] - 2025-08

- Adopted Expo merchant app foundation with contract-aligned auth
  (`/auth/request-otp`, `/auth/verify-otp`, `/auth/logout`) and order
  accept/reject/batch/rush-reply/receipts/reject-reasons paths.