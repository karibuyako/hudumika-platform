# Hudumika Provider App (`@hudumika/provider`)

Provider mobile app — the supply-side operating system for skilled-service businesses: service catalog, availability, job marketplace, booking execution, technician team, earnings and payouts. Built by Team 3 per `provider/INSTRUCTIONS.md`, mirroring the `rider-mobile/app` house pattern exactly. Expo SDK 57 (managed), React Native 0.86, TypeScript strict, expo-router, zustand.

## Stack

- **Routing/auth gate:** expo-router SDK 57 `Stack.Protected` (anon → onboarding → authed), role-guarded by provider `VerificationState`.
- **Data layer:** repository interfaces (`src/repos/index.ts`) — screens import the interface only.
  Mock (`src/repos/mock/*`, fixture-backed, deterministic seed `20260813`) vs live
  (`src/repos/api/*`, thin clients over `src/api/client.ts`) switched by the env vars below in `src/repos/factories.ts`.
- **State:** zustand in-process stores (`src/store/session.ts`, `jobs.ts`, `network.ts`). Server state is the truth — status transitions render the server-returned `Booking`, never optimistic UI.
- **Design:** `@hudumika/tokens` semantic tokens (`src/constants/theme.ts`), Plus Jakarta Sans (UI), Space Grotesk (display/earnings), brand `#1a5c44`. Light-only.
- **i18n:** lightweight dict `en` + `sw` in `src/i18n/index.ts` with `t()`; money via `formatTZS` (integer TZS minor units only, totals server-computed).
- **HTTP:** `src/api/client.ts` — timeout, bounded retries, `Idempotency-Key` header, offline mutation queue (`src/api/queue.ts`). Relative paths only; base comes from `EXPO_PUBLIC_API_URL`.

## Commands

`npm ci` at `provider/app` installs everything — the app has its own `package-lock.json` (workspace deps `@hudumika/contract`, `@hudumika/tokens` are installed as file deps; no root workspaces entry needed).

```sh
npm install        # or npm ci — installs deps (own lockfile)
npm run start      # expo dev server
npm run web        # web dev (mocks on)
npm run typecheck  # tsc --noEmit (strict, noUnusedLocals/Parameters)
npm test           # contract tests (esbuild → node --test)
npm run lint       # expo lint (flat config, eslint-config-expo)
```

## Environment variables

All config is `EXPO_PUBLIC_*` only — no secrets, no hardcoded URLs. Copy `.env.example` to `.env` for local runs. Full registry: `../docs/ENV-VARS.md`.

| Var | Default | Gates |
| --- | --- | --- |
| `EXPO_PUBLIC_ENV` | `development` | Runtime env tag (development/staging/production) |
| `EXPO_PUBLIC_API_URL` | `http://localhost:8081` | API base URL for `src/api/client.ts` / `queue.ts` (trailing `/` stripped) |
| `EXPO_PUBLIC_MOCK_AUTH` | `true` | auth + session repos |
| `EXPO_PUBLIC_MOCK_PROFILE` | `true` | provider + availability repos |
| `EXPO_PUBLIC_MOCK_BOOKINGS` | `true` | bookings machine repo |
| `EXPO_PUBLIC_MOCK_DISPATCH` | `true` | marketplace + dispatch repos |
| `EXPO_PUBLIC_MOCK_SERVICES` | `true` | catalog + services repos |
| `EXPO_PUBLIC_MOCK_TECHNICIANS` | `true` | technicians + staff repos |
| `EXPO_PUBLIC_MOCK_EARNINGS` | `true` | earnings + payouts repos |
| `EXPO_PUBLIC_MOCK_NOTIFICATIONS` | `true` | notifications repo |
| `EXPO_PUBLIC_MOCK_SUPPORT` | `true` | support tickets repo |
| `EXPO_PUBLIC_MOCK_CATALOG` | `true` | inventory/contracts/plans/trust/copilot repos |

Mock switches default ON in dev (unset = `true`), forced OFF in preview and production EAS builds — mock code never ships (CI asserts on `provider/**`).

## Mock fixtures

`src/repos/mock/mockState.ts` holds seeded in-memory state so demos feel real: `setFixturesSeed(20260813)` at load, deterministic faker fixtures from `@hudumika/contract/fixtures`, `resetMockState()` to restore between tests/demo sessions. Mocks mirror contract paths and error codes 1:1 (`401 OTP_INVALID`, `409 BOOKING_STATUS_CONFLICT`, `409 JOB_OFFER_EXPIRED`, `429 RATE_LIMITED` with `retryAfterSeconds`, `403 CAPABILITY_FORBIDDEN`).

## Tests

`node:test` via `tests/run.mjs` (esbuild bundle → `node --test`). `npm test` runs the full suite; `npm run test:contract` runs just `tests/provider-contract.test.ts`. The contract suite drives the mock repositories with `resetMockState()` in `beforeEach`, asserts `ApiError` status + code, and checks money as integers.

## Structure

```
src/app/          expo-router routes: (auth) OTP login, (onboarding) application,
                  (tabs) home | jobs (marketplace, calendar, [bookingId], quotes,
                  invoice, parts, proof, warranty) | earnings | profile
                  (staff, technicians, dispatcher, catalog, inventory, contracts,
                  plans, trust, copilot, notifications, support, tickets, settings)
src/repos/        index.ts (interfaces) → mock/* (fixture impls) → api/* (live) → factories.ts
src/store/        session.ts, jobs.ts, network.ts (zustand)
src/api/          client.ts, queue.ts, types.ts (hardened transport, ApiError)
src/components/   ui.tsx + domain components (OfferCard, BookingCard, StatusPill, ...)
src/i18n/         en + sw dicts, t(), formatTZS
tests/            run.mjs + provider-contract.test.ts
```

## EAS profiles

`eas.json` defines `development` (dev client, mocks on), `preview` (internal, live staging API, mocks off), `production` (store build, live API, mocks off). Channels: development / preview / production.

## Security

Tokens live in `expo-secure-store` (`src/lib/tokenStore.ts`) on native; web falls back to sessionStorage. Access + refresh tokens are stored; on `401` the hardened client refreshes once via `POST /auth/refresh` and retries, then force-logouts (`src/api/client.ts`). Logout calls `POST /auth/logout` then wipes storage. Never log tokens; masked customer contact (`+255 ••• ••• •89`). Sessions are role-scoped — switching role re-verifies OTP (`purpose: verify_role`, see Settings → role switch).

## Resilience & a11y

- **Reduce motion**: the OS reduce-motion setting (read in `src/app/_layout.tsx`) gates modal animations and haptics (`src/lib/motion.ts`).
- **Push**: registration runs at login and degrades gracefully (`src/lib/push.ts`) — no push-token endpoint exists in the contract yet (Team 6 gap), so the token stays client-side and in-app polling keeps the notification center live.
- **Offline**: mutations made offline are queued (`src/api/queue.ts`) and replayed with their idempotency keys on reconnect.
- **Geofence check-in**: `provider_arrived` uses `POST /bookings/{id}/check-in` with the device position; `409 CHECK_IN_NOT_ALLOWED` surfaces the position hint plus a manual fallback.

## Contract-first

No invented endpoints — every path exists in `backend/API-CONTRACT.yaml` and is relative (base from `EXPO_PUBLIC_API_URL`). Team 6 gaps, tracked mock-only until the contract lands: `GET /reviews/me` (received reviews), reschedule endpoint, `commissionRateBps` on `ProviderPrivate`, `tradeRequirements`, `booking.followup`, push-token registration (see `provider/docs/ROADMAP.md`).

## Docs

Spec and milestone details live in `../docs/` (start: `README.md` → `NAVIGATION.md` → `PRODUCT.md` → `ROADMAP.md`). The API contract is the single source of truth for paths and DTOs.
