# HUDumika RIDER — Earnings

Endpoints: `GET /payouts/me` (`PayoutSummary[]`), `GET /payouts/me/statement?from=&to=` (`LedgerStatement`). Money is TZS integer minor units; render as `TZS 12,500` (`Intl.NumberFormat('en-TZ')`-style grouping), never floats, never bare numbers.

## Earnings dashboard

| Section | Data | Source |
| --- | --- | --- |
| Today / week / month totals | Sum of rider-relevant ledger entries in range | statement entries filtered client-side for display |
| Delivery fee per order | `totals.deliveryFeeTZS` context + `delivery_fee` ledger entries | order + ledger |
| Tips (day/week/month) | Sum of `tip` entries in range | statement entries filtered client-side for display |
| Payout status | latest `PayoutSummary` | `GET /payouts/me` |
| Reliability/rating | `RiderPrivate.rating`, `reviewCount` | `GET /riders/me` |

- Totals are derived from the ledger (server-computed), shown read-only.
- Loading: skeletons. Empty (no entries in range): "No earnings in this period" + date-range picker. Error: retry. Success: summary cards + statement list.

## Earnings analytics (avg per trip, top hours)

- `GET /riders/me/performance` → `RiderPerformance` adds analytics for the earnings dashboard: `avgPerTripTZS` (integer, nullable — mean earnings per completed trip in the window, `TZS x,xxx`) and `topHours` (`string[]` — best-performing hours of the week, e.g. `"18:00"`) plus `onlineHoursWeek` (PERFORMANCE.md).
- Dashboard rendering: "Avg per trip" stat card (`TZS x,xxx`; hidden when `null` — pool too small, never a placeholder value) and a "Top hours" strip (hour chips from `topHours`, e.g. "18:00 · 19:00 · 20:00") — the hours are server-derived labels, rendered as chips, never as a promise of earnings.
- The analytics are derived-performance views and may lag the live ledger; money still comes from the ledger and fare breakdown (EARNINGS.md data honesty in PERFORMANCE.md). States: loading (stat skeleton) → `null` fields hidden → error (retry) → success (stat card + chips).

## Fare breakdown (per order)
- `GET /orders/{orderId}/fare` → `FareBreakdown` `{orderId, baseTZS, distanceTZS, timeTZS, surgeMultiplier, surgeTZS, tipTZS, codFeeTZS, waitPayTZS, bonusTZS, totalTZS, currency}` for orders assigned to this rider (assigned or completed).
- Sum rule: `baseTZS + distanceTZS + timeTZS + surgeTZS + tipTZS + codFeeTZS + waitPayTZS + bonusTZS = totalTZS` — server-computed; the app renders rows, never sums itself.
- The fare model mirrors Meituan: base fare (`baseTZS`), per-km distance fee (`distanceTZS`), time component (`timeTZS`), peak/weather surge — `surgeMultiplier` is the factor (default 1.0, applied to the base fare) and `surgeTZS` the resulting money line (rendered "Surge ×1.5 — TZS 1,500" style), tips (`tipTZS`, credited via the `tip` ledger entry), COD handling fee (`codFeeTZS`, PAYMENTS.md), restaurant wait-time compensation (`waitPayTZS` — paid waiting, DELIVERY-FLOW.md), mission/boost bonus (`bonusTZS`, credited via the `bonus` ledger entry).
- Transaction history: every fare row in Delivery History shows its surge line — `surgeTZS > 0` renders the multiplier badge + amount; a surge-free order shows no surge row (factor 1.0 never rendered as a money claim).
- 404 `FARE_NOT_AVAILABLE`: order not assigned to this rider — hide the Fare row and refetch the order list.
- Delivery history rows deep-link to the fare breakdown screen; totals render `TZS 12,500`-style with separators, integer only, `currency` default `TZS`.
- States: loading (skeleton rows) → error (retry; `FARE_NOT_AVAILABLE` variant hides the row) → success (line-item rows with `totalTZS`).

## Payout history (`PayoutSummary`)

| Field | Notes |
| --- | --- |
| `amountTZS` | amount paid out (negative ledger effect, shown as payout card amount) |
| `status` | `pending \| processing \| paid \| failed \| exception` |
| `method` | payout method (bank or mobile money) |
| `createdAt` / `paidAt` | UTC → local time |

Status pill colors per DESIGN-SYSTEM: `paid` → `success`; `pending`/`processing` → neutral (`ink-900`); `failed`/`exception` → `danger` + "actionable" CTA.

| Status | UI |
| --- | --- |
| `pending` | "Scheduled for next payout cycle" |
| `processing` | "Being processed" |
| `paid` | "Paid" + `paidAt` local date |
| `failed` | "Payment failed" + action: retry/support ticket (see PAYMENTS.md) |
| `exception` | "Needs review" + CTA to support; finance resolves server-side |

Payout failures are visible and actionable (PRODUCT.md acceptance criteria): every `failed`/`exception` card links to a support ticket prefilled with the payout context; the app never retries payouts itself.

## Ledger statement (`LedgerStatement`)

- Header: period (`from`, `to`), `openingBalanceTZS`, `closingBalanceTZS`.
- Entries list (newest first): `type`, signed `amountTZS` (+/−), running `balanceTZS`, `referenceId`/`referenceType`, `createdAt` local time.

| `LedgerEntry.type` | Rider meaning | Sign |
| --- | --- | --- |
| `delivery_fee` | fee for a delivered order | + |
| `bonus` | promo/incentive credit | + |
| `tip` | customer gratuity on a completed order | + |
| `adjustment` | manual correction (reason in reference) | +/− |
| `payout` | cash-out | − |
| `refund` | returned money (rare for riders) | − |

`order_earning`/`booking_earning`/`commission` entries never appear in rider statements (merchant/provider concepts).

## Payout cycle

- Nightly batch per cycle from all positive balances (`PAYOUTS-LEDGER.md`): `draft → processing → settled`, failures → `exception` with finance review.
- Ledger credit timing: rider `delivery_fee` entry is created only when the order reaches `delivered` (completion rule). "Available balance" = `closingBalanceTZS` excluding in-cycle payouts.
- Dispute holds: if an order goes `disputed`, related payout amounts are held (not batchable) — the statement may show a held amount; the app renders it as "Held — under review" derived from the ledger view, never from a client computation.

## Bonuses and incentives

Bonuses arrive as `bonus` ledger entries (sign +) with a reference; there is no separate incentives API — render them from the statement. Notification events `payout.paid` / `payout.failed` / `payout.exception` drive banners and badge counts.

## Zone boosts (surge bonuses)

- Completing a delivery inside a high-demand zone (`demandLevel` `high`/`critical`, DISPATCH-FLOW.md heat map) earns a zone boost: credited as a `bonus` ledger entry (sign +) referencing the zone/order; the statement row shows the zone context ("Zone boost — {zone name}").
- The surge portion of the fare (`surgeTZS`) and the zone boost (`bonusTZS`) are separate lines: the first lives in `FareBreakdown`, the second in the ledger — both server-computed, never client-calculated.
- `surge.active` push/in-app (zone boost started) refreshes the earnings summary; the boost is paid via the nightly payout cycle like any `bonus` entry.

## Leaderboard earnings metric

- `GET /riders/me/leaderboard?metric=earnings` ranks riders by period earnings (daily/weekly/monthly, PERFORMANCE.md) — the value shown is the ranking figure from the derived performance view.
- It is a ranking number, never a wallet balance: the rider's actual money always comes from the ledger statement (`closingBalanceTZS`, payout cycle below). The leaderboard screen labels the metric clearly ("Earnings — this week") and never links to payout actions.

## Missions and incentives (`rider_missions`)

- Source: `GET /riders/me/missions?status=active|completed|expired` → `RiderMission[]` `{id, title, description?, targetDeliveries, completedDeliveries, rewardTZS, status, claimed, canClaim, startsAt?, endsAt?}` — progress is server-derived from completed deliveries in the mission window.
- Display: Missions section (Home/Earnings) — card with title, description, progress bar `completedDeliveries`/`targetDeliveries`, reward `TZS x,xxx` (thousands separators, never floats), status pill (`active` `success`, `completed` neutral, `expired` muted), window `startsAt`/`endsAt` in local time.
- Claimable rewards: a mission with `canClaim: true` shows a Claim button on the card — tapping it claims the reward server-side and the card flips to `claimed: true` (button replaced by a "Claimed" state). While the delivery threshold is unmet, `canClaim: false` → the button is disabled with progress copy ("{n} of {target} deliveries"); any premature claim attempt returns `PROMOTION_NOT_CLAIMABLE` (shown inline, card refetches). The claim is a server action; the reward lands as a `bonus` ledger entry (sign +) with the mission reference.
- Reward credit: when a mission completes, the reward `rewardTZS` is credited as a `bonus` ledger entry (sign +) and `rider.mission_completed` pushes/in-apps the rider; the statement then shows the entry with the mission reference. The app never estimates the reward — it renders `rewardTZS` and the ledger.
- States: loading skeleton → empty ("No missions" with the status filter) → error + retry → success (cards; progress bar animates from server values only; claim button per `canClaim`/`claimed`).
- Planned: daily mission bundles (Meituan-style batches of several missions) — backend contract addition, marked planned in ROADMAP P10.

## Trip batch earnings (multi-stop trips)

- Source: `GET /riders/me/trips` (active) and `GET /riders/me/trips/{tripId}` (detail) → `Trip.earningsTZS` — the batch summary: fares + tips + bonuses across all of the trip's orders, server-computed (the app never sums it).
- On completion the server emits `trip.completed` — an in-app batch summary card with the earnings figure; the Earnings summary refetches and shows `earningsTZS` as `TZS x,xxx` (separators, integers only, never floats).
- The underlying money still lands as per-order `delivery_fee`, `tip`, and `bonus` ledger entries as each order completes; `Trip.earningsTZS` is the rolled-up read-only figure, not a separate ledger entry.
- States: loading (trip card skeleton) → empty (`TRIP_NOT_FOUND` — no trip in the period) → error (retry) → success (summary card + per-stop rows).

## Promo order bonuses

- A promo order carries `Order.promoCode`; on completion the bonus is credited as a `bonus` ledger entry (sign +) referencing the promo code — the statement row shows the reference ("Promo — {promoCode}").
- The rider app never applies or validates codes (`PROMO_INVALID` rejects unknown/expired codes at order level); it renders `promoCode` read-only on Order Detail and shows the credited entry from the statement (DISPATCH-FLOW.md).
- States: loading (statement skeleton) → empty ("No promo bonuses in this period") → error (retry) → success (bonus rows with the promo reference).

## Tips (customer gratuity)

- A customer tips after the order is delivered/completed via `POST /orders/{orderId}/tip` — customer-callable; the rider app never posts a tip.
- `tip.received` (push, in-app) arrives with the tip; Home earnings summary and order detail (`Order.tipTZS`) refresh from refetched server data. The tip is credited as a `tip` ledger entry (sign +) referencing the order (PAYOUTS-LEDGER.md); it is never estimated client-side.
- Server rules: `TIP_NOT_ALLOWED` (order not completed) and `TIP_EXCEEDS_LIMIT` — the rider UI never triggers them; a stale screen just refetches and shows the current order state. Daily/weekly/monthly tip totals derive from `tip` entries in the statement range (display filter only).
- States: loading skeleton → empty ("No tips in this period") → error + retry → success (tip cards + totals).

## Shifts

- Shift card on Home: `GET /riders/me/shifts?scope=current|upcoming|past` → `RiderShift[]` (NAVIGATION.md).
- `RiderShift`: `{id, riderId, startsAt, endsAt?, status, deliveriesCompleted, earningsTZS, cashCollectedTZS, cashReconciled, clockedInAt?, clockedOutAt?}` — `status` ∈ `scheduled | active | completed | cancelled`.
- Lifecycle: `scheduled` → `active` (clock-in) → `completed` (clock-out with reconciliation); `cancelled` is ops-only.
- Clock-in: `POST /riders/me/shifts/clock-in` `{shiftId, lat?, lon?}`; errors `SHIFT_NOT_FOUND`, `SHIFT_ALREADY_ACTIVE` (one active shift at a time).
- Clock-out: `POST /riders/me/shifts/clock-out` `{shiftId, cashCollectedTZS?, cashReconciled?}`; errors `SHIFT_CLOCKOUT_WITHOUT_CLOCKIN`, `SHIFT_CASH_MISMATCH`.
- Cash reconciliation at clock-out: the rider enters `cashCollectedTZS` (COD collected in the shift); while `cashReconciled: false` the server returns `SHIFT_CASH_MISMATCH` and the shift stays `active` with a reconciliation notice — re-submit with `cashReconciled: true` → `completed` (DELIVERY-FLOW.md).
- `shift.reminder` push 15 min before `startsAt`; `shift.started` / `shift.ended` in-app notifications refresh the shift card.
- Shift summary (post clock-out): `deliveriesCompleted`, `earningsTZS`, `cashCollectedTZS` read-only; TZS rendered with thousands separators, never floats; earnings/cash masked to the rider only (SECURITY.md).
- States: loading skeleton → empty ("No shifts" per scope tab) → error + retry → success (cards with status pill per DESIGN-SYSTEM: `active` `success`, `completed` neutral, `cancelled` muted).

## Rider level benefits

- `GET /riders/me/performance` → `RiderPerformance.level` (`bronze | silver | gold | platinum`, default `bronze`) — the rider's star tier, derived server-side from performance (PERFORMANCE.md); `levelBenefits[]` lists the active benefits.
- Benefits are config-driven (e.g. priority dispatch eligibility, lower withdrawal fees) and render from the server list, never hardcoded client-side; Profile shows the level badge with the benefit list. The level is a status tier, not a money computation — earnings always come from the ledger and fare breakdown.

## Predictive earnings and surge timing (Phase 3)

- Surge timing: `GET /dispatch/forecast` zones (`predictedSurgeMultiplier`, `windowFrom`/`windowTo`) drive a "Best time to ride" hint on Earnings ("Zone X predicted high demand 18:00–18:15") — repositioning before a predicted surge window may raise earnings; the hint is forecast-derived copy, never a money promise (DISPATCH-FLOW.md).
- Surge ramp: surge multipliers ramp gradually (reinforcement-learning variant, `backend/AI-LAYER.md`) — no abrupt drops; the fare row always renders the exact server `surgeMultiplier`/`surgeTZS`.
- Earnings forecast (planned): a forecasted-day-earnings card is planned (backend model + contract addition, `backend/ROADMAP.md` M10c); until it ships the card renders "Coming soon" — never a client-computed estimate. Earnings always come from the ledger.

## Expense deductibles and training rewards (Vehicle & Tools)

- Deductible expenses: `deductible: true` rows (`GET`/`POST /riders/me/expenses`, VEHICLE-TOOLS.md) render deductible vs non-deductible totals (`TZS x,xxx`; display-only sums of returned rows). The tax-season tie-in is the tax export (`POST /riders/me/exports`, `reportType: tax`, CSV/PDF/JSON — VEHICLE-TOOLS.md); exports never create or modify ledger entries — the ledger stays the money source of truth.
- Training completion reward: `POST /riders/me/training/{moduleId}/complete` → `TrainingModule.rewardTZS` (nullable). The reward is credited server-side as a `bonus` ledger entry (sign +) with the module reference — the statement shows it like any bonus; the app renders `rewardTZS` on the certificate card and the statement entry, never credits or estimates (VEHICLE-TOOLS.md, EDUCATION.md).
- States: expenses — loading / empty ("No expenses in this period") / error + retry / success; export — 202 accepted card (`jobId`, `status` pill, `EXPORT_IN_PROGRESS` guard); training — loading / `TRAINING_MODULE_NOT_FOUND` refetch / success with certificate + reward.

## TZS formatting rules

- Always show the `TZS ` prefix; thousands separators; integer only (unit = 1 TZS).
- Use `Intl.NumberFormat('en-TZ', { style: 'currency', currency: 'TZS', maximumFractionDigits: 0 })` with a fallback formatter; never `toFixed` on money.
- Dates: UTC from API → local timezone rendering via the i18n date helper.

## State checklist

| State | Behavior |
| --- | --- |
| Loading | summary + list skeletons |
| Empty | no payouts / no entries → empty-state copy with period picker |
| Error | `ErrorResponse.message` + retry |
| Retry | refetch `payouts/me` and `statement` together |
| Success | summary cards, payout list, statement rows |
