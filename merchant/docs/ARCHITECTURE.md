# HUDumika Merchant — Architecture

## Repository layout

The earlier "proposed" split (`apps/mobile` + `apps/web` Vite app + `api-client`/`auth`/`i18n`/`ui` packages) is superseded: the merchant product ships as a single Expo codebase, with the web surface produced by Expo's static web export of the same app. `packages/` at the workspace root holds only `contract` (types, generated once from `backend/API-CONTRACT.yaml`) and `tokens` (design tokens, DESIGN-SYSTEM.md).

```
merchant/
  app/                     # single Expo app (mobile + static web export)
  docs/                    # this documentation set
```

## App project layout

```
merchant/app/
  src/
    app/                   # expo-router file-based routes
      _layout.tsx          # providers (session, events/socket, offline bars, toasts)
      index.tsx            # splash → /dashboard or /login
      (auth)/login.tsx     # OTP sign-in
      (auth)/register.tsx  # onboarding wizard (profile → documents → submit)
      (tabs)/              # 7 bottom tabs (see NAVIGATION.md deviation note)
        dashboard/         # business health, analytics, finance, messages, risk
        orders/            # incoming queue → detail → accept/advance/cancel
        products/          # catalogue, combos, menus, templates
        marketing/         # deals, promotions, coupons, flash sales
        store/             # tables, bills, inventory, staff, devices, chain
        ops/               # shifts, attendance, approvals, tasks, webhooks
        profile/           # account, verification, finance, settings, support
      (tabs)/profile/verification.tsx  # onboarding/verification status screen
    api/       # HTTP client (retries/backoff, refresh-on-401), event long-poll, WebSocket, offline queue
    store/     # zustand stores per module (session, orders, finance, …)
    i18n/      # en/sw/ar key bundles + formatting (src/i18n/index.ts)
    components/  # shared design-system kit (ui.tsx etc., DESIGN-SYSTEM.md)
    mock/      # MSW handlers mirroring API-CONTRACT.yaml (dev only)
  tests/       # node:test suites + MSW parity/contract suites (tests/run.mjs)
  eas.json     # EAS profiles + channels + per-env env
```

Web builds from the same tree: `npm run build` (`expo export --platform web`, static `dist/`) — there is no separate Vite project.

## Shared module contracts

| Module | Responsibility | Notes |
| --- | --- | --- |
| `api/client.ts` | Typed fetch wrapper, base URL from `EXPO_PUBLIC_API_URL`, retries/backoff/timeouts/idempotency, 401 → refresh → retry-once, error normalization (`code`, `message`, `requestId`, `retryAfterSeconds`) | Typed against `@hudumika/contract`; mock and live share the same client |
| `store/session.ts` | `Session` (accessToken, refreshToken, me), attach bearer header, refresh on 401, restore from keychain on boot | Native: expo-secure-store; web: sessionStorage; never in plain state outside memory |
| `store/*` | Per-module zustand stores (orders, finance, catalogue, …) | Server state lives in stores, not a query library |
| `i18n/index.ts` | Locale resolution (`en`, `sw`, `ar`), key bundles, money/date formatters | `en` ships first; `sw`/`ar` keys present but can fall back to `en` |
| `components/ui.tsx` | Shared components from DESIGN-SYSTEM.md (Button, Card, Form field, Status pill, Toast, Empty/Error/Retry, Stars, BilingualPill, …) | One kit for mobile and web surfaces |

## Navigation map

```
auth (request-otp → verify-otp → Session)
  └─ onboarding wizard (register.tsx) → profile/verification
       ├─ pending / documents_review → status + documents checklist (polls while pending)
       ├─ changes_requested → re-submission
       ├─ rejected / suspended → reason + support
       └─ approved → commercial terms card → dashboard
            ├─ dashboard (business health, open orders, quick stats)
            ├─ orders (incoming queue → detail → accept/advance/cancel)
            ├─ products (catalogue, availability, publish)
            ├─ marketing (promotions, coupons, deals)
            ├─ store (tables, bills, inventory, staff, devices)
            ├─ ops (shifts, attendance, approvals, tasks)
            └─ profile (account, verification, settings, support)
```

Route guard: while `verification.status` is not `approved`, a banner on the dashboard links to the verification screen, and register-submission lands there directly; the tabs themselves are not hard-locked (soft gate — the hard tab-lock is a tracked ROADMAP P1 follow-up). Verification entry points: `dashboard` under-review banner, `profile → Store verification`, and `register.tsx` after submit.

## State management

- Server state: per-module zustand stores; the app hydrates stores at boot, then keeps them live via server events (long-poll + WebSocket, `src/api/events.ts` / `src/api/socket.ts`) and explicit refetch after mutations. No TanStack Query.
- Auth state: `store/session.ts` (zustand) + `api/client.ts` refresh-on-401; restore from keychain on app boot.
- Client-only UI state: local component state; money and statuses always derived from server responses, never stored as floats.
- Event signal source: `order.*`, `notification.created`, `chat.message`, `campaign.updated`, `task.updated`, `payment.captured`/`settlement.created`/`ledger.updated` events update the stores in place (`src/app/_layout.tsx`); there is no interval polling of an orders list and no refetch-on-focus. The verification screen polls `GET /onboarding/status` every 10 s while pending; bulk-ops screens poll their job status while a job runs.

## Environment configuration

| Variable | Surface | Purpose |
| --- | --- | --- |
| `EXPO_PUBLIC_API_URL` | both | Base URL for the API (dev/staging/prod, environment-driven; never committed) |
| `EXPO_PUBLIC_ENVIRONMENT` | both | `development` / `staging` / `production` switch; `production` hard-gates mocks off (`src/mock/switches.ts`) |
| `EXPO_PUBLIC_MOCK_*` | both dev | One per-module MSW switch (default ON in dev), master `EXPO_PUBLIC_MOCK_ALL`; mocks never load in production builds |
| `MOCK_PORT` | native dev | Mock-gateway port for `npm run mock:gateway` (default 3001) |

MSW parity rule: dev mocks must reproduce endpoint paths, statuses, error codes, and schemas from `backend/API-CONTRACT.yaml`; contract-test suite (see TESTING.md) guards the parity.

## Cross-cutting

- All timestamps from API are UTC ISO 8601; render local time via i18n formatter.
- All money fields are `*TZS` integer minor units; format with thousands separators (`TZS 12,500`).
- Pagination is mixed by design: statements use size-limited queries (`/payouts/me/statement?size=100`), chat/notification surfaces paginate, and most list screens fetch the full collection client-side; the "cursor everywhere" wording of earlier drafts is dropped.
