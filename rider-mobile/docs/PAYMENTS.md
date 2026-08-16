# HUDumika RIDER — Payments

Riders never compute money. All fees, balances, and payouts are server-side; the app only renders values from the contract.

## Delivery fee computation (server-side)

- The delivery fee is a line in `PriceBreakdown` (`deliveryFeeTZS`) computed at order creation by the backend from distance, vehicle, order size, and service rules. It is also the rider's earning basis.
- No client-side pricing: the rider app never calculates, estimates, or displays a pre-computed "expected fee" — it reads `Order.totals.deliveryFeeTZS` and `LedgerEntry` values only.
- `PriceBreakdown` fields (all server-computed): `subtotalTZS, deliveryFeeTZS, platformFeeTZS, taxTZS, discountTZS, totalTZS`.
- Rider earnings timing: the `delivery_fee` ledger entry is created when the order reaches `delivered` (completion rule in `PAYOUTS-LEDGER.md`). A pending delivery shows no earnings until then.

## Payout method setup

- The payout method (bank account or mobile money number) is configured through the application/approval flow and stored server-side; sensitive fields are masked in API responses by default (per `AUTH.md`).
- The rider app does not create or edit payout destinations directly via the contract (no rider payout-account endpoint exists). Changes go through support (`POST /support/tickets`) or the onboarding/ops flow.
- `PayoutSummary.method` labels the destination type; the destination itself is never rendered in full.

## COD flow

- COD orders are those with `paymentMethod: cod` (contract enum: `mpesa, tigo_pesa, airtel_money, card, cod`) on the order.
- At delivery the rider collects `totals.totalTZS` in cash and records "Collected" in the delivery confirmation flow (DELIVERY-FLOW.md).
- COD collected is cash to the merchant/customer, not rider earnings; rider earnings remain the delivery fee.
- Recording is confirmation only — the amount is bound to the server total, the rider never enters an amount.
- COD orders carry a handling fee (`codFeeTZS`) as a line in the rider fare (`GET /orders/{orderId}/fare`, EARNINGS.md); it is part of the fare and never collected separately — the rider collects `totals.totalTZS` only, and `codFeeTZS` appears in the fare breakdown, not the collected cash.
- Mismatch/discrepancy path: support ticket with `TicketCreate.orderId` set.

## Payout statuses and actions

| Status | Rider action |
| --- | --- |
| `pending` / `processing` | none (informational) |
| `paid` | none; `paidAt` shown |
| `failed` | visible, actionable: support ticket (payout context prefilled); app never auto-retries |
| `exception` | visible, actionable: support ticket; finance review server-side |

Every failed/exception payout surfaces both in the payout list and via `payout.failed` / `payout.exception` notifications.

## Money invariants (app-level)

- All amounts are `integer` TZS; render `TZS 12,500` with thousands separators.
- Never use float arithmetic on money; no `toFixed`, no client sum of fees for display (use `closingBalanceTZS` and `balanceTZS` from the ledger).
- Disputed orders hold related payouts server-side; the app renders held amounts as "Held — under review", from ledger data only.

## Security notes

- Payout account data is masked; the app never logs or persists payout destinations.
- All payment-state changes come from signed webhooks/ledger events, never client callbacks (per SHARED-FLOWS payment flow).
