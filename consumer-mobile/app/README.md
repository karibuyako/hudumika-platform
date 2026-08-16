# HUDumika Consumer App (consumer-mobile/app)

The customer-facing Expo app (SDK 57, React Native, TypeScript strict) — **discover → transact → manage**.
Mirrors the rider-mobile house pattern exactly (repository interfaces, factories, mock state, store
shape, theme, tests). Spec: `consumer-mobile/docs/` (README → PRODUCT → MASTER-BLUEPRINT → ORDER-FLOW
→ API → PAYMENTS → ROADMAP).

## Run

```bash
npm ci
npm start          # Expo dev server (mocks ON by default)
npm run web        # web target
```

## Test / lint / typecheck

```bash
npm test                 # node:test contract tests against the mock repositories
npm run test:contract    # just consumer-contract.test.ts
npm run test:unit        # jest unit + component suites (price math, state machines, RNTL)
npm run lint             # expo lint (eslint-config-expo, flat config)
npm run typecheck        # tsc --noEmit (strict; app + component-tests + e2e tsconfigs)
```

## E2E (Detox — `e2e/`, TESTING.md §4)

Happy-path suites (`e2e/*.e2e.ts`) run on emulators/simulators against the
MSW-backed mock build (mocks default ON in debug builds). Every suite maps to
a TESTING.md §4 flow; the spec headers document the exact labels/text used and
any seed gaps (e.g. the rush/`awaiting_customer_confirmation` states the mock
does not seed — those tests are written and skipped with the enable steps).

```bash
npm run e2e:build        # detox build  --configuration android.emu  (npx expo run:android debug)
npm run e2e:test         # detox test   --configuration android.emu
```

Requirements / notes:

- **Native build first**: `npx expo prebuild --platform android` (or ios)
  generates the native projects, then `e2e:build` compiles the debug APK.
- **Emulator**: `android.emu` targets the `Pixel_7_API_36` AVD
  (`ios.sim` targets an iPhone 15 simulator) — see `detox.config.js`.
- **CI**: `.github/workflows/consumer.yml` carries a commented-out `e2e` job
  (needs an emulator-capable runner — enable by removing `if: false`).
- **Not part of `npm test`/`test:unit`**: the suites run only through
  `detox test` (e2e/jest.config.js is independent of the component-tests
  jest config; typecheck covers e2e via `e2e/tsconfig.json`).
- Release candidates run the same specs against staging by flipping the
  `EXPO_PUBLIC_MOCK_*` switches off (README "Mock switches").

`npm test` picks up every `tests/*.test.ts` via `tests/run.mjs` (esbuild → `node --test`):

- `consumer-contract.test.ts` — endpoint parity: every repo behaves per the contract
  (validation, auth/404, 409 → refetch, idempotency replay, pagination, error shape).
- `contract-parity.test.ts` — the contract-parity harness: machine-checks the mock repos
  against the generated contract package and `backend/ERROR-CODES.md` — (a) every URL the
  app's api repos call exists in the contract, (b) every `ApiError` code the mocks throw is a
  real code (no invented codes; allow-lists are explicit and exact), (c) every `ApiError`
  carries `{code, message, requestId}`. Allow-lists: `/providers/{param}` (provider detail
  GET not yet in the OpenAPI spec — flagged for backfill); mock codes currently need none.
- `m{1..16}-*.test.ts` — per-milestone suites.

CI: `.github/workflows/consumer.yml` runs install → typecheck → lint → `npm test`
(contract + milestones + parity) → `npm run test:unit` (jest) on `consumer-mobile/**` PRs +
main.

## Mock switches (default ON in dev, OFF in staging/production)

| Var | Repositories it flips |
| --- | --- |
| `EXPO_PUBLIC_MOCK_AUTH` | auth + user profile |
| `EXPO_PUBLIC_MOCK_HOME` | home feed + search |
| `EXPO_PUBLIC_MOCK_ORDERS` | orders, payments, bookings, reviews, notifications, support, conversations, merchants, providers, hotels, travel, events, marketing, shipments, disputes, group-orders, lists (curated), splits |
| `EXPO_PUBLIC_MOCK_WALLET` | wallet, finance (invoices + withdrawals), coupons, favorites, memberships, group-buy, vouchers, dine-in, reservations, red-packets, rewards (referral + birthday) |
| `EXPO_PUBLIC_MOCK_ASSISTANT` | assistant chat |

Set any to `false` to hit the live API for that surface (contract paths only — see
`docs/API-BASE-CONVENTION.md`). The mock path is never deleted; `src/repos/factories.ts` is the only switch.

## Environment

`.env.example` — `EXPO_PUBLIC_*` only, no secrets. Registered in `docs/ENV-VARS.md`:

- `EXPO_PUBLIC_API_URL` — live backend **includes `/api/v1`**; dev mock gateway is the bare host.
- `EXPO_PUBLIC_ENV` — `development` | `staging` | `production` (eas.json profiles).
- `EXPO_PUBLIC_MOCK_*` — the switches above.

## Deployment

Builds and release via EAS (`eas.json`: `development` / `staging` / `production` profiles); store
links come from `EXPO_PUBLIC_APP_LINKS`, never code literals. **OTA gap**: `expo-updates` is NOT
installed yet — JS-only fixes ship in the next native build, so the staging/production channels
have no in-app over-the-air updates until the native pipeline is wired. Web dev (`npm run web`) is
unaffected by this gap.

## How to flip a repository to live

1. Edit `src/repos/factories.ts` — one line per repo getter (env switch).
2. The `.api.ts` implementation for every module already exists and calls only contract paths.
3. Verify the screen behaves identically, then revert (or keep a live profile build).

## Structure

```
src/
├── app/          expo-router: (auth) login (OTP + social buttons)/
│                 verify-otp/signup/forgot-password,
│                 (onboarding) city picker with GPS auto-detection,
│                 (tabs) home/orders(universal activity center)/services/messages/
│                 profile, plus detail routes: search (+ filters/sort),
│                 search-results, merchant/[merchantId], provider/[providerId]
│                 (preferred-provider toggle), booking/[bookingId] (share
│                 button), group-buys, group-buys/[groupId], vouchers,
│                 reservations, dine-in (QR→menu→bill→pay), cart, checkout
│                 (universal shell, ?transactionType=), splits/[splitId],
│                 order/[orderId] (share button), order/[orderId]/tracking,
│                 order/confirmation/[orderId], wallet (top-up, report issue),
│                 coupons, favorites (lists), list/[listId] (curated lists),
│                 membership (points redemption), notifications,
│                 notification-preferences (per-event keys + locked security
│                 toggles), support, support/[ticketId],
│                 messages/[conversationId], addresses, settings, security
│                 (sessions + 2FA), privacy (consent + export), payments,
│                 review, book (questionnaire + urgency + estimate + intent
│                 pay), hotels, hotels/[hotelId], hotel-bookings/[bookingId],
│                 travel (bus/ferry/flight + mock-ext trains),
│                 travel-bookings, events, events/[eventId], events/tickets,
│                 assistant, referrals, withdrawals (payout destinations),
│                 invoices, invoices/[invoiceId], live-deals,
│                 live/[sessionId] (broadcast + lite chat)
├── components/   ui.tsx primitives + EmptyState, ErrorState, StatusPill,
│                 MoneyText, Rating, BilingualPill, SkeletonCard,
│                 LocationPermissionSheet (each its own file, re-exported)
├── constants/    theme.ts (copied rider — @hudumika/tokens only)
├── lib/          format.ts (formatTZS), dates.ts (UTC→local), order.ts (status
│                 sets), idempotency.ts (real user id + nonce), deep-link.ts
│                 (allow-list), secureStorage.ts (SecureStore + web fallback),
│                 geolocation.ts (GPS detect + reverse-geocode + service-area),
│                 search.ts (pure filter/sort/dispatch), analytics.ts (event
│                 catalog + pluggable sink)
├── api/          client.ts (hardened fetch, single-flight refresh, offline
│                 queue with sensitive-op fail-fast), queue.ts, types.ts
├── store/        session.ts (boot/anon/onboarding/authed), cart.ts (per-merchant
│                 draft groups), location.ts (city + service area), ui.ts
│                 (reduced motion), addresses.ts, network.ts, consent.ts
│                 (per-purpose privacy consents), events.ts
├── i18n/         index.ts (t() + formatTZS) + locales/{en,sw,ar}.ts
├── repos/        index.ts (interfaces) + factories.ts + mock/ + api/ per surface
│                 (auth incl. sessions/export/social login/2FA, home, search,
│                 merchants, providers incl. questionnaire + preferred list,
│                 orders incl. route/waybill/phases/masked call + share,
│                 payments, wallet incl. payout destinations, bookings incl.
│                 quote decision + share, reviews, notifications, support,
│                 conversations incl. attachments, coupons, favorites incl.
│                 lists, memberships incl. redemption, groupBuy incl. detail,
│                 vouchers, dineIn incl. table QR + bill detail, reservations,
│                 hotels, travel, events, assistant, rewards (referral +
│                 birthday), finance (invoices + withdrawals), marketing
│                 (live deals + live chat), shipments, disputes, redPackets,
│                 groupOrders, lists (curated), splits)
│                 + mock/mockState.ts (seeded, resetMockState())
└── hooks/        query.ts — query keys mirroring contract resources
                  (['orders','me',{status}], ['merchants',id], …) +
                  useQueryData() over queryCache.ts (see "Server state")
tests/            run.mjs (esbuild → node --test, runs every *.test.ts) +
                  consumer-contract.test.ts (endpoint parity) +
                  per-milestone suites m1-auth / m1b-onboarding / m2-home /
                  m2c-location / m2b-booking / m3-cart / m4-payments /
                  m5-orders / m5c-activity / m5-confirmation /
                  m6-engagement / m6b-reviews / m7-hardening / m8-superapp /
                  m8b-loyalty / m9-realtime / m9b-push / m10-catalog-promos /
                  m10-saved-searches / m11-camera / m11-maps / m12-query /
                  m12d-disputes / m12-shipment / m13-flash-lists / m14-env /
                  m15-red-packets / m15b-group-order / m16-voice-image /
                  m16b-hotels / m16c-travel / m16d-events / m16e-assistant /
                  m16f-rewards / m16g-withdrawals / m16h-invoices /
                  m16i-tips / m16j-live-deals
```

## Feature verticals

- **Hotels & travel & events** — new super-app verticals: hotel search/detail
  (`hotels`, `hotels/[hotelId]`), intercity bus/ferry/flight options
  (`travel`, `travel-bookings`; trains are a **mock-only extension** — the
  contract `TravelOptionMode` has no `'train'` value yet, so the mode chip is
  cast mock-side and the live API forwards the query string verbatim), event
  discovery + ticket booking (`events`, `events/[eventId]`, `events/tickets`),
  plus `hotel-bookings/[bookingId]`. All ride the same repo/contract/mock
  pattern.
- **Split payments** (`splits/[splitId]`) — "Split the payment" toggle on
  checkout (even split 2/3/4 or custom rows with live sum validation, hidden
  for COD) creates a plan, pays your own share via the normal intent flow,
  then lands on the split summary with paid-status rows, "Pay my share",
  "Complete split" and a `hudumika://split/{id}` share link behind
  `SplitPaymentsRepository` (mock-first; the other payers' flow is simulated
  as pre-paid).
- **Favorites lists & curated lists** (`favorites`, `list/[listId]`) —
  user-organized favorites lists (create/add/remove/delete, "Add to list" on
  merchant cards, optimistic with server rollback) plus 必吃榜-lite curated
  rankings (`GET /lists`, `GET /lists/{id}`) behind `FavoritesRepository` +
  `ListsRepository` (both mock-first, CONTRACT-ADDITIONS #14).
- **Preferred providers** — "Preferred provider" toggle on the provider
  detail screen plus a "Your preferred providers" section above the services
  tab list, behind `ProvidersRepository.listPreferred`/`setPreferred`
  (mock-first, CONTRACT-ADDITIONS #21; hidden entirely against a live backend
  that has not adopted the paths).
- **Share order/booking** — share buttons on `order/[orderId]` and
  `booking/[bookingId]` (react-native Share sheet with the
  `hudumika://order/{id}` / `hudumika://booking/{id}` deep link; browser
  fallback on web).
- **Social login** — Google + Apple buttons under "or continue with" on
  `(auth)/login.tsx`; tap shows an honest mock-first explainer sheet and signs
  in the seeded demo customer via `AuthRepository.socialLogin`
  (`POST /auth/social`, mock-only, CONTRACT-ADDITIONS #19 — no real OAuth
  redirect; SDKs are a native-phase concern).
- **Two-factor authentication** — "Two-factor authentication" card on
  `security.tsx` (Enabled/Disabled pill, enable flow with the one-time demo
  TOTP code sheet, disable sheet with inline error) behind
  `AuthRepository.getTwoFactorStatus`/`enableTwoFactor`/`disableTwoFactor`/
  `verifyTwoFactor` (mock-first, CONTRACT-ADDITIONS #23; the withdrawal/
  payment/account-deletion §21 gates are not wired yet).
- **Universal checkout shell** — `checkout.tsx` reads the `?transactionType=`
  query param (`commerce|booking|service|hotel` — blueprint §2 typed route)
  and dispatches the shell: type chip, booking/hotel context cards and the
  right submit path, so one checkout route serves every vertical.
- **Per-event notification preferences** — `notification-preferences.tsx`
  renders one toggle per event key (order/payment/booking/promo/review/
  intercity/security sections) and a **locked** security section (the
  security.otp / security.login toggles are backend-locked, always-on).
- **Withdrawal destinations** — withdrawals + wallet show the masked payout
  destination (`destination` is a mock-only extension on
  `WalletWithdrawInput`/`Withdrawal` — the contract body carries only
  `{amountTZS}`; a live backend hides the destination note).
- **Live streaming-lite chat** (`live/[sessionId]`) — the live-deals broadcast
  screen: hero video placeholder (static LIVE dot + honest `videoSoon` note),
  countdown, shared DealCard rail and a mock-first live chat with optimistic
  composer behind `MarketingRepository.fetchLiveChat`/`postLiveChat`
  (mock-only, CONTRACT-ADDITIONS #20 — no video playback dependency, no
  websockets).
- **AI assistant** (`assistant`) — chat surface behind `AssistantRepository`
  (flipped by `EXPO_PUBLIC_MOCK_ASSISTANT`).
- **Referral & birthday rewards** (`referrals`) — referral code + invite stats,
  `POST /referrals/claim`, and the birthday reward, behind `RewardsRepository`.
- **Wallet withdrawals** (`withdrawals`) — `POST/GET /wallet/withdrawals` with
  idempotent request/replay (never a double debit) behind `FinanceRepository`.
- **Invoices & receipts** (`invoices`, `invoices/[invoiceId]`) — list, detail
  (VAT/standard, tax rows, buyer info) and signed-PDF download behind
  `FinanceRepository`.
- **Tips** — tip sheet in `order/[orderId]` (amount chips + custom, payment
  method, note) after delivery only; the server records `tipTZS` and rejects a
  second tip.
- **Live deals zone** (`live-deals`) — countdown sessions behind
  `MarketingRepository` (`listLiveDeals`).
- **Voice/image search** (`search.tsx` → `search-results`) — voice transcript
  rides `POST /search/voice`, picked images `POST /search/image`.

## Money & trust rules (enforced by tests)

- Integer TZS everywhere; `formatTZS` only, never inline `toLocaleString()` in UI.
- `PriceBreakdown` rendered verbatim before every confirm; client totals are advisory.
- `TrackingEvent.estimateMinutes`/`eta` rendered verbatim — the client never computes ETAs.
- Every mutation sends an `Idempotency-Key`; retry replays, never double-creates.
- Tokens in `expo-secure-store` (web fallback localStorage); never logged.

## Platform rules in practice

- **Errors** carry `{code, message, requestId}` (mock + live envelope in `ApiError`); screens
  switch on `code`, never `message`; `INTERNAL_ERROR` surfaces as generic copy.
- **Single-flight refresh**: a 401 triggers one `POST /auth/refresh` (all callers share it), the
  request replays once, and refresh failure force-logs-out (`api/client.ts`).
- **Payment UX**: checkout shows the STK-push wait state per method; `PAYMENT_PROVIDER_ERROR`
  renders a `retryAfterSeconds` countdown and retries the same intent (idempotent replay).
  Mocks can simulate an outage: `simulatePaymentFailure('PAYMENT_PROVIDER_ERROR', 3)`.
- **Analytics** (`lib/analytics.ts`): `home_viewed`, `search_submitted`, `merchant_viewed`,
  `cart_item_added`, `checkout_started`, `order_created`, `tracking_viewed`, `review_submitted`
  — entity ids/statuses only, never money, PII, or bodies.
- **Offline**: `api/queue.ts` persists mutations with idempotency keys and replays on reconnect
  (offline banner in the tabs); queue behavior is covered by tests.
- **Auth surface**: `AuthRepository` mirrors `request-otp/verify-otp/refresh/logout`, `users/me`,
  `users/me/roles`, `privacy/delete`; only `customer` sessions render in this app.
- **Deep links**: allow-list `order/{id}`, `booking/{id}`, `ticket/{id}`, `conversation/{id}`,
  `dine-in/{id}`, `reservation/{id}`, `voucher/{code}` in `lib/deep-link.ts`; notification taps
  validate before navigating (dine-in/reservation/voucher targets currently take no param — the
  screens refetch their lists on mount).

## Server state (React Query decision)

`docs/ARCHITECTURE.md` ("React Query: all server state") records the platform intent; this app
implements it as a lightweight cache layer without a new dependency. Decision:

**(a) Why the repo + store pattern is retained.** The house pattern (rider-mobile reference +
`docs/MOBILE-MOCK-PATTERN.md`) is repository interfaces + zustand in-process stores, and a full
`@tanstack/react-query` migration would be a large risky rewrite of every screen. The contract is
the single source of truth (`src/repos/index.ts` — screens import repo interfaces only), and
mock-first parity means every repo (mock + live) already satisfies it. Server state therefore
stays behind repos; the cache is an optional layer on top, not a replacement.

**(b) The sanctioned path for new screens / server-state caching** is `src/hooks/query.ts`
(`useQueryData`) over the dependency-free core in `src/hooks/queryCache.ts`:
`registerQuery(key, loader)` serves a cached entry without reloading (returns `{data, fromCache}`),
`invalidateQuery(key | prefix)` drops exact keys or whole branches (`['orders']` clears
`['orders','me']` and `['orders',id,'track']`), `subscribeCache`/`clearQueryCache` cover non-React
and session-switch use. Keys are the existing `queryKeys` builders (contract-resource shape, e.g.
`queryKeys.orders.me({status})`), so invalidation and refetching are key-driven — server state
wins on 409/`CONFLICT` by invalidating + reloading, exactly as ARCHITECTURE.md specifies. Existing
screens keep their `useState` + `load()` pattern until migrated incrementally.

**(c) Future migration note.** A move to `@tanstack/react-query` swaps the `queryCache.ts` core for
a `QueryClient` with `queryKey`/`queryFn` per resource — the key shapes and invalidation semantics
are already theirs. The migration is per-screen (replace `useState`+`load()` with `useQuery`, and
mutations with `useMutation` + `invalidateQueries`), is contained behind the repo interfaces, and
does not change the contract or the mock/live parity.
