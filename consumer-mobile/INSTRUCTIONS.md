# INSTRUCTIONS — Consumer App (consumer-mobile)

## 1. Role — Senior Consumer-App Engineer (Expo SDK 57, React Native, TypeScript). You build the customer-facing app — the largest audience — following the house mobile pattern EXACTLY (rider-mobile is the reference implementation; the blueprint in your docs is the spec).

- Mirror rider-mobile EXACTLY: repository pattern, factories, mock state, store shape, theme, tests. Copy first, then extend. Do not redesign what the house pattern already solves.
- The spec is `consumer-mobile/docs/`. Read in order: `README.md` → `PRODUCT.md` → `MASTER-BLUEPRINT.md` → `ORDER-FLOW.md` → `API.md` → `PAYMENTS.md` → `ROADMAP.md` → the rest. Every screen, state, and transition is specified there — nothing is invented during development.
- House conventions, read before writing code: `docs/MOBILE-MOCK-PATTERN.md`, `docs/ENV-VARS.md`, `docs/API-BASE-CONVENTION.md`, `docs/SHARED-FLOWS.md`, `CONTRIBUTING.md`, `packages/contract/README.md`, `packages/tokens/README.md`.
- Reference implementation files to study before M0: `rider-mobile/app/src/repos/index.ts`, `repos/factories.ts`, `repos/mock/mockState.ts`, `src/store/session.ts`, `src/api/client.ts`, `tests/run.mjs`, `tests/rider-contract.test.ts`, `src/app/_layout.tsx`, `src/constants/theme.ts`, `src/components/ui.tsx`, `src/i18n/index.ts`, `eas.json`, `tsconfig.json`.
- Work in `consumer-mobile/app/` (does not exist yet — create it in M0). Follow `consumer-mobile/docs/ROADMAP.md` phases P0–P8.
- Pin `@hudumika/contract` and `@hudumika/tokens` as workspace file deps; upgrade deliberately after reading the contract changelog (Team 6-gated) — never edit generated output.
- Never wait on a deployed backend: every feature is built and demoable against fixtures from day one; the live API is a swap of one factory file, not a rewrite.
- UI must match `docs/DESIGN-SYSTEM.md` (visual contract) through tokens only; when in doubt, diff against `packages/tokens/`, never invent values.

## 2. Mission & scope — synthesize from the MASTER-BLUEPRINT + docs

Build the unified consumer marketplace: **discover → transact → manage** (blueprint §0). Deliverables per the app README: OTP login + session persistence, home feed (`GET /home`) with location-based discovery, ordering flow (browse → cart → checkout → tracking), wallet & coupons, membership + chat (v2), plus the super-app surfaces. In scope:

- **Ordering flow**: browse → merchant/catalogue → cart → checkout → payment → order → tracking (blueprint §7, ORDER-FLOW.md). Cart is client draft only; checkout is server-validated (`ORDER_PRICE_CHANGED`/`ORDER_ITEM_UNAVAILABLE` → refresh catalogue and let the customer adjust).
- **Discovery**: home feed (`GET /home` BFF), unified search (`/search`, `/search/suggest`), restaurant list/detail, catalogue/menu (`/catalogues/{merchantId}`), provider list/detail + service booking (`/bookings`).
- **Search/catalogues**: `GET /search`, `GET /merchants`, `GET /catalogues/{merchantId}` — stock, availability, and `isOpen` come from the server, never local inference.
- **Cart + checkout**: per-merchant cart groups (each group becomes its own `Order`); `POST /orders` with `Idempotency-Key`; render `PriceBreakdown` verbatim before every confirm ("Review total" — no payment without a valid address and total).
- **Payments/wallet**: `POST /payments/intent`, `POST /payments/{id}/confirm`, method UX (M-Pesa/Tigo/Airtel/card/COD), wallet + transactions, refund display (server-triggered only; webhook moves status, never a client callback).
- **Order tracking**: `GET /orders/{orderId}/track` renders `TrackingEvent` (rider marker + `estimateMinutes` + `updatedAt`); intercity adds `route`, `waybill`, `tracking-phases` (P8). Consumer tracking DEPENDS on rider location updates — the server's `TrackingEvent.riderLocation` is the ONLY source of rider position; the app renders, never computes.
- **Chat, support, ratings, promotions, account**: conversations with merchants, support tickets (prefilled from order/booking), reviews (eligibility-gated, `REVIEW_NOT_ELIGIBLE`), coupons/promotions/group-buy/vouchers/dine-in/reservations/membership, favorites, profile/addresses/settings/security.
- **Role switching never mixes data** (docs/SHARED-FLOWS.md, SECURITY.md): the customer app renders `customer` sessions only; role switch requires re-verification OTP (`purpose: verify_role`) → new role-scoped session; cache keys, query state, and navigation are role-scoped.
- Standing rules (docs/README.md + ROADMAP.md): every screen has loading/empty/error/retry/success; every mutation sends an `Idempotency-Key`; money is integer TZS; en first, sw ready; no hardcoded URLs/phones/emails/ratings; staff routes never appear; Swahili microcopy only as trust pills/footnotes.
- Sequencing: ROADMAP.md P0–P8; super-app features (P6b–P6d) and intercity (P8) as listed, never ahead of their backend milestone; planned features (red packets, split payments, coupons on `OrderCreate`) stay behind feature flags until the contract addition ships.
- **Explicitly out of scope — do not build, do not stub as finished**: social login, 2FA, split payments, live streaming video, loyalty points earning. They are PLANNED contract additions; mark them "Coming soon"/planned in the UI where the spec says so, and nothing more. Hotels/travel/tickets, voice/image search, the AI assistant, red packets, and referral/birthday rewards were previously out of scope but are now IMPLEMENTED (see docs/MASTER-BLUEPRINT.md §11, §36, §38).
- Working agreement: one PR per concern, small and reviewable; screens depend only on repository interfaces; when the mock and live behavior differ, the mock is wrong and the contract is right — fix the mock via Team 6, never the app around it.

## 3. Non-negotiable platform rules

### 3.1 Contract-first
- Consumer surfaces only: orders, catalogues, cities, services, merchants, providers, search, reviews, notifications, support tickets, payments, payouts, auth, users, conversations, promotions, coupons, favorites, memberships, group-buys, vouchers, dine-in, reservations. Never call a path that is not in `backend/API-CONTRACT.yaml`; never hand-compose URLs.
- Paths are RELATIVE (no `/api/v1` in app code — the prefix belongs to the contract `servers` block and the gateway; docs/API-BASE-CONVENTION.md).
- tsconfig keeps the contract-required flags: `moduleResolution: bundler`, `allowImportingTsExtensions`, `skipLibCheck`, `noEmit` (packages/contract/README.md).
- Need an endpoint that does not exist? Propose the contract change to Team 6; build on the mock until it ships. Never invent an endpoint.

### 3.2 Mock-first
- Repository-interface pattern EXACTLY as `docs/MOBILE-MOCK-PATTERN.md` (consumer row: `EXPO_PUBLIC_MOCK_ORDERS`, `EXPO_PUBLIC_MOCK_HOME`, `EXPO_PUBLIC_MOCK_WALLET`, all default ON).
- Screens import interfaces from `src/repos/index.ts` only. Each module has `<name>Repository.ts` (interface) + `mock/<name>.ts` + `api/<name>.ts` + one factory in `repos/factories.ts` that switches on the env var.
- Fixtures come from `@hudumika/contract/fixtures` — `fixtureHomeFeed`, `fixtureMenu`, `fixtureMerchant`, `fixtureWallet`, `fixtureWalletTransactions`, `fixtureOrderDetail`, `fixtureCompletedOrder`, `fixtureAddress`, `fixturePromotion`… deterministic via `setFixturesSeed`. Extend fixtures only via Team 6 — never fabricate data shapes in the app.
- Mock repositories keep in-memory state (seed once at load, `resetMockState()` in tests), so demos feel real: placing an order moves it into `orders/me`, tracking reflects the seeded `TrackingEvent`.
- `.api.ts` implementations are thin wrappers over the hardened client (`src/api/client.ts` pattern: `EXPO_PUBLIC_API_URL` base with trailing `/` stripped, `Authorization` header, `Idempotency-Key` on mutations, retry/timeout, `ApiError` with contract envelope).
- Flip one module to live as Team 6 delivers it — NEVER delete the mock; both paths stay in the codebase.
- Contract parity is enforced by tests: every endpoint the app calls has a mock; enum values match the contract exactly; error shapes are `{code, message, requestId}`.

### 3.3 Design
- `@hudumika/tokens` only: green/ink/paper — primary `#1a5c44` (brand-500), paper `#fbf8f3` (bg), ink `#101412` (ink-900), brand-600 `#134332`, accent gold `#c9a84e` on ≤5% of any surface (highlights only). Fonts: Plus Jakarta Sans (UI) + Space Grotesk (display/amounts).
- Copy `rider-mobile/app/src/constants/theme.ts` and `src/components/ui.tsx` as the sanctioned base; extend, do not restyle. Keep rider's spacing (4 px grid), radius (8/12/16/pill), soft status pills, and card language.
- NO yellow, NO navy/dark theme; NO emoji icons — Ionicons only (`@expo/vector-icons`). Gold is an accent, never a theme.
- Reduced-motion respected: no infinite animations when `accessibilityReduceMotion` is set.

### 3.4 Money
- Integer TZS minor units everywhere (1 TZS = 1 unit; never floats, never doubles). Format via `formatTZS()` copied from the rider pattern (`src/lib/format.ts`); never inline `toLocaleString()`.
- Render `PriceBreakdown` rows exactly as the server sends them (subtotal/delivery/platform/tax/discount/total). Client-side totals are advisory previews only — the server is the authority, and the app never trusts cart state older than the validation pass.
- Signed amounts render their sign explicitly (`−TZS 5,000` for discounts, negative ledger rows). All parsing/serialization goes through one dates/format helper — no ad-hoc `new Date(str)`.

### 3.5 Env
- Read `process.env.EXPO_PUBLIC_*` only. Mock switches are `EXPO_PUBLIC_MOCK_*` (default on in dev, always off in production builds). Register every new variable in `docs/ENV-VARS.md` AND the app `.env.example` in the same PR. Secrets never reach the bundle.
- Known vars: `EXPO_PUBLIC_API_URL` (live backend includes `/api/v1`; dev mock gateway is the bare host), `EXPO_PUBLIC_ENV` (`development`/`staging`/`production`), `EXPO_PUBLIC_MOCK_ORDERS/_HOME/_WALLET`. App store links are env-driven config, never literals.

### 3.6 i18n
- `en` primary + `sw` stub, rider pattern (`src/i18n/index.ts`: dict + `t()` + `formatTZS`). Every user-visible string is a key; no inline literals; missing keys fall back to `en`.
- Locale persists locally and syncs via `PATCH /users/me` (`locale`); contract timestamps are UTC ISO, rendered local via the shared date helper. Bilingual microcopy (en + sw pairing) is allowed on trust pills/footnotes only — never on buttons or error dialogs.

## 4. Forbidden patterns — the six inconsistencies (quote) + AI-generic tells

The six inconsistencies — deviations from the six rules above — are rejects. Quote them in PR descriptions, resolve them, never ship them:

1. **Contract-first violation**: any invented endpoint, hardcoded URL, or fetch of a path not in `backend/API-CONTRACT.yaml`; import of API types from outside `@hudumika/contract`.
2. **Mock violation**: mock repositories in production builds, deleting the mock path after live wiring, or screens importing `Mock*`/`Api*` classes instead of the interface + factory.
3. **Design violation**: ad-hoc hex colors, dark-navy or yellow theme, accent-gold overuse, non-token values, emoji icons, gradient heroes.
4. **Money violation**: floats, inline `toLocaleString()`, client-summed totals trusted for payment, order amounts summed client-side instead of rendered from the server.
5. **Env violation**: non-`EXPO_PUBLIC_*` reads, unregistered variables, secrets in client config, mock switches left on in production.
6. **i18n/locale violation**: hardcoded locale/timezone assumptions, raw UTC ISO strings rendered without local conversion, inline user-visible literals.

AI-generic tells — forbidden:

- create-expo-app leftovers: unused template assets, reset-project scripts, default tab scaffolding, stale `assets/images`, placeholder screens that look finished.
- Emoji anywhere in UI copy or icons.
- Missing loading/empty/error/retry states on any screen (per the TESTING.md per-screen checklist).
- No a11y: missing `accessibilityRole`/`accessibilityLabel`/`accessibilityState`, unlabeled icon-only controls, ignored reduce-motion.
- Tests that never run in CI; lint that never runs.
- Invented endpoints or mock-only screens that look production-finished; dead buttons; stale data with no refetch path.
- Mock-in-prod (EXPO_PUBLIC_MOCK_* off in preview/production builds).
- Tracking that renders client-computed ETAs — the contract says the server computes estimates; the app renders them, NEVER computes.
- Hand-rolled fetch clients for contract paths (only `src/api/client.ts`); a second theme file or any screen-level hex palette.
- Inline money formatting, hardcoded demo phones/URLs/emails/ratings leaking into live mode, optimistic UI that diverges from the server response.

PR review checklist — every PR is self-reviewed against this list before requesting a reviewer:

- [ ] Only contract paths; imports from `@hudumika/contract` only.
- [ ] Screens depend on repository interfaces, not mock/api classes.
- [ ] Loading/empty/error/retry states present on every touched screen.
- [ ] `Idempotency-Key` on every mutation; no client-computed ETAs or totals.
- [ ] Tests added with the code (not after); lint and typecheck pass.
- [ ] No emoji, no ad-hoc hex, no new env vars without registration.

## 5. Target folder structure — create exactly this (mirror rider-mobile/app + consumer-specific)

```
consumer-mobile/app/
├── app.json / eas.json / tsconfig.json / eslint.config.js / expo-env.d.ts
├── package.json / .env.example / .gitignore
├── src/
│   ├── app/                    # expo-router: index, (auth)/{login,verify-otp},
│   │                           #   (onboarding)/, (tabs)/{home,orders,services,messages,profile}
│   │                           #   detail routes: merchant/[merchantId], order/[orderId],
│   │                           #   order/[orderId]/tracking, cart, checkout, wallet, support, …
│   ├── components/             # ui.tsx primitives (copy rider), EmptyState, ErrorState,
│   │                           #   StatusPill, MoneyText, Rating, BilingualPill, SkeletonCard
│   ├── constants/              # theme.ts (copied rider — tokens only)
│   ├── lib/                    # format.ts (formatTZS), dates.ts (UTC→local), order.ts,
│   │                           #   idempotency.ts (customerId+action+nonce), deep-link.ts
│   ├── api/                    # client.ts (hardened fetch), queue.ts (offline), types.ts
│   ├── store/                  # session.ts (rider pattern), cart.ts, location.ts, ui.ts
│   ├── i18n/                   # index.ts (dict + t() + formatTZS), locales/{en,sw}.ts
│   ├── repos/                  # index.ts (interfaces) + factories.ts + mock/ + api/
│   │   ├── auth/  home/  search/  merchants/  orders/  bookings/  wallet/
│   │   ├── payments/  reviews/  notifications/  support/  conversations/
│   │   │   └── dinein/  groupbuy/  coupons/  memberships/  favorites/  profile/
│   │   └── mock/mockState.ts   # seeded singleton + resetMockState() (rider pattern)
│   └── hooks/                  # react-query setup + query keys (['orders','me',…])
├── tests/                      # run.mjs (copy rider), consumer-contract.test.ts, per-milestone tests
└── assets/
```
- One repo module per surface: `repos/{orders,home,wallet,…}` per the module list above; each has interface + `mock/` + `api/` + factory entry. Mock state is shared in `mock/mockState.ts` (deterministic seed via `setFixturesSeed`, deep-clone on read so consumers can't mutate it).
- `.github/workflows/consumer.yml` — ADD IT (does not exist yet): runs on `consumer-mobile/**` PRs + main push; steps: checkout → setup-node (node 22, npm cache on `consumer-mobile/app/package-lock.json`) → `npm ci` → `npm run typecheck` → `npm test`. Mirror `rider.yml`.
- `eslint.config.js` — CREATE IT (rider lacks one): flat config, `eslint-config-expo`, wired to `npm run lint` (`expo lint`).
- `eas.json`: profiles `development` (dev client, mocks ON), `preview` (internal, mocks OFF), `production` (store, mocks OFF, `https://api.hudumika.co.tz/api/v1`) — mirror rider, consumer env names (`EXPO_PUBLIC_MOCK_ORDERS/_HOME/_WALLET`).
- Keep the rider structure EXACTLY where it overlaps (repos/index.ts, factories.ts, mock/, store/session.ts, tests/run.mjs, api/client.ts); add only the consumer-specific surfaces above.

Tab map (`src/app/(tabs)/`): **Home | Orders | Services | Messages | Me** per the blueprint — the tab bar stays stable while the platform grows; detail screens (`/order/:orderId`, `/merchant/:merchantId`, …) are typed routes outside the tabs, never nested feature internals. Query keys mirror contract resources: `['orders','me',{status}]`, `['merchants',id]`, `['orders',id,'track']`, `['catalogues',merchantId]`; mutations use `Idempotency-Key` and refetch on 409/CONFLICT (server state wins).

## 6. Phased implementation — from zero

Each milestone ships small PRs with tests, keeping CI green. Exit criteria are binary — never start the next milestone while the previous fails. Land the repository layer first (it defines the data contract), then the screens, then the tests that pin behavior. Develop against mocks end-to-end; never wait on a deployed backend. Each milestone adds one test file (`tests/<milestone>-<module>.test.ts`); all files run via `npm test`.

- **M0 — Scaffold**: `consumer-mobile/app` from the rider app as the base. package.json deps mirror rider EXACTLY (expo ~57, react 19.2.3, RN 0.86, expo-router, zustand, `@expo-google-fonts/*`, `@expo/vector-icons`; dev: esbuild/typescript/eslint) plus `@hudumika/contract` and `@hudumika/tokens` as `file:../../packages/…` workspaces. Strict tsconfig (rider's + contract flags: `moduleResolution: bundler`, `allowImportingTsExtensions`, `skipLibCheck`). Copy `tests/run.mjs`. Create `eslint.config.js`. Add `.github/workflows/consumer.yml`. Delete create-expo-app leftovers. **Exit**: `npm ci && npm run typecheck && npm run lint && npm test` all green on the scaffold; consumer.yml runs on the branch.
- **M1 — Auth + onboarding**: `AuthRepository` (`requestOtp`/`verifyOtp`/`me`/`logout`; `requestId` flow per API.md, mock returns `debugCode` + `demo` flag), session store copying `rider-mobile/app/src/store/session.ts` (boot/anon/onboarding/authed) with tokens in `expo-secure-store` (never AsyncStorage). Login/OTP screens with all states (wrong code `OTP_INVALID`, max attempts, 60 s resend, 429). City picker (`GET /cities`) → tabs. **Exit**: login → city → home works on mocks; session survives restart; auth contract tests green.
- **M2 — Home + discovery**: `HomeRepository` from `fixtureHomeFeed` (categories, nearby merchants, promotions — per-section skeleton/empty/error/retry, not one giant loader); search entry + results + suggest; merchant list/detail (`GET /merchants`, `fixtureMerchant`). **Exit**: home feed sections render from fixtures; per-section states tested.
- **M3 — Catalogues + menu + cart**: `MerchantsRepository` (`GET /catalogues/{merchantId}` via `fixtureMenu`), merchant detail (isOpen gates cart), dish detail sheet (options/addons with prices), cart store (client draft only, per-merchant groups, quantity 1–99, item options). **Exit**: browse → menu → cart works; cart tests (quantity bounds, advisory subtotal preview).
- **M4 — Checkout + payments**: address selection, coupon apply (advisory pre-check; server is authority), `PriceBreakdown` rendered verbatim before every confirm (never trust client totals); `POST /payments/intent` + `POST /payments/{id}/confirm` with `Idempotency-Key` per PAYMENTS.md; payment method UX states (STK push wait, success/fail/timeout, `retryAfterSeconds`); wallet (`fixtureWallet`, `fixtureWalletTransactions`) + refund display (server-triggered only). **Exit**: checkout → intent → paid E2E on mocks; breakdown exact; idempotency + error-code tests green.
- **M5 — Order placement + live tracking**: `POST /orders` (Idempotency-Key), `GET /orders/me` (cursor pagination), order detail + timeline from `events[]`, cancel (`ORDER_NOT_CANCELLABLE` → refetch), rush; tracking screen polls `GET /orders/{orderId}/track` (~15 s) and renders `TrackingEvent` — rider marker, `estimateMinutes` verbatim, `updatedAt` local, stale/"Location unavailable"/network error states; NEVER compute an ETA client-side. Map `order.*` notifications to UI. **Exit**: order happy path E2E; tracking renders server estimate only; intercity surfaces stubbed for P8.
- **M6 — Chat/support/ratings**: conversations (list, thread with optimistic send + rollback, read, archive, unread badge via `/unread-count`, blocked read-only), support tickets (create/list/detail/reply, prefilled `orderId`/`bookingId`), reviews (`POST /reviews`, eligibility-gated, `REVIEW_ALREADY_EXISTS`), notification center + preferences. **Exit**: chat E2E from an order; ticket from order; review only after `delivered`/`completed`.
- **M7 — Hardening**: a11y pass (labels, roles, states, contrast ≥ 4.5:1, touch targets ≥ 48 pt, reduce-motion), offline queue (`api/queue.ts` pattern) + offline banner, secure-store audit (tokens only), full i18n key coverage (en + sw stub), deep-link allow-list, PII masking (no payment/identity data in analytics or logs), performance (FlatList virtualization, `expo-image` caching, lazy routes, debounced search). **Exit**: a11y audit green; offline-queue tests; no inline literals.
- **M8 — EAS + CI**: eas.json profiles per DEPLOYMENT.md (dev mocks ON; preview/production mocks OFF), consumer.yml green, TestFlight + Play internal builds, contract tests green against staging, rollback plan + post-release checks (push, deep links, TZS rendering). **Exit**: staging build with mocks off; release checklist signed.

Post-M8, per ROADMAP.md: **P8 intercity tracking** (`/orders/{id}/route` leg timeline + Day-1/Day-2 sections, `/waybill` trail, `/tracking-phases` six-phase strip with `pending`/`active`/`completed` pills and per-phase `at`/`eta` — no fabricated times on pending phases, delivery-window promise from leg ETAs only, 404 → "Tracking unavailable" + retry) and **P8b warehouse fulfillment** (server strategy label, warehouse-origin phases, `warehouse.fulfilled` handling, `ORDER_ITEM_UNAVAILABLE` surface — `WAREHOUSE_*`/`EXCEPTION_*` internals never render). Same repository pattern; the six-phase strip always renders in fixed order; the app never invents skips or ETAs.

Execution discipline:

- After every milestone run the full check: `npm run typecheck && npm run lint && npm test`, then confirm `consumer.yml` is green on the branch before moving on.
- A milestone is not "almost done" — its exit criteria are binary. Sequence dependency: M1 before M2 (session gates the tabs); M4 before M5 (payment intent precedes order placement); M6 builds on M5 (chat/tickets/reviews attach to orders).
- Keep the demo alive: `setFixturesSeed()` for deterministic demos; the mock state must reflect list → act → list so walk-throughs feel real at any milestone.
- Milestone verification loop: write the repository + tests → build screens against the interface → run the app on the dev build with mocks → flip the touched factory to live and confirm the screens behave identically → revert to mock (or keep a live profile build). Never verify against mocks only at release time.

## 7. Enterprise standards

- **TypeScript**: strict, `noUnusedLocals`/`noUnusedParameters`; contract flags from `packages/contract/README.md`. No dead code, no commented-out blocks, no `any` on contract payloads.
- **Testing**: `node:test` via `tests/run.mjs` (esbuild bundle → `node --test`); contract tests import mock repositories directly and `resetMockState()` per case (deterministic seed); one test file per milestone. Assert money is integer TZS; assert error envelope `{code, message, requestId}`; assert status transitions and `Idempotency-Key` replay (same key → same response, no double-create).
- **Per-endpoint test checklist** (from TESTING.md): validation, auth/403-404 visibility, state conflicts (409 → refetch), idempotency, cursor pagination, error shape, and empty/terminal states — every endpoint the app calls gets these asserts in the contract test suite.
- **Lint**: `eslint.config.js` (flat, eslint-config-expo) green in CI.
- **Error handling**: switch on error `code`, never on `message`; map every code in `API.md`/`PAYMENTS.md` tables to a UI state; `INTERNAL_ERROR` never surfaces raw (generic copy + `requestId` for support).
- **State management**: three-store split (UI state local, server state cached with invalidation + refetch on conflict, persistent local: auth/addresses/cart draft in storage) — never mix money into client-trusted state.
- **A11y**: WCAG 2.1 AA (blueprint §31) — text scaling, screen-reader labels + live announcements on status changes, contrast ≥ 4.5:1 body, touch targets ≥ 48 pt, motion reduction, clear actionable error states with recovery hints.
- **Security**: tokens in `expo-secure-store` only (access 15 min JWT + rotating refresh in SecureStore; `requestId`/OTP in memory only, cleared on unmount); PII masking (render `maskedPhone`, never store/log full phone); never log `providerReference`, card data, PINs, OTP codes, or idempotency keys; no secrets in `EXPO_PUBLIC_*`; deep-link allow-list (`order/{id}`, `booking/{id}`, `ticket/{id}`, `conversation/{id}`) with refetch before render; single-flight token refresh on 401, force logout on refresh failure; location sent only for active checkout/tracking, never in analytics.
- **Money safety**: integer TZS end-to-end; `formatTZS` only, never inline `toLocaleString()`; render order/breakdown amounts from the server — never sum client-side; `Idempotency-Key` per mutation attempt (`customerId + action + nonce`), same key on retry after network failure, fresh key for a genuinely new action, keys never logged.
- **Realtime**: REST for initial state + WS/long-poll `/events` or push for live changes (order status, tracking, `message.received`, `intercity.eta_updated`); push wake + local cache for offline; tracking continues via push when backgrounded (never an infinite poll).
- **Screen state contract** (blueprint §22, enforced everywhere): loading skeleton per section → empty state with CTA → error + retry → success; every mutation has an in-flight spinner, optimistic update with server rollback, and a toast. Payment/status state changes arrive via webhook-driven notification or refetch — never from a client callback.
- **Navigation/deep links**: expo-router typed routes; `Linking` allow-list for `order/{id}`, `booking/{id}`, `ticket/{id}`, `conversation/{id}` (+ new surfaces as they ship); every deep-link target refetches via API before render; unknown payloads open the app root.
- **Pagination**: cursor-based (`?limit=20&cursor=<opaque>`) on every list; "load more" appends, never replaces; empty/terminal states per the TESTING.md matrix.
- **Performance**: lazy routes, image caching (`expo-image`), list virtualization (FlatList with `getItemLayout`/`keyExtractor`), per-section skeletons, debounced search (300 ms), `expo-image` for menu/merchant imagery, tab bar stable while screens swap.
- **Analytics**: instrument `home_viewed`, `search_submitted`, `cart_item_added`, `checkout_started`, `order_created`, `tracking_viewed`, `review_submitted` — entity ids and statuses only, never money details, PII, or notification bodies.
- **Money rendering** is verified against staging ledger fixtures before release (TZS grouping, negative refund rows, `−TZS 5,000` discount rendering).
- **Demo discipline**: demos run on mocks with `setFixturesSeed()` — deterministic, offline, and never dependent on a deployed backend; the same mocks back the contract tests, so demos and CI exercise the same data.
- **Supportability**: errors carry `requestId` for support; stable error codes mapped to copy (never raw messages); every screen's states are reachable in a review build (force-error tooling in dev only).

## 8. Definition of Done

Every change, milestone, and screen:

- [ ] `npm run typecheck` green (strict TS, contract flags).
- [ ] `npm test` green (`node:test` contract tests for every touched repository/flow).
- [ ] `npm run lint` green.
- [ ] CI `consumer.yml` green on the branch; `contract.yml` green when the contract is touched.
- [ ] Mock switches `EXPO_PUBLIC_MOCK_ORDERS/_HOME/_WALLET` OFF in preview/production builds; mocks never load in prod; mock path never deleted.
- [ ] Every path called exists in `backend/API-CONTRACT.yaml`; no invented endpoints, no hand-composed URLs.
- [ ] Theme 100% `@hudumika/tokens` via the copied `theme.ts`; no ad-hoc hex, no emoji icons (Ionicons only), no navy/yellow.
- [ ] Money rendered via `formatTZS` as integer TZS only; order/breakdown amounts from server, never client-summed.
- [ ] Every user-visible string via `t()`; en primary + sw stub keys shipped together.
- [ ] Tokens in `expo-secure-store` only; no secrets, payment data, or idempotency keys in logs/analytics/bundle.
- [ ] ETAs and estimates rendered from server values only (`TrackingEvent.estimateMinutes`, `eta`, windows) — client computes nothing.
- [ ] New env vars registered in `docs/ENV-VARS.md` + `.env.example` in the same PR.
- [ ] README updated (run, test, mock switches, env, how to flip a repo to live).
- [ ] No create-expo-app leftovers, no dead code, no commented-out blocks.
- [ ] Every screen ships loading/empty/error/retry/success states with no flicker between them.
- [ ] Every mutation sends an `Idempotency-Key`; retry replays, never double-creates.
- [ ] Deep-link allow-list enforced; every deep-link target refetches via API before render; 403/404 render as "not visible".
- [ ] No hardcoded URLs, phones, emails, or ratings anywhere — all environment-driven.
- [ ] Money rendering verified against staging fixtures (TZS grouping, negative/signed rows) before release.
