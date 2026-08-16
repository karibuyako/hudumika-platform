# HUDumika Merchant — Order Flow

Merchant order management: incoming queue, accept, status advancement, cancellation, detail, completion, search, enterprise orders, batch actions, claims, refunds, and dispute awareness. Status values are the exact `OrderStatus` strings from the contract.

## Statuses the merchant sees

| Status | Meaning in UI |
| --- | --- |
| `paid` | New incoming order, waiting for merchant decision. Push + in-app alert. |
| `merchant_accepted` | Accepted; waiting for merchant to start preparation. |
| `preparing` | In preparation; merchant sets progress. |
| `rider_assigned` | A rider is on the way to pick up; merchant can no longer advance (rider-owned from here). |
| `picked_up` / `delivering` / `delivered` | Rider progress; merchant watches live. |
| `completed` | Delivery confirmed; ledger earning eligible (payouts created after completion rules). |
| `cancelled` / `refunded` / `failed` / `disputed` | Terminal (dispute holds the payout until review — EARNINGS.md); cancellation fees and refund rules apply (below). |
| `draft` / `pending_payment` | Not merchant-visible (customer-owned). |

## Incoming orders (queue)

- Source: `GET /orders/me?status=paid` polling + push (mobile) / in-app notification. Rows: item names, `totals.totalTZS`, `createdAt` (local time), accept CTA. No client-enforced acceptance window — the server rejects stale accepts with 409.
- Screen states: loading skeleton → empty ("No new orders") → error + retry → queue.

## Accept order

- `POST /orders/{orderId}/accept` → `Order` (moves to `merchant_accepted`); 409 means already transitioned (another device or timeout) — conflict banner, refetch, never double-accept.
- Decline: before acceptance the merchant rejects with a reason — `POST /orders/{orderId}/reject` (below). After acceptance there is no rejection path; cancellation rules apply (SHARED-FLOWS: fee shown before confirmation).

## Reject order with reason

- `POST /orders/{orderId}/reject` (body `reason` ≤500) is valid only on an order not yet accepted (server-enforced); `ORDER_ALREADY_REJECTED` on double-reject (button disables after first 200), `ORDER_REJECT_AFTER_ACCEPTANCE` on post-acceptance attempts (banner + refetch).
- Flow: confirm dialog with reason picker (stock reasons + free text ≤500) → spinner → success (order leaves the queue, `order.rejected` notifies the customer) → error + retry. Outcome: full refund subject to payment-provider timing (SHARED-FLOWS); the merchant sees the terminal state via the queue.

## Rush / hurry-up handling

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/orders/{orderId}/rush` | Customer requests a hurry-up (204, event recorded) |
| GET | `/orders/rush?status=` | Rush queue (`open` / `replied` / `resolved`) |
| POST | `/orders/{orderId}/rush-reply` | Merchant replies, body `message` ≤300 → `RushOrder` |

- `Order.rushRequestedAt` is set server-side; `order.rush_requested` push + in-app notifies the merchant; `rush.replied` (push) notifies the customer on reply. `RushOrder`: `orderId`, `status` (`open`/`replied`/`resolved`), `requestedAt`, `repliedAt`, `replyMessage`.
- UI: rush banner on the order card ("Customer asked to hurry — X ago", local time); the queue tab lists open rushes with a reply box (message ≤300).
- Errors: `RUSH_NOT_OPEN` (order no longer rushable), `RUSH_ALREADY_REPLIED` (double reply — disable send after 200, refetch on conflict); repeated customer rushes → `ORDER_RUSH_NOT_ALLOWED` (banner CTA hides after the first acknowledged rush). The merchant cannot trigger rushes — the request endpoint is customer-owned.

## Advance (scheduled) orders

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/orders/me/advance?date=` | Scheduled orders for the merchant day |

- Advance orders carry `scheduledAt` (nullable on `Order`); `ORDER_SCHEDULED_IN_PAST` rejects past scheduling (customer side). `order.scheduled_reminder` (30 min before) notifies merchant + customer (push, SMS).
- UI: "Scheduled" tab with local-time `scheduledAt` and countdown cards; accepting before the window follows the normal accept flow — the prep start is merchant-discretionary. States: loading → empty ("No scheduled orders for this day") → error + retry → day list with time pills.

## Batch print receipts

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/print-jobs` | Create a print job (batch receipts, kitchen tickets, labels, vouchers) |
| GET | `/print-jobs?status=&limit=` | Print job history |
| GET | `/print-jobs/{printJobId}` | Print job detail |

- Job body (`PrintJob`): `jobType` enum `receipt` / `kitchen_ticket` / `label` / `voucher`; batch receipts send one job with `orderIds[]` (multi-select); `copies` (1–5, default 1); `deviceId` (target printer; null = default); optional `tableId`, `label` ≤80.
- Statuses: `queued` → `printing` → `done`; `failed` carries `error`. Errors: `PRINT_DEVICE_OFFLINE` (per-device alert + retry, STAFF-AND-DEVICES.md), `PRINT_JOB_EMPTY` (no documents), `PRINT_JOB_NOT_FOUND` (404 stale refs); `print.job_failed` (in-app) notifies staff.
- `StoreSettings.printSettings` (`autoPrint`, `copies`, `labelPrinter`) and the receipt template stay the store defaults; job-level `copies`/`deviceId` overrides per run.

## Order status filtering

- `GET /orders/me?status=<OrderStatus>&limit=&cursor=` filters the queue server-side (cursor pagination). UI: filter chips (paid, merchant_accepted, preparing, completed, cancelled, refunded, disputed); each tab is a separate query.
- Terminal statuses render read-only; filters never include customer-owned `draft`/`pending_payment`.

## Order search (`GET /orders/search`)

- Query params: `q` ≤120 (order/item keyword), `status` (OrderStatus), `from`/`to` (date), `customerPhone`, `limit`, `cursor`. Errors: `ORDER_SEARCH_INVALID` on malformed input (422-grade banner).
- Results are `Order[]`, each row opens the order detail. States: loading skeleton → empty ("No orders match") → error + retry → results with cursor "load more".

## Enterprise (B2B) orders (`GET /orders/enterprise`)

- `EnterpriseOrder` = `Order` + `companyName`, `costCenter` (nullable), `billingRef` (nullable); corporate tab with `OrderStatus` filter; rows show company/cost center/billing ref; detail is the standard order detail plus the corporate header block.

## Order timeline (`GET /orders/{orderId}/timeline`)

- Response `{events: OrderEvent[]}` — `status`, `at`, `by` (`system`/`merchant`/`rider`/`customer`), `note`. Dedicated timeline screen vs the inline events on order detail: grouped by status, local times, rider-owned states read-only.

## Batch accept / reject (`POST /orders/batch/accept`, `POST /orders/batch/reject`)

- Accept body: `orderIds` (minItems 1, maxItems 50). Reject body: `orderIds` + one `reason` ≤500 for the batch. Response `BatchResult`: `accepted`, `failed`, `failures[]` (`orderId` + `code` per failure).
- Errors: `BATCH_EMPTY` (nothing selected — action disabled until ≥1), `BATCH_EXCEEDS_LIMIT` (>50 — reduce the selection).
- UI: multi-select rows on the pending tab → action bar → confirm (reject opens the reason picker from `/orders/reject-reasons`) → result summary ("accepted X, failed Y") with per-failure reasons; failed rows stay selectable for retry.

## Food damage claims (`POST /orders/{orderId}/damage`)

- `DamageClaim`: `orderId`, `type` (`spilled`/`missing`/`wrong_item`/`damaged_packaging`/`quality`), `description` ≤1000, `images` (uri, maxItems 5), `status` (`open`/`approved`/`rejected`/`compensated`), `createdAt`. 201 on create.
- Errors: `DAMAGE_CLAIM_NOT_FOUND` (stale ref), `DAMAGE_CLAIM_ALREADY_DECIDED` (resubmission after a decision is blocked — banner).
- Flow: type chips → description → up to 5 photos (pre-signed upload pattern) → submit → `open` pill; the decision arrives server-side and the status pill updates; `compensated` tracks compensation.

## Reason catalogs (`GET /orders/reject-reasons`, `GET /refunds/reasons`)

- Both return `string[]`; rendered as picker chips with a free-text fallback (≤500). Fetched once per screen and cached; an empty catalog falls back to free text only.

## Receipt reprint list (`GET /orders/receipts`)

- Returns `[{orderId, printedAt, jobId}]` — recently printed receipts; row → reprint creates a new receipt print job (`POST /print-jobs`, `jobType: receipt`, that `orderId`). States: loading → empty ("No receipts printed yet") → error + retry → list with local-time `printedAt`.

## Refund request queue (`GET /refunds`, `POST /refunds/{refundId}/approve|reject`)

- The merchant receives customer refund requests in a queue — decisions are merchant-owned; execution stays provider-webhook-driven. `RefundRequest`: `id`, `orderId`, `customerName` (nullable), `amountTZS`, `reason`, `status` (`pending`/`approved`/`rejected`), `decisionReason`, `createdAt`.
- Approve or reject with `reason` ≤500; filter by status. Errors: `REFUND_REQUEST_NOT_FOUND`, `REFUND_ALREADY_DECIDED` (409 banner + refetch), `REFUND_REQUEST_AFTER_ACCEPTANCE_POLICY` (policy banner).
- Notifications: `refund.request_received` (merchant, in-app), `refund.decision` (customer, push + in-app). Dispute refunds: `disputed` still holds the payout until review — the order-detail banner + ticket path below stays the route (SHARED-FLOWS).

## Advance status

| From | To | Action |
| --- | --- | --- |
| `merchant_accepted` | `preparing` | `POST /orders/{orderId}/status` with `status: preparing`, optional `note` (e.g. prep estimate) |
| `preparing` | (auto) | Dispatch assigns rider → `rider_assigned`; after this the rider owns `picked_up`/`delivering`/`delivered` |

Visibility rule: `rider_assigned` and later states are read-only for the merchant — the track view (`GET /orders/{orderId}/track`) shows rider location and `estimateMinutes`; buttons hide past merchant-owned transitions and a stale press is rejected with 409 (UI refetches).

## Order detail

From `GET /orders/{orderId}` (`OrderDetail`):

| Section | Content |
| --- | --- |
| Items | `items[]`: name, quantity, `unitPriceTZS` (snapshot — catalogue changes never alter it) |
| Totals | `PriceBreakdown`: subtotalTZS, deliveryFeeTZS, platformFeeTZS, taxTZS, discountTZS, totalTZS (rendered `TZS 12,500`-style, separators, integer only) |
| Delivery | `deliveryAddress`: label, lines, landmark; `contactPhone` masked per policy |
| Events | `events[]`: status, at, by (system/merchant/rider/customer), note — rendered as a timeline |

## Cancellation handling (SHARED-FLOWS)

| Moment | Rule | UI |
| --- | --- | --- |
| Before merchant acceptance | Full refund, subject to payment-provider timing | Cancel action with reason; note "customer refunded" |
| After merchant acceptance | Applicable cancellation fee shown before confirmation | Confirm dialog states the fee (from server response) before `POST /orders/{orderId}/cancel` |
| Customer-initiated late cancellation | Reliability event recorded; operations notified | Merchant sees `cancelled` status with reason |
| Customer dispute | Payout held until reviewed | `disputed` badge + banner "payment held pending review" |

Cancel body: `reason` (≤500). Refund execution is server/webhook-driven (`refund.processed`, `refund` ledger entry) — the merchant app never triggers payment intents or refunds directly.

## Completion

- `delivered` (rider-confirmed) → `completed` (system, per completion rules); the merchant sees the status change and a `completed` in-app notification. Ledger earning (`order_earning`) is created only after `completed` — the balance updates in earnings, not in orders.

## Screen states (orders list and detail)

- Loading skeleton + queue unread badge; empty ("No orders" for the filter); error with retry (429 honors `Retry-After`). Success: actions disabled where the state machine forbids (server-enforced; 409s surface as banners, never silent failures).

## MSW parity

MSW must reproduce the order state machine: accept 409 when status is not `paid`, reject codes (`ORDER_ALREADY_REJECTED`, `ORDER_REJECT_AFTER_ACCEPTANCE`), status advance rejection for rider-owned states, cancel fee responses, `rushRequestedAt` on order payloads, advance-order day lists, masked `contactPhone`, and print-job statuses (`queued`/`printing`/`done`/`failed` with `PRINT_DEVICE_OFFLINE`) — plus search params + `ORDER_SEARCH_INVALID`, enterprise payloads, timeline events, `BatchResult` (`BATCH_EMPTY`/`BATCH_EXCEEDS_LIMIT`), damage claims (`DAMAGE_CLAIM_*`), rush queue statuses (`RUSH_NOT_OPEN`/`RUSH_ALREADY_REPLIED`), refund queue (`REFUND_ALREADY_DECIDED`), reason catalogs, and receipts rows.

# Round-2 additions (deep survey — `docs/REFERENCE-SURVEY.md`)

## Order identity, concurrency, and read state

- `Order.no` — human-readable order number; rendered on queue cards, the detail header ("Order #..."), and receipt reprints (`GET /orders/receipts`). Display only; the id remains the reference key.
- `Order.version` — optimistic-concurrency version. Every order mutation that transitions state sends the version observed by the client; `POST /orders/{orderId}/accept` requires body `expectedVersion` (integer).
- `VERSION_CONFLICT` (409) — the version no longer matches (a concurrent device acted first). UI: conflict banner on the detail, refetch `GET /orders/{orderId}`, retry the accept **once** with the fresh `version`; a second conflict renders the updated state and disables the accept CTA (never double-accept, never silent failure). `ORDER_STATUS_CONFLICT` covers non-version state mismatches (order no longer `paid`).
- `Order.source` — enum `app` / `web` / `phone` / `pos` (default `app`); renders as a source badge on the card and detail. `phone` rows surface the phone-ordering context; `pos` rows come from counter terminals.
- `Order.deadlineAt` — acceptance deadline (nullable date-time). A live countdown (mm:ss, local time) renders on `paid` rows; it is informational only — the server is authoritative. The auto-cancel sweeper (backend DATA-MODEL) cancels orders past `deadlineAt` with reason code `AUTO_CANCEL` and an idempotent refund; a late accept attempt returns `ORDER_AUTO_CANCELLED` (409-grade banner + refetch).
- `Order.seen` (default `false`) — new-arrival badge state. `POST /orders/{orderId}/seen` (204) marks an order seen and dismisses the badge; the queue/detail call it once per unread order. Seen state is server-side, never client-local.
- `Order.freeDelivery` (default `false`) — renders a "free delivery" chip; `PriceBreakdown.deliveryFeeTZS` is 0 server-side when true.
- Per-status timestamps (all nullable date-times): `acceptedAt`, `readyAt`, `completedAt`, `cancelledAt`, `settledAt` — render beside the matching `OrderStatus` event on the detail timeline; `settledAt` links the order to its ledger settlement (EARNINGS.md).
- `Order.rejectReasonCode` (nullable) — catalog code next to the free-text `rejectReason`; shown on rejected orders in historical filters and in the reject-confirm summary.

## Rush urgency tiers and ETA reply presets

- Urgency tiers classify dwell time since `createdAt` on the rush/open queue: Low < 2 min, Medium < 5 min, High < 10 min, Critical >= 10 min — rendered as a tier pill per row. This is a UI convention over contract data (`rushRequestedAt`, `deadlineAt`, `deliveryEtaMin`); there is no `urgency` field on `RushOrder` (contract gap).
- ETA reply presets: chips 5 / 10 / 15 / 20 / 30 / 45 minutes fill the reply box text; the message goes through `POST /orders/{orderId}/rush-reply` (`message` <=300, free text allowed). Server behavior unchanged: `RUSH_NOT_OPEN`, `RUSH_ALREADY_REPLIED` (disable send after 200, refetch on conflict).

## Pre-order tabs (Today / Upcoming / Past)

- `GET /orders/me/advance?date=` remains the only contract surface for scheduled orders. The reference-app tabs are date queries over it: Today = `date=<today>`, Upcoming = next 7 days, Past = completed pre-orders filtered by status. Each tab is its own query with loading skeleton → empty ("No pre-orders for this day") → error + retry → day list with local-time `scheduledAt` countdown cards.

## Refund queue — partial-amount approval

- The queue (`GET /refunds`, `POST /refunds/{refundId}/approve|reject`, `reason` <=500) shows the requested `amountTZS` on each pending row. Partial-amount approval (approve an amount <= requested) is a reference-app capability **not in the contract** — the approve body carries only `reason`; no `amountTZS` field exists (contract gap: flag before building). Until then the decision is approve-in-full or reject, both with a reason; `REFUND_ALREADY_DECIDED` (409) and `REFUND_REQUEST_NOT_FOUND` handling is unchanged.

## Reason codes

- Reject reasons come from the catalog (`GET /orders/reject-reasons`) and land on the order as `rejectReason` (free text) + `rejectReasonCode` (catalog code) when a preset chip was used; refund decisions use `GET /refunds/reasons` the same way. The detail renders the code pill next to the text; a stale catalog falls back to free text only (<=500).

# Round-3 additions — server-enforced order rules (reference contract tests)

Behaviors verified against the reference contract suite (`tests/contract.test.ts`) and the server sweeper (`src/mock/sweeper.ts`). Statuses and error codes are exact; all money is integer TZS.

## Orders gate

- Order creation while the store is closed → 409 `STORE_CLOSED`; existing orders continue.
- `StoreSettings.orderReceiving.acceptWhileClosed` (default `false`): when `true`, a closed store accepts **scheduled** orders (`scheduledAt` set) only; immediate orders still return 409 `STORE_CLOSED`. When `false`, the closed store rejects all new orders.
- Subtotal below `deliverySettings.minimumOrderTZS` → 409 `BELOW_MIN_ORDER`.
- Pre-orders disabled + order carries `scheduledAt` → 409 `PREORDERS_DISABLED`.

## Note requirement (`requireNotes`)

- `requireNotes: required` → order without a note rejected `NOTE_REQUIRED` (reference suite asserts 400); with a note accepted and the note persisted on the order.
- `optional` / `none` → no note required; both pass without a note.

## Acceptance deadline and auto-cancel

- `orderReceiving.autoCancelMinutes` (N) → `Order.deadlineAt = createdAt + N minutes`, derived server-side at creation.
- Sweeper (periodic job): `new` orders past `deadlineAt` → `cancelled`, `cancelReasonCode: AUTO_CANCEL`, `cancelReason` "Not accepted in time", `cancelledAt` set, `cancelled` timeline event (actor `system-auto-cancel`). Captured payments are refunded for real: payment status `refunded`, refund record `approved`, exactly one refund ledger entry. Re-running the sweeper never double-refunds (refund idempotent on `rf_<orderId>`).

## Stock

- Accept decrements stock server-side exactly once; replaying accept with a different idempotency key does not decrement again; the same key replays the stored result (version unchanged).
- Insufficient stock on accept → 409 `INSUFFICIENT_STOCK`, order stays `new`.
- Bulk stock adjust supports `set` (absolute) and `delta` (relative) per item; deltas clamp at 0.

## State machine

- Invalid moves → 409 `INVALID_TRANSITION` (e.g. `new` → `ready` rejected; `ready` → `completed` allowed).

## Refund rules

- Requested refund amount above the order total is clamped to the total; zero amount → 400.
- Refund request on a cancelled order → 409 `ORDER_CANCELLED`.
- Refund request on an un-captured payment is allowed (amount clamped); the decide is blocked until capture → 409 `PAYMENT_NOT_CAPTURED`.
- Approve / reject / decide are idempotent: a double decide creates one refund record and one ledger debit; a double reject creates one refund record.
- Refund reason catalog served (`GET /refunds/reasons`); the selected `reasonCode` is recorded on the reject and in the audit entry.

## Rush

- Second rush within the cooldown (`Order.rushCooldownMinutes`, default 1) keeps `deadlineAt` unchanged.
- Rush reply extends the deadline exactly once (+5 min); a repeated reply is idempotent (deadline unchanged).
- Preparing orders can be rushed; rushing a completed order → 409 `INVALID_TRANSITION`.

## Reject honesty

- Rejecting an un-captured order notifies the customer without claiming a refund ("no charge was made" wording — never "refunded").
- Rejecting a captured order notifies the customer that the payment was refunded.

## Pre-order reminder

- Sweeper notifies ≤15 min before `scheduledAt`, once, and sets `Order.preOrderReminderSent` (persists on the order row).

## Versioning and batch

- Stale `expectedVersion` → 409 `VERSION_CONFLICT` with `details.currentVersion`; the client refetches and retries once with the fresh version.
- Batch accept reports partial failures (`accepted[]` / `failed[]` with per-failure id + code); replaying an already-accepted order in a batch does not crash; ready replay dispatches the rider exactly once (single audit entry).

## Free delivery

- Subtotal >= `StoreSettings.freeDeliveryThresholdTZS` → `Order.freeDelivery: true` and `deliveryFeeTZS` 0 (fee waived); below the threshold the fee is charged.
