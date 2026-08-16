# Merchant (Team 2)

Merchant web + mobile apps — catalogue/menu management, orders, payments, promotions, staff & devices, analytics, multi-store, enterprise features.

## Handoff

Copy this folder to start the team repo. It contains the full product specification in `docs/` (start with `README.md` → `PRODUCT.md` → `MASTER-BLUEPRINT.md` → `ORDER-FLOW.md`).

## Stack (per platform plan)

- Web: React (Vite) + `@hudumika/contract` + MSW mocks
- Mobile: React Native / Expo
- Repo name: `app-merchant`

## Dependency on the contract

Install `@hudumika/contract` from the private registry. While it is unpublished, develop against this monorepo workspace:

```sh
npm install   # at the Hudumika Platform root — exposes the workspace package
```

Use MSW mocks in dev for the web app; the mobile app uses the repository-interface pattern with `@hudumika/contract/fixtures` — see `docs/MOBILE-MOCK-PATTERN.md`. Flip each endpoint to the live API as Team 6 delivers it.

## Deliverables

1. Auth: OTP login (mock) + role guard
2. Catalogue & menu management (MVP)
3. Order receive/accept flow with live updates
4. Earnings + payout status
5. Promotions builder (v2)

See `docs/ROADMAP.md` for the full sequence.