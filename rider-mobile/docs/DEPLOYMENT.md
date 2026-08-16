# HUDumika RIDER — Deployment

Distribution via Expo Application Services (EAS). One app binary (Expo managed); environments differ only by config — no code changes between staging and production.

## Environments

| Channel | Use | Backend (`EXPO_PUBLIC_API_URL`) | MSW |
| --- | --- | --- | --- |
| `development` | devs, local testing | dev/staging API or MSW (`EXPO_PUBLIC_MSW_ENABLED=true`) | on |
| `staging` | QA, demo | staging API | off |
| `production` | store builds | production API | off |

- Environment is compiled into the build via `app.config.ts` + `EXPO_PUBLIC_*` vars; secrets never in the repo.
- Config validation at startup: fail loudly if `EXPO_PUBLIC_API_URL` is missing or non-HTTPS (outside dev).

## EAS builds

- `eas build --profile development` → dev client builds (local, ad hoc).
- `eas build --profile staging --channel staging` → internal testers via Expo updates.
- `eas build --profile production --channel production` → store submission builds (`eas submit`).
- OTA updates: `eas update` per channel only for non-breaking changes; native-version-dependent releases go through stores. Offer countdown, status transitions, and money rendering are never hot-patched silently — update notes must state what changed.

## Store releases

- iOS: TestFlight (internal/QA) → App Store Connect review → production. Version/bundle bumped per release.
- Android: Play internal track (QA) → closed testing → production. Release notes in en + sw.
- Both stores: EAS Submit with credentials stored in EAS secrets; app icon/splash from design tokens; privacy labels document location (foreground + background during delivery) and push notifications.
- Store review guardrails: reviewer-facing demo mode (MSW or staging channel) must not leak real credentials; no real money actions in review builds.

## Versioning

- `app.json` `version` (semver) + `buildNumber`/`versionCode` auto-increment on EAS builds.
- API contract compatibility: client and backend share `backend/API-CONTRACT.yaml`; a client that needs a new endpoint ships only after the contract exists (MSW keeps dev unblocked).
- Status/error-code changes are backward-compatible per contract; otherwise a coordinated release (see rollback).

## Rollback

| Trigger | Action |
| --- | --- |
| OTA update regression | `eas update --channel` rollback to previous update (instant, no store review) |
| Native release regression | store: promote previous version (TestFlight / Play internal); disable auto-update on affected users if patch not ready |
| API incompatibility | server-first: contract is source of truth; revert to last compatible client channel while backend hotfix lands |
| Money/payout bug | stop-the-line: disable online toggle server-side if needed; do not ship partial payout code |

## Release checklist (per release candidate)

1. `tsc --noEmit`, lint, Jest + MSW contract tests green (TESTING.md).
2. Detox happy path green on staging channel.
3. Config validated: correct API URL per channel; MSW disabled outside dev.
4. Store metadata + privacy labels updated; version bumped.
5. Staging QA pass of earnings/payout flows and dispatch offer flow.
6. Contract test suite green against staging backend (launch definition in `ROADMAP.md`).
