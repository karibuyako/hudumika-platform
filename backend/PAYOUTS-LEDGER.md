# HUDumika Payouts and Ledger

## Principles

- The ledger is **immutable** and append-only. No UPDATE, no DELETE.
- Every money movement is an entry with type, signed amount, running balance, and reference.
- Corrections are new `adjustment` entries, never edits.
- Ledger entries are created only after completion rules are satisfied:
  - Merchant earning: order `completed`.
  - Provider earning: booking `completed` (customer confirmed).
  - Rider delivery fee: order `delivered`.
- Commission (merchant/provider) and platform fee (customer) are deducted at settlement time.

## Entry types

| Type | Meaning | Sign |
| --- | --- | --- |
| order_earning | merchant share of a completed order | + |
| booking_earning | provider share of a completed booking | + |
| delivery_fee | rider fee for a delivered order | + |
| tip | customer gratuity credited to the rider on completed orders | + |
| commission | platform commission on an order/booking | - |
| adjustment | manual correction (reason required) | +/- |
| payout | cash-out to bank/mobile money | - |
| refund | returned money | - |
| bonus | promo or incentive | + |

## Payout lifecycle

```text
draft -> processing -> settled
                 \-> exception (needs finance review)
```

1. Batch created nightly per cycle (`payout_batches`) from all positive balances.
2. Entries marked `processing`; funds sent via gateway (bank transfer or mobile money).
3. Gateway confirmation flips entries to `paid`; batch to `settled`.
4. Failures become `exception` with reason; finance re-processes or pays manually — each action is audited.

## Reconciliation (finance team)

1. Compare provider gateway settlement report with platform ledger totals per day.
2. Flag mismatches as `exception` batches with reason.
3. Only finance can mark exceptions resolved; every resolution is an audit log entry.
4. `payouts/me/statement` gives earners the ledger view (opening/closing balance + entries).

## Dispute holds

- Order/booking `disputed`: related payout amount is held (not batchable).
- Hold released when dispute resolves: payout proceeds or refund entry is added.
- Hold state is a view over ledger references, not a separate table.

## Statement rules

- Earners see only their own entries (`account_owner_id` = their user id).
- Statements show opening/closing balance for the requested range.
- Money values are TZS minor units; apps render as `TZS x,xxx`.
