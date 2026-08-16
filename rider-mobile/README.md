# Rider Mobile (Team 4)

Rider mobile app — dispatch flow, delivery flow, long-haul relay, earnings, performance, penalties & appeals, vehicle tools, navigation.

## Handoff

Copy this folder to start the team repo. Full product specification in `docs/` (start with `README.md` → `PRODUCT.md` → `MASTER-BLUEPRINT.md` → `DISPATCH-FLOW.md`).

## Stack (per platform plan)

- Mobile: React Native / Expo
- Repo name: `app-rider-mobile`

## Dependency on the contract

Install `@hudumika/contract` from the private registry. While unpublished, develop against this monorepo workspace:

```sh
npm install   # at the Hudumika Platform root — exposes the workspace package
```

Typed client + mock repositories behind an interface. **The pattern is built and documented: `docs/MOBILE-MOCK-PATTERN.md` at the platform root, with ready-made fixtures in `@hudumika/contract/fixtures`** (dispatchable orders, completed orders, rider profile, wallet — faker-only, deterministic via `setFixturesSeed`). Swap each repository to the real API (`EXPO_PUBLIC_MOCK_*` env vars) as Team 6 delivers it.

## Deliverables

1. Auth: OTP login (mock) + shift onboarding
2. Dispatch acceptance + pickup flow
3. Delivery flow with route legs + handoffs (relay)
4. Earnings dashboard
5. Vehicle tools + penalties/appeals (v2)

See `docs/ROADMAP.md` for the full sequence.