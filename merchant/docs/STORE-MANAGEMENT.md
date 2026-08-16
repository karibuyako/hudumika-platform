# HUDumika Merchant — Store Management

Store-level configuration: business hours, announcement, cover image, recommended items, open/close, closure protection, payment account, and printing preferences. Owned by `owner`/`manager` staff roles; every mutation is server-authorized.

## Store settings (`StoreSettings`)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/merchants/me/settings` | Current store settings | `StoreSettings` |
| PUT | `/merchants/me/settings` | Replace store settings (full object) | `StoreSettings` |

| Field | Type | Notes |
| --- | --- | --- |
| `businessHours` | array | Per day: `dayOfWeek` (0–6), `open`, `close` (HH:MM), `closed` flag |
| `announcement` | string ≤500 | Shown to customers; e.g. holiday note |
| `coverImageUrl` | uri | Upload → storage URL |
| `recommendedItemIds` | uuid[] | Featured items surfaced on the store page |
| `isOpen` | boolean | Store open state (also on `PATCH /merchants/me`) |
| `acceptanceMethod` | manual / auto | Order acceptance mode (see SETTINGS.md) |
| `phoneOrderingHours` | object | `enabled`, `open`, `close` — phone-call ordering window |
| `orderNotificationChannels` | push / sms / in_app[] | New-order alert channels |
| `acceptedPaymentMethods` | mpesa / tigo_pesa / airtel_money / card / cod[] | Which payment methods the store accepts |
| `deliverySettings` | object | `radiusKm`, `deliveryFeeTZS`, `minimumOrderTZS`, `sameDayCutoff` |
| `specialRules` | string ≤1000 | Free-text custom business rules |
| `printSettings` | object | `autoPrint`, `copies` (1–5), `labelPrinter`, `receiptTemplate` |

Settings editor (web full form, mobile essentials): loading skeleton → form → saving spinner → success toast → 422 maps `errors[].field` to fields → error + retry. PUT is a full replace — send the current object back with changes.

## Open / close control

| Carrier | Endpoint | Behavior |
| --- | --- | --- |
| Merchant profile | `PATCH /merchants/me` | `isOpen`, `businessName`, `logoUrl`, `description`, `serviceAreas`, and now `address` ≤300 + `contactPhone` |
| Store settings | `PUT /merchants/me/settings` with `isOpen` | Same flag via settings object |

One toggle on the dashboard updates the flag; the server is authoritative when business hours and `isOpen` disagree (customers see `MerchantPublic.isOpen`). Closed store + `ORDER_MERCHANT_CLOSED` blocks new orders; existing orders continue.

## Closure protection

| Method | Path | Purpose | Request |
| --- | --- | --- | --- |
| POST | `/merchants/me/closure-protection` | Apply (`active: true`) or cancel (`active: false`) closure protection | `active`, `reason` ≤500, `until` (date, nullable) |

`ClosureProtection` response: `active`, `reason`, `startedAt`, `until`, `penaltyExempt`.

- Pausing operations (holiday, renovation) without penalty: `penaltyExempt: true` while active; the store is treated as closed for reliability/uptime scoring.
- Apply flow: confirm dialog shows the requested `until` and the penalty-exemption guarantee → submit → success card with `startedAt` → the dashboard shows a "closure protected" banner.
- Cancel flow: same endpoint with `active: false`; store returns to normal open/close behavior.
- Screen states: loading → current state card → submit spinner → success → error + retry; 422 on missing reason.

## Payment account (payout)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| GET | `/merchants/me/payout-account` | Current payout account, masked | `PayoutAccount` |
| PUT | `/merchants/me/payout-account` | Set or change payout account (verification required) | `PayoutAccount` |

- `PayoutAccount`: `type` (`mobile_money` / `bank`), `provider`, `accountMasked` (e.g. `****1234`), `accountHolderName`, `verified`, `updatedAt`. Full account numbers never leave the backend (AUTH.md masking rule).
- Write (`PayoutAccountWrite`): `type`, `provider`, `accountNumber`, `accountHolderName` ≤120. A change is not active until verified — until then reads stay masked and `verified: false`; writes are audited.
- Errors: `PAYOUT_ACCOUNT_NOT_SET` (no account yet), `PAYOUT_ACCOUNT_VERIFICATION_REQUIRED` (change pending/needed before payouts), `PAYOUT_ACCOUNT_PROVIDER_UNSUPPORTED` (422 on unsupported provider).
- `payout_account.verified` (in-app, owner) marks the change complete; the masked view refreshes. Screen states: loading skeleton → masked value card (verified pill) → change form (provider picker + number/name) → saving spinner → verification-pending banner → error + retry.
- Balance/withdraw screens treat an unverified account as `WITHDRAWAL_ACCOUNT_MISSING` until verified (EARNINGS.md).

## Payment method settings

- `StoreSettings.acceptedPaymentMethods` (enum `[mpesa, tigo_pesa, airtel_money, card, cod]`) is the merchant-managed toggle list: checkboxes in the settings form, saved via `PUT /merchants/me/settings`.
- COD and dine-in cash are recorded with evidence (backend/PAYMENTS.md manual-proof flow), not as free-form merchant entries.

## Receipt printing and template

- `printSettings` (autoPrint, copies 1–5, labelPrinter) controls order receipt and kitchen-label output; print jobs run through `POST /print-jobs` with store defaults (ORDER-FLOW.md).
- Receipt template is LIVE: `printSettings.receiptTemplate` with `headerText` ≤200, `footerText` ≤200, and `showLogo` (boolean). The settings form exposes header/footer text inputs and a logo toggle; output renders on `receipt` print jobs.

## Delivery settings

- `StoreSettings.deliverySettings`: `radiusKm` (number), `deliveryFeeTZS` (integer), `minimumOrderTZS` (integer), `sameDayCutoff` (HH:MM, e.g. `20:00`).
- The form groups: coverage radius, delivery fee, minimum order, and same-day cutoff time; all values server-validated, money integers (TZS). Rendered with thousands separators.
- Customer-facing delivery estimates derive from these settings server-side; the merchant surface only edits and displays them.

## Special rules

- `StoreSettings.specialRules` (string ≤1000) is free-text custom business rules (e.g. "no cash on delivery over TZS 50,000", "orders packed with cutlery on request").
- UI: multiline input on the settings form with a character counter (≤1000); shown to customers as store rules where rendered. Stored and returned verbatim via `PUT /merchants/me/settings` (see SETTINGS.md).

## Kitchen camera (`GET/PATCH /store/kitchen-camera`)

- `enabled`, `streamUrl`, `publicAccess` (visible to customers), `lastCheckedAt`.
- `KITCHEN_CAMERA_NOT_CONFIGURED` when no stream is set; `kitchen_camera.offline` alert when the feed fails health checks.
- Privacy: public access requires explicit opt-in and consent copy in the customer app.

## Qualifications (`GET/POST /store/qualifications`)

- Business licenses/permits: `type` (e.g. `business_license`, `food_safety`), `url`, status `pending` → `approved`/`rejected`.
- Upload uses the pre-signed URL pattern; re-upload replaces the document and resets status to `pending`.
- Expiring licenses generate violation tasks (TASKS-RISK.md) and block closure-protection extension.

## Store QR codes (`GET/POST /store/qr-codes`, `DELETE .../{qrCodeId}`)

- Kinds: `ordering` (menu), `collection` (pay-at-counter), `download` (app link), `review` (rate us).
- Each QR prints for tables/counter via print-jobs (label type); `qrPayload` always from the API, never hardcoded.
- Delete removes the printed asset; regenerate creates a new payload.

## Receipt templates (`/store/receipt-templates`)

- CRUD + `POST .../{templateId}/activate` sets the active default (one per store; `RECEIPT_TEMPLATE_LIMIT_REACHED` at cap).
- Fields: `name`, `headerText`, `footerText`, `showLogo`; the active template drives receipt printing (ORDER-FLOW print-jobs).

## Store payment accounts (`GET/POST /store/payment-accounts`, `DELETE .../{accountId}`)

- Multiple collection accounts per store (`mobile_money`/`bank`, provider, masked number, `isDefault`, `verified`).
- Distinct from the payout account (EARNINGS.md): collection accounts receive customer payments; payout account receives settlements.
- `PAYMENT_ACCOUNT_LIMIT_REACHED` at cap; verification required before the account can receive payments.

## Self-pickup (`GET/PUT /store/self-pickup`)

- `enabled`, `pickupReadyMinutes` (default 15), `pickupHours` (open/close).
- Enabling adds a pickup fulfilment type to customer checkout; `SELF_PICKUP_INVALID_CONFIG` for nonsense hours.

## Compliance recheck (`POST /store/compliance/recheck`)

- Request a re-evaluation of store compliance (qualifications, hours, catalogue rules).
- Returns `queued` → `processing` → `completed`; `COMPLIANCE_RECHECK_IN_PROGRESS` blocks repeats; `compliance.recheck_completed` notifies.

## Store logs (`GET /store/logs`)

- Append-only operation log for the store (settings changes, status toggles, QR/print actions) — the store-scope view of the audit trail (backend AUDIT.md).

## Business rules

- Money and durations stay server-validated; no client-side persistence of settings — the API is the source of truth.
- MSW parity: settings GET/PUT shapes (incl. `acceptedPaymentMethods`, `deliverySettings`, `specialRules`, `receiptTemplate`), closure-protection response, masked `PayoutAccount`, and `PAYOUT_ACCOUNT_*` codes must match the contract.

# Round-2 additions (deep survey — `docs/REFERENCE-SURVEY.md`)

## Store rank (contract gap)

- The reference store-rank card (current / previous rank, category rank, store score) has no dedicated endpoint. The contract data points are `GET /analytics/store-score` (`score` 0–100, `ratingAverage`, `breakdown[]`) and `GET /analytics/benchmarks` (`merchantScore`, `industryAverage`, `percentileRank`, `metrics[]`) — ANALYTICS.md. Rank deltas (current vs previous) are a contract gap; nothing else renders a rank.

## Scheduled reopen (contract gap)

- The server has a scheduled-reopen sweeper (backend DATA-MODEL: "honored only when no closure protection is active"), but no merchant-facing API fields for timed reopen (30m / 1h / 2h / 4h / Tomorrow presets are reference-app chips). Until the contract grows, the UI exposes only the `isOpen` toggle; the reopen picker is not built and no mock fabricates it.

## Decoration fields (contract gap)

- `StoreSettings` covers `coverImageUrl`, `announcement` <=500, and `recommendedItemIds`. Reference-app decoration extras — `posterColor`, `posterText`, `sign`, `brandStory`, `tagline`, and a featured count cap — are contract gaps. The featured strip renders `recommendedItemIds`; the reference app caps it at 6 — treat 6 as a UI limit, not a contract rule.

## Delivery zones (contract gap)

- `deliverySettings` is a single block (`radiusKm`, `deliveryFeeTZS`, `minimumOrderTZS`, `sameDayCutoff`). Per-zone fees and a `perKmFee` (distance-based pricing) are contract gaps; the form renders the flat values only.

## Self-pickup slots (contract gap)

- `SelfPickupConfig` (GET/PUT `/store/self-pickup`): `enabled`, `pickupReadyMinutes` (default 15), `pickupHours` (`open` / `close`). Morning / Afternoon / Evening slot presets, pickup-ready notifications, pickup instructions (<=500), and `selfPickupDiscount` are reference-app fields not in the contract (contract gap). `SELF_PICKUP_INVALID_CONFIG` handling is unchanged.

## Operating settings (contract gap)

- `preparationTime`, `maxOrdersPerHour`, `preOrderLeadTime`, and `selfPickupDiscount` have no contract fields. The related contract surface is `acceptanceMethod` (manual / auto) + `autoAcceptWithinSeconds` (30–300, SETTINGS.md); the rest stays unbuilt until the contract grows.

## Table zones and statuses (LIVE)

- `DineInTable` now carries: `zone` (<=40, nullable), `status` enum `idle` / `occupied` / `reserved` / `cleaning` (default `idle`), `disabled` (bool), `qrToken` / `qrUrl` (nullable), `reservedUntil` (nullable date-time), `currentOrderId` (nullable).
- The table editor adds a zone input and a status picker (incl. `cleaning` between sits); reservations set `reserved` + `reservedUntil` (DINE-IN.md); generated QR renders `qrToken` / `qrUrl` per table (`GET /dine-in/tables/{tableId}/qr` remains the generation path).

## Kitchen camera (contract gap)

- `KitchenCamera` (GET/PATCH `/store/kitchen-camera`): `enabled`, `streamUrl`, `publicAccess`, `lastCheckedAt`. Recording duration, storage used, video quality, and recent clips are reference-app extras not in the contract (contract gap); `KITCHEN_CAMERA_NOT_CONFIGURED` and `kitchen_camera.offline` handling is unchanged.

## Qualifications expiry and renew (contract gap)

- `Qualification`: `type`, `url`, `status` (`pending` / `approved` / `rejected`), `createdAt`. Expiry dates and an explicit renew action are contract gaps; the renew path today is re-upload (same type + new `url`), which resets status to `pending`.

## Receipt template — full field set (LIVE)

`ReceiptTemplate` (CRUD + `POST .../{templateId}/activate`): `name` <=80, `headerText` <=200, `footerText` <=200, `showLogo` (default true), `logoEmoji` <=4 (nullable), `paperSize` enum `58mm` / `80mm` (default `80mm`), `copies` 1–5 (default 1), `font` enum `monospace` / `sans_serif` (default `monospace`), `isActive`, and the `fields` toggle set: `logo`, `storeName`, `address`, `phone`, `orderId`, `date`, `items`, `subtotal`, `tax`, `total`, `paymentMethod`, `thankYou`, `qrCode` (default false), `cashierName` (default false).

- Template editor renders a toggle row per field plus paper-size / font / copies / logo-emoji pickers; the active template drives receipt print jobs (ORDER-FLOW.md). Contract note: the schema description says "13 toggles" while listing 14 properties (logo … cashierName) — render the properties as defined.

## Payment account status (contract gap)

- `StorePaymentAccount` exposes `verified` (bool) as the only status. Reference-app statuses pending / active / disabled are labels over that boolean — contract gap for a status enum; the verified pill remains the rendered state, `POST .../{accountId}/verify` is the activation path.

## Quick payment request (LIVE)

| Method | Path | Purpose | Response |
| --- | --- | --- | --- |
| POST | `/payments/request` | Send a quick payment request to a customer phone | `{requestId, status}` / 201 |

- Body: `phone`, `amountTZS` (integer), `method` enum `mpesa` / `tigo_pesa` / `airtel_money` / `ezy_pesa` / `halotel` / `bank` (required), `note` <=200. Response: `{requestId, status}` with status enum `sent` / `pending_confirmation`.
- Flow: method picker → phone + `amountTZS` + optional note → confirm → spinner → success card with `requestId` and status pill ("sent" / "pending confirmation"); the customer completes payment on their side — funds land via provider webhooks, the merchant never creates payment intents. Errors: provider-level 422 mapped to the method row, network error + retry. States: loading → form → in-flight spinner → success → error + retry.

## Closure protection — statuses, 15-day cap, reasons

- `ClosureProtection` now carries `status` enum `pending` / `approved` / `completed` / `cancelled` / `rejected`, `daysRemaining` (nullable), and `maxDays` (default 15), alongside `active`, `reason`, `startedAt`, `until`, `penaltyExempt`.
- UI: status pill on the closure card; the apply dialog states the 15-day cap and shows `daysRemaining` on an active protection; a rejected application renders the `rejected` state and allows re-application; cancel via `active: false` returns to normal open/close behavior.
- Reason picker chips (Holiday / Family Emergency / Kitchen Renovation / Health Issue / Other) are UI suggestions filling `reason` <=500 — the contract accepts any free-text reason; 422 on missing reason is unchanged.

# Round-3 additions — order receiving settings, closure and account rules (reference contract tests)

Behaviors verified against the reference contract suite (`tests/contract.test.ts`) and the server sweeper (`src/mock/sweeper.ts`).

## Order receiving settings (`StoreSettings.orderReceiving`)

| Field | Type | Behavior |
| --- | --- | --- |
| `requireNotes` | enum `none` / `optional` / `required`, default `optional` | `required` rejects orders without a note (`NOTE_REQUIRED`, reference suite asserts 400); `optional` / `none` pass without a note |
| `acceptWhileClosed` | boolean, default `false` | `true` lets a closed store accept scheduled orders only; immediate orders still 409 `STORE_CLOSED` |
| `autoCancelMinutes` | integer, nullable | `Order.deadlineAt = createdAt + N minutes`; the sweeper auto-cancels overdue `new` orders with reason code `AUTO_CANCEL` and a real (idempotent) refund when the payment was captured |
| `contactlessDelivery` | boolean, default `false` | Delivery preference flag; preserved by `orderSettings` object merges |

## Hours validation

- Equal `open` / `close` times → 400 `HOURS_INVALID` (reference suite: `INVALID_HOURS`); `closedDays` round-trips through PATCH and GET.

## Closure protection

- Apply with `from = now` is allowed and closes the store immediately.
- Overlap with an active protection → 409; missing `reason` → 400; cancel with no active protection → 404.
- Annual quota: applying beyond the 15-day annual cap → 409 `CLOSURE_ANNUAL_QUOTA` (reference suite: `PROTECTION_QUOTA`); the status response carries `usedDaysThisYear` / `remainingDays`.
- Status flow: `active` → `expired` (sweeper marks past-window protections expired; the store stays closed) or `cancelled` (manual cancel, store reopen allowed).
- Manual reopen (`open: true`) while protection is active cancels the active protection and logs `closure:cancel` (`before: active` → `after: cancelled`).

## Scheduled reopen

- Setting `scheduledReopenAt` in the past → 400 `INVALID_REOPEN`; the rejected patch never sets the field.
- Sweeper: when `scheduledReopenAt` arrives the store reopens (`open: true`), the field is cleared, `store:reopen` is logged (`before: false` / `after: true`), and a "Store reopened automatically" notification is created.
- Active closure protection blocks the scheduled reopen: the store stays closed, `scheduledReopenAt` is cleared (reopen cancelled), `store:reopen` is logged (`before: false` / `after: false`), and a "Scheduled reopen cancelled" notification is created.
- Manual open clears `scheduledReopenAt` and logs `store:update` for the field.

## Payment accounts

- Un-defaulting the last default account → 409 `LAST_DEFAULT`; the account stays default.
- Deleting the default account auto-assigns the remaining account as default; the delete response reports the replacement (`newDefault`).
- Lifecycle: create (status `pending`, non-default, number masked) → verify → `active` → promote to default.

## Receipt templates

- Delete of the in-use (active default) template → 409 `RECEIPT_TEMPLATE_IN_USE` (reference suite: `TEMPLATE_IN_USE`).
- The active template is readable via the active endpoint; created templates are non-default until activated; PATCH round-trips header/footer/paper fields.

## Printers

- Create → status `pairing` → connect → `connected`; a new printer is never the default.
- Offline test → 409 `PRINTER_OFFLINE`; live test → 200 `printed: true`.
- `purpose` round-trips through PATCH (`kitchen` → `receipt`); a bogus purpose → 400 `INVALID_PURPOSE`.
- `copies` PATCH round-trips; DELETE removes the printer from the list.
