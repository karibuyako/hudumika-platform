# HUDumika Provider — Payments and Settlement

How money moves around the provider. The provider does not initiate payments; settlement is backend-driven (PAYMENTS.md, PAYOUTS-LEDGER.md). This doc covers what the provider surfaces show and the rules behind them.

## Who pays and when

| Stage | Money movement | Provider visibility |
| --- | --- | --- |
| Booking created | Customer payment intent (`created → pending → paid`) | None (customer-side) |
| Booking `completed` | `booking_earning` + `commission` ledger entries | Statement (`GET /payouts/me/statement`) |
| Payout cycle | Balance → payout batch → gateway → `paid` | `GET /payouts/me` (`PayoutSummary`) |
| Refund / dispute | `refund` entry; held payout | Statement + booking `refunded` / `disputed` status |

## On-site payments (quote-approved jobs)

Priced-after-inspection jobs are paid on site after the final quote (SERVICE-CATALOG.md, BOOKING-FLOW.md):

1. Customer approves the quote → work runs → provider issues the invoice (`POST /bookings/{bookingId}/invoice`).
2. Customer pays against the booking payment intent — reusing `/payments/intent` and the provider's `/payments/qr` collection code — with the invoice `totalTZS` as the expected amount.
3. Payment webhook flips `ServiceInvoice.status` `issued` → `paid`, booking moves to `completed` (with customer confirmation), and the ledger release (`booking_earning`) happens as usual.
4. The provider sees the `paid` pill on the invoice and the booking; `PAYMENT_AMOUNT_MISMATCH` on the intent is a customer-side error surfaced as "amount does not match the invoice". Never prompt off-platform payment (PRODUCT.md).

The provider never triggers the payment itself — it shows the QR/payment instructions from the booking and waits for the webhook-driven state change (never client callbacks).

On-site payment is complete only when the invoice shows `paid`: `ServiceInvoice.status` `issued` → `paid` after the webhook; the booking then completes (customer confirmation) and settles. The provider sees the `paid` pill on the invoice and the booking; until `paid`, the job stays at the pre-settlement state and the earnings entry is not released.

## Contract billing (B2B) — planned

Contract-bound bookings (CONTRACTS-SLA.md) bill the contracting organization rather than the customer individually. Organization billing — per-location billing accounts, invoice destinations, and approval rules for spend — is planned, not built; the current contract exposes only `ServiceContract.pricing` terms and `Booking.contractId`. Until it lands, contract jobs settle through the normal per-booking ledger path (`booking_earning` per occurrence); the provider never invoices an organization manually or off-platform.

Payment statuses the provider may see on a booking context: `PaymentIntent.status` `created`, `pending`, `paid`, `failed`, `refunded`, `partially_refunded` — surfaced only where the booking detail carries payment state (e.g. why a `paid` booking was refunded). Never rely on client callbacks for state; webhooks drive all changes.

## Settlement mechanics

- Provider earning is created only after the customer confirms completion (`completed`), per PAYOUTS-LEDGER.md.
- Commission is deducted at settlement time; the ledger shows it as a `commission` entry — the client never calculates it.
- `payoutCycleDays` (default 7) from `ProviderPrivate`; nightly batches per cycle: `draft → processing → settled`, failures become `exception` needing finance review.
- Payout method and account are configured at approval; sensitive fields (payout account) are masked in API responses by default — the provider sees masked values in settings.

## Payout statuses (UI mapping)

| `PayoutSummary.status` | UI | Action |
| --- | --- | --- |
| `pending` | neutral pill | None |
| `processing` | neutral pill + spinner | None |
| `paid` | `success` pill, `paidAt` | None |
| `failed` | `danger` pill | Support ticket (`TicketCreate`) |
| `exception` | `danger` pill + "under finance review" | Support ticket; finance resolves |

## Payment and refund awareness (booked services)

- Cancellation before provider acceptance → full refund (subject to payment-provider timing). No provider action.
- Cancellation after acceptance → cancellation fee per policy, shown before the customer confirms; provider sees `cancelled` + `refunded` statuses.
- Dispute → payout held until review; `dispute.opened` / `dispute.resolved` in-app notifications. Never message the customer asking for off-platform payment (PRODUCT.md: no off-platform payment prompts; masked contact relay).
- Error codes that can surface on payout screens: `PAYOUT_NOT_FOUND`, `PAYOUT_ACCOUNT_MISSING` (contact support — masked account), `PAYOUT_BATCH_EXCEPTION`, `LEDGER_INSUFFICIENT_BALANCE`.

## TZS formatting

- Money is integer TZS (1 TZS = 1 unit). Never floats.
- Render with `Intl.NumberFormat`-style grouping, currency always visible: `TZS 12,500`.
- i18n formatter shared between surfaces (`packages/shared/i18n`); format every money field at the boundary — no client-side arithmetic on totals (totals are server-computed `PriceBreakdown`).

## Screen states (earnings/payout screens)

| State | Behavior |
| --- | --- |
| Loading | Skeletons |
| Empty | "No payouts yet — earnings settle after completed bookings" |
| Error | Retry; keep last data on refresh failure |
| Success | Balance card (TZS), payout list, statement, cycle info |
