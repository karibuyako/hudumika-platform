# Provider App — Environment Variables

Every `EXPO_PUBLIC_*` variable the provider app reads or ships with, in one table. If a variable is not listed here, it is not wired up — register new reads here and in `app/.env.example` in the same PR.

## Rule

- `EXPO_PUBLIC_*` only (Expo inlines them into the bundle). No secrets — tokens live in `expo-secure-store`, never in env.
- Register every new variable in this file **and** `app/.env.example` in the same PR that reads it.
- Mock switches: `EXPO_PUBLIC_MOCK_*`, one per repository group in `src/repos/factories.ts`. On by default when unset; forced `false` in preview/production EAS builds; never true in a shipped build.
- No hardcoded URLs, phones, emails, or ratings — environment-driven config only.

## Registry

| Var | Default | Module gated | Where used | Notes |
| --- | --- | --- | --- | --- |
| `EXPO_PUBLIC_ENV` | `development` | — (runtime env tag: `development`/`staging`/`production`) | eas.json env, `.env.example` | Set per EAS profile; not read by src yet, reserved for profile-aware behavior |
| `EXPO_PUBLIC_API_URL` | `http://localhost:8081` (dev) | live API base | `src/api/client.ts`, `src/api/queue.ts` | Base URL only; paths are relative, trailing `/` stripped. Local dev gateway `http://localhost:8081`; staging `https://staging-api.hudumika.co.tz/api/v1`; prod `https://api.hudumika.co.tz/api/v1` |
| `EXPO_PUBLIC_MOCK_AUTH` | `true` (on) | auth + session repos (`AuthRepository`) | `src/repos/factories.ts` | `'false'` → live API |
| `EXPO_PUBLIC_MOCK_PROFILE` | `true` (on) | provider + availability repos (`ProviderRepository`, `AvailabilityRepository`) | `src/repos/factories.ts` | `'false'` → live API |
| `EXPO_PUBLIC_MOCK_BOOKINGS` | `true` (on) | bookings machine repo (`BookingsRepository`) | `src/repos/factories.ts` | `'false'` → live API |
| `EXPO_PUBLIC_MOCK_DISPATCH` | `true` (on) | marketplace + dispatch repos (`DispatchRepository`) | `src/repos/factories.ts` | `'false'` → live API |
| `EXPO_PUBLIC_MOCK_SERVICES` | `true` (on) | catalog + services repos (`ServicesRepository`, `CatalogRepository`) | `src/repos/factories.ts` | `'false'` → live API |
| `EXPO_PUBLIC_MOCK_TECHNICIANS` | `true` (on) | technicians + staff repos (`TechniciansRepository`, `StaffRepository`, `CertificationsRepository`) | `src/repos/factories.ts` | `'false'` → live API |
| `EXPO_PUBLIC_MOCK_EARNINGS` | `true` (on) | earnings + payouts repo (`EarningsRepository`) | `src/repos/factories.ts` | `'false'` → live API |
| `EXPO_PUBLIC_MOCK_NOTIFICATIONS` | `true` (on) | notifications repo (`NotificationsRepository`) | `src/repos/factories.ts` | `'false'` → live API |
| `EXPO_PUBLIC_MOCK_SUPPORT` | `true` (on) | support tickets repo (`SupportRepository`) | `src/repos/factories.ts` | `'false'` → live API |
| `EXPO_PUBLIC_MOCK_CATALOG` | `true` (on) | inventory/contracts/plans/trust/copilot repos (`InventoryRepository`, `ContractsRepository`, `PlansRepository`, `TrustRepository`, `CopilotRepository`) | `src/repos/factories.ts` | `'false'` → live API |

All mock switches follow the same `mock()` helper semantics in `src/repos/factories.ts`: unset or `'true'` → mock, `'false'` → live.

## EAS build profile mapping (`app/eas.json`)

| Profile | `EXPO_PUBLIC_ENV` | `EXPO_PUBLIC_API_URL` | Mock switches | Channel |
| --- | --- | --- | --- | --- |
| `development` | `development` | `https://staging-api.hudumika.co.tz/api/v1` | all `true` | development |
| `preview` | `staging` | `https://staging-api.hudumika.co.tz/api/v1` | all `false` | preview |
| `production` | `production` | `https://api.hudumika.co.tz/api/v1` | all `false` | production |

Local `npm start` / `npm run web` read `.env` (from `.env.example`); EAS builds read the profile env block. Mocks are on in dev and the development profile, off in preview/production — the CI gate (`npm run lint` + tests on `provider/**`) keeps mock code out of shipped bundles.

## Cross-references

- Platform-wide registry and naming rules: `../../docs/ENV-VARS.md`.
- Mock pattern: `../../docs/MOBILE-MOCK-PATTERN.md`, `provider/docs/ARCHITECTURE.md` (environment config).

## Navigation

| Variable | Description | Default | Module |
| --- | --- | --- | --- |
| `EXPO_PUBLIC_NAV_URL` | Deep-link template for "Navigate to job" (`{lat}`,`{lon}` placeholders) | `https://maps.google.com/?q={lat},{lon}` | `src/lib/config.ts` → job detail |
