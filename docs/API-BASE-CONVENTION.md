# API Base URL Convention (binding)

Where the `/api/v1` prefix lives, who owns it, and how every app composes request URLs.

## The rule

1. **Contract paths are RELATIVE** — `backend/API-CONTRACT.yaml` paths have **no** `/api/v1` baked in (e.g. `/auth/request-otp`, `/admin/orders`). The orval-generated client uses these relative URLs as-is; the MSW mock handlers register the same relative paths under an `/api/*` dev-only alias.
2. **The contract `servers` block owns the `/api/v1` prefix** (`https://api.hudumika.co.tz/api/v1`, `https://staging-api.hudumika.co.tz/api/v1`).
3. **The deployed API gateway terminates `/api/v1`** and forwards the remaining relative path to the Go service.
4. **Apps fetch `${API_BASE}${path}`** where:
   - `API_BASE` = origin (`""`) for web apps and for all mock layers (mocks are same-origin).
   - `API_BASE` = `EXPO_PUBLIC_API_URL` for native apps — pointing at the live backend it **includes `/api/v1`**; pointing at the dev mock gateway it is just `http://<host>:3001`.
5. **In-app mock layers MUST intercept the same relative paths the contract defines.** The `/api` mock prefix is a dev-only alias for `/api/v1`; a future alignment task renames mock registrations from `/api/*` to `/api/v1/*` so mocks and live requests share byte-identical paths.

Never add a version segment to a resource name, and never hardcode `/api/v1` into app code — the prefix belongs to the servers block and the gateway.

## Current state (who does what today)

| Layer | Base | Example request | Notes |
| --- | --- | --- | --- |
| Contract paths | relative | `/auth/request-otp` | `backend/API-CONTRACT.yaml` — no version in path |
| Contract `servers` | `/api/v1` | `https://api.hudumika.co.tz/api/v1/auth/request-otp` | Production + staging servers defined |
| orval-generated client | relative | `fetch('/auth/request-otp')` | `@hudumika/contract` — caller prepends `API_BASE` |
| Public web mocks (MSW) | `/api/*` (alias) | `/api/services`, `/api/leads` | `public-frontend/src/mocks/handlers.ts` — relative, same-origin |
| Merchant mock gateway | `http://<host>:3001` | `http://192.168.1.20:3001/orders` | `merchant/app/scripts/mock-gateway.ts`, port via `MOCK_PORT` |
| Native live client | `EXPO_PUBLIC_API_URL` incl. `/api/v1` | `https://api.hudumika.co.tz/api/v1/orders` | `merchant/app` + `rider-mobile/app` `src/api/client.ts` (trailing `/` stripped) |
| API gateway (target) | terminates `/api/v1` | forwards `/orders` to Go service | — |

## Target state

- All mock layers register the contract's relative paths verbatim, under `/api/v1/*`.
- Web apps keep `API_BASE = origin` (same-origin in dev and prod).
- Native apps set `EXPO_PUBLIC_API_URL` to `https://api.hudumika.co.tz/api/v1` in production builds; dev keeps the bare mock gateway host.
- The gateway is the only component that knows the `/api/v1` prefix; app code, mocks, and the Go service all use relative paths.
