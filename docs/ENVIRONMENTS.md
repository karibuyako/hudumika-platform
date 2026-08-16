# Hudumika Environments

Consolidated environment matrix. Source of truth for names: `docs/PLAN.md`,
`docs/ROADMAP.md`, `backend/DEPLOYMENT.md`, `backend/API-CONTRACT.yaml`
(servers block).

## Hostnames

| Environment | API | Admin web | Web (public) | Purpose |
| --- | --- | --- | --- | --- |
| dev | localhost / `dev-api.hudumika.co.tz` | localhost | localhost:5173 | Feature work, MSW parity |
| staging | `https://staging-api.hudumika.co.tz/api/v1` | `staging-ops.hudumika.co.tz` | staging web origin | Integration, contract tests, release candidates |
| production | `https://api.hudumika.co.tz/api/v1` | `ops.hudumika.co.tz` | `hudumika.co.tz` | Live traffic |

Admin surfaces are never linked from public pages and are protected by
network policy (allow-listed IPs/VPN) plus staff MFA.

## Environment × surface matrix

| Surface | dev | staging | production |
| --- | --- | --- | --- |
| Backend (api) | local `docker compose` (in-memory until migrations land), dev OTP code `123456` | `ENV=staging`, real secrets, seeded data | `ENV=production`, provider certs, full observability |
| public-web | `npm run dev`, mocks on | Vite build, staging `VITE_*` | Vite build, prod `VITE_*` |
| admin-web | `VITE_USE_MOCKS=true` (default), MSW | `VITE_USE_MOCKS=false`, staging admin API | `VITE_USE_MOCKS=false`, prod admin API |
| merchant (mobile/web) | dev client (EAS `development`), MSW or mock gateway | EAS `preview` channel, staging API | EAS `production` channel, prod API |
| rider | dev client, mocks ON by default | EAS `preview`, mocks OFF | EAS `production`, mocks OFF |
| consumer | dev client, MSW | EAS `staging`, staging API | EAS `production`, prod API |
| provider | dev client, MSW | staging API | prod API |

## API mode (mock vs live)

| Surface | dev | staging | production |
| --- | --- | --- | --- |
| Backend | in-memory / compose Postgres+Redis | live staging API | live prod API |
| public-web | MSW (leads/services are `/api/*` stubs) | live staging API (leads to backend when shipped) | live prod API |
| admin-web | MSW (default; `VITE_USE_MOCKS=false` opts out) | live staging admin API | live prod admin API |
| merchant | MSW in-browser (web) / mock gateway on `MOCK_PORT` (native) | live staging API | live prod API |
| rider | `EXPO_PUBLIC_MOCK_AUTH/JOBS/EARNINGS` default ON | mocks forced OFF in EAS `preview` | mocks forced OFF in EAS `production` |
| consumer | MSW | live staging API | live prod API |
| provider | MSW | live staging API | live prod API |

Rule: MSW / mock repos are never active in staging or production builds.

## Env vars per app (real names from code)

### Backend (backend/DEPLOYMENT.md config list)

`DATABASE_URL`, `REDIS_URL`, `JWT_SIGNING_KEY`, `OTP_SMS_GATEWAY_*`, `MPESA_*`,
`TIGO_*`, `AIRTEL_*`, `CARD_GATEWAY_*`, `EXPO_PUSH_*`, `S3_*`,
`ADMIN_ALLOWED_IPS`, plus `ENV`/`PORT`/`CORS_ORIGINS` (compose default).

### public-web (public-frontend/src/config)

| Var | Purpose |
| --- | --- |
| `VITE_CUSTOMER_IOS_URL` / `VITE_CUSTOMER_ANDROID_URL` | Consumer app store links |
| `VITE_MERCHANT_IOS_URL` / `VITE_MERCHANT_ANDROID_URL` | Merchant app store links |
| `VITE_PROVIDER_IOS_URL` / `VITE_PROVIDER_ANDROID_URL` | Provider app store links |
| `VITE_RIDER_IOS_URL` / `VITE_RIDER_ANDROID_URL` | Rider app store links |
| `VITE_SUPPORT_CONSUMER_PHONE` / `_EMAIL` | Consumer support contact |
| `VITE_SUPPORT_MERCHANT_PHONE` / `_EMAIL` | Merchant support contact |
| `VITE_SUPPORT_PROVIDER_PHONE` / `_EMAIL` | Provider support contact |
| `VITE_SUPPORT_RIDER_PHONE` / `_EMAIL` | Rider support contact |
| `VITE_COMPANY_LOCATION` | Office/location string |

### admin-web (admin-web/DEPLOYMENT.md + app/src/main.tsx)

| Var | Purpose |
| --- | --- |
| `VITE_ADMIN_API_URL` | Admin API base URL per environment |
| `VITE_USE_MOCKS` | MSW on when unset in dev (`!== 'false'`); always `false` in staging/prod |

### merchant (app/src/api/client.ts, scripts/mock-gateway.ts)

| Var | Purpose |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | API base; empty = same-origin/MSW (web dev); gateway `http://<lan-ip>:3001` for native dev |
| `EXPO_PUBLIC_ENV` | `development` / `staging` / `production` (set in eas.json) |
| `MOCK_PORT` | Mock gateway port (default `3001`) — dev only |

### rider (app/src/api/client.ts, src/repos/factories.ts)

| Var | Purpose |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | API base; empty = same-origin/MSW |
| `EXPO_PUBLIC_MOCK_AUTH` | Auth + rider profile repo: mock (default) vs live |
| `EXPO_PUBLIC_MOCK_JOBS` | Dispatch + delivery repos: mock (default) vs live |
| `EXPO_PUBLIC_MOCK_EARNINGS` | Earnings + payouts repo: mock (default) vs live |

## Data reset policy

| Environment | Policy |
| --- | --- |
| dev | Reset freely; `docker compose down -v` wipes Postgres/Redis; in-memory state dies with the process |
| staging | Seeded dataset; scheduled reset allowed with team sign-off; no real customer data ever |
| production | No automatic reset; mutations only via migration + data tools; backups per RUNBOOKS 2 |

## Promotion path

1. dev: contract tests + MSW parity per client.
2. staging: full integration — contract suites green against staging API, E2E happy paths, 24 h dashboard green (`docs/ROADMAP.md` launch definition).
3. production: tagged image/build promoted; mobile via EAS channel `production` + store submission; rollback per RUNBOOKS 1.
