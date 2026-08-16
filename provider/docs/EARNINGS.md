# HUDumika Provider — Earnings

Earnings dashboard and ledger statement for the provider surface. Money is integer TZS everywhere; never float.

## Where earnings come from

- Booking earning: provider share of a `completed` booking (customer-confirmed) — a `booking_earning` ledger entry is created only after completion rules are satisfied (PAYOUTS-LEDGER.md).
- Pricing basis: `baseRateTZS` (starting price on profile) + per-job price from the booking's `PriceBreakdown`. The customer's total includes `platformFeeTZS`; the provider's earning is server-computed.
- Commission: platform's share of a booking, set per provider at approval (per GLOSSARY); deducted at settlement time as a `commission` ledger entry (negative). Clients never compute commission — it is read from the ledger.

## settled = payout eligible

The job machine ends at `settled` (`BookingStatus`): after the customer confirms (`completed`) and the invoice is `paid`, the server settles the booking and releases the ledger entry — `settled` is the payout-eligible state. `booking_earning` entries are created at settlement, not at `completed`.

- Earnings dashboard, pending vs settled: **pending** = `completed` jobs whose settlement has not yet been released (invoice paid, awaiting the settlement pass); **settled** = released `booking_earning` entries sitting in the balance, batchable on the next payout cycle.
- The job timeline shows `settled` as the terminal happy-path state; a `disputed` booking never reaches `settled` while the hold is active (payout held, not batchable).
- `GET /bookings/me?status=settled` filters history; the earnings list shows the settled amount with the booking reference.
- Screen states apply to the pending/settled split view: loading skeleton, empty ("No settled earnings yet"), error + retry, success with amounts formatted `TZS 12,500`.

## Ledger statement

`GET /payouts/me/statement?from&to` → `LedgerStatement` (`openingBalanceTZS`, `closingBalanceTZS`, `entries[]`). Immutable, append-only; corrections appear as `adjustment` entries, never edits.

| `LedgerEntry.type` | Sign | Provider sees |
| --- | --- | --- |
| `booking_earning` | + | Completed booking share, `referenceId` → booking detail |
| `commission` | - | Platform commission on a booking |
| `adjustment` | +/- | Manual correction (finance, reason required) |
| `payout` | - | Cash-out to bank / mobile money |
| `refund` | - | Refunded booking money |
| `bonus` | + | Promo or incentive |

Statement UI: date range picker (default: current cycle), running `balanceTZS` per entry, export per PRODUCT.md ("provider can export earnings and job history"). Loading/empty ("No activity in this period")/error/retry states; amounts formatted `TZS 12,500`.

## Invoice breakdown on the job

Per-job earnings are visible in the service invoice (SERVICE-CATALOG.md) before they reach the ledger: `ServiceInvoice` breaks the total into `laborTZS` + `tripFeeTZS` + `partsTZS` − `discountTZS` + `taxTZS` = `totalTZS`. The provider reads the breakdown read-only; `totalTZS` is server-computed and only what it settles on enters the ledger. The invoice detail screen shows each line (labor, trip, parts with quantities, discount, tax) with `TZS 12,500` formatting.

## Warranty and claims

Warranties (SERVICE-CATALOG.md) have no ledger impact while unresolved: issuing a warranty changes `ServiceWarranty.status` only. A claim (`claimed`, opened via support ticket) does not create or hold ledger entries until ops resolves it — the payout of the original booking is unaffected, and a resolution that involves money goes through the normal `adjustment` / `refund` entry path with a reason. The earnings UI shows warranty status on the job but never implies a pending amount for it.

## Payout history

`GET /payouts/me?limit&cursor` → `PayoutSummary[]`.

| `status` | UI pill | Meaning |
| --- | --- | --- |
| `pending` | neutral | Queued for the next nightly batch |
| `processing` | neutral | Batch sent to gateway |
| `paid` | `success` | Gateway confirmed; `paidAt` shown |
| `failed` | `danger` | Send failed; retry/exception path |
| `exception` | `danger` | Batch exception; finance review required |

## Payout cycle

- `ProviderPrivate.payoutCycleDays` (default `7`) — the provider's settlement cycle.
- Batches are created nightly per cycle (`draft → processing → settled`, failures → `exception`) from all positive balances.
- `pending` → batched → gateway → `paid`. Provider-facing copy: "Payouts run every 7 days (per your cycle); today's balance settles in the next batch."

## Dispute holds

- Booking `disputed`: the related payout amount is held — not batchable — until review resolves (PAYOUTS-LEDGER.md). `dispute.opened` / `dispute.resolved` are in-app notifications.
- Hold is a view over ledger references, not a separate table; the provider sees the affected amount in the statement and the `disputed` status on the booking.
- Resolution: payout proceeds or a `refund` entry is added.

## Reliability impacts on earnings

- No-shows, late arrivals, cancellations after acceptance, and repeated declines lower the reliability score (0–100, server-side). The score is displayed read-only in earnings/profile with an explanatory note; it also influences dispatch ranking (fewer requests → less earning opportunity) but is never client-computed.
- Provider late cancellation also notifies operations.

## Quality signals and tier progression

Quality signals (completion rate, on-time rate, cancellation rate, repeat rate, response time) and multi-dimensional review dimensions (professionalism, punctuality, quality, communication, priceTransparency, cleanliness, wouldRecommend — TRUST-SAFETY.md) feed the provider tier: `bronze` → `silver` → `gold` → `platinum` (`TrustProfile.tier`, GET /providers/me/trust).

- Tier benefits (priority matching, lower commission, badge, support priority) are defined platform-side; the provider app renders the tier read-only with the earned benefits list where the API exposes it.
- The trust/risk profile (`trustScore`, `riskScore`) is distinct from earnings but impacts it indirectly: flagged risk behaviors (`off_platform_payment`, `price_manipulation`, `false_completion`, `fake_reviews`, `location_spoofing`, `repeated_cancellation`, `account_sharing`, `identity_mismatch`) can hold payouts or reduce matching, which reduces earning opportunity. Scores are read-only; no client-side earnings math.

## Recurring plan settlement

Recurring service plans (CONTRACTS-SLA.md) settle per occurrence: each recurring booking (`recurringPlanId`) is an ordinary booking with its own invoice, completion, and one `booking_earning` entry at its own settlement. The earnings dashboard may group recurring occurrences under the plan label when the API provides `recurringPlanId` on the booking, but amounts are always per-booking ledger entries — never a plan-level payout or client-computed total.

## Screen state checklist

| State | Behavior |
| --- | --- |
| Loading | Skeleton balance card + payout list |
| Empty | "No payouts yet" + explanation that earnings settle after `completed` bookings |
| Error | Fetch failed → retry; statement range failed → retry keeping range |
| Success | Balance, cycle info, payout list, statement entries |

## Productivity metrics

Jobs per day, revenue per hour, and utilization rate are computed from job history (planned dashboard extension alongside benchmarking).
