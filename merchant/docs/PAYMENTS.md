# HUDumika Merchant — Payments

Settlement mechanics, refunds, payout account setup, and TZS formatting. The merchant app never creates payment intents or webhooks — those are customer/payment-provider flows (`/payments/*`). Merchant surfaces read settlement state and report problems.

## Settlement mechanics

- Money is held and released per order completion rules (SHARED-FLOWS, PAYOUTS-LEDGER):
  - `order_earning` ledger entry is created only after the order is `completed`.
  - Commission (platform share, `commissionRateBps`) is deducted at settlement time as a `commission` entry — not at sale time.
  - `delivery_fee` and `platform_fee` components in `PriceBreakdown` are customer-side line items; the merchant never sees them as receivables beyond the net earning.
- Net flow per completed order: `order_earning` (+) and `commission` (-) appear on the statement; the balance then rides the payout cycle (`payoutCycleDays`, default 3) into a nightly batch.
- Balance display derives from `GET /payouts/me` + `GET /payouts/me/statement`; the app never sums order totals as a substitute for the ledger.

## Payout methods

| Method | Notes |
| --- | --- |
| Bank transfer | account details captured at onboarding; shown masked as `payoutAccount` |
| Mobile money | same masking rule |

- `PayoutSummary.method` identifies the destination channel per payout.
- Payout account changes are operations-managed: the merchant requests changes via support ticket; the account stays masked in every response (AUTH.md: sensitive fields masked by default).
- Payout statuses the UI renders: `pending`, `processing`, `paid`, `failed`, `exception` (see EARNINGS.md).

## Refund flow (merchant-visible)

- Refunds are executed by the payment provider + backend webhook (`payments/webhooks/{provider}`); the merchant never calls `POST /payments/{intentId}/refund` (that endpoint exists for customer-service staff with permissions).
- Merchant-facing refund signals:
  - Order terminal status `refunded` with the original totals.
  - `refund` ledger entry (negative) in the statement.
  - `refund.processed` notification (SMS + in-app).
- Cancellation fee rule (SHARED-FLOWS): before merchant acceptance → full refund subject to payment-provider timing; after acceptance → applicable fee shown to the user before confirmation. The merchant sees the fee reflected in the ledger, never computes it.

## Payout account setup

- Captured during onboarding document upload (bank/mobile-money details).
- Displayed masked everywhere; full details never leave the backend.
- "Request account change" opens a support ticket (`POST /support/tickets`) with subject prefilled; changes take effect after operations approval.
- Screen states: loading → masked value card → error + retry → success toast on request submission.

## TZS formatting (all money, both surfaces)

| Rule | Detail |
| --- | --- |
| Storage | integer minor units; `priceTZS`, `totalTZS`, `amountTZS` etc. never floats |
| Display | `TZS 12,500` — thousands separators via `Intl.NumberFormat('en-TZ')`-style grouping, currency always visible |
| Arithmetic | server-computed; client only formats, never recalculates totals |
| Inputs | integer input, no decimals; reject floats in catalogue price fields (422 if passed) |

## Business rules

- No hardcoded payment channels, phone numbers, or URLs — provider references (`providerReference`) and methods come from the API.
- MSW parity: masked `payoutAccount`, payout statuses, `refund` ledger entries, and `refunded`/`cancelled` order states in mocks.
