# HUDumika Provider — Deployment

Deployment for both surfaces: Expo builds (mobile) and Vite build/deploy (web dashboard). Environments and URLs are environment-driven — never hardcoded.

## Environments

| Environment | API base | Purpose |
| --- | --- | --- |
| `development` | MSW on (no API needed) | Local dev, contract mocks |
| `staging` | `staging-api.hudumika.co.tz/api/v1` (per contract servers) | Pre-release testing against staging backend |
| `production` | `api.hudumika.co.tz/api/v1` (per contract servers) | Live |

- Mobile: `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_ENV` (EAS profiles).
- Web: `VITE_API_URL`, `VITE_ENV` (`.env.*` files, committed example only — no secrets).

## Mobile (Expo / EAS)

| Step | Command / config |
| --- | --- |
| Configure | `eas.json` profiles: `development` (dev client), `preview` (internal distribution), `production` (store build) |
| Build | `eas build --platform android|ios` (cloud build, versioned per app store) |
| Submit | `eas submit` (Play Console / App Store Connect credentials via EAS) |
| Push | Expo project config; push tokens registered at login (NOTIFICATIONS.md) |
| Rollback | Store-only: publish a previous build; never push a rollback via OTA for money/booking flows |

Rules: no OTA updates to code that touches booking state machines or money rendering (Expo updates limited to non-critical assets/copy); releases ship when contract tests are green against staging (see TESTING.md).

## Web (React + Vite)

| Step | Command | Notes |
| --- | --- | --- |
| Build | `npm run build` (tsc -b && vite build) | Static assets to `dist/` |
| Preview | `npm run preview` | Local prod check |
| Deploy | Static host (platform of choice), env vars at build time | CDN-friendly: hashed assets, cache headers |
| Env per deploy | `VITE_API_URL` per environment | Rebuild per env; never bake staging URLs into prod bundles |
| MSW | Excluded from production builds | Worker + handlers never ship |

Deploy flow: CI builds per environment, runs contract + unit tests, deploys to staging first, then production. Rollback: redeploy the previous release tag (static hosting makes this instant); keep `dist/` artifacts per release.

## Store releases (mobile)

1. Internal test (`preview`) → QA on real devices (push, foreground/background, secure-store, location).
2. Store track (Play internal / TestFlight) with the same build that was QA'd.
3. Production rollout; monitor crash/error rates and payout-related error codes.
4. Rollback path: Play (pause rollout / revert) and App Store (expire builds / release previous) — coordinated with web + backend deploys.

## Release checklist

- Contract test suite green against staging.
- No MSW in production bundles; no debug endpoints.
- `EXPO_PUBLIC_*` / `VITE_*` point at the environment's API; support contacts come from env config, never code.
- Store metadata (icons, screenshots, privacy labels for location/push) current.
- Backend + web + mobile release notes coordinated for booking/payout changes (statuses, error codes).
