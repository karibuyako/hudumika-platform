# Changelog

All contract package changes are versioned by Team 6. Format: version, date, change summary.

## 0.3.0 — 2026-08-20

- Breaking: `POST /auth/verify-otp` now returns `422 ROLE_NOT_ACTIVE` when the requested `role` has no active role row; clients must handle role-not-active vs invalid OTP.
- Breaking: ledger owner mapping fixed — `GET /payouts/me/statement` owner resolution corrected; statement entries now map to the authenticated earner.
- Breaking: barcodes resolver fixed — `/barcodes` merchant resolver returns the correct merchant-owned catalogue items.
- Breaking: dine-in soft-delete — deleted catalogue items are filtered from public catalogue reads; soft-delete semantics enforced.
- Breaking: hourly booking `422` — hourly bookings with invalid duration/slot now return `422` validation (was `400`).
- Fix: loyalty discount applied correctly at order/booking pricing; points accrual and redemption reconciled.
- Fix: reviews eligibility — review creation now checks completed-order/booking participation before allowing review.
- Fix: idempotency — `Idempotency-Key` handling tightened for order, booking, and payment intent creation.
- Fix: audit actor — audit log `actor` field now records the authenticated user/role correctly.
- Fix: rider city `NULL` — rider profile allows `city_id` `NULL` for unassigned riders; contract reflects nullable city.
- Migrate `00094` — schema migration backing the above contract fixes; clients should upgrade to `0.3.0`.

## 0.2.0 — 2026-08-13

- Added `./fixtures` export: pure-data fixture factories for React Native mock
  repositories (home feed, merchants, providers, promotions, menus, orders,
  wallet, rider profile). Faker-only — no msw import.
- Included `src/` in the typecheck scope (`tsconfig` now checks fixtures,
  index, and mocks, not only generated output).
- Publish pipeline prepared (GitHub Packages) — first release to the registry
  pending repo creation.

## 0.1.0 — 2026-08-13 (unpublished dev cut)

- Generated client (fetch) + MSW handler factories per endpoint tag from
  `backend/API-CONTRACT.yaml` (464 paths / 249 schemas).
- `./mocks` export aggregating all per-tag MSW handlers.
- Model barrel (1,025 types).