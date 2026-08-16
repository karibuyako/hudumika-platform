# Customer App — Deployment

Builds and release via EAS; stores: TestFlight (iOS) and Play internal (Android) → production.
App store links are environment-driven config, never hardcoded.

## EAS build profiles (`eas.json`)

| Profile | Purpose | Distribution |
| --- | --- | --- |
| `development` | Local dev + MSW | Development build (`expo-dev-client`) |
| `staging` | QA/contract validation | Internal distribution (TestFlight / Play internal) |
| `production` | Store release | App Store Connect / Google Play |

## Environment config per channel

| Key | development | staging | production |
| --- | --- | --- | --- |
| `EXPO_PUBLIC_ENV` | `development` | `staging` | `production` |
| `EXPO_PUBLIC_API_URL` | local MSW / staging API | staging API | prod API (env-driven) |
| Push | sandbox APNs / FCM test | TestFlight push | Production push credentials |
| Payments | sandbox provider certs | sandbox | live provider certification |

Secrets (push credentials, keystores, signing certs) live in EAS credentials, never in the repo or
in `EXPO_PUBLIC_*` (bundled values).

## Release flow

| Stage | Steps | Gate |
| --- | --- | --- |
| Dev | `eas build --profile development` | — |
| Staging | `eas build --profile staging` → `eas submit` to TestFlight / Play internal | Contract tests + Detox happy paths green against staging |
| Production | `eas build --profile production` → submit to App Store / Play | Store review + backend live payments certification |

- Versioning: `app.json` version follows SemVer; Android `versionCode` + iOS `buildNumber`
  increment per submit; `version` matches a backend-supported API version.
- Release notes reference milestones from `ROADMAP.md` (P0–P7).
- One store app per platform; never repurpose channels (TestFlight internal vs production build).

## Rollback

- **iOS**: no app-side downgrade; emergency rollback = release a fixed build; feature flags
  (remote config) disable a broken feature until fix ships.
- **Android**: Play internal/alpha rollback via Play Console (unpublish broken version, keep
  working one). Same version-number rule: never re-use an uploaded `versionCode`.
- **Runtime/JS updates**: OTA (`expo-updates`) for JS-only fixes to current channel; critical
  native changes require a full build.
- Backend compatibility: if the contract changes, ship app + backend together; apps on older
  versions must still render `ErrorResponse` gracefully (`NOT_FOUND`/`FORBIDDEN` paths).

## Versioning rules

- Bump `version` (SemVer) on feature milestones; bump native `versionCode`/`buildNumber` on every
  submitted build (even if JS-version unchanged).
- A build once submitted to a store channel is immutable; release channels are append-only.

## Post-release checks

- Push token registration works on released build (APNs/FCM production).
- Deep links verified on cold start (notification → order/booking/ticket).
- Money rendering verified against staging ledger fixtures (TZS grouping).
- Monitoring: crash-free rate, payment failure rate, `payment.failed` notification delivery.
