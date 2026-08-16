# HUDumika Provider — Localization

i18n architecture for both surfaces. First release English; Swahili-ready (`sw`); Arabic-capable (`ar`). `User.locale` enum is exactly `en | sw | ar` (contract `UserUpdate.locale`).

## Architecture

| Concern | Approach |
| --- | --- |
| Library | `i18next`-style keys + dictionaries in `packages/shared/i18n`; shared by both surfaces |
| Default | `en`; fall back `sw` → `en`, `ar` → `en` per missing key (never a raw key on screen) |
| Locale source | `User.locale` (`PATCH /users/me`); persisted client-side and re-fetched on login |
| Plurals/format | `Intl` for dates, times, numbers, currency; no hand-rolled format strings |
| RTL | `ar` is RTL-capable: layout mirrors (react-native direction / web `dir`); token layout uses logical props |

Key conventions: namespaced keys per screen (`booking.incoming.title`, `earnings.statement.empty`); status labels map 1:1 to contract enum values (`provider_arrived`, `awaiting_customer_confirmation`, ...) so enums never display raw.

## Bilingual microcopy

Per `DESIGN-SYSTEM.md`: English + Swahili pairings on pills and footnotes as a trust signal — e.g. status pills and confirmation footnotes show `en` primary with a `sw` subline ("Verified · Imehakikiwa"). Rules:

- Pills/footnotes only; never full paragraphs twice.
- Both strings come from the same dictionary entry (`pair: {en, sw}`), so a locale change replaces both.
- Notifications render `title`/`body` as delivered by the backend (server-localized); the client does not re-localize them.

## Local time rendering

- All API timestamps are UTC ISO 8601 (`scheduledFor`, `createdAt`, `events[].at`, `paidAt`); always convert with the device/browser timezone.
- `scheduledFor` in requests: sent as UTC; the availability editor works in local time (`startTime`/`endTime` are local wall-clock strings per the contract example).
- Formats: date "12 Aug 2026", time "14:30", relative "in 2 h" for reminders/countdowns; 12/24 h follows locale, default 24 h for `en`/`sw`, locale-appropriate for `ar`.

## Key dictionaries

| Namespace | Entries | Example keys |
| --- | --- | --- |
| `auth.*` | OTP screens, errors | `auth.otp.title`, `auth.otp.resendIn` |
| `onboarding.*` | Application, VerificationState copy | `onboarding.state.documents_review` |
| `availability.*` | Week grid, toggle, save errors | `availability.window.startTime` |
| `booking.*` | Status labels, actions, countdown | `booking.status.provider_arrived`, `booking.actions.accept` |
| `earnings.*` | Balance, payouts, statement | `earnings.statement.openingBalance` |
| `notifications.*` | Center, preferences | `notifications.event.booking.requested` |
| `support.*` | Tickets, composer | `support.ticket.status.resolved` |
| `settings.*` | Profile, security, logout | `settings.locale.sw` |

Status-label keys map 1:1 to contract enums; a locale switch re-renders every status pill without logic changes.

## Translation checklist (per locale)

| Check | Detail |
| --- | --- |
| `sw` | No truncated labels on buttons/pills; "Huduma" phrasing matches glossary intent; date format dd MMM yyyy |
| `ar` | RTL mirror of nav, countdown, timeline; mixed en numbers inside ar strings render correctly |
| Fallback | Missing `sw`/`ar` key falls back to `en` — never raw keys; test one forced-missing key per screen |
| Numbers | TZS stays `en-TZ` grouping in all locales; durations and counts use `Intl.NumberFormat(locale)` |

## Screen checklist

Every screen must render correctly under: `en`, `sw` (verify no truncated labels), `ar` (RTL mirror), and missing-key fallback. Test at least the jobs list, booking detail (statuses + countdown), earnings statement, and settings on both surfaces. Money stays `TZS 12,500` format in all locales (en-TZ grouping), currency symbol always visible. Locale changes apply instantly via context (no restart) and persist via `PATCH /users/me` (`locale`).
