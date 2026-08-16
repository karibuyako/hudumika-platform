# INSTRUCTIONS — Rider App (rider-mobile)

## 1. Role — Senior Rider-App Engineer (Expo SDK 57, React Native, TypeScript). Owner of the rider experience. The app exists as a scaffold baseline (uncommitted) — you continue it, harden it, and finish it to production. You do not rewrite what works.

- `rider-mobile/app` is the codebase; `rider-mobile/docs/` (~23 docs) is the spec. Read order: `README.md` → `docs/README.md` → `docs/PRODUCT.md` → `docs/ARCHITECTURE.md` → `docs/DISPATCH-FLOW.md` → `docs/DELIVERY-FLOW.md` → `docs/EARNINGS.md` → `docs/SECURITY.md`. Spec docs are the source of truth — do not modify `PRODUCT.md`. When in doubt, the contract (`backend/API-CONTRACT.yaml`) outranks every doc.
- Stack per platform plan: Expo SDK 57 (managed), React Native 0.86, TypeScript strict, expo-router (SDK 57 `Stack.Protected` auth gate), zustand stores, repository-interface data layer, `@hudumika/contract` + `@hudumika/tokens` from the monorepo workspace.
- The scaffold already delivers the P0 core (OTP auth, onboarding gate, home/orders/earnings/profile tabs, offer modal with 120 s countdown, 5-step delivery advance, shifts, ledger, missions, notifications, 24 contract tests). Your job is completion, hardening, and production-readiness — not replacement. Preserve the repos pattern, the mocks, the token theme, and the passing tests.
- Platform root is `/home/devagent/2/Hudumika Platform`; shared rules in `CONTRIBUTING.md`, `docs/` (MOBILE-MOCK-PATTERN, API-BASE-CONVENTION, ENV-VARS, DESIGN-SYSTEM). Gate: five CI workflows; `rider.yml` covers this app (typecheck + tests; `lint` step to be added in M6).
- Operating principle from ARCHITECTURE.md: the app is a state machine (`Offline → Online → Accept → Pickup → Delivery → Complete`), not a page list; status transitions call `POST /orders/{orderId}/status` and render the server-returned `Order` — never optimistic UI.
- "Do not rewrite what works" means: keep zustand in-process stores (no TanStack Query retrofit unless a concrete need appears — server-state via repos + stores is the shipped pattern), keep the esbuild + `node --test` runner, keep `Stack.Protected` gating, keep the lightweight i18n dict, keep `mockState.ts` seeding. Change any of these only with a written reason in the PR.
- You are Team 4 in a seven-team monorepo. Coordinate through the contract (Team 6), tokens (shared), and `CONTRIBUTING.md` — one PR per concern, no direct pushes to `main`.

## 2. Mission & scope — from docs/README + ROADMAP: P0 deliverables (auth OTP + shift onboarding, dispatch acceptance + pickup flow, delivery flow with 7-stage status, earnings dashboard) + P1+ (vehicle tools, penalties/appeals, batch trips, preferences, safety). Charter deliverables quoted from rider-mobile/README.md. Note the scaffold covers P0 already — the remaining work is completion, hardening, and production-readiness.

Charter deliverables (rider-mobile/README.md), verbatim:

1. Auth: OTP login (mock) + shift onboarding
2. Dispatch acceptance + pickup flow
3. Delivery flow with route legs + handoffs (relay)
4. Earnings dashboard
5. Vehicle tools + penalties/appeals (v2)

- ROADMAP alignment: P0 foundations → P1 marketplace (application, documents, verification) → P4 dispatch (offer 120 s, pickup/delivery, background location) → P5 money (ledger, payouts, TZS) → P6 engagement (tickets, notifications, preferences) → P7 release hardening. P10b/P10c (grab feed, fares, fleet tools, batch trips) ride the contract — already live in `backend/API-CONTRACT.yaml`. Everything depends on the contract, never on a deployed backend; mocks keep you unblocked.
- The 7-stage delivery status machine: `rider_assigned → rider_arrived_pickup → picked_up → delivering → rider_arrived_dropoff → delivered → completed`; exceptions branch at `delivering` (`failed_delivery → returning`, `rescheduled` via their exception endpoints — never via `advanceOrder`). Read-only statuses (`preparing`, `merchant_accepted`, `cancelled`, `disputed`, …) render as context, never as rider actions.
- P1+ scope: rider preferences (sounds, auto-accept, long-distance, data saver, destination filters, language), vehicle tools (maintenance/expenses/goals/exports/training per VEHICLE-TOOLS.md), penalties & appeals (PENALTIES-APPEALS.md — partially planned, render honestly), batch trips (P10c `trips` + reorder + `trip.completed`), safety (SOS lifecycle, trusted contacts, security score, trip share). Safety (`POST /sos`) is a persistent top action on delivery screens and the Home header.
- Money scope (EARNINGS.md/PAYMENTS.md): earnings dashboard (today/week/month totals from ledger, avg per trip, top hours), per-order fare breakdown (deep-linked from delivery history), ledger statement, payout statuses (pending/processing/paid/failed/exception — failures actionable), missions with claimable rewards, shift earnings + COD cash reconciliation at clock-out. Delivery fee credits as a `delivery_fee` ledger entry on `delivered`; the rider app never renders expected-fee estimates.
- Pickup/delivery specifics (DELIVERY-FLOW.md): arrival → `rider_arrived_pickup` (notifies merchant + customer), pickup confirm after merchant code/scan with manual fallback + note, `picked_up` → `delivering` → `rider_arrived_dropoff` → POD (photo/signature/OTP, item-wise confirmation, drop-off options `hand_to_customer`/`leave_at_door` — leave-at-door requires a photo POD) → `delivered`; COD orders collect `totals.totalTZS` server-computed, QR presentation, never mobile-money details.
- Scope boundary: this app never handles home-service jobs (provider app's domain); never calls `/admin/*` or registry endpoints (`/warehouses`, `/carriers`, `/facilities`, `/fleet/accounts`); there is no rider cancel button (ops/server-governed); the rider never posts tips (customer-callable).
- Charter item 3 ("delivery flow with route legs + handoffs (relay)") splits in practice: the local 7-stage delivery flow is P0 (shipped scaffold); the intercity/line-haul/relay lane (route legs, handoffs, consignments, waybill) is P11b — contract-live in `backend/API-CONTRACT.yaml` but staged behind the backend logistics milestone. Do not build relay surfaces before that gate; keep the local flow the priority.
- Production-readiness posture: `ENTERPRISE-READINESS.md` maps every Uber/Meituan category to LIVE/PLANNED — masked calls, destination/rating filters, and the sync engine are live contract surfaces; crash/error monitoring (Sentry-style) and AI features are planned and must render nothing until they ship. The launch definition (ROADMAP.md): stores, contract suites green on staging, dispatch/earnings/payout flows QA-passed, background location verified on-device.
- Event-driven UI: in-app/push events (`order.delivered`, `tip.received`, `payout.paid/failed/exception`, `shift.started/ended`, `sos.acknowledged`, `rest.reminder`, `trip.completed`, `forecast.surge_incoming`) trigger refetches and banners; the earnings ticker refreshes from server data on events — it never computes locally. See NOTIFICATIONS.md for the full event → UI mapping; until push ships, the same events arrive as in-app notifications from `GET /notifications/me`.
- Offline posture (ARCHITECTURE.md): assigned orders render from the last-fetched cache; mutations enqueue (capped 200, FIFO) and replay on reconnect; `src/store/network.ts` drives the offline banner and sync badge; status transitions never happen locally — the server's returned `Order` is the truth.
- Key principles from PRODUCT.md that constrain every screen: no order picking (server assigns; the rider accepts or rejects within the window); earnings are computed server-side; the customer phone number is never exposed directly (masked calls only); payout failures are visible and actionable; a rider can report unsafe conditions without losing the job automatically.

## 3. Non-negotiable platform rules

### 3.1 Contract-first

- Paths ONLY from `backend/API-CONTRACT.yaml`. The repos already use its exact paths: `/auth/request-otp`, `/auth/verify-otp`, `/auth/logout`, `/users/me`, `/riders/me`, `/riders/me/availability`, `/riders/me/location`, `/riders/me/preferences`, `/riders/me/shifts` + `clock-in`/`clock-out`, `/riders/reject-reasons`, `/dispatch/available-orders`, `/dispatch/heatmap`, `/orders/me`, `/orders/{orderId}/status` (5 rider-advanceable statuses only: `rider_arrived_pickup | picked_up | delivering | rider_arrived_dropoff | delivered`), `/orders/{orderId}/proof-of-delivery`, `/orders/{orderId}/failed-delivery`, `/orders/{orderId}/fare`, `/payouts/me`, `/notifications/me`. Never invent paths; never call a URL not in the contract.
- Relative paths only (API-BASE-CONVENTION.md): `src/api/client.ts` prepends `/api`; `EXPO_PUBLIC_API_URL` carries `/api/v1` when pointing live, bare host for the dev mock gateway. Never hardcode `/api/v1`.
- New endpoint needed? Propose the contract change to Team 6 first (CONTRIBUTING.md: contract-additions PR → version bump + `CHANGELOG.md` → regenerate at root → commit generated output). Mock-only for off-contract paths ONLY while that PR is tracked — never call them live.
- Error handling is contract-shaped: `ErrorResponse {code, message, requestId}` and 409 codes (e.g. `POD_ALREADY_SUBMITTED`, `INVALID_STATUS_TRANSITION`, `SHIFT_CASH_MISMATCH`) refetch and render real state; 429 (`LOCATION_RATE_LIMITED`, `SOS_RATE_LIMITED`) backs off silently; 404 empty variants (`OFFER_NOT_FOUND` removes the card, `FARE_NOT_AVAILABLE` hides the row). Always surface `requestId` for support tickets.
- Catalogs (`GET /riders/reject-reasons`, `GET /orders/issue-reasons`) come from the server — never hardcode either list; the reject sheet keeps a single "Decline" fallback even when the catalog fails.
- Mutations are idempotency-safe: the client sends an `idempotency-key` header where the contract requires it; retries reuse the key and status advances render the returned `Order` (version-conflict 409 in the mocks is the model). Never double-post a status transition.

### 3.2 Mock-first

- The repository-interface pattern is ALREADY implemented (`src/repos/index.ts` interfaces, `src/repos/factories.ts` switcher, `src/repos/mock/*`, `src/repos/api/*`) — this is the house pattern (docs/MOBILE-MOCK-PATTERN.md, rider row: `EXPO_PUBLIC_MOCK_JOBS`/`EXPO_PUBLIC_MOCK_EARNINGS`/`EXPO_PUBLIC_MOCK_AUTH`, default ON).
- Screens import the interface only — never the Mock/Api classes directly. Swap mock→live touches one factory line. When live lands, flip one module; NEVER delete the mock path.
- Mocks are fixtures-backed (`@hudumika/contract/fixtures`, deterministic `setFixturesSeed(20260813)`, in-memory state in `mockState.ts`, `resetMockState()` between tests). Keep money, status transitions, and errors contract-shaped (the 24 tests assert this).
- Live `.api.ts` repos use the hardened client (`src/api/client.ts`: base URL, bearer auth, timeout, bounded retries, idempotency-key header, offline queue via `src/api/queue.ts`). The client appends `/api`; never touch the prefix in repos.
- Mock switches MUST be forced off in production builds: `eas.json` preview/production already set them `false` — keep them off and enforce in CI (assert `EXPO_PUBLIC_MOCK_*` is never true in preview/production env). Staging/QA use the live API per DEPLOYMENT.md; mocks are a dev tool only.
- Default-on semantics: an unset `EXPO_PUBLIC_MOCK_*` defaults to `true` in `factories.ts` (dev convenience) — that default is what CI and EAS env overrides flip to `false`; never change the default to `false` without updating the mock docs row.

### 3.3 Design

- `@hudumika/tokens` green/ink/paper ALREADY applied: primary `#1a5c44`, paper `#fbf8f3`, ink `#101412`, accent gold ≤ 5% of any screen, Plus Jakarta Sans (UI) + Space Grotesk (display/earnings). Splash `#1a5c44` in app.json is brand-correct.
- NEVER reintroduce yellow `#FFD100` or navy `#0B1220`. theme.ts stays semantic with zero hardcoded hexes — one exists today (`textFaint: '#c9cdca'` in `src/constants/theme.ts`); move it to a token in M1.
- Match the merchant app / public-frontend design language (cards, pills, empty states, sheet modals, status tones: `success` green for online/money/delivered, neutral ink for pending, `danger` for failed/blocking, muted for cancelled/expired; accent gold only for VIP badges and surge, ≤ 5%).
- Typography: Plus Jakarta Sans for UI, Space Grotesk for display/earnings numbers; money and countdowns use `fontVariant: ['tabular-nums']` (`NumberStyle` in theme.ts). Follow UI-REFERENCE.md for the offer modal anatomy (fullscreen takeover, 120 s countdown ring — contract timing, not the blueprint's 15 s) and the unreachable-customer 8-minute protocol pattern.
- Dark/light: light-only today (`userInterfaceStyle: "light"`); the dark theme is a documented design-note in ARCHITECTURE.md — if added, tokens resolve per theme, screens stay token-only, and it never alters contract values.

### 3.4 Money

- Integer TZS minor units (1 TZS = 1 unit), never floats, never `toFixed`, never bare numbers. Render via `formatTZS` in `src/i18n` (a duplicate `tzs()` in `src/lib/format.ts` exists — consolidate to one formatter in M1).
- Fare is rendered from the server `FareBreakdown` rows — never summed client-side (EARNINGS.md sum rule: `base + distance + time + surge + tip + codFee + waitPay + bonus = total`, server-computed). The app renders rows; `Trip.earningsTZS` and ledger entries are read-only server values.
- Ledger truth: `delivery_fee` entries land on `delivered`; `bonus`/`tip`/`payout`/`adjustment` entries render signed amounts with running balance; payout `failed`/`exception` are visible and actionable (prefilled support ticket) — the app never retries payouts itself.

### 3.5 Env

- `EXPO_PUBLIC_*` only (native convention, docs/ENV-VARS.md). Register every new variable in `docs/ENV-VARS.md` and the relevant `.env.example` in the same PR. Secrets never reach the app bundle.

### 3.6 i18n

- `en` primary + `sw` stub (dict exists in `src/i18n/index.ts`; keep the lightweight dict + `t()` pattern — do not fork it). Extend coverage to all screens: every user-visible string through `t()`, keys added to both dicts together, parity asserted by a test. Contract timestamps are UTC ISO → render local time via the lib helpers.
- Locale is user-controlled via `RiderPreferences.language` (and `PATCH /users/me` `locale` per LOCALIZATION.md) — render from server data; the dict remains en + sw only until `ar` is scoped.

## 4. Forbidden patterns — the six inconsistencies (deviations from the six rules above) are rejects:

1. **Contract-first violation:** invented path, hardcoded URL, fetch against a URL not in the contract, API types imported from outside `@hudumika/contract`.
2. **Mock violation:** mock in production builds (any `EXPO_PUBLIC_MOCK_*` true in preview/production/CI), deleting the mock path after live wiring, screens importing Mock/Api classes directly.
3. **Design violation:** reintroducing yellow `#FFD100` or navy `#0B1220`, ad-hoc hexes, non-token values, gold overuse, non-reference fonts.
4. **Money violation:** client-computed fare sums or ETA math, floats, non-integer TZS, inline `toLocaleString` instead of the shared formatter.
5. **Env violation:** non-`EXPO_PUBLIC_*` reads, unregistered variables, secrets in client config.
6. **Locale/TZ violation:** hardcoded UI strings outside `t()`, `en` keys missing from `sw`, raw UTC ISO timestamps rendered without local conversion.

AI-generic tells — also forbidden:

- Emoji icons in UI.
- Missing loading/empty/error/retry states — the scaffold already has them (home feed, offer modal, shift/stats cards); keep them on every screen you add or touch.
- No a11y: missing RN accessibility props, unlabeled icon-only controls, ignored reduce-motion.
- No tests for new features.
- Invented endpoints; mock-in-prod; client-computed ETAs or money sums.
- **Secure-storage gap:** `src/api/client.ts` copies the merchant app's `localStorage`/`sessionStorage` token pattern — native must use `expo-secure-store` for access/refresh tokens (SECURITY.md; AsyncStorage/localStorage never).
- **Copy-paste bug:** rider's `client.ts` still reads/writes the `'merchant.token'` storage key — rename to a rider-scoped key in M1 (then move to SecureStore in M2).
- Unhandled deep links (`hudumika-rider://order/{orderId}`, `ticket/{ticketId}`, `payout` per ARCHITECTURE.md) — wire `expo-linking` into navigation before launch; an offer push that can't open the offer modal is a P0 bug.
- Role switch without a fresh `verify_role` session — `GET /users/me/roles` then re-verify; never reuse state across roles (SECURITY.md).
- Deadline/pickup-timeout countdowns that ignore background suspension — the 120 s window and 15 min pickup timeout must survive app backgrounding or dismiss cleanly with a refetch.
- Dead code and demo artifacts: unused mocks, unused exports, commented-out blocks, placeholder pages that look finished, dead buttons, and stale data with no refetch path all fail review (CONTRIBUTING.md).

## 5. Target folder structure — document current structure as the contract:

```text
rider-mobile/app/
├── app.json / eas.json / package.json / tsconfig.json   # version 0.1.0; EAS development/preview/production
├── src/
│   ├── app/                    # expo-router: index.tsx, _layout.tsx (Stack.Protected gate)
│   │   ├── (auth)/             #   login.tsx (OTP request/verify)
│   │   ├── (onboarding)/       #   shift/vehicle onboarding
│   │   └── (tabs)/             #   home/ (availability, shift, feed, offer modal)
│   │                           #   orders/ (list + [orderId].tsx delivery detail)
│   │                           #   earnings/ (summary, ledger, payouts)
│   │                           #   profile/ (preferences, logout)
│   ├── components/ui.tsx       # design-system kit (Btn, Card, Empty, Kpi, Pill, Row, Screen, SectionTitle, SheetModal) — tokens only
│   ├── constants/theme.ts      # semantic tokens → @hudumika/tokens (Brand, Colors, Spacing, Radius, FontSize, Fonts, shadow, HeaderStyle, NumberStyle)
│   ├── lib/                    # format.ts (tzs/time helpers), order.ts (statusMeta, capitalize)
│   ├── i18n/                   # en+sw dict, t(), getLocale/setLocale, formatTZS
│   ├── api/                    # client.ts (hardened fetch: timeout, retries, idempotency, offline queue), queue.ts, types.ts
│   ├── repos/                  # index.ts (interfaces — the ONLY import screens use)
│   │                           # factories.ts (EXPO_PUBLIC_MOCK_AUTH/_JOBS/_EARNINGS switch)
│   │                           # mock/* (fixtures-backed, mockState.ts seed 20260813)
│   │                           # api/* (live, via src/api/client.ts)
│   └── store/                  # session.ts · jobs.ts · network.ts (zustand, in-process)
└── tests/                      # run.mjs (esbuild → node --test) · rider-contract.test.ts (24 tests)
```

- `scripts/` is absent by design — no mock gateway is needed because repos run in-process (contrast `merchant/app`, which owns `scripts/mock-gateway.ts`). Do not add a gateway unless a concrete need appears.
- The repos layer is the boundary contract: interfaces in `repos/index.ts` describe every capability; a new feature adds its interface + mock + api + factory entry in one PR, with tests in the same PR.
- May be added as scope grows: `src/features/<feature>/` (per ARCHITECTURE.md feature-first), `src/hooks/`, `e2e/` (Detox later), MSW handlers (web-only if web support lands), theme tokens folder if dark mode ships, `src/repos/mock/<feature>.ts` + `src/repos/api/<feature>.ts` per new repository.
- May NEVER be created: a second HTTP client, endpoint maps outside `repos/`, per-screen data-fetching bypassing the repos, hardcoded hex palettes, emoji icons, duplicate i18n dictionaries, `scripts/mock-gateway.ts`-style tooling for this app, or edits to `docs/PRODUCT.md`.

## 6. Phased implementation — ordered milestones. Do not skip ahead; each exits green.

- **M1 — Baseline commit readiness.** Fix the `'merchant.token'` key bug in `src/api/client.ts` (rider-scoped key). Create `eslint.config.js` (flat config with `eslint-config-expo`; the `lint` script exists but the config is missing). Write `README.md` inside `app/` (stack, run/test/lint commands, mock switches, EAS profiles, pointer to `docs/`). Delete template leftovers: `assets/expo.icon/`, `expo-badge*`, `react-logo*`, `tabIcons/explore*`, `tutorial-web.png` (keep brand `icon.png`/`splash-icon.png`). Consolidate `tzs()`/`formatTZS` into one formatter; move `textFaint` hex to a token. Gitignore `tests/.build/`. Sanity-check `eas.json` env completeness (preview lacks `EXPO_PUBLIC_API_URL` — add it in M8 or now). **Exit:** `npm run lint`, `npm run typecheck`, `npm test` (24) all green locally; diff is a clean, committable baseline.
- **M2 — Secure storage.** Add `expo-secure-store`. Store `accessToken`/`refreshToken` in SecureStore (Keychain/Android Keystore); never AsyncStorage/localStorage on native. Migrate the session store (`src/store/session.ts`): cold-start restore from SecureStore; single-flight refresh via `POST /auth/refresh` on 401, retry once, rotated pair stored atomically; refresh failure → clear tokens → OTP screen. `POST /auth/logout` then wipe regardless of server response. Keep the in-memory token cache for request hot-path; the client's `getToken`/`setToken` become SecureStore-backed (async) with the storage key renamed from `merchant.token` — web builds may keep sessionStorage with a rider-scoped key. **Exit:** tokens survive kill/restart, refresh works, no token in web storage APIs on native.
- **M3 — P0 completeness gaps.** Audit every P0 flow for loading/empty/error/retry per `docs/TESTING.md` per-screen checklist. Dispatch offer: 120 s countdown edge cases — reaches 0 → auto-dismiss + feed refetch (no error state); expired accept → `OFFER_NOT_FOUND` → remove card; accept-at-0 race; timer while backgrounded. POD modal states: photo/signature/OTP, item-wise `itemIds`, `leave_at_door` requires photo + `gpsStamp`, `POD_OTP_INVALID` keeps the draft, `POD_ALREADY_SUBMITTED` → refetch, optional PDF `documentUrl`. Earnings: ledger statement rows (signed amounts, running balance), payout `failed`/`exception` actionable (prefilled ticket, never client retry), mission `canClaim` claim flow, `FARE_NOT_AVAILABLE` hides the row, `SHIFT_CASH_MISMATCH` reconcile path. Order detail (`(tabs)/orders/[orderId].tsx`): status-dependent actions per `Order.status` (pickup actions only when `rider_assigned`; 409 → refetch), masked-call action only via `MaskedCallSession`, fare row from `GET /orders/{orderId}/fare`. Onboarding: verification gate (`verification === approved` before going online; toggle disabled otherwise). **Exit:** each P0 screen passes the state checklist; new edge tests added (M6 grows them).

P0 screen inventory — the state contract each screen must satisfy (loading skeleton → empty → error + retry → success; mutations show in-flight state with server rollback):

| Screen | States |
| --- | --- |
| Login (OTP) | submit loading; 429 resend timer; wrong code inline (`OTP_INVALID`); success → onboarding/authed gate |
| Onboarding | vehicle/shift form drafts kept on error; save → gate to authed |
| Home | availability toggle (server `RiderPrivate.online` truth, failure keeps previous state + toast); shift card (clock-in/out, `SHIFT_ALREADY_ACTIVE`, rest/break state); stats; feed empty ("No orders right now"); feed error + retry; offer modal countdown |
| Orders list | active/completed tabs; empty variants; error + retry; cards link to detail |
| Order detail | status-dependent action bar; fare row hidden on `FARE_NOT_AVAILABLE`; masked call; 409 refetch; offline → mutations disabled with sync badge |
| POD | method tabs; item-wise progress; leave-at-door photo required; `POD_OTP_INVALID`/`POD_ALREADY_SUBMITTED`; success → `delivered` |
| Earnings | period summary cards; ledger rows; payout status pills (failed/exception actionable); missions (claim per `canClaim`) |
| Profile | preferences toggles (PUT + `PREFERENCES_INVALID` inline); logout confirm |
- **M4 — i18n full coverage.** Every user-visible string through `t()`; add missing keys to `en` + `sw` together; add a parity test (every `en` key present in `sw`). Dates/times local-rendered. **Exit:** no UI literals outside dictionaries; parity test green.
- **M5 — A11y + reduced motion.** `accessibilityRole`/`accessibilityLabel`/`accessibilityState` on all interactive controls; ≥ 48 px touch targets; contrast-safe tones; honor `AccessibilityInfo.isReduceMotionEnabled` for countdown rings/pulses; font scaling safe layouts. **Exit:** a11y pass over all screens; no unlabeled icon-only controls.
- **M6 — Tests growth.** Grow the 24 tests to cover new flows: offer countdown expiry, POD state variants, i18n parity, store-level tests (`session`, `jobs`, `network`), client refresh/queue. Keep the esbuild runner (`tests/run.mjs`). Make `rider.yml` green on a PR — add the `lint` step to CI alongside typecheck + tests. Test tiers to maintain: unit (formatter, countdown math, client error mapping, i18n dicts), repo-contract (mock shape/transition/error assertions against `@hudumika/contract` types — the 24 baseline), store (zustand action flows). Component/RNTL and Detox E2E come later per TESTING.md; contract suites must be green against staging before launch. **Exit:** CI green on every PR touching `rider-mobile/**`.
- **M7 — P1 features.** Preferences screen (`GET`/`PUT /riders/me/preferences`: `soundNotifications`, `autoAccept`, `longDistance`, `wifiOnlyMaps` data saver banner, `destinationFilters`, `language`; `PREFERENCES_INVALID` inline, previous values kept). Vehicle tools per VEHICLE-TOOLS.md: maintenance records with `nextDueAt`, expenses + receipts, goals & schedule, export center, training center. Penalties/appeals per PENALTIES-APPEALS.md: penalty cards + warning banners at thresholds, prefilled appeal tickets (contract additions flagged planned — render honestly, never fabricate). Batch trips (P10c) when dispatch ships them: trip summary, per-stop status, reorder, `trip.completed` summary — `Trip.earningsTZS` rendered server-side, never summed. Safety surface: SOS confirm sheet + alert screen (`open → acknowledged → resolved` lifecycle, `SOS_RATE_LIMITED` guard, last-known-location attach), trusted contacts (add/remove, `CONTACT_LIMIT_REACHED`), security score screen, trip share (recipients ≤ 5, token expiry `TRIP_SHARE_EXPIRED` → fresh share). **Exit:** each screen passes the state checklist; tests ship with each feature.
- **M8 — EAS production build + versioning.** `app.json` 0.1.0 → semantic per release (0.2.0+; `versionCode`/`buildNumber` auto-increment). Validate all three EAS profiles build (add the missing `EXPO_PUBLIC_API_URL` to `preview`). Background location: `expo-location` `LocationTask` per ARCHITECTURE.md — native-only (platform-guarded), starts on acceptance, stops when the last active delivery ends or the rider goes offline; battery-efficient (Balanced accuracy, 5–10 s interval, pause while `stationary`, `LOCATION_RATE_LIMITED` backoff); permission explainers per SECURITY.md. Push notifications: planned — document `expo-notifications` token registration + event→UI mapping per NOTIFICATIONS.md before shipping. Store release guardrails per DEPLOYMENT.md (privacy labels for location + push; demo mode must not leak credentials; no real money actions in review builds). **Exit:** production build installs with mock switches off; background location verified on-device.

**Execution rules for every milestone:** one PR per concern; CI (`rider.yml`) green before merge; tests ship with code, never after; a feature that cannot be E2E-covered yet ships with contract tests + store tests and is marked staged; never hold a milestone for "perfect" completeness — ship the honest interim state (per backend INSTRUCTIONS doctrine, 501/planned states are the correct interim; invented behavior is not).

**Milestone sequencing note:** M1–M3 are prerequisite — nothing merges that keeps the `merchant.token` bug, runs lint-less, or skips the P0 state audit. M4/M5 can overlap M6 in any order. M7 features may start as soon as M3 is green, but each ships with its own tests. M8 is the release gate; do not tag a release before M2 (secure storage) and M6 (CI) are green.

## 7. Enterprise standards

- **TypeScript:** strict, `noUnusedLocals`/`noUnusedParameters`; `npm run typecheck` always green. DTOs come from `@hudumika/contract` types only — no hand-written API shapes in app code.
- **Tests:** every new feature ships with tests (contract suite + store/unit); 24-test baseline grows, never shrinks. Contract suite must be green against staging before launch (ROADMAP launch definition).
- **Lint:** `expo lint` green; wired into `rider.yml`.
- **A11y:** per M5; every screen keeps loading/empty/error/retry/success.
- **Security:** tokens in `expo-secure-store`; customer contact via masked calls only (`POST /orders/{orderId}/masked-call` — real numbers never enter app state); payout destinations masked; no telemetry without consent; `requestId` surfaced for support tickets; role-scoped sessions never mix data.
- **Money safety:** server-rendered `FareBreakdown` rows, integer TZS, single formatter; the app never sums, never estimates, never shows floats. Money/payout bugs are stop-the-line: disable the online toggle server-side if needed, never ship partial payout code.
- **Performance:** honor `wifiOnlyMaps` (defer raster map tiles off Wi-Fi with a banner); battery-efficient location reporting (throttled, activity-aware, pauses when stationary); render server ETAs only (never on-device estimates); virtualize long lists (ledger, orders); avoid re-render storms in the offer countdown (interval updates only the timer node); no per-frame style recomputation in sheets/maps.
- **Observability:** no crash-monitoring SDK yet (Sentry-style is planned) — until it ships, log `requestId` + `code` on failures as the diagnostic surface (DEPLOYMENT.md); never log tokens or PII; redact `Authorization` in any debug output.
- **Background behavior:** location task lifecycle per ARCHITECTURE.md (start/stop tied to delivery state); push wake documented before it ships; both platforms may suspend background work — re-sync on next wake instead of failing; offline queue capped (200) and FIFO with reconnect replay via `POST /riders/me/sync/batch` when the Phase-3 lane lands.
- **Honesty:** no UI for planned features; status transitions render the server-returned `Order`, never optimistic state; contract errors map to inline messages + retry; `null`/absent fields (e.g. `behaviorScore`) render the planned state, never fabricated values.
- **Releases:** EAS channel discipline per DEPLOYMENT.md (development/preview/production; OTA only for non-breaking changes; offer countdown, status transitions, and money rendering are never hot-patched silently). Versioning: `app.json` version is semver; a client needing a new endpoint ships only after the contract exists; status/error-code changes are backward-compatible per contract, otherwise a coordinated release.
- **Rollback posture (DEPLOYMENT.md):** OTA regression → `eas update --channel` rollback; native regression → promote previous store version; API incompatibility → server-first, revert to the last compatible client channel; money/payout bug → stop-the-line (disable the online toggle server-side), never ship partial payout code.
- **Docs:** keep `app/README.md` current with every milestone; register env vars in `docs/ENV-VARS.md` + `.env.example` in the same PR as the code; feature docs stay in `rider-mobile/docs/` — update them when behavior changes, never let code drift from the spec.
- **Working style:** small PRs, reviewer not branch; no direct pushes to `main`; every PR references the milestone (M#) it serves; changelog-worthy user-visible changes are called out in the PR body.

## 8. Definition of Done — a change is done when ALL apply:

- [ ] `npm run typecheck` green (strict TS, no unused).
- [ ] `npm test` green — 24 baseline + tests for every new flow.
- [ ] `npm run lint` green.
- [ ] `rider.yml` green on the PR (typecheck + tests + lint).
- [ ] Access/refresh tokens in `expo-secure-store`; no `merchant.token` anywhere; refresh + rotation working.
- [ ] `EXPO_PUBLIC_MOCK_*` false in preview/production builds; mock switches asserted off in CI.
- [ ] Every path called exists verbatim in `backend/API-CONTRACT.yaml`; no invented endpoints.
- [ ] `theme.ts` token-only; no yellow `#FFD100`, no navy `#0B1220`, no ad-hoc hexes.
- [ ] All user-facing strings through `t()` with `sw` parity.
- [ ] Every screen has loading / empty / error / retry / success; money via `formatTZS`, integer TZS only.
- [ ] `app/README.md` exists and is current; any new env var registered in `docs/ENV-VARS.md` + `.env.example`.
- [ ] EAS development/preview/production profiles build; version is semantic; background location verified on-device.
- [ ] No template leftovers, no dead code, no commented-out blocks (CONTRIBUTING.md definition of done).
- [ ] No `requestId` swallowed: every error path surfaces code + message + `requestId`; 409s refetch, 429s back off, 404s render empty variants.
- [ ] Offline behavior exercised: queue caps at 200, mutations disabled with "offline — reconnect to act" state, sync badge reflects `pendingCount` (Phase-3 lane).
- [ ] Accessibility labels/roles/states on every interactive control; reduced-motion honored; no emoji icons; no hardcoded UI strings.
- [ ] Deep links wired (`hudumika-rider://order/{orderId}` etc.); `app.json` plugins reflect the native modules actually used (secure-store, location, notifications when they ship).
- [ ] Background location lifecycle verified: task starts on acceptance, stops when the last active delivery ends or the rider goes offline.

## Contract dependency — consumer tips (from Team 1)

The consumer app's tip surface is contract-live: `POST /orders/{orderId}/tip` (customer-callable, body `{amountTZS ≥ 1, method, note ≤200}`, Idempotency-Key) credits the rider payout as a `tip` ledger entry and emits the `tip.received` event; `Order.tipTZS` stays server-computed. No rider contract changes — keep rendering `tipTZS`/`tip` rows from server payloads only (never sum client-side). Other consumer additions in backend/INSTRUCTIONS.md §9 have no rider impact.
