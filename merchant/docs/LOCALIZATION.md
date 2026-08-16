# HUDumika Merchant — Localization

i18n architecture: English first, Swahili-ready (`sw`), Arabic-capable (`ar`) — GLOSSARY: "first release English, Swahili-ready, Arabic-capable".

## Language model

| Aspect | Spec |
| --- | --- |
| Locale source | `User.locale` (`GET /users/me`); `UserUpdate.locale` (`en`, `sw`, `ar`) updates it |
| Default | `en` |
| Fallback | missing key → `en`, missing `en` key → key name surfaced to i18n review, never raw text in prod |
| RTL | `ar` must support RTL layout (both surfaces) from day one — layout never hardcodes LTR |
| Scope | All user-facing strings; server-provided text (titles/bodies of notifications, review bodies, ticket messages) is never translated by the client |

## Key structure

```
merchant/
  auth.login.title
  orders.accept.cta
  orders.cancel.confirm_fee   # "Cancellation fee TZS 5,000 applies"
  catalogue.item.unavailable
  earnings.payout.exception
  onboarding.status.documents_review
```

Pluralization and parameterized strings (amounts, counts) use the i18n library's plural rules — never string concatenation for money or counts.

## Bilingual microcopy

- Design system requires English + Swahili pairings on pills and footnotes as a trust signal (DESIGN-SYSTEM.md): e.g. "Online — Upo mtandaoni" on the store status pill; "Commission — Tume" in the earnings card footnote.
- Pairings ship in `en`/`sw` bundles from the first release; the pairing renders when both locales are available and the label is a designated trust copy item.
- `ar` capable: keys exist in the schema; Arabic strings may be empty until a translator passes them (fallback = `en`).

## Local time rendering

- All API timestamps are UTC ISO 8601 (`createdAt`, `paidAt`, `publishedAt`, event `at`).
- Render via locale-aware formatter: date + time in device/browser timezone; e.g. "12 Aug 2026, 14:05" with the merchant's locale.
- Relative time ("2 min ago") only in lists; absolute local time in details, tickets, and statements.
- Never render raw UTC or `Z` suffixes in UI.

## Formatting rules (locale-independent invariants)

| Value | Rule |
| --- | --- |
| Money | `TZS 12,500`, thousands separators, integer units — same format in every locale (TZS is the only currency) |
| Dates | locale-formatted, local timezone |
| Phones | masked per policy, same mask in every locale |
| Weights/quantities | Arabic numerals in all locales for the first release |

## Implementation notes

- Shared `i18n` package (ARCHITECTURE.md) used by both surfaces: same key files, same fallback chain, same formatters.
- Web: `Intl` + a lightweight i18n library; mobile: the Expo-managed equivalent; RTL test on `ar` in CI for both.
- Locale switch reflects immediately (auth context) and persists via `PATCH /users/me` with `locale`.
- Screen-state strings (loading/empty/error/retry/success) are localized keys everywhere — never literal English in components.

## Rules

- No user-facing English literals outside i18n bundles.
- New copy requires keys in all three locales (empty `ar` allowed with `en` fallback); `sw` ships with real copy from the first release.
- MSW fixtures return UTC timestamps and TZS integers to keep formatting tests deterministic.
