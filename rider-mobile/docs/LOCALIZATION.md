# HUDumika RIDER — Localization

i18n per glossary: first release English (`en`), Swahili-ready (`sw`), Arabic-capable (`ar`). Locale is user-controlled via `PATCH /users/me` (`locale` ∈ `en | sw | ar`).

## Setup

- `i18next` + `react-i18next` (or Expo-preferred equivalent); catalogs per language in `src/i18n/{en,sw,ar}.json`.
- Every user-visible string is a key; no literals in components.
- `sw` strings ship in the catalog from the start (tested with bilingual copy); `ar` catalog is capable (RTL layout ready via `I18nManager`, mirror-safe icons) but content can lag until release.
- Fallback chain: `locale` → `en`.
- Number and date formatting localized; money always `TZS` prefix with thousands separators regardless of locale (per DESIGN-SYSTEM).

## Bilingual microcopy

- Trust-signal pairings on pills and footnotes: English + Swahili (per DESIGN-SYSTEM), e.g. "Online / Uko Mtandaoni", "Payment failed / Malipo yameshindikana".
- Confirmation dialogs (accept offer, confirm pickup, proof of delivery) show both languages when `sw` is active.
- Keep bilingual text short; never translate status strings from the contract (`rider_assigned`, `delivered` render via localized labels, the raw enum stays server-shaped).

## Local time rendering

- API timestamps are UTC ISO 8601; render in device-local time via the i18n date helper (`date-fns` or `Intl.DateTimeFormat` with the active locale).
- Relative time in notification center ("2 min ago"); absolute local time in order events (`OrderDetail.events[].at`), payouts, and statements.
- Offer countdown (120 s) is a duration, locale-independent formatting.

## Navigation app integration

- Maps handoff via environment-driven deep link scheme (`EXPO_PUBLIC_MAPS_SCHEME`) — never hardcoded URLs.
- Coordinates come from order data (`deliveryAddress.lat/lon`, merchant location); when coordinates are missing, fall back to the address label/landmark text query through the maps app.
- Return-from-maps resumes the delivery screen state (countdowns, active order).
- `Linking.createURL` for internal deep links (`order/{orderId}`, `ticket/{ticketId}`, `payout`), used by notifications and push payloads.

## String conventions

| Rule | Example |
| --- | --- |
| Status labels map enum → key | `orderStatus.delivering` → "Delivering" / "Inaendelea kufikishwa" |
| Errors show `ErrorResponse.message` with key fallback | key per `code`, fallback `message` |
| Money always `TZS x,xxx` | `TZS 12,500` |
| No punctuation-in-key hacks | keys are full sentences |

## Testing

- Unit tests assert catalog completeness: every `en` key exists in `sw`/`ar`, no missing `locale` rendering.
- Component tests set a mock locale and assert bilingual copy and RTL flag.
