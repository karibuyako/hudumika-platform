# Changelog

All contract package changes are versioned by Team 6. Format: version, date, change summary.

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