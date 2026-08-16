# Customer App — Architecture

## Repository layout (Expo managed)

```
customer-app/
  app.json / eas.json        # Expo + EAS build config, env per channel
  .env.development / .env.production  # EXPO_PUBLIC_* only
  src/
    screens/                 # One folder per feature: auth, city, home, explore,
                             # merchant, catalogue, cart, checkout, order, tracking,
                             # booking, payments, reviews, notifications, support, account
    components/              # Shared UI per ../DESIGN-SYSTEM.md (Button, Card, StatusPill,
                             # EmptyState, ErrorState, Rating, MoneyText, BilingualPill)
    navigation/              # Root stack + bottom tabs (Home, Explore, Orders, Bookings,
                             # Saved, Account) + deep-link config
    api/                     # Generated typed client (see below) + error code mapper
    state/                   # Zustand stores (session, cart, location) + query keys
    i18n/                    # i18next config, locale files, date/number formatters
    mocks/                   # MSW handlers generated from backend/API-CONTRACT.yaml
  __tests__/                 # Jest unit + RNTL component tests
  e2e/                       # Detox suites (order happy path, booking happy path)
```

## Navigation map

```
Auth stack (OTP → verify → role picker)
  → City picker / service area selection
  → Home (tabs: Home | Explore | Orders | Bookings | Saved | Account)
      ├─ Explore → Service list (GET /services) → category → Merchant list / Provider list
      ├─ Home  → search → Merchant detail (GET /merchants/{id})
      │            → Catalogue (GET /catalogues/{merchantId})
      │            → Cart → Checkout → Payment → Order detail → Tracking
      ├─ Orders → Order detail (GET /orders/{id}) → Tracking (GET /orders/{id}/track)
      │            → Cancel / Review / Support ticket
      ├─ Bookings → Booking detail (GET /bookings/{id})
      │            → Booking form → Payment → status timeline → complete confirmation
      └─ Account → profile, addresses, payment methods, refunds, preferences, tickets
```

Deep links (`deepLink` from notifications): `order/{orderId}`, `booking/{bookingId}`,
`ticket/{ticketId}` — validated in `navigation/` (see `SECURITY.md`).

## State management

- **React Query**: all server state. Query keys mirror contract resources, e.g.
  `['orders', 'me', {status}]`, `['merchants', id]`, `['orders', id, 'track']`.
  Mutations use `Idempotency-Key`; on 409/`CONFLICT` refetch detail (server state wins).
- **Zustand** (client-only state): session tokens (mirrored to SecureStore), selected city,
  cart line items (client-side preview only — totals always recomputed server-side),
  UI flags (theme, reduced motion). Never store money totals trusted for payment.

## API client

- Generated from `backend/API-CONTRACT.yaml` (openapi-typescript or similar): typed request/response
  schemas, endpoint paths, query params. No hand-written endpoints.
- Shared `apiFetch` wrapper: adds `Authorization: Bearer <access>`, `Idempotency-Key` on mutations,
  `X-Request-ID`; normalizes errors to `{ code, message, requestId }` (`ErrorResponse`).
- One `refetchOnError` + token refresh queue: on `401`/`SESSION_EXPIRED` call
  `POST /auth/refresh` once, replay the request; on refresh failure → logout.
- Pagination: cursor-based `?limit=20&cursor=<opaque>`; lists expose "load more".

## Environment configuration

| Variable | Purpose |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | Base URL; dev = local MSW or staging, prod = configured staging/prod API |
| `EXPO_PUBLIC_ENV` | `development` / `staging` / `production` (drives eas.json profile) |
| `EXPO_PUBLIC_APP_LINKS` | Store/support links — never hardcoded in code |

- No secrets in `EXPO_PUBLIC_*` (values are bundled). Server credentials never ship.
- Dev mode: MSW intercepts every request and serves fixtures generated from the contract so the
  app runs offline against mocked data; parity is enforced by contract tests (`TESTING.md`).
- All API URLs, phones, emails, and store links are environment-driven; code contains no literals.

## Money and dates

- Money: integer TZS (`priceTZS`, `totalTZS`). Display via `Intl.NumberFormat('en-TZ')`-style
  grouping → `TZS 12,500`. Never floats.
- Timestamps: UTC ISO 8601 from API; render local time via i18next-formatted date helpers.

## Planned platform notes

- **Social login** (Google/Facebook) = planned; phone OTP is the primary identity path.
- **Natural-language search** ("my sink is leaking") = planned; keyword/category search is live.
- **PWA**: the customer surface is a mobile app; a responsive web/PWA build is planned for later phases.

## Service discovery depth

Service categories expose **sub-categories and specializations** (Electrical → Wiring / Lighting / Panel Upgrades) from the `ServiceCategoryConfig` tree; discovery filters by price range, rating, availability, response time, and certifications.
