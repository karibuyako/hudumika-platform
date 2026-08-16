# INSTRUCTIONS — Provider App (provider)

Standing order for the AI agent building `provider/app` from scratch to enterprise production. Read this file before every task; it outranks other docs when they conflict. This is the Team 3 (provider) counterpart to `merchant/INSTRUCTIONS.md` and follows the same conventions.

## 1. Role — Senior Provider-App Engineer (Expo SDK 57, React Native, TypeScript). You build a new production app following the house mobile pattern EXACTLY as rider-mobile does — no invented structure, no shortcuts, no generic scaffolding.

You are the sole owner of `provider/app`. The app does not exist yet: `provider/` contains only `README.md` + `docs/`. You create the codebase from zero, mirroring `rider-mobile/app` as the reference implementation of the house mobile pattern: same repo layout, same repository-interface pattern, same session store, same test runner, same design base. rider-mobile is your spec for HOW to build; `provider/docs/` is the spec for WHAT to build. Copy the pattern, adapt the domain — never invent a parallel architecture.

## 2. Mission & scope — synthesize from provider/docs (charter README + PRODUCT: what the provider app is: services/technicians/availability/booking execution; modules list; phases from ROADMAP; the docs are spec — the app code does not exist yet, you create it)

The provider app is the supply-side operating system of the three-sided ecosystem: skilled-service businesses (plumbing, electrical, cleaning, appliance/AC repair, painting, carpentry, moving, laundry, beauty, pest control, + future trades) take jobs and get paid. Distinct from the merchant surface — never reuse merchant flows, tables, or state. The docs are the spec; the code does not exist yet, you create it.

Scope (docs index, `provider/docs/README.md`): auth & OTP login with role guard; provider application + `VerificationState` onboarding; availability (weekly `AvailabilityWindow` + toggle); service catalog with pricing models, estimates, quote flow, final invoicing, parts, warranties; the job state machine (`BookingStatus`: matching → offered → provider_accepted → scheduled → en_route → provider_arrived → check_in → diagnosing → quote_required → quote_submitted → quote_accepted → in_progress → completion_review → awaiting_customer_confirmation → completed → settled → warranty; exceptional `escalated`/`reassignment`/`provider_late`/`no_show`/`customer_cancelled`/`provider_cancelled`; terminals `declined`/`cancelled`/`refunded`/`disputed`); job marketplace with `matchScore` + `reasons[]` transparency; technician team + dispatcher console; staff roles with capability-based rendering; earnings/ledger/payouts; notifications + support tickets + reviews; inventory/materials; B2B contracts/SLA + recurring plans; trust profile; AI copilot (rule-based v1).

Module list (NAVIGATION.md + API.md): Auth & onboarding → Main tabs Home | Jobs (Marketplace | My Jobs | Calendar) | Earnings | Profile (Certifications | Team | Settings | Help). Capability-driven: modules render from `GET /providers/me/capabilities`; never optimistic UI for actions the server would deny. Team members (owner/dispatcher/technician/supervisor) sign in under `/providers/me/staff` roles; capabilities are explicit per member, never inherited.

Key flows you must ship (BOOKING-FLOW.md, SERVICE-CATALOG.md, TECHNICIANS.md): marketplace browse → offer accept (5-min window) → schedule → en-route → arrive → check-in → diagnose → quote → approved → work → proof of service → parts → invoice → customer confirms → settled → warranty; quote requests; dispatcher assignment (`assign-technician`); on-site payment awareness (invoice `issued` → `paid`, webhook-driven — never client callbacks).

Standing rules that apply to every line of code (provider/docs/README.md + ROADMAP invariants): every screen implements loading, empty, error, retry, and success states; timestamps are UTC ISO 8601 from the API, always rendered local; no hardcoded URLs, phones, emails, or ratings — environment-driven config only; switch errors on `ErrorResponse.code`, never `message`; no client-side money arithmetic on totals.

Phases (ROADMAP.md, aligned to cross-team P0–P9): P0 auth, P1 application/verification, P3 bookings, P4 dispatch, P5 earnings, P6 engagement (notifications/support/reviews), P7 launch. Post-launch (P8–P9 family, live contract slices only): service tools, provider OS, intelligence/enterprise — build only what `backend/API-CONTRACT.yaml` already declares; everything else is flagged to Team 6.

Deliverables (provider/README.md, expanded by ROADMAP.md): auth (OTP login mock + role guard); service catalogue + availability calendar; booking accept/decline + schedule; earnings + payout status; technician roster + materials inventory; job marketplace + job machine through `settled`; staff roles/capabilities; notifications/support/reviews; service-business tools (quote/proof/parts/invoice/warranty); contracts/SLA + recurring plans; trust profile; copilot.

## 3. Non-negotiable platform rules

### 3.1 Contract-first

Every endpoint the app calls must exist in `backend/API-CONTRACT.yaml` — provider tag (`/providers/*`, `/dispatch/provider-jobs`, `/service-categories`, `/cities`, `/services`) plus `bookings`, `reviews`, `payouts`, `notifications`, `support`, `auth`, `users`. Never invent paths; never call a URL not in the contract. Paths are relative (no `/api/v1` in app code — `docs/API-BASE-CONVENTION.md`); the base comes from `EXPO_PUBLIC_API_URL`. Need an endpoint that is not in the contract (e.g. `GET /reviews/me`, reschedule)? Propose the contract addition to Team 6 first (CONTRIBUTING.md: contract-first rule), keep any off-contract path mock-only and tracked; never call it live. Open contract gaps to raise: received-reviews listing, reschedule endpoint, `commissionRateBps` on `ProviderPrivate`, `tradeRequirements`, `booking.followup` (ROADMAP.md "Contract gaps to raise with backend").

### 3.2 Mock-first

Implement `docs/MOBILE-MOCK-PATTERN.md` EXACTLY as rider-mobile does: typed repository interface (`src/repos/index.ts`) → `.mock.ts` fixture-backed implementation (in-memory state in `mock/mockState.ts`, deterministic seed via `setFixturesSeed`) → `.api.ts` thin client over the hardened transport (`src/api/client.ts`); one switcher per module in `src/repos/factories.ts` gated by `EXPO_PUBLIC_MOCK_*`, default ON in dev, forced OFF in preview/production builds (eas.json env) and never shipped live (CI asserts). Use `@hudumika/contract/fixtures` where they exist (`fixtureProvider`, `fixtureCategory`, ...); add new fixtures to `packages/contract` only via Team 6. When a live endpoint lands, flip one module in the factory — never delete the mock. Mock repositories keep in-memory state so demos feel real; mocks mirror contract paths and error codes 1:1 (409 `BOOKING_STATUS_CONFLICT`, 401 `OTP_INVALID`, 429 `RATE_LIMITED` with `retryAfterSeconds`, 422 field errors, 403 `CAPABILITY_FORBIDDEN`, 409 `JOB_OFFER_EXPIRED`).

### 3.3 Design

Use `@hudumika/tokens` exclusively: primary `#1a5c44` (brand-500), paper `#fbf8f3`, ink `#101412`, accent gold `#c9a84e` ≤ 5% of any screen, danger `#b42318`; fonts Plus Jakarta Sans (UI) + Space Grotesk (display) via `@expo-google-fonts`, loaded in `src/app/_layout.tsx`. Copy the semantic `src/constants/theme.ts` + `src/components/ui.tsx` pattern from rider-mobile/app — that is the sanctioned base; adapt (add provider components: status pills per `BookingStatus`, offer card with countdown, availability week grid, quote composer, invoice breakdown, ledger rows), never invent a new design language. Screens never hardcode hexes. NEVER yellow, NEVER dark navy, NEVER emoji icons — icons are `@expo/vector-icons` Ionicons (rider's `Icon` wrapper). Cards use `line` rings, not borders; money uses tabular-nums.

### 3.4 Money

Integer TZS minor units everywhere (1 TZS = 1 unit); never floats. Use rider's `formatTZS` pattern (`src/i18n/index.ts`: `TZS 12,500`, `Math.round`, `en-US` grouping); totals are always server-computed (`ServiceInvoice.totalTZS`, ledger balances) — the client never computes commission, stock math, or totals. Money fields render with currency always visible.

### 3.5 Env

`EXPO_PUBLIC_*` only (`EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_ENV`, `EXPO_PUBLIC_MOCK_AUTH/_PROFILE/_BOOKINGS/_DISPATCH/_SERVICES/_TECHNICIANS/_EARNINGS/_NOTIFICATIONS/_SUPPORT/_CATALOG`). Register every new variable in `docs/ENV-VARS.md` and the app `.env.example` in the same PR. No hardcoded URLs, support phones, emails, or ratings anywhere.

### 3.6 i18n

`en` primary + `sw` stub dict — copy rider's `src/i18n/index.ts` pattern (keyed dict, `t()`, `setLocale`, fallback `sw → en`, never a raw key on screen). Namespace per screen (`booking.status.provider_arrived`, `earnings.statement.openingBalance`); status labels map 1:1 to contract enum values. Money stays `TZS 12,500` in all locales; timestamps are UTC from the API, always rendered local.

## 4. Forbidden patterns

The six platform inconsistencies (quote, from merchant app README — the canonical platform list; each was a real defect, resolve the equivalent, do not propagate):

1. "the ~50 unique endpoints ... Not yet on contract (deferred to Phase B, mock-only for now)" — drive to contract via Team 6 additions; keep mock-only until then.
2. "`GET /auth/me` (payload is merchant-specific)" — align payload/type via contract-additions PR; it stays mock-only until adopted.
3. "order list (`/orders/me` in the contract is the consumer's)" — the app's order list path is off-contract; propose a provider-scoped path.
4. "'ready'/'complete' transitions (contract has status advance instead)" — map onto the contract's advance endpoint, don't invent new ones.
5. "Payment method keys are still internally `wechat`/`alipay`" — re-key when the contract payment model is adopted.
6. Tokens live in `localStorage`/`sessionStorage` (`src/api/client.ts`) — move to `expo-secure-store` on native (web keeps sessionStorage).

Provider equivalents of #1/#3 (provider/docs/ROADMAP.md contract gaps): `GET /reviews/me`, reschedule endpoint, `commissionRateBps`, `tradeRequirements`, `booking.followup` — raise with Team 6, never invent. Sessions are role-scoped; a provider session never reads customer/merchant data, and role switch re-verifies OTP (`purpose: verify_role`).

AI-generic tells — forbidden:

- create-expo-app leftovers: template assets (`assets/images/*`, reset-project script), unused deps, `AGENTS.md`/`.vscode` cruft — delete in M0.
- Emoji icons or emoji in UI copy; gradient hero headers; glassmorphism/surge effects.
- Missing loading/empty/error/retry/success states on any screen (per-screen matrix in provider/docs/TESTING.md).
- No a11y: missing RN `accessibilityRole`/`accessibilityLabel`/`accessibilityState`, unlabeled icon-only controls, no reduce-motion respect.
- Tests that never run in CI; snapshot-only content tests (locale-sensitive — use i18n keys).
- Invented endpoints, or mock code shipping to production builds.
- Copy-paste theme drift: hardcoded hexes, per-screen token divergence, off-brand colors.

## 5. Target folder structure

Create exactly this tree in `provider/app` (mirror rider-mobile/app):

```
provider/app/
  app.json, eas.json, tsconfig.json, eslint.config.js, expo-env.d.ts, .gitignore
  package.json, package-lock.json          # deps mirror rider exactly (SDK 57)
  src/
    app/                                   # expo-router routes
      _layout.tsx                          # fonts + session restore + Stack.Protected
      index.tsx
      (auth)/_layout.tsx, login.tsx        # request-otp → verify-otp → role redirect
      (onboarding)/_layout.tsx, index.tsx  # application, VerificationState screens
      (tabs)/_layout.tsx                   # Home | Jobs | Earnings | Profile
      (tabs)/home/index.tsx                # today's jobs, availability toggle, snapshot
      (tabs)/jobs/index.tsx                # Marketplace | My Jobs | Calendar
      (tabs)/jobs/[bookingId].tsx          # job detail: timeline + actions per status
      (tabs)/jobs/marketplace.tsx          # nearby/recommended/offers/quote_requests
      (tabs)/jobs/calendar.tsx             # weekly schedule + conflicts
      (tabs)/jobs/quotes.tsx, invoice.tsx, parts.tsx, proof.tsx, warranty.tsx
      (tabs)/earnings/index.tsx            # balance, payouts, statement
      (tabs)/profile/index.tsx, staff.tsx, certifications.tsx, settings.tsx
      (tabs)/profile/notifications.tsx, preferences.tsx, support.tsx, tickets/[ticketId].tsx
      (tabs)/profile/catalog.tsx, technicians.tsx, dispatcher.tsx, inventory.tsx
      (tabs)/profile/contracts.tsx, plans.tsx, trust.tsx
    components/ui.tsx                      # copy rider's ui.tsx base, adapt
    components/                            # OfferCard, BookingCard, CountdownPill, StatusPill,
                                           # AvailabilityWeek, QuoteComposer, ProofUpload,
                                           # InvoiceCard, PartsList, TechnicianRow, StaffRow,
                                           # NotificationRow, TicketThread, LedgerRow
    constants/theme.ts                     # semantic tokens from @hudumika/tokens (rider pattern)
    lib/format.ts                          # tzs/timeAgo/clock/dateISO/minutesLabel/uid/mmss
    lib/booking.ts                         # status→action maps, idempotency-key helper
    api/client.ts, queue.ts, types.ts      # copy rider's hardened client (retries, 401 handler,
                                           # offline mutation queue, ApiError)
    i18n/index.ts                          # en + sw dicts, t(), formatTZS
    repos/
      index.ts                             # interfaces ONLY (Auth, Provider, Availability,
                                           # Services, Dispatch, Bookings, Technicians, Earnings,
                                           # Notifications, Support, Reviews)
      factories.ts                         # EXPO_PUBLIC_MOCK_* per module, default ON
      mock/mockState.ts + mock/*.ts        # seeded in-memory state, contract-shaped
      api/*.ts                             # thin clients over src/api/client.ts
    store/session.ts                       # zustand — copy rider's store; status by
                                           # VerificationState (boot/anon/onboarding/authed)
    store/jobs.ts, store/network.ts
  tests/run.mjs                            # esbuild bundle + node --test (rider pattern)
  tests/provider-contract.test.ts          # mock-repository contract tests
```

Notes: `eslint.config.js` — rider lacks one; create it (`eslint-config-expo` flat config) since `expo lint` needs it. `.github/workflows/provider.yml` at the platform root does NOT exist yet — add it (mirror `.github/workflows/rider.yml`, paths `provider/**`, typecheck + `npm test`, `npm run lint`). Test runner: docs/TESTING.md documents Jest/RNTL, but the running platform convention is `node:test` via `tests/run.mjs` (rider does exactly this) — use node:test; keep CI green.

## 6. Phased implementation

Sequencing (ROADMAP.md dependencies): M1 unblocks everything; M2 waits on M1 (availability gates matching); M3 slices build on M2's booking screens; M4 earnings references M2's settled bookings; M5 rides on M4 (payout events) and M2 (booking events); M6/M7 are hardening, run continuously from M1 onward. Ship each phase's screens against mock fixtures before backend deploys; never wait on a deploy — mock-first keeps every phase buildable. Re-run the contract suite against staging when the backend milestone lands.

M0 — Scaffold: create `provider/app` with package.json deps mirroring rider exactly (expo ~57.0.11, react 19.2.3, react-native 0.86.2, expo-router, zustand, `@hudumika/contract` `file:../../packages/contract`, `@hudumika/tokens` `file:../../packages/tokens`, `@expo-google-fonts/*`, `@expo/vector-icons`); tsconfig strict with `noUnusedLocals`/`noUnusedParameters`; copy `api/client.ts`+`queue.ts`+`types.ts`, `theme.ts`, `ui.tsx`, `i18n/index.ts`, `lib/format.ts`; `tests/run.mjs` with a placeholder test; `eslint.config.js`; initial README (provenance + run/verify commands). Exit: `npm run typecheck` and `npm test` green; no template leftovers.

M1 — Auth + onboarding (P0–P1): contract `request-otp`/`verify-otp` requestId flow — copy rider's session store pattern (`src/store/session.ts`: requestId + debugCode from mock, `statusFor` by provider `VerificationState`); `(auth)` OTP screens; application (`POST /providers`), `GET /cities` + `GET /services` pickers, `GET/PATCH /providers/me`, `PUT /providers/me/availability`; every `VerificationState` rendered (`pending`/`documents_review`/`changes_requested`/`approved`/`rejected`/`suspended`); approval gates the tabs. Concrete files: `(auth)/login.tsx`, `(onboarding)/index.tsx`, repos `Auth` + `Provider` + `Availability`, `store/session.ts` (status `boot`/`anon`/`onboarding`/`authed` with boot retry like rider), i18n `auth.*`/`onboarding.*` keys. Exit: login → application → `approved` (mock decision) unlocks tabs; `changes_requested` resubmit loop works; typecheck + tests green; no forbidden patterns.

M2 — Availability + bookings (P3–P4): jobs tabs (`GET /bookings/me?status`); incoming-request screen with 300 s countdown; accept/decline (`reason` max 500); status advance (`provider_arrived` → `in_progress`); check-in (geofence + manual fallback), pause/resume; complete; cancel with confirm dialog; detail timeline from `BookingDetail.events`; marketplace `GET /dispatch/provider-jobs` + accept with `matchScore`/`reasons[]`, `expiresAt` countdown, `JOB_OFFER_EXPIRED` handling; exceptional states (`no_show`, `provider_late`). Concrete files: `(tabs)/jobs/*`, repos `Dispatch` + `Bookings`, `lib/booking.ts` status→action maps, countdown component, `store/jobs.ts`. All mutations carry `Idempotency-Key`; 409 conflicts refetch (server is the truth). Exit: request → accept → schedule → arrive → progress → complete → history green on mocks (TESTING.md happy path + negative cases).

M3 — Service execution + technician tools (live P9/P9b/P9c contract slices): service catalog CRUD (`/providers/me/services`) + estimate preview + quote flow (`quote`/`quote/decision`) + proof-of-service + parts (`PartsLine` + inventory deduction) + invoice + warranty; technicians CRUD + assign-technician + dispatcher console; certifications with `CERTIFICATION_EXPIRED` listing gate; staff invite/roles + capability-gated navigation (`/providers/me/capabilities`); inventory + adjust (`INVENTORY_NEGATIVE_STOCK`, reason required); trust profile; copilot (suggestions never auto-submit; `COPILOT_UNAVAILABLE` non-blocking). Concrete files: repos `Services` + `Technicians` + `Catalog`/`Inventory`/`Trust`, screens `catalog.tsx`, `technicians.tsx`, `dispatcher.tsx`, `inventory.tsx`, `trust.tsx`, `staff.tsx`, `certifications.tsx`, job-detail action sheets (quote/parts/proof/invoice/warranty). Exit: TESTING.md service-business flow + marketplace flow + provider-intelligence flow green; capability denials render as 403 handling, never optimistic UI.

M4 — Earnings/payouts (P5): earnings dashboard (`GET /payouts/me`), ledger statement with date range (`GET /payouts/me/statement`, immutable entries, `booking_earning`/`commission`/`adjustment`/`payout`/`refund`/`bonus`), payout status pills incl. `exception` (danger + support CTA), dispute-hold awareness (`disputed` blocks settle), `TZS 12,500` everywhere. Concrete files: repo `Earnings`, `(tabs)/earnings/index.tsx`, statement date-range picker, i18n `earnings.*` keys. Exit: statement balances match ledger fixtures; dispute hold visible in UI.

M5 — Notifications/support/ratings (P6): notification center (`GET /notifications/me`, cursor pagination, mark read, unread badge, `Notification.deepLink` → booking/ticket/statement), preferences GET/PUT with locked system rows (`PREFERENCE_INVALID_EVENT` rollback), per-event UI mapping (booking.requested, job.offered, quote.requested, payout.*, review.received, ticket.reply, lead.reviewed, sla.deadline_approaching...), push registration (Expo Push Service; token at login; degrade gracefully — in-app polling still works), support tickets (create/list/get/reply, `ticket.reply` deep link), provider-side review of customer (`POST /reviews` + report abuse); received reviews via profile rating only until `GET /reviews/me` lands (Team 6 gate). Exit: push lands on device for a booking request; ticket thread round-trips; tests green.

M6 — Hardening: a11y audit (accessibilityRole/Label/State everywhere, 44 px targets, reduce-motion); offline mutation queue verified (rider `api/queue.ts` pattern); tokens in `expo-secure-store` (never AsyncStorage; refresh on 401 once then logout); i18n coverage pass (no raw keys, `sw` verified, missing-key fallback); performance (lazy routes, `FlatList` virtualized lists, no inline list render functions); per-screen states re-audited against TESTING.md matrix. Exit: typecheck + lint + tests green; a11y scan clean; no mock code in prod bundle.

M7 — EAS + CI: `eas.json` profiles development/preview/production (production: `EXPO_PUBLIC_ENV=production`, live `EXPO_PUBLIC_API_URL=https://api.hudumika.co.tz/api/v1`, every `EXPO_PUBLIC_MOCK_*=false`); add `.github/workflows/provider.yml` at platform root (mirror rider.yml; typecheck + lint + tests on `provider/**`); `eas build` + `eas submit` per DEPLOYMENT.md; store metadata (icons, splash green, privacy labels for location/push); release checklist (contract suite green vs staging, no MSW in bundles, no OTA for booking/money code). Exit: CI green on PR; preview build QA'd on device; production build has mocks forced off.

Each milestone's exit criteria: typecheck + tests green, `npm run lint` clean, no forbidden patterns (section 4), new env vars registered, contract-only paths.

Cross-cutting error handling (API.md) — implement once in the transport, per-screen in UI:

- `401 UNAUTHORIZED` / `SESSION_EXPIRED` → refresh once → retry → force logout to auth.
- `403 FORBIDDEN` / `CAPABILITY_FORBIDDEN` → role/capability mismatch; refetch capabilities, show role-switch prompt — never downgrade silently.
- `409 CONFLICT` (`BOOKING_STATUS_CONFLICT`, `JOB_OFFER_EXPIRED`, `TECHNICIAN_BUSY`, `QUOTE_ALREADY_ISSUED`, `PROOF_OF_SERVICE_ALREADY_SUBMITTED`) → refetch the booking; server state is the truth; toast.
- `429 RATE_LIMITED` → respect `retryAfterSeconds`, disable resend until it passes.
- `422 VALIDATION_FAILED` → map `errors[].field` to form fields.
- All booking status/cancel and payment mutations carry `Idempotency-Key`; mock repositories throw the same `ApiError(status, code)` shapes so tests and app behavior match live.

Per-screen state matrix (TESTING.md) — every screen must implement and test all four:

| Screen | Loading | Empty | Error / retry | Success |
| --- | --- | --- | --- | --- |
| Login/OTP | sending | — | OTP invalid/expired/rate-limited (retry with `retryAfterSeconds`) | session → redirect by role |
| Onboarding | `GET /providers/me` fetch | no application → start CTA | fetch fail → retry | per `VerificationState` |
| Availability | week skeleton | no windows → CTA | save fail → revert + toast | `204` → refetch |
| Jobs list (per status tab) | skeleton cards | "No incoming requests" etc. | retry | status pills + TZS |
| Job detail | skeleton timeline | — | mutation fail → toast + refetch | timeline + actions per status |
| Marketplace | skeleton offers | "No jobs in your area yet" | retry | cards + countdown |
| Earnings | skeleton balance | "No payouts yet" | retry | balance, payouts, statement |
| Notifications | skeleton | "No notifications" | retry | unread/read, deep links |
| Support tickets | skeleton | "No tickets" | retry | thread + reply composer |
| Settings/profile | skeleton | — | retry | profile, locale, logout |

## 7. Enterprise standards

- Strict TS: `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true` (rider tsconfig); typecheck is `tsc --noEmit`, tests excluded.
- Tests required per milestone: node:test via `tests/run.mjs` (esbuild bundle + `node --test`), contract tests against mock repositories with `resetMockState()` in `beforeEach`, deterministic `setFixturesSeed`; assert `ApiError` status + code; money assertions check `Number.isInteger`.
- Contract-test outline (`tests/provider-contract.test.ts`, mirror rider-contract.test.ts): fixtures deterministic per seed; OTP request/verify (wrong code → `401 OTP_INVALID`, debugCode path, session shape); availability replace + toggle semantics; booking machine walk (offer accept → advance to `settled`) + out-of-sequence advance → `409`; offer expiry → `JOB_OFFER_EXPIRED`; quote submit/decision + `QUOTE_DECLINED` block; proof-of-service single-submit guard; parts + invoice sum rule (labor + trip + parts − discount + tax = `totalTZS`, integers); warranty issue; technician assign + `TECHNICIAN_BUSY`; capability denial (`CAPABILITY_FORBIDDEN`); payout request within/over balance; statement opening+closing balances; notifications read/markAllRead; ticket thread round-trip; review + report.
- Lint: `expo lint` + `eslint.config.js` (flat config, `eslint-config-expo`); no console.log in src; no dead code.
- A11y: RN accessibility props on every control; labeled icon-only buttons; status announcements for live updates; respect reduce-motion.
- Security: `expo-secure-store` for access/refresh tokens; refresh interceptor (401 → refresh once → retry → logout); logout calls `POST /auth/logout` then wipes storage; never log tokens; masked customer contact rendered as masked (`+255 ••• ••• •89`); no secrets in `EXPO_PUBLIC_*`; deep links validate bookingId against the active role; destructive actions confirm dialogs.
- Error hygiene: switch on `ErrorResponse.code` everywhere (never `message`); show `message` + `requestId`, never stack traces; retriable errors use the client's backoff (408/429/5xx); `ApiError` from `src/api/client.ts` is the only error type across repos and tests.
- Money safety: `Idempotency-Key` on all booking status/payment mutations (safe retries, never double-apply); integer TZS only; totals server-computed; error handling switches on `ErrorResponse.code`, never `message`.
- Performance: lazy routes (expo-router), virtualized lists (`FlatList`) for jobs/ledger/notifications/feed, memoized rows, no re-render of whole lists per tick; countdowns scoped to one component.

## 8. Definition of Done

- [ ] `npm run typecheck` passes (strict, no unused).
- [ ] `npm test` green (node:test contract suite, mock repositories).
- [ ] `npm run lint` passes (`eslint.config.js` present, `expo lint`).
- [ ] CI added: `.github/workflows/provider.yml` at platform root (typecheck + lint + tests).
- [ ] Mock switches forced off in preview/production builds; mock code never ships (CI assert).
- [ ] Every endpoint used exists in `backend/API-CONTRACT.yaml`; no invented paths; gaps raised with Team 6.
- [ ] Theme is `@hudumika/tokens`-only (semantic `theme.ts`; no hex literals in screens).
- [ ] i18n: all strings via `t()`; `en` complete, `sw` stub; no raw keys on screen.
- [ ] Every screen implements loading/empty/error/retry/success; a11y props present.
- [ ] Tokens in `expo-secure-store`; no secrets, no logged tokens.
- [ ] README updated (run/verify, env table, mock switches, provenance).
- [ ] New env vars registered in `docs/ENV-VARS.md` + `.env.example` in the same PR.

Final standing order: before every task, re-read this file and the relevant `provider/docs/` slice; after every task, run typecheck + tests + lint, and re-check the DoD list above. When in doubt between this file and any other doc, this file wins; between the app and the contract, the contract wins. Build like rider-mobile, think like a platform engineer, ship like an operator.
