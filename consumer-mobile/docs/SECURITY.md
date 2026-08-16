# Customer App — Security

Aligns with `backend/AUTH.md` session rules and the platform security invariants. Client code never
decides permissions (RBAC is server-side on every route).

## Token storage

| Item | Storage | Notes |
| --- | --- | --- |
| `accessToken` (JWT, 15 min) | `expo-secure-store` | Never `AsyncStorage`; never in Redux/Zustand outside memory |
| `refreshToken` (opaque, 30 days) | `expo-secure-store` | Rotation on every refresh (server returns new pair) |
| `requestId` / OTP `requestId` | memory only | Cleared on screen unmount |

- SecureStore values are cleared on logout, session expiry, and app data reset.
- iOS Keychain / Android Keystore backing via SecureStore defaults; no plaintext fallback.
- Access token in memory only while app process lives; on cold start restore from SecureStore.

## Session refresh handling

- Every API call attaches `Authorization: Bearer <access>`.
- On `401` with code `SESSION_EXPIRED` / `UNAUTHORIZED`: one in-flight `POST /auth/refresh`
  (single-flight), replays queued requests, rotates pair, retries once.
- Refresh failure (`REFRESH_TOKEN_REVOKED`): force logout, clear secure store, return to auth.
- `POST /auth/logout` revokes server-side (revoked_at) and clears local tokens + push token.
- Background refresh: on app foreground, refresh if access token near expiry (within ~2 min).

## Role switching

- Source of truth: `GET /users/me/roles` (`RoleSummary[]`).
- Switching to another role (`merchant`/`provider`/`rider`) requires a re-verification OTP
  (`purpose: verify_role` per AUTH.md) → new role-scoped session.
- Sessions never mix data: after switch, cache keys, query state, and navigation are scoped to the
  active role; customer data views are not carried into the other app surface.
- The customer app only renders `customer` sessions; other roles redirect to their own apps.

## Address and location privacy (per SHARED-FLOWS.md)

- Request location permission only after explaining why (copy before system prompt).
- Manual address entry + landmarks always available; geocode into `AddressSnapshot`
  (`label`, `lines`, `landmark`, `lat`, `lon`, `contactPhone`).
- `AddressSnapshot` is stored with the order/booking (snapshot semantics); never silently change
  delivery address after payment.
- Saved addresses are user-owned data; deletion available in Account.
- `lat`/`lon` sent only for the active checkout/tracking context, never in analytics events.

## Payment information handling

- Never log or track `providerReference`, card data, PINs, OTP codes, or full payment payloads
  (PRODUCT.md acceptance criterion).
- Card data is entered on the card processor's page, never stored in the app.
- `PaymentIntent` renders (`amountTZS`, status) only; idempotency keys are not logged.
- Analytics events contain entity ids and statuses only, never money details.

## Deep link validation

- Allowed schemes/routes: `order/{orderId}`, `booking/{bookingId}`, `ticket/{ticketId}`
  (plus generic app root). Nothing else navigates.
- Every deep link target refetches the resource via API (`GET /orders/{id}` etc.) and renders
  `403`/`404` as "not visible" — a link to someone else's order never leaks data.
- Unknown/unmatched links open the app root; no navigation by arbitrary path.
- Push payload `deepLink` values are validated against the same allow-list before navigation.

## Additional invariants

- No hardcoded URLs, phones, emails, or store links — environment-driven config only
  (`EXPO_PUBLIC_API_URL` and similar; see `ARCHITECTURE.md`).
- Certificate/SSL pinning decision owned by backend team; default TLS only.
- `INTERNAL_ERROR` responses are never surfaced raw; map to generic copy with requestId for support.
- Security-related events (login, logout, role switch, payment attempts) are auditable server-side;
  the app never suppresses them.
