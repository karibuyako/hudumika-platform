# HUDumika Merchant — Settings

Application and store-behavior settings: order alerts, acceptance method, phone ordering, special rules, language, and the quick-actions dashboard surface.

## Order alert settings

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/notifications/me/order-settings` | Order alert + acceptance settings | `OrderAlertSettings` |
| PUT | `/notifications/me/order-settings` | Update settings (full object) | `OrderAlertSettings` |

`OrderAlertSettings`: `acceptanceMethod`, `voiceAlerts`, `channels[]`, `quietHours`, `autoAcceptWithinSeconds`.

| Field | Type | Notes |
| --- | --- | --- |
| `acceptanceMethod` | manual / auto | order acceptance mode |
| `voiceAlerts` | boolean | audible new-order alert on the merchant device |
| `channels` | push / sms / in_app[] | alert channels for new orders |
| `quietHours` | `{enabled, from, to}` | e.g. 22:00–08:00; alerts suppressed in-app |
| `autoAcceptWithinSeconds` | int 30–300 | auto-accept delay when `acceptanceMethod: auto` |

- Acceptance method appears on two contract fields: `OrderAlertSettings.acceptanceMethod` and `StoreSettings.acceptanceMethod`. One toggle in the UI keeps both in sync on save; the server is authoritative on disagreement.
- `auto` mode: incoming `paid` orders are accepted automatically within `autoAcceptWithinSeconds` (30–300, validated); the UI shows the countdown and a "switch back to manual" path.
- Quiet hours only mute non-critical alerts; system events (security, payout failures) cannot be disabled (backend/NOTIFICATIONS.md).
- Screen states: loading → toggle/stepper form → saving spinner → success toast → error + retry; `PREFERENCE_INVALID_EVENT` maps to the channel list.

## Phone ordering

- `phoneOrderingHours` on store settings (STORE-MANAGEMENT.md): `enabled`, `open`, `close` — the window when phone-call orders are accepted.
- UI: enabled switch + open/close pickers on the store settings form; outside the window the phone-ordering badge reads "closed".

## Special rules

Rule types split between contract switches and free text:

| Rule | Mechanism |
| --- | --- |
| Free-text business rules | `StoreSettings.specialRules` (≤1000) — editable on the store settings form (STORE-MANAGEMENT.md) |
| Holiday/renovation pause | closure protection (`POST /merchants/me/closure-protection`) |
| Night silence | `quietHours` |
| Closed days | `businessHours[].closed` per weekday |
| Order gap | `acceptanceMethod: manual` + `autoAcceptWithinSeconds` |
| Print behavior | `printSettings` (autoPrint, copies, labelPrinter) |

- `specialRules` is stored and returned verbatim by `PUT /merchants/me/settings`; the UI renders it on the store settings form and (where displayed) to customers. No client-side interpretation — text only.

## Message and ringtone

- `voiceAlerts` (order-settings) is a server-side preference: audible new-order alerts push to the merchant device.
- The ringtone sound selection itself is device-local on mobile (OS-level notification sound) — there is no contract field for ringtone choice; the web surface has no ringtone concept.

## Language

- App language is `locale` on the user profile: `PATCH /users/me` with `locale` enum `en` / `sw` / `ar` (contract-validated).
- i18n bundles, bilingual microcopy, RTL handling, and local-time rendering follow LOCALIZATION.md; language applies per user, not per device.

## Quick actions dashboard (mobile home)

Mobile home surfaces the most-used switches per DESIGN-SYSTEM card layout:

| Quick action | Endpoint behind it |
| --- | --- |
| Open / close store | `PUT /merchants/me/settings` (`isOpen`) |
| Acceptance manual / auto | `PUT /notifications/me/order-settings` |
| Voice alerts on/off | same |
| Quiet hours toggle | same |
| Pause for holiday | `POST /merchants/me/closure-protection` |
| Print now / test label | `POST /print-jobs` (label job to the default printer) |

Quick actions are optimistic with server rollback on 409/422; the web dashboard is the full settings surface (feature parity — mobile never hides capability, only layout).

## Screen states and rules

- Every settings screen: loading / (empty where lists apply) / error+retry / success toast on save.
- MSW parity: order-settings shape, `autoAcceptWithinSeconds` bounds, quiet-hours payload, and `PREFERENCE_INVALID_EVENT` must match the contract.
