# Customer App — Payments

Rules from `backend/PAYMENTS.md` + `SHARED-FLOWS.md`. The app never decides money state; it renders
`PaymentIntent` and webhook-driven order/booking status.

## Price breakdown display

From `PriceBreakdown` (all fields integer TZS; client totals are advisory only):

| Row | Field | Example |
| --- | --- | --- |
| Subtotal | `subtotalTZS` | TZS 45,000 |
| Delivery fee | `deliveryFeeTZS` | TZS 2,500 |
| Platform fee | `platformFeeTZS` | TZS 1,000 |
| Tax | `taxTZS` | TZS 3,600 |
| Discount | `discountTZS` (−) | −TZS 5,000 |
| **Total** | `totalTZS` | **TZS 47,100** |

- Format via `Intl.NumberFormat('en-TZ')`-style grouping; always visible currency, never floats.
- Render `PriceBreakdown` before every confirm button ("Review total"), per PRODUCT.md acceptance:
  no payment without a valid address and total.

## Intent flow

```
1. POST /orders | POST /bookings        (Idempotency-Key)      → draft + intent reference
2. POST /payments/intent                (Idempotency-Key)      → PaymentIntent {status, amountTZS, providerReference}
3. Open provider flow with providerReference                    (STK push / USSD / card page)
4. POST /payments/{intentId}/confirm    (only where provider requires client confirm)
5. Signed webhook /payments/webhooks/{provider}  → status paid  (never trusted from client callback)
6. Order/booking moves to paid; UI updates on notification or refetch
```

Intent statuses shown in UI: `created`, `pending`, `paid`, `failed`, `refunded`,
`partially_refunded`.

## Checkout UX per method

| Method (`paymentMethod`) | UX | Success | Failure |
| --- | --- | --- | --- |
| `mpesa` | STK push to customer phone; "Enter M-Pesa PIN" state | `paid` → order `paid` | `failed` → retry/cancel |
| `tigo_pesa` | Tigo flow via `providerReference` | same | same |
| `airtel_money` | Airtel flow via `providerReference` | same | same |
| `card` | Card entry via card processor page (never store card data in app) | same | same |
| `cod` | Cash on delivery; no provider flow; confirmed at delivery by rider | Order placed without intent | — |

Payment method chips use trust-chip styling (M-Pesa/Tigo/Airtel/card) per DESIGN-SYSTEM.

## Error handling (switch on `code`, never message)

| Code | UI |
| --- | --- |
| `PAYMENT_INTENT_NOT_FOUND` | Recreate intent; refetch order |
| `PAYMENT_ALREADY_PAID` | Treat as success; refetch order/booking |
| `PAYMENT_METHOD_UNSUPPORTED` | Disable method chip; suggest others |
| `PAYMENT_PROVIDER_ERROR` | "Payment provider unreachable" + retry after `retryAfterSeconds` |
| `PAYMENT_SIGNATURE_INVALID` | Contact support (server-side integrity) |
| `PAYMENT_AMOUNT_MISMATCH` | Price changed; refetch totals and re-show breakdown |
| `PAYMENT_REFUND_EXCEEDS_AMOUNT` | Never surfaced by normal flows; show support CTA |
| `PAYMENT_REFUND_PENDING` | "Refund being processed" info banner |
| `RATE_LIMITED` (429) | Resend/retry timers from `retryAfterSeconds` |

Related order/booking errors: `ORDER_NOT_PAYABLE`, `ORDER_EMPTY`, `ORDER_MERCHANT_CLOSED`,
`ORDER_PRICE_CHANGED`, `BOOKING_TIME_IN_PAST`, `BOOKING_DURATION_INVALID`.

## Idempotency key generation

- Generated client-side per mutation attempt: `customerId + action + nonce` hashed (uuid v4 nonce).
- Sent on `POST /orders`, `POST /bookings`, `POST /payments/intent`, refunds.
- Retry with the same key replays the stored response — never double-charge, never double-insert.
- Same key reused across a retry after network failure; a fresh key is generated for a genuinely
  new action (e.g. new attempt after cancel).
- Keys are not logged with request bodies.

## Refund display

- Refunds are server-triggered (cancel policy, disputes, finance); the app only renders them.
- Card on order/booking or payments screen: "Refunded TZS 47,100" with intent `paidAt` local time
  and `providerReference`.
- `refunded`/`partially_refunded` intent status → green pill; `refund.processed` push/SMS notifies.
- Rules reminder: full refund before acceptance; fee minus refund after acceptance; disputes hold
  payout until review.

## Coupons at checkout

- "Apply coupon" row above the breakdown: eligible `claimed` coupons for this merchant
  (`GET /coupons/me?status=claimed`, filtered by merchant campaign).
- Client pre-check `subtotalTZS ≥ minimumSpendTZS` is advisory only; the server is the authority —
  `COUPON_MINIMUM_SPEND_NOT_MET` renders inline under the coupon row.
- The applied discount flows into `PriceBreakdown.discountTZS` (existing row); `totalTZS` is
  always server-recomputed and `discountTZS` never exceeds `subtotalTZS`.
- `COUPON_ALREADY_USED` / `COUPON_EXPIRED` → remove the coupon from the selector and refetch the
  wallet. See `WALLET-COUPONS.md` for the claim/wallet flow.

## Group buy purchase payment

- Purchase charges the customer at purchase time via `POST /group-buys/{groupId}/purchase`
  (`Idempotency-Key`); success returns `Voucher[]` (201) — one voucher per unit.
- Settlement to the merchant happens **on redemption**, not purchase (`group_buy_settlement`
  ledger entry; backend `PAYMENTS.md`) — invisible in the customer app.
- Failure/retry: standard `PAYMENT_*` codes apply; `GROUP_BUY_ENDED` / `GROUP_BUY_QUANTITY_EXCEEDED`
  render inline and block the purchase.

## Voucher refund states

- Voucher refunds are server-triggered (expiry beyond `validityDays`, policy) — never initiated
  in-app (same rule as order refunds).
- `VOUCHER_REFUND_PENDING` → info banner on the voucher card; resulting `expired` / `refunded`
  statuses render in the wallet; `refund.processed` push/SMS notifies as with order refunds.
- Refund eligibility: voucher `unused` within `validityDays` (server-enforced).

## Security notes

- Never log `providerReference`, card data, phone PINs, or full payment payloads (PRODUCT.md
  acceptance criteria: sensitive payment data never in logs/analytics).
- Never trust a client callback for state; always refetch after webhook-driven notification.

## Split payments (planned)

Split/group payments for shared services are a planned contract addition — the escrow model (funds held until completion) remains the baseline for all service payments.
