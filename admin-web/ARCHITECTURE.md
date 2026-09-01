# HUDumika Admin Web — Architecture

React + Vite + TypeScript, matching the public web stack so the design system and component conventions carry over.

## Repository layout

```text
admin-web/
├── app/
│   ├── src/
│   │   ├── main.tsx
│   │   ├── Shell.tsx           # layout + topbar + nav + session refresh
│   │   ├── router.tsx          # createBrowserRouter, lazy features/*, 404
│   │   ├── pages/              # ControlTowerPage, OrdersPage, DispatchConsolePage
│   │   ├── features/           # one folder per module (35 modules, see MODULES.md)
│   │   ├── components/         # DataTable, DetailDrawer, MaskedField, ErrorState, etc.
│   │   ├── lib/                # money.ts (formatTZS), time.ts (toLocal), api-error.ts, permissions.ts, api-base.ts, session.ts
│   │   ├── mocks/              # browser.ts — setupWorker(getHudumikaMocks())
│   │   ├── styles.css
│   │   └── test/               # setup.ts, parity.test.ts
│   ├── vite.config.ts          # proxy target via VITE_ADMIN_API_URL or Railway prod
│   └── vitest.config.ts
```

## Key conventions

| Concern | Approach |
| --- | --- |
| Data fetching | Generated contract client (`@hudumika/contract`) via `fetch` + `useEffect`/`useCallback`; polling via `useServerEvents` + `useRefetchOnFocus`; retries via `ErrorState` + retry key |
| Global state | React state + `useSession`/`localStorage` for auth; local component state for filters/drawer — no Zustand |
| Routing | `react-router` `createBrowserRouter` with `Shell` layout; lazy `features/*` pages + `ErrorBoundary` + 404 `NotFoundPage` |
| Tables | Shared `DataTable`: column config, row actions, cursor pagination (server), export via `lib/csv` |
| Detail views | Drawer panels with the entity timeline (events) and action buttons |
| Mutations | Optimistic off; show loading → success/error toast; reason input on money/status/moderation actions |
| Masking | `MaskedField` component — unmask button only when permission grants it |
| API client | Generated from `backend/API-CONTRACT.yaml` (same source as every client); live base via `VITE_ADMIN_API_URL` patched in `src/lib/api-base.ts` (`installApiBaseFetch`) |
| MSW | Dev-mode mocks via `getHudumikaMocks()` (`src/mocks/browser.ts`); MSW parity tests |

## Environments

- `VITE_ADMIN_API_URL` per environment; never hardcoded in app code (vite proxy + `api-base.ts` patch read it).
  - dev: empty (same-origin) + `VITE_USE_MOCKS=true`, MSW via `@hudumika/contract/mocks`.
  - staging: `https://staging-api.hudumika.co.tz/api/v1` + `VITE_USE_MOCKS=false`.
  - production: `https://hudumika-api-production.up.railway.app/api/v1` (Railway) + `VITE_USE_MOCKS=false`.
- Separate staging vs production hostnames; staging uses staging admin API with seeded data.
- Feature flags: route-level flags for modules not yet backed by the API.

## Non-goals

- No marketing pages, no public routes, no payment processing.
- No direct DB access — everything through `/admin/*` API.
