# Customer App — Localization

Architecture per `GLOSSARY.md` ("Localization"): first release English, Swahili-ready (`sw`),
Arabic-capable (`ar`). `UserUpdate.locale` enum is `[en, sw, ar]`.

## Architecture

| Concern | Choice |
| --- | --- |
| Engine | i18next (`react-i18next`) + `expo-localization` for device locale |
| Default | `en`; device locale used to prefill, user selection overrides |
| Language switch | In Account settings; persists locally and syncs via `PATCH /users/me` (`locale`) |
| Resource files | `src/i18n/locales/{en,sw,ar}.json`, namespaced: `common`, `auth`, `order`, `booking`, `payment`, `notification`, `review`, `support`, `account` |
| Dates/times | UTC from API (`createdAt`, `scheduledFor`, `updatedAt`) rendered local; `scheduledFor` sent back to API in UTC ISO 8601 |
| Numbers/money | `Intl.NumberFormat('en-TZ')`-style grouping; currency always TZS (`TZS 12,500`) |
| Direction | `ltr`; RTL ready if `ar` ships (layout must not hardcode start/end) |

## Language selection

- Priority: user `locale` (persisted) → device locale → `en`.
- Switch reflects instantly (in-memory) and persists via `PATCH /users/me`.
- Untranslated keys fall back to `en`; never crash on missing keys (i18next `fallbackLng: 'en'`).
- MSW dev mode ships all three locale files so translation completeness is testable offline.

## Bilingual microcopy patterns (from DESIGN-SYSTEM)

- English + Swahili pairings on pills and footnotes as a trust signal, e.g.
  `Karibu` / "Welcome", `Malipo` / "Payment", `Imefikishwa` / "Delivered".
- Pattern: primary text in active locale; secondary locale in muted style on the same pill/footnote.
- Restricted to non-destructive trust surfaces (hero pills, footnotes, status helper text) — not
  buttons or error dialogs.
- Terms must match `GLOSSARY.md`; do not coin new Swahili terms without adding them to the glossary.

## Date/time local rendering

| Field | Example render |
| --- | --- |
| `createdAt` / `updatedAt` | `12 Aug 2026, 14:30` (local) |
| `OrderEvent.at` / booking event `at` | Timeline rows: `14:30` short, full date on expand |
| `scheduledFor` | Booking form picker in local tz; submit converted to UTC |
| `TrackingEvent.updatedAt` | "Updated 14:32" |
| `Notification.createdAt` | Relative: "5 min ago" for <24 h, absolute after |

- All parsing/serialization goes through one `dates` helper (never ad-hoc `new Date(str)`).
- `estimateMinutes` is a plain integer, not a timestamp.

## Microcopy examples (Swahili, illustrative only)

| Context | EN | SW |
| --- | --- | --- |
| Order placed | "Order placed" | "Oda imewekwa" |
| Payment failed | "Payment failed" | "Malipo yameshindikana" |
| No notifications | "No notifications" | "Huna taarifa" |
| Retry | "Retry" | "Jaribu tena" |
| Completed | "Completed" | "Imekamilika" |

## Acceptance checks

- Every user-visible string is an i18n key; no inline literals.
- Locale change persists across restarts and re-renders screens in flight.
- No hardcoded dates, money, or URLs — formatting always via helpers with the active locale.
