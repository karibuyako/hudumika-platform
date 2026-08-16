# HUDumika Payments

## Supported methods

| Method | Integration | Webhook |
| --- | --- | --- |
| M-Pesa | Daraja API (C2B) | signed callback |
| Tigo Pesa | Tigo money gateway | signed callback |
| Airtel Money | Airtel Africa gateway | signed callback |
| Card | CardTonic / card processor | signed webhook |
| COD | — | collected at delivery, recorded manually with proof |

## Intent lifecycle

```text
created -> pending -> paid -> refunded / partially_refunded
                 \-> failed
```

1. Client creates an order/booking draft (`Idempotency-Key` header).
2. Client creates `POST /payments/intent` (also idempotent).
3. Client opens the provider flow (STK push, USSD, or card page) using `providerReference`.
4. Provider sends a **signed webhook** to `/payments/webhooks/{provider}`.
5. Backend verifies the signature, idempotently marks the intent `paid`, and moves the order/booking to `paid`.
6. Client callbacks are never trusted for state changes — only webhooks.

## Idempotency

- `Idempotency-Key` required on: order creation, booking creation, payment intent creation, refunds.
- Key is `customerId + action + clientNonce` hashed; stored in Redis `SETNX` with 24 h TTL.
- On repeat key: replay the stored response; never double-charge.

## Price computation

Prices are always recomputed server-side from catalogue snapshots:

```text
total = subtotal + delivery_fee + platform_fee + tax - discount
```

- `platform_fee` and `delivery_fee` come from server config, not the client.
- The client's totals are advisory only and revalidated before payment.

## Refunds

- Before merchant/provider acceptance: full refund.
- After acceptance: per cancellation policy (`SHARED-FLOWS.md`), fee shown before confirmation.
- Refunds require a reason and an audit log entry; finance role needed above a threshold (e.g. > 200,000 TZS).
- Disputed orders: payout is held until review completes.

## Error codes (payment)

`PAYMENT_INTENT_NOT_FOUND`, `PAYMENT_ALREADY_PAID`, `PAYMENT_METHOD_UNSUPPORTED`,
`PAYMENT_PROVIDER_ERROR`, `PAYMENT_SIGNATURE_INVALID`, `PAYMENT_AMOUNT_MISMATCH`,
`PAYMENT_REFUND_EXCEEDS_AMOUNT`.

## Merchant wallet and withdrawals

- The merchant wallet (`GET /wallet`) is a **projection of the ledger**, never a second source of truth.
- `withdrawableTZS` = settled balance minus pending payouts and dispute holds.
- Withdrawal request (`POST /wallet/withdrawals`) creates signed ledger entries (`payout`) and is subject to minimum amount and daily rate limits.
- Withdrawals move through `pending → processing → paid/failed/exception`; failures require a reason and are audited.
- COD and dine-in cash are recorded against the ledger with evidence (manual proof flow for cash).

## Chargebacks and disputes

- Card chargebacks are handled through the gateway's dispute flow; the platform submits evidence (escrow state, completion confirmation, POD) and tracks the case to resolution.
- Chargeback abuse is a `risk_events` signal (`payment_abuse`) feeding trust scores.

## Escrow principle

Customer payments for services are held in escrow (captured but not released) until the customer confirms completion (`completed` → `settled`). Disputes hold the escrow until review; refunds release it back to the customer. Never release escrow on a client callback — only on server-side completion confirmation.

## Group buy settlement

- Group buy sales settle to the merchant wallet on voucher redemption (not on purchase).
- Unused vouchers beyond `validity_days` expire; expiry refunds the customer and reverses the receivable.
- Voucher refunds require a reason and follow the refund threshold rules.

## Outbox pattern

Payment state changes are written to `outbox` in the same transaction; a worker
sends provider requests and retries with exponential backoff. This guarantees
at-least-once delivery and makes webhook reconciliation safe.
