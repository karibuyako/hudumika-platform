# Provider (Team 3)

Provider web + mobile apps — service catalogue, availability, bookings, contracts & SLA, earnings, technicians, materials & inventory, monetization.

## Handoff

Copy this folder to start the team repo. Full product specification in `docs/` (start with `README.md` → `PRODUCT.md` → `MASTER-BLUEPRINT.md` → `BOOKING-FLOW.md`).

## Stack (per platform plan)

- Web: React (Vite) + `@hudumika/contract` + MSW mocks
- Mobile: React Native / Expo
- Repo name: `app-provider`

## Dependency on the contract

Install `@hudumika/contract` from the private registry. While unpublished, develop against this monorepo workspace:

```sh
npm install   # at the Hudumika Platform root — exposes the workspace package
```

Use MSW mocks in dev for the web app; the mobile app uses the repository-interface pattern with `@hudumika/contract/fixtures` — see `docs/MOBILE-MOCK-PATTERN.md`. Flip each endpoint to the live API as Team 6 delivers it.

## Deliverables

1. Auth: OTP login (mock) + role guard
2. Service catalogue + availability calendar (MVP)
3. Booking accept/decline + schedule
4. Earnings + payout status
5. Technician roster + materials inventory (v2)

See `docs/ROADMAP.md` for the full sequence.