# Hudumika Rider App (`@hudumika/rider`)

Rider mobile app — dispatch flow, delivery flow, earnings, shift management, safety.
Expo SDK 57 (managed), React Native 0.86, TypeScript strict, expo-router, zustand.

## Stack

- **Routing/auth gate:** expo-router SDK 57 `Stack.Protected` (anon → onboarding → authed).
- **Data layer:** repository interfaces (`src/repos/index.ts`) — screens import the interface only.
  Mock (`src/repos/mock/*`, fixtures-backed, deterministic seed `20260813`) vs live
  (`src/repos/api/*`) switched by the env vars below in `src/repos/factories.ts`.
- **State:** zustand in-process stores (`src/store/session.ts`, `jobs.ts`, `network.ts`).
  Server state is the truth — status transitions render the server-returned `Order`, never optimistic UI.
- **Design:** `@hudumika/tokens` semantic tokens (`src/constants/theme.ts`), Plus Jakarta Sans (UI),
  Space Grotesk (display/earnings). Light-only.
- **i18n:** lightweight dict `en` + `sw` in `src/i18n/index.ts` with `t()`; money via `formatTZS`
  (integer TZS minor units only).
- **HTTP:** `src/api/client.ts` — timeout, bounded retries, idempotency-key header, offline queue
  (`src/api/queue.ts`, capped 200, FIFO replay). Relative paths only; the client prepends `/api`.

## Commands

```sh
npm install        # install deps (workspace deps: @hudumika/contract, @hudumika/tokens)
npm run start      # expo dev server
npm run web        # web dev (mocks on)
npm run typecheck  # tsc --noEmit (strict)
npm test           # contract + unit tests (esbuild → node --test)
npm run lint       # expo lint (flat config)
```

## Mock switches (default ON in dev)

| Env var | Controls | Default |
| --- | --- | --- |
| `EXPO_PUBLIC_MOCK_AUTH` | auth + rider profile repos | `true` |
| `EXPO_PUBLIC_MOCK_JOBS` | dispatch, delivery, notifications repos | `true` |
| `EXPO_PUBLIC_MOCK_EARNINGS` | earnings, payouts, ledger repos | `true` |
| `EXPO_PUBLIC_MOCK_SUPPORT` | support tickets repo | `true` |
| `EXPO_PUBLIC_MOCK_SAFETY` | safety repo (SOS, contacts, security, trip share) | `true` |
| `EXPO_PUBLIC_MOCK_VEHICLE` | vehicle tools repo (maintenance, expenses, goals, exports, training) | `true` |
| `EXPO_PUBLIC_MOCK_TRIPS` | batch-trips repo (active trip, detail, stop reorder) | `true` |

Set `EXPO_PUBLIC_API_URL` to a live backend (e.g. `https://staging-api.hudumika.co.tz/api/v1`) and
flip the mocks to `false` to run against real APIs. Mock switches are forced off in EAS
preview/production builds — never ship a build with mocks on.

## Background location

`src/lib/locationTask.ts` registers the `hudumika-rider-location` task at app launch
(`defineTask` at module scope, imported by `src/app/_layout.tsx`). `src/lib/location.ts`
controls the lifecycle — starts on offer acceptance or going online, stops when the last
active delivery ends, the rider goes offline, or on logout. Native-only (lazy imports
no-op on web / in tests): Balanced accuracy, 10 s interval, pauses while stationary,
`LOCATION_RATE_LIMITED` (429) backs off silently. Permission strings live in the
`expo-location` plugin in `app.json`.

## Auth & security

Access/refresh tokens live in `expo-secure-store` (`src/api/tokenStore.ts`) — never
AsyncStorage/localStorage on native. The client (`src/api/client.ts`) rotates via
`POST /auth/refresh` on 401 (single-flight, one retry) and wipes the session if refresh
fails; every error carries `code`, `message`, and `requestId` for support tickets.

## Notifications

In-app notifications ship today (`GET /notifications/me` via `src/repos/notifications.ts`):
the list screen (`(authed)/notifications.tsx`) renders order/earnings/system/warning events
with unread dots, tap-to-open (deep links resolve to `/orders/*`, `/ticket/*`, `/earnings`),
and mark-all-read; the Home header bell shows the unread badge and refetches on focus.
The event → UI mapping lives in `../docs/NOTIFICATIONS.md`.

Push (expo-notifications) is **planned, not implemented** — ship checklist, per
`NOTIFICATIONS.md`: register the device token after login and refresh it on every login
(tokens stored per user server-side); request permission only after an in-app explainer
(assignments, order status, payout failures) with a settings-screen fallback; retry token
registration with backoff and degrade gracefully (in-app pull still works). Until push
ships, the same events arrive as in-app notifications.

## Store release guardrails

Per `../docs/DEPLOYMENT.md` before submitting to stores: privacy labels must document
location (foreground + background during delivery) and push notifications; reviewer-facing
demo mode (MSW or staging channel) must never leak real credentials; no real money actions
in review builds — the `EXPO_PUBLIC_MOCK_*` switches are asserted off for
preview/production in `tests/eas-mocks.test.ts` (CI), and production points at
`https://api.hudumika.co.tz`.

## EAS profiles

`eas.json` defines `development` (dev client, mocks on), `preview` (internal, live API),
`production` (store build, live API). Channels: development / preview / production.
Version in `app.json` is semver — bump with each release.

### Monorepo build rules (EAS)

- The app is a member of the root npm workspaces (`rider-mobile/app`), so EAS detects the
  workspace and runs `npm ci` at the monorepo **root** — `packages/*` deps (e.g.
  `@faker-js/faker` used by `@hudumika/contract` fixtures) resolve from the root
  `node_modules`.
- After any dependency change, regenerate the **root** `package-lock.json`
  (`npm install` at the repo root), not the app's lock — the app has no nested lockfile.
- `app.json` splash plugin requires an `image` (the plugin emits a `splashscreen_logo`
  drawable reference that fails `processReleaseResources` if absent).
- EAS `expo-doctor` may report duplicate `react`/`react-dom` (hoisted from sibling
  workspaces); non-blocking, builds succeed.
- On-device verification (background location, push) still requires a physical device.

## Docs

Spec and milestone details live in `../docs/` (start: `README.md` → `PRODUCT.md` →
`ARCHITECTURE.md` → `DISPATCH-FLOW.md` → `DELIVERY-FLOW.md` → `EARNINGS.md` → `SECURITY.md`).
The API contract (`backend/API-CONTRACT.yaml`) is the single source of truth for paths and DTOs.
