# HUDumika Merchant — Deployment

EAS builds for mobile, Expo static web export for web, environments, channels, store releases, rollback.

## Environments

| Environment | API base URL | Purpose |
| --- | --- | --- |
| dev | dev API or MSW (dev-only) | local iteration; `EXPO_PUBLIC_MOCK_*` switches on for parity with the contract |
| staging | staging server from contract (`staging-api...`) | integration, contract tests, release candidates |
| prod | production server | store/web release |

Base URLs are environment-driven only: `EXPO_PUBLIC_API_URL` (both surfaces) — never committed per-environment values in client code.

## Mobile (Expo EAS)

| Profile | Channel | Build target | Use |
| --- | --- | --- | --- |
| `development` | dev | simulator/emulator | local + CI dev builds |
| `preview` | preview | ad hoc/internal distribution | QA and beta testers via EAS update or TestFlight/Play internal |
| `production` | production | store binaries | App Store / Google Play release |

Workflow:

1. `eas build --profile <profile>` per platform.
2. `eas channel:edit` maps a channel to the desired build branch/update.
3. `eas update` ships JS/asset updates to a channel without a new store binary (config-only or non-native changes).
4. `eas submit` uploads store builds; store releases (TestFlight internal → App Store review → production rollout; Play internal → closed → production).

Rollback (mobile):

- Non-native regression: `eas update --channel <previous>` repoints the channel to the last known-good update.
- Native regression: rebuild and resubmit; if the store build is broken, disable the app on the channel via EAS or store-side (remove from sale / pause release).
- Store release gates: contract test suite green against staging, E2E happy path passed on the release build, audit/observability dashboards green.

EAS status: profiles/channels match `eas.json`, but `eas submit` (store releases), a staging contract-test run, and rollback drills are not automated or evidenced yet — they are tracked as P7 operations TODOs (see ROADMAP status column).

## Web (Expo static export)

1. `npm run build` → static `dist/` (wraps `npx expo export --platform web`; CI runs the same export with `EXPO_PUBLIC_ENVIRONMENT=production`).
2. Deploy `dist/` to the static host with `EXPO_PUBLIC_API_URL` set per environment.
3. Previews per PR for staging; production deploy is tagged and reversible.

Rollback (web): static hosting is immutable-versioned — republish the previous build artifact; keep at least the last two tagged builds. Env-specific config (API URL, feature flags) must not require a rebuild for rollback.

Deploy status: CI builds and uploads `dist/` as the `web-build` artifact (`.github/workflows/ci.yml`), but no static host is configured in this repo yet — the deploy step, tag/rollback tooling, and the rollback drill are outstanding (ROADMAP P7).

## Release checklist (shared)

| Item | Gate |
| --- | --- |
| Contract tests | green against staging (CI runs the MSW parity + contract suites on every push; the staging run is a P7 operations TODO) |
| E2E happy path | catalogue publish → order accept passed on target surface |
| i18n | `en` complete, `sw` shipped, `ar` keys fall back cleanly; RTL checked on `ar` |
| Money format | sampled screens show `TZS 1,234,567` grouping, integer only |
| Secrets | no API keys/URLs beyond env-driven config in the artifact |
| Environments | dev/staging/prod config verified; MSW never active in staging/prod |

## Versioning

- Mobile: semantic version in app config, matched to store versioning; changelog per release.
- Web: tag builds; deploy date + tag recorded for rollback selection.
- Both surfaces share the contract version (`backend/API-CONTRACT.yaml`); a contract change ships with its API.md impact review.

## Rules

- Production builds never contain MSW handlers (tree-shaken at build; `EXPO_PUBLIC_ENVIRONMENT=production` hard-gates mocks, `EXPO_PUBLIC_MOCK_*` switches off in preview/production).
- No hardcoded domains or store URLs — store links, if surfaced, come from environment config.
- All releases go through staging contract tests first (ROADMAP launch definition).
