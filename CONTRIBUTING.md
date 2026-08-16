# Contributing to Hudumika Platform

## Repo layout

Seven product teams, one monorepo — each owns a folder:

| Folder | Team | Stack |
| --- | --- | --- |
| `consumer-mobile/` | Team 1 (consumer) | React Native / Expo |
| `merchant/` | Team 2 (merchant) | React (web) + React Native / Expo (mobile) |
| `provider/` | Team 3 (provider) | React (web) + React Native / Expo (mobile) |
| `rider-mobile/` | Team 4 (rider) | React Native / Expo |
| `admin-web/` | Team 5 (admin) | Vite + React 19 |
| `backend/` | Team 6 (API) | OpenAPI 3.1 + Go (chi) |
| `public-frontend/` | Team 7 (marketing) | Vite + React 19 + Tailwind 4 |

Shared: `packages/contract/` (generated TS client + MSW mocks + fixtures, owned by Team 6), `packages/tokens/` (design tokens), `docs/` (product + platform conventions).

## Contract-first rule

`backend/API-CONTRACT.yaml` is the single source of truth for every API. It feeds the generated client (`@hudumika/contract`), the MSW mocks, and the Go service.

- **Never invent endpoints** in app code, and never call a URL that is not in the contract.
- New or changed API? Propose the contract change first → Team 6 gates it → bump the package version + `CHANGELOG.md` entry (`packages/contract/CHANGELOG.md`) → regenerate (`npm run generate:contract` at root) → commit the generated output.
- Contract paths are relative — see `docs/API-BASE-CONVENTION.md` before touching URLs.

## Branches and PRs

- Short-lived branches off `main`; one PR per concern.
- Every PR must pass CI. The gate is five workflows (`.github/workflows/`):

| Workflow | Runs on | Checks |
| --- | --- | --- |
| `contract.yml` | `backend/API-CONTRACT.yaml`, `packages/contract/**` | regen client → `git diff --exit-code` → typecheck |
| `backend.yml` | `backend/**` | `go vet` + `go test` |
| `public-web.yml` | `public-frontend/**` | typecheck + build |
| `admin-web.yml` | `admin-web/**` | typecheck + build |
| `rider.yml` | `rider-mobile/**` | typecheck + tests |

- Ask a reviewer, not a branch: merge via PR, no direct pushes to `main`.

## Mock-first development

No backend needed to build features:

- Web: MSW mocks from `@hudumika/contract/mocks` (or app-local handlers), controlled by `VITE_USE_MOCKS` / `VITE_MOCK_*`.
- Native: fixture repositories via `@hudumika/contract/fixtures`, switched by `EXPO_PUBLIC_MOCK_*` (see `docs/MOBILE-MOCK-PATTERN.md`).
- Develop against mocks, flip to the live API per endpoint as Team 6 delivers it — never delete the mock path.

## Design system

All UI **must** use tokens from `@hudumika/tokens` (web `index.css` custom properties / native JS tokens) — no ad-hoc hex codes. Token names, values, and usage: `packages/tokens/README.md`; visual contract: `docs/DESIGN-SYSTEM.md`.

## Money

All money is **TZS in integer minor units** (1 TZS = 1 unit) — never floats, never doubles. The contract encodes this in every money field (`*TZS`).

## Environment variables

- Web: `VITE_*`; native: `EXPO_PUBLIC_*`; backend: plain names. Mock switches: `VITE_USE_MOCKS` (web) / `EXPO_PUBLIC_MOCK_*` (native).
- Register any new variable in `docs/ENV-VARS.md` and the relevant `.env.example` in the same PR. See `docs/ENV-VARS.md` for the full registry and rules.

## Definition of done

- Typecheck passes, tests pass, CI is green on the branch.
- No dead code: no unused mocks, unused exports, or commented-out blocks.
- New env vars registered, contract changes versioned + regenerated + committed.
