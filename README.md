# Hudumika Platform

Monorepo for the Hudumika platform. Each team owns a folder — copy that folder to hand off work.

## Team map

| Folder | Team | Product | Stack |
| --- | --- | --- | --- |
| `public-frontend/` | Marketing | Public marketing site | Vite + React 19 + Tailwind 4 + MSW |
| `backend/` | Team 6 | API — contract + Go service | OpenAPI 3.1 + Go 1.22 (chi) + Postgres + Redis |
| `admin-web/` | Team 5 | Admin operations web | Vite + React 19 + generated client + MSW |
| `merchant/` | Team 2 | Merchant web + mobile | React (web) + React Native / Expo (mobile) |
| `provider/` | Team 3 | Provider web + mobile | React (web) + React Native / Expo (mobile) |
| `consumer-mobile/` | Team 1 | Consumer mobile | React Native / Expo |
| `rider-mobile/` | Team 4 | Rider mobile | React Native / Expo |
| `packages/contract/` | Team 6 | Generated TS client + MSW mocks from the contract | orval |
| `docs/` | — | Shared product docs (plan, research, style, glossary) | — |

## Package registry (dormant)

`@hudumika/contract` (later `@hudumika/ui`, `@hudumika/ui-mobile`) will publish to **GitHub Packages** (`@hudumika:registry=https://npm.pkg.github.com`). Not live yet — frontend teams currently install from this monorepo workspace (`npm install` at root). Consumption details, tsconfig flags, and the per-endpoint mock-switching convention live in `packages/contract/README.md`; the RN pattern is in `docs/MOBILE-MOCK-PATTERN.md`.

## Commands

```sh
npm install                  # link npm workspaces (contract, public-frontend, admin-web/app)
npm run dev:web              # marketing site — localhost:5173
npm run dev:admin            # admin web — localhost:4173 (MSW mocks on)
npm run build:contract       # regen TS client + mocks from backend/API-CONTRACT.yaml, typecheck
npm run build:api && npm run test:api   # Go service
```

Notes on installs:

- `backend/app` is a **Go module, not an npm workspace** — no npm install there (it has its own `go.mod` / `go.sum`).
- `merchant/app` and `rider-mobile/app` are **not** root workspaces either — they have their **own** `npm install` and `package-lock.json` (Expo projects with their own dependency trees).

## The source of truth

`backend/API-CONTRACT.yaml` — OpenAPI 3.1, 464 paths / 249 schemas. Team 6 owns it and gates changes. It feeds:

- `npm run build:contract` → `@hudumika/contract` (typed fetch clients + MSW mocks) — all frontends
- `make -C backend/app gen` → Go types + chi server stubs

Any contract change must be versioned; frontends switch per-endpoint from mocks to the live API (Team 6 delivery order: auth → commerce → services → logistics → admin).

## Handing off a folder to a team

1. Copy the team folder (e.g. `merchant/`).
2. Inside it, the README states the charter, deliverable, and dependencies.
3. The team works in its own repository; `@hudumika/contract` is installed from the monorepo workspace now, from the private registry once it is published.
4. Weekly demo day: each team demoes against MSW mocks / fixture repos first, real API as endpoints land.