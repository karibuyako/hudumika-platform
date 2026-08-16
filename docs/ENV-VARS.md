# Environment Variables Registry

Every environment variable actually read by platform code, in one table. If a variable is not listed here, it is not wired up — do not add reads without registering them first.

## Naming convention (binding)

| Platform | Prefix | Example |
| --- | --- | --- |
| Web (Vite) | `VITE_` | `VITE_USE_MOCKS` |
| Native (Expo/RN) | `EXPO_PUBLIC_` | `EXPO_PUBLIC_API_URL` |
| Backend (Go) | plain uppercase | `DATABASE_URL` |

- Mock switches: web = `VITE_USE_MOCKS` (single global) and `VITE_MOCK_*` per-endpoint; native = `EXPO_PUBLIC_MOCK_*` (one per repository/factory). No other mock-switch names are allowed.
- **New variables must be registered here** (and added to the relevant `.env.example`) in the same PR that reads them.

## Registry

### Web

| Var | Platform | Apps | Default | Mock/live control | Notes |
| --- | --- | --- | --- | --- | --- |
| `VITE_CUSTOMER_IOS_URL` | web | public-frontend | (empty) | — | Customer app App Store link (hero CTA) |
| `VITE_CUSTOMER_ANDROID_URL` | web | public-frontend | (empty) | — | Customer app Play Store link |
| `VITE_MERCHANT_IOS_URL` | web | public-frontend | (empty) | — | Merchant app App Store link |
| `VITE_MERCHANT_ANDROID_URL` | web | public-frontend | (empty) | — | Merchant app Play Store link |
| `VITE_PROVIDER_IOS_URL` | web | public-frontend | (empty) | — | Provider app App Store link |
| `VITE_PROVIDER_ANDROID_URL` | web | public-frontend | (empty) | — | Provider app Play Store link |
| `VITE_RIDER_IOS_URL` | web | public-frontend | (empty) | — | Rider app App Store link |
| `VITE_RIDER_ANDROID_URL` | web | public-frontend | (empty) | — | Rider app Play Store link |
| `VITE_SUPPORT_CONSUMER_PHONE` | web | public-frontend | (empty) | — | Consumer support phone (footer/contact) |
| `VITE_SUPPORT_CONSUMER_EMAIL` | web | public-frontend | (empty) | — | Consumer support email |
| `VITE_SUPPORT_MERCHANT_PHONE` | web | public-frontend | (empty) | — | Merchant support phone |
| `VITE_SUPPORT_MERCHANT_EMAIL` | web | public-frontend | (empty) | — | Merchant support email |
| `VITE_SUPPORT_PROVIDER_PHONE` | web | public-frontend | (empty) | — | Provider support phone |
| `VITE_SUPPORT_PROVIDER_EMAIL` | web | public-frontend | (empty) | — | Provider support email |
| `VITE_SUPPORT_RIDER_PHONE` | web | public-frontend | (empty) | — | Rider support phone |
| `VITE_SUPPORT_RIDER_EMAIL` | web | public-frontend | (empty) | — | Rider support email |
| `VITE_COMPANY_LOCATION` | web | public-frontend | (empty) | — | Company location string (sitewide) |
| `VITE_USE_MOCKS` | web | admin-web/app | on in dev (`!== 'false'`) | **mock** | Enables MSW handlers via `@hudumika/contract/mocks`; never in production builds |
| `VITE_ADMIN_API_URL` | web | admin-web/app | (empty) | live | Admin API base override (per `admin-web/DEPLOYMENT.md`, injected per environment for the live API). The generated contract client uses relative paths (e.g. `/admin/orders`) resolved against the page origin — same-origin gateway at the ops hostname proxies `/api/v1` (see `docs/API-BASE-CONVENTION.md`). Set only when the live API is NOT same-origin with the admin host; trailing `/` stripped in `admin-web/app/src/lib/api-base.ts` |

The 17 public-frontend vars above are declared in `public-frontend/src/config/*.ts` and `public-frontend/src/vite-env.d.ts`; root `.env.example` mirrors them. The admin-web vars (`VITE_USE_MOCKS`, `VITE_ADMIN_API_URL`) are read in `admin-web/app` (`src/main.tsx`, `src/lib/api-base.ts`).

### Native

| Var | Platform | Apps | Default | Mock/live control | Notes |
| --- | --- | --- | --- | --- | --- |
| `EXPO_PUBLIC_API_URL` | native | merchant/app, rider-mobile/app, consumer-mobile/app | (empty) | mock/live | API base. Mock gateway (`http://<host>:3001`, dev-only) or live backend **including `/api/v1`** (see `docs/API-BASE-CONVENTION.md`). Trailing `/` stripped in `src/api/client.ts`. |
| `EXPO_PUBLIC_ENV` | native | consumer-mobile/app | `development` | — | `development` / `staging` / `production`; drives eas.json profile behavior |
| `EXPO_PUBLIC_MOCK_AUTH` | native | rider-mobile/app | `true` (on) | **mock switch** | Auth + rider profile repositories; `'false'` → live API |
| `EXPO_PUBLIC_MOCK_JOBS` | native | rider-mobile/app | `true` (on) | **mock switch** | Dispatch + delivery + notifications + payments (collection QR) repositories; `'false'` → live API |
| `EXPO_PUBLIC_MOCK_EARNINGS` | native | rider-mobile/app | `true` (on) | **mock switch** | Earnings + payouts repositories; `'false'` → live API |
| `EXPO_PUBLIC_MOCK_HOME` | native | consumer-mobile/app | `true` (on) | **mock switch** | Home feed + search repositories; `'false'` → live API |
| `EXPO_PUBLIC_MOCK_ORDERS` | native | consumer-mobile/app | `true` (on) | **mock switch** | Orders, payments, bookings, reviews, notifications, support, conversations, merchants, providers repositories; `'false'` → live API |
| `EXPO_PUBLIC_MOCK_WALLET` | native | consumer-mobile/app | `true` (on) | **mock switch** | Wallet, coupons, favorites, memberships, group-buy, dine-in, reservations repositories; `'false'` → live API |
| `EXPO_PUBLIC_MOCK_ASSISTANT` | native | consumer-mobile/app | `true` (on) | **mock switch** | Assistant chat repository (Xiaomei-lite, POST /assistant/chat); `'false'` → live API |
| `EXPO_PUBLIC_FEATURE_COUPON_CHECKOUT` | native | consumer-mobile/app | `true` (on) | feature flag | Gates the checkout coupon selector (WALLET-COUPONS.md). Default ON since the mock-first batch (docs/CONTRACT-ADDITIONS.md #10): the mock validates and applies `couponId` server-side; a live backend that has not shipped the contract field ignores it (no discount), so the selector is safe either way. `'false'` hides it |
| `EXPO_PUBLIC_MOCK_SUPPORT` | native | rider-mobile/app | `true` (on) | **mock switch** | Support tickets repository; `'false'` → live API |
| `EXPO_PUBLIC_MOCK_SAFETY` | native | rider-mobile/app | `true` (on) | **mock switch** | SOS + trusted contacts + security score + trip share repository; `'false'` → live API |
| `EXPO_PUBLIC_MOCK_VEHICLE` | native | rider-mobile/app | `true` (on) | **mock switch** | Vehicle tools repository (maintenance, expenses, goals, exports, training); `'false'` → live API |
| `EXPO_PUBLIC_MOCK_TRIPS` | native | rider-mobile/app | `true` (on) | **mock switch** | Batch-trips (P10c) repository (active trip, detail, stop reorder); `'false'` → live API |
| `EXPO_PUBLIC_APP_LINKS` | native | consumer-mobile/app | (empty) | — | JSON string of store/support links (`ios`, `android`, `supportPhone`, `supportEmail`) — app store links are environment-driven config, never hardcoded (ARCHITECTURE.md) |
| `EXPO_PUBLIC_MOCK_AUTH` | native | merchant/app | `true` (on) | **mock switch** | Auth handlers; `'false'` → live API |
| `EXPO_PUBLIC_MOCK_ORDERS` | native | merchant/app | `true` (on) | **mock switch** | Orders handlers; `'false'` → live API |
| `EXPO_PUBLIC_MOCK_CATALOG` | native | merchant/app | `true` (on) | **mock switch** | Products (catalog) handlers; `'false'` → live API |
| `EXPO_PUBLIC_MOCK_FINANCE` | native | merchant/app | `true` (on) | **mock switch** | Finance + finance-extra handlers; `'false'` → live API |
| `EXPO_PUBLIC_MOCK_BI` | native | merchant/app | `true` (on) | **mock switch** | BI + analytics handlers; `'false'` → live API |
| `EXPO_PUBLIC_MOCK_MARKETING` | native | merchant/app | `true` (on) | **mock switch** | Campaigns + redemptions handlers; `'false'` → live API |
| `EXPO_PUBLIC_MOCK_MESSAGING` | native | merchant/app | `true` (on) | **mock switch** | Messaging handlers; `'false'` → live API |
| `EXPO_PUBLIC_MOCK_OPS` | native | merchant/app | `true` (on) | **mock switch** | Ops + staff + risk + reviews + announcements handlers; `'false'` → live API |
| `EXPO_PUBLIC_MOCK_STORE` | native | merchant/app | `true` (on) | **mock switch** | Store-ops handlers; `'false'` → live API |
| `EXPO_PUBLIC_MOCK_ALL` | native | merchant/app | `true` (on) | **mock switch** | Master override for all merchant mock modules; `'false'` → all live |
| `EXPO_PUBLIC_ENVIRONMENT` | native | merchant/app | (empty) | — | `production` disables mocks entirely (merchant mock gate); unset means dev, mocks on |
| `MOCK_PORT` | native (dev tooling) | merchant/app | `3001` | mock | Port for the dev mock gateway (`npm run mock:gateway`, `scripts/mock-gateway.ts`) |

### Backend

| Var | Platform | Apps | Default | Mock/live control | Notes |
| --- | --- | --- | --- | --- | --- |
| `ENV` | backend | backend/app | (none — required) | — | Must be exactly `development` \| `staging` \| `production`; an invalid or empty value is a hard boot failure (no silent default) |
| `PORT` | backend | backend/app | `8080` | — | HTTP listen port |
| `DATABASE_URL` | backend | backend/app | (none) | — | Postgres DSN. **Required in production** (boot failure otherwise). Unset outside production runs without persistence (dev only, warned at boot) |
| `REDIS_URL` | backend | backend/app | (none) | — | Redis DSN for OTP/rate-limit/session/idempotency state. **Required in production**; in-memory stores are dev/test only |
| `JWT_SECRET` | backend | backend/app | (none — required) | — | HS256 signing secret; **required**, min 32 bytes in production, known weak values refused in production |
| `JWT_SIGNING_KEY` | backend | backend/app | — | — | **Alias** of `JWT_SECRET` (DEPLOYMENT.md); both spell the same secret, `JWT_SECRET` wins when both set |
| `OTP_DEV_CODE` | backend | backend/app | `123456` | — | Fixed dev OTP code; honoured only in non-production environments, and **refused in production config** |
| `OTP_PAYLOAD_KEY` | backend | backend/app | (none) | — | Hex 256-bit AES key encrypting outbox payloads (OTP codes before SMS delivery). **Required in production**; a random per-boot key is generated elsewhere |
| `ACCESS_TOKEN_TTL` | backend | backend/app | `15m` | — | Access-token lifetime (Go duration format) |
| `REFRESH_TOKEN_TTL` | backend | backend/app | `720h` | — | Refresh-token lifetime (Go duration format) |
| `CORS_ORIGINS` | backend | backend/app | (none) | — | Comma-separated allowed origins; `*` is accepted in dev only and **refused in staging/production** |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | backend | backend/app | (none) | — | When set, OpenTelemetry spans export over OTLP/HTTP; unset runs a no-op tracer |
| `PAYMENT_WEBHOOK_SECRET` | backend | backend/app | (none) | — | HMAC-SHA256 secret verifying payment provider webhooks (`X-Webhook-Signature`); webhooks are rejected with 503 while unset |

## Rules

1. Web reads `import.meta.env.VITE_*` only; native reads `process.env.EXPO_PUBLIC_*` only; backend reads plain `os.Getenv(...)`.
2. Mock switches: `VITE_USE_MOCKS` / `VITE_MOCK_*` (web), `EXPO_PUBLIC_MOCK_*` (native). Convention is on-by-default in dev, always off in production builds.
3. Secrets never reach the browser or the app bundle: `VITE_*` / `EXPO_PUBLIC_*` are compiled into the client — only non-sensitive config belongs there.
4. Register any new variable here and in the relevant `.env.example` in the same PR (definition of done).
